/**
 * Role-dispatching delegation tool.
 *
 * One tool, many specialists. The caller names a `role` — `oracle`, `metis`,
 * `explore`, … — and this tool starts a child agent composed from that role's
 * definition: its own system prompt (`persona`), its own tool access
 * (`toolFilter`), and optionally its own model (`agentOptions`).
 *
 * It is a thin adapter over `ctx.subagents`, the same Service the shipped
 * `@deepseek-ai/dsh-tool-subagent` consumes, so it deliberately owns only two
 * things the shipped tool does not have: the role roster and the argument
 * mapping. Everything else — child composition, background settlement, the
 * durable descriptor that `send_message` and `list_agents` operate on, depth
 * accounting — stays with the Service, and therefore behaves identically to a
 * delegation started by the shipped tool.
 *
 * ## The model rule
 *
 * A role's `model` / `provider` / `reasoningEffort` may be empty. All three
 * empty means the request carries **no** `agentOptions` at all, and the child
 * inherits compatible fields from the calling agent — "follow the main
 * session". Any one configured means the request carries exactly the configured
 * subset, so the remaining fields are still inherited.
 *
 * ## What this tool deliberately does not do
 *
 * It exposes no per-call `provider` / `model` / `reasoning_effort` parameters.
 * Those belong to the Host's `subagent-model-selection` policy, which the
 * shipped tool enforces and whose helpers are not exported; adding them here
 * would mean either bypassing a user-set allowlist or reimplementing it. A role
 * pins its model in `role.yml` instead.
 *
 * Registration is called by the bundle's single plugin entry (`index.js`), not
 * by the Loader directly: a profile-linked package resolves by its bare name in
 * a nested preset row, but its subpath exports do not, and a row that fails to
 * import is reported only as "never started".
 *
 * @module dsh-ulanworker/subagent
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSimpleYaml } from './yaml-lite.js'

/** Directory holding one subdirectory per role. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROLES_DIR = join(PACKAGE_DIR, 'roles')

/** Default provider and tool name; the row may override both. */
const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_TOOL_NAME = 'subagent'

/** Kebab-case, the same grammar the skill registry uses for names. */
const ROLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Accepted spellings for the `enabled` flag. */
const TRUTHY = new Set(['true', 'yes', 'on', '1'])
const FALSY = new Set(['false', 'no', 'off', '0'])

/**
 * Install the dispatch tool into a preset scope.
 *
 * @param ctx - the preset context that owns the tool registration; its
 *   `tools` and `subagents` services must be available.
 * @param config - the plugin config; the roster root may be overridden.
 */
export function registerDispatch(ctx, config) {
  const settings = config ?? {}
  const providerName = settings.provider ?? DEFAULT_PROVIDER
  const toolName = settings.toolName ?? DEFAULT_TOOL_NAME
  const directory = settings.rolesDirectory ?? DEFAULT_ROLES_DIR
  const roster = loadRoster(directory)

  const assertProvider = (candidate) => {
    const missing = []
    if (candidate.capabilities?.persona !== true) missing.push('persona')
    if (candidate.capabilities?.toolFilter !== true) missing.push('toolFilter')
    if (pinsAnyModel(roster) && candidate.capabilities?.agentOptions !== true) missing.push('agentOptions')
    if (typeof candidate.prepareContinuable !== 'function') missing.push('prepareContinuable')
    if (missing.length > 0) {
      throw new Error(
        `ulanworker-subagent: subagent provider "${candidate.name}" cannot honour this roster (missing ${missing.join(', ')}); ` +
          `use a provider that advertises them or clear the role fields that need them`,
      )
    }
  }

  // Fail at mount rather than at the first delegation: a provider that cannot
  // compose a persona or enforce a tool filter would otherwise accept the call
  // and produce a child that is not the role the caller asked for.
  const present = ctx.subagents.getProvider(providerName)
  if (present !== undefined) assertProvider(present)
  ctx.on('subagent/provider-added', (candidate) => {
    if (candidate.name === providerName) assertProvider(candidate)
  })

  ctx.effect(
    () =>
      ctx.tools.register({
        name: toolName,
        description: describeRoster(roster),
        // Hand-written JSON Schema rather than the harness's `defineTool`
        // ergonomics: a workspace-installed bundle resolves its own imports
        // from the workspace, so importing `@deepseek-ai/dsh-tools` here would
        // fail to load. The registry stores exactly this shape.
        parameters: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: [...roster.order],
              description: 'Which specialist to start. Use the exact name from the role list in this tool description.',
            },
            description: {
              type: 'string',
              description: 'A 3-5 word label for this delegation, shown to the user and used to address the child.',
            },
            prompt: {
              type: 'string',
              description:
                'The complete brief. The child sees nothing else: state the task, the evidence it needs, what to deliver, and when to stop.',
            },
            run_in_background: {
              type: 'boolean',
              description:
                'Defaults to true: the child starts in the background and this call returns its id immediately. Set false only for a short child whose result gates your very next call.',
            },
          },
          required: ['role', 'description', 'prompt'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error(`${toolName} requires a calling agent`)
          validateArgs(args, toolName, roster)
          const role = roster.roles.get(args.role)
          if (ctx.subagents.getProvider(providerName) === undefined) {
            throw new Error(`subagent provider "${providerName}" is not registered, so no child can be started`)
          }

          const request = buildChildRequest(role, args, parent)
          const background = args.run_in_background ?? true
          if (!background) {
            const run = await ctx.subagents.start(providerName, { ...request, signal: exec.signal })
            return await settleForeground(run)
          }
          const started = await ctx.subagents.startContinuable({
            provider: providerName,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return `started subagent ${started.childId} (role: ${role.toolName})`
        },
      }),
    'ulanworker-subagent: role dispatch tool',
  )
}

/**
 * Reject arguments the tool's schema promises the model would not send.
 *
 * The registry stores `parameters` as documentation for the model; it does not
 * enforce it, so the checks live here.
 *
 * @param args - the parsed call arguments.
 * @param toolName - the registered tool name, for the error text.
 * @param roster - the loaded roster, for the valid role list.
 * @throws when a required field is missing, mistyped, or names an unknown role.
 */
export function validateArgs(args, toolName, roster) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object`)
  }
  for (const field of ['role', 'description', 'prompt']) {
    if (typeof args[field] !== 'string' || args[field].trim() === '') {
      throw new Error(`${toolName}: "${field}" is required and must be a non-empty string`)
    }
  }
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') {
    throw new Error(`${toolName}: "run_in_background" must be a boolean when provided`)
  }
  if (!roster.roles.has(args.role)) throw new Error(unknownRoleMessage(args.role, roster))
}

/**
 * Read and validate a role directory.
 *
 * Every failure is a mount failure: a roster that is half-understood would send
 * delegations to a child that is not the role the caller named.
 *
 * @param directory - absolute path of the roles root.
 * @returns the roles in declaration order, keyed by tool name.
 * @throws when the directory is unreadable or any role is malformed.
 */
export function loadRoster(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`ulanworker-subagent: cannot read the roles directory ${directory}: ${String(error)}`)
  }

  const roles = new Map()
  const order = []
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const role = readRole(join(directory, entry.name), entry.name)
    if (role === undefined) continue
    if (roles.has(role.toolName)) {
      throw new Error(`ulanworker-subagent: role name "${role.toolName}" is declared twice (${entry.name} repeats it)`)
    }
    roles.set(role.toolName, role)
    order.push(role.toolName)
  }

  if (order.length === 0) throw new Error(`ulanworker-subagent: no enabled roles found under ${directory}`)
  return { roles, order }
}

/**
 * Read one role directory.
 *
 * @param directory - absolute path of the role's own directory.
 * @param fallbackName - directory name, used only in error messages.
 * @returns the role, or undefined when it is explicitly disabled.
 * @throws when a required field is missing or malformed.
 */
function readRole(directory, fallbackName) {
  const where = `role "${fallbackName}" (${directory})`
  let raw
  try {
    raw = readFileSync(join(directory, 'role.yml'), 'utf8')
  } catch (error) {
    throw new Error(`ulanworker-subagent: ${where} has no readable role.yml: ${String(error)}`)
  }

  const fields = parseSimpleYaml(raw)
  const enabled = readEnabled(fields.enabled, where)
  if (!enabled) return undefined

  const toolName = readString(fields.toolName, `${where}: toolName`)
  if (!ROLE_NAME.test(toolName)) {
    throw new Error(`ulanworker-subagent: ${where}: toolName "${toolName}" must be lower-kebab-case (letters, digits, hyphens)`)
  }
  const summary = readString(fields.summary, `${where}: summary`)
  readString(fields.title, `${where}: title`)

  let persona
  try {
    persona = readFileSync(join(directory, 'persona.md'), 'utf8').trim()
  } catch (error) {
    throw new Error(`ulanworker-subagent: ${where} has no readable persona.md: ${String(error)}`)
  }
  if (persona === '') throw new Error(`ulanworker-subagent: ${where}: persona.md is empty`)

  const agentOptions = readAgentOptions(fields, where)
  const toolFilter = readToolFilter(fields.toolFilter, where)
  return {
    toolName,
    summary,
    persona,
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(toolFilter === undefined ? {} : { toolFilter }),
  }
}

/**
 * Build the start request for one role.
 *
 * The returned object is exactly what the child is composed from, which is why
 * it is a pure function: the "empty model follows the main session" rule is a
 * property of this object, and is asserted directly in the checks.
 *
 * @param role - a role from {@link loadRoster}.
 * @param args - the validated tool arguments.
 * @param parent - the calling agent.
 * @returns a `SubagentStartRequest` body without `signal`.
 */
export function buildChildRequest(role, args, parent) {
  return {
    label: args.description,
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    ...(role.agentOptions === undefined ? {} : { agentOptions: role.agentOptions }),
    ...(role.persona === undefined ? {} : { persona: role.persona }),
    ...(role.toolFilter === undefined ? {} : { toolFilter: role.toolFilter }),
  }
}

/**
 * Render the model-facing tool description.
 *
 * @param roster - the loaded roster.
 * @returns the description, with every role and its one-line contract.
 */
export function describeRoster(roster) {
  const lines = roster.order.map((name) => `- \`${name}\`: ${roster.roles.get(name).summary}`)
  return [
    'Dispatch one task to a named specialist subagent. It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when its run settles. Pass `run_in_background: false` to wait for its result in this turn.',
    '',
    'Roles (pass the exact name as `role`):',
    ...lines,
    '',
    'Each role has its own system prompt, its own tool access, and its own default model; a role whose model is unset follows the current session model. The brief is the child\u2019s entire context, so name the skills it should load and say when to stop.',
  ].join('\n')
}

/**
 * Build the error for a role that is not in the roster.
 *
 * @param requested - the value the caller passed.
 * @param roster - the loaded roster.
 * @returns the message, listing every valid name.
 */
export function unknownRoleMessage(requested, roster) {
  return `unknown role ${JSON.stringify(String(requested))}; valid roles are: ${roster.order.join(', ')}`
}

/**
 * True when at least one role pins any part of the child route.
 *
 * @param roster - the loaded roster.
 * @returns whether any role needs the provider's `agentOptions` capability.
 */
function pinsAnyModel(roster) {
  for (const role of roster.roles.values()) {
    if (role.agentOptions !== undefined) return true
  }
  return false
}

/**
 * Collect the configured route fields, or undefined when nothing is configured.
 *
 * @param fields - the parsed role.yml.
 * @param where - human-readable location, for errors.
 * @returns `{ provider?, model?, reasoningEffort? }`, or undefined when all empty.
 */
function readAgentOptions(fields, where) {
  const agentOptions = {}
  for (const [key, field] of [
    ['provider', 'provider'],
    ['model', 'model'],
    ['reasoningEffort', 'reasoningEffort'],
  ]) {
    const value = fields[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') throw new Error(`ulanworker-subagent: ${where}: ${field} must be a string`)
    const trimmed = value.trim()
    if (trimmed === '') continue
    if (/\s/.test(trimmed)) throw new Error(`ulanworker-subagent: ${where}: ${field} "${trimmed}" must not contain whitespace`)
    agentOptions[key] = trimmed
  }
  return Object.keys(agentOptions).length === 0 ? undefined : agentOptions
}

/**
 * Normalize a tool filter, rejecting the shapes the Service rejects.
 *
 * @param value - the parsed `toolFilter` block, or undefined.
 * @param where - human-readable location, for errors.
 * @returns `{ allow? }` or `{ deny? }`, or undefined when absent.
 */
function readToolFilter(value, where) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`ulanworker-subagent: ${where}: toolFilter must be a mapping with "allow" or "deny"`)
  }
  const filter = {}
  for (const key of ['allow', 'deny']) {
    const names = value[key]
    if (names === undefined) continue
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error(`ulanworker-subagent: ${where}: toolFilter.${key} must be a non-empty list of tool names`)
    }
    for (const entry of names) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error(`ulanworker-subagent: ${where}: toolFilter.${key} contains a non-string or empty tool name`)
      }
    }
    filter[key] = names.map((entry) => entry.trim())
  }
  if (filter.allow === undefined && filter.deny === undefined) {
    throw new Error(`ulanworker-subagent: ${where}: toolFilter names neither "allow" nor "deny"; remove the key or fill it`)
  }
  return filter
}

/**
 * Read a required non-empty string field.
 *
 * @param value - the parsed value.
 * @param label - field label, for errors.
 * @returns the trimmed string.
 * @throws when the field is missing or empty.
 */
function readString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ulanworker-subagent: ${label} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read the optional `enabled` flag.
 *
 * @param value - the parsed value, or undefined.
 * @param where - human-readable location, for errors.
 * @returns whether the role is enabled; defaults to true.
 */
function readEnabled(value, where) {
  if (value === undefined || value === '') return true
  const normalized = String(value).toLowerCase()
  if (TRUTHY.has(normalized)) return true
  if (FALSY.has(normalized)) return false
  throw new Error(`ulanworker-subagent: ${where}: enabled must be a boolean, got ${JSON.stringify(String(value))}`)
}

/**
 * Await one foreground child and hand back its text.
 *
 * Mirrors the shipped tool's settlement: the run is always disposed, and a stop
 * reason other than `completed` is an error carrying whatever the child managed
 * to say before it stopped.
 *
 * @param run - the run returned by `ctx.subagents.start`.
 * @returns the child's assistant text.
 */
async function settleForeground(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      if (result.stopReason !== 'completed') throw new Error(stopReasonMessage(result))
      return outputText(result.output)
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Turn a non-completed stop reason into a model-facing error.
 *
 * @param result - the settled run result.
 * @returns the headline, with any partial output appended.
 */
function stopReasonMessage(result) {
  const headline =
    {
      aborted: 'subagent run was cancelled',
      error: 'subagent run failed',
      'max-tokens': 'subagent run hit its token limit before finishing',
      refusal: 'subagent declined the task',
    }[result.stopReason] ?? `subagent run ended abnormally (${String(result.stopReason)})`
  const partial = outputText(result.output)
  return partial === '' ? headline : `${headline}\n\nPartial output before it stopped:\n${partial}`
}

/**
 * Flatten content blocks to their text.
 *
 * @param blocks - the run's output blocks, possibly undefined.
 * @returns the concatenated text.
 */
function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
