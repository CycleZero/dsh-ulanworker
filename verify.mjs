/**
 * Offline checks for everything this bundle ships.
 *
 * Four sections, all runnable without installing the bundle:
 *
 *  1. **Skills** — the loader's registration payload and its rejection paths.
 *  2. **Roles** — the roster parses, every role is complete, and malformed
 *     definitions fail loudly instead of producing a half-configured child.
 *  3. **Dispatch** — the request this tool hands to the subagent Service,
 *     including the "an empty model follows the main session" rule, plus the
 *     argument validation the tool's schema promises.
 *  4. **Surface** — the generated preset differs from the shipped `standard`
 *     preset by exactly the rows declared in `SURFACE_DELTA`.
 *
 * Usage: `node verify.mjs`
 *
 * @module dsh-ulanworker/verify
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, buildRegistration, inject, name } from './index.js'
import { buildChildRequest, describeRoster, loadRoster, unknownRoleMessage, validateArgs } from './subagent.js'
import { SURFACE_DELTA, applySurfaceDelta, splitRows } from './surface-delta.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const EXPECTED_SKILLS = ['handoff', 'ultrawork']
const EXPECTED_ROLES = ['atlas', 'explore', 'librarian', 'looker', 'metis', 'momus', 'oracle', 'plan']
/**
 * Tool names that exist only while an optional bundle is enabled. Naming one in
 * a role's `toolFilter` breaks that role on every deployment without the bundle:
 * `tools.restrict()` rejects unknown names while the child is composed, and the
 * failure is per-call, not at mount. `node smoke.mjs` is the authoritative
 * real-mount guard; this lint catches the mistake before a harness boots.
 */
const CONDITIONAL_TOOLS = new Set([
  'spawn_teammate',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
])
const ROW_INDENT = '          '
const FIELD_INDENT = `${ROW_INDENT}  `

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}
const throws = (fn, pattern, label) => {
  try {
    fn()
  } catch (error) {
    const message = String(error?.message ?? error)
    check(pattern.test(message), `${label}: error "${message}" does not match ${pattern}`)
    return
  }
  failures.push(`${label}: expected a throw`)
}

// ------------------------------------------------------------------- skills

const registered = []
const warnings = []
let mounted
const started = []
const stubProvider = (overrides = {}) => ({
  name: 'spawn',
  capabilities: { persona: true, toolFilter: true, agentOptions: true },
  prepareContinuable() {},
  ...overrides,
})

/**
 * A minimal stand-in for the preset context: enough of `skills`, `tools`, and
 * `subagents` to run the real `apply()` and call the tool it registers.
 *
 * @param provider - the subagent provider the stub registry reports.
 * @returns the stub context plus the arrays recording what was registered.
 */
const makeCtx = (provider = stubProvider()) => ({
  logger: { warn: (message) => warnings.push(String(message)) },
  skills: {
    register(skill) {
      registered.push(skill)
      return () => {}
    },
  },
  tools: {
    register(tool) {
      mounted = tool
      return () => {}
    },
  },
  subagents: {
    getProvider: (wanted) => (provider.name === wanted ? provider : undefined),
    resolveMaxDepth: () => 1,
    startContinuable: async (spec) => {
      started.push(spec)
      return { childId: 'child-1' }
    },
    start: async (_name, request) => {
      started.push(request)
      return {
        id: 'run-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'the answer' }] }),
        dispose: async () => {},
      }
    },
  },
  on() {
    return () => {}
  },
  effect(callback, label) {
    if (typeof label !== 'string' || label === '') throw new Error('ctx.effect called without a label')
    return callback()
  },
})

apply(makeCtx(), undefined)

check(
  inject.join(',') === 'skills,tools,subagents',
  `inject must name the skill registry, the tool registry and the subagent service, got ${inject.join(',')}`,
)
check(name === 'dsh-ulanworker', `unexpected plugin name ${name}`)
check(warnings.length === 0, `unexpected warnings: ${warnings.join(' | ')}`)
check(
  registered.map((skill) => skill.name).sort().join(',') === EXPECTED_SKILLS.join(','),
  `registered ${JSON.stringify(registered.map((skill) => skill.name))}, expected ${JSON.stringify(EXPECTED_SKILLS)}`,
)

for (const skill of registered) {
  const directory = join(ROOT, 'skills', skill.name)
  const file = join(directory, 'SKILL.md')
  check(existsSync(file), `${skill.name}: ${file} does not exist`)
  const raw = readFileSync(file, 'utf8')
  const body = raw.slice(raw.indexOf('\n---', 4) + 4).replace(/^\n+/, '')
  check(typeof skill.description === 'string' && skill.description.length >= 20, `${skill.name}: description missing or too short`)
  check(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0, `${skill.name}: whenToUse was not parsed`)
  check(
    skill.metadata !== undefined && typeof skill.metadata['short-description'] === 'string',
    `${skill.name}: nested metadata map was not parsed`,
  )
  check(skill.content === body, `${skill.name}: registered body does not match the file body (frontmatter must be stripped)`)
  check(skill.source === 'runtime', `${skill.name}: source must be 'runtime'`)
  check(skill.path === file, `${skill.name}: path must point at its own SKILL.md`)
  check(
    skill.resourceBase?.kind === 'directory' && skill.resourceBase?.path === directory,
    `${skill.name}: resourceBase must be its own directory`,
  )
  check(
    skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true,
    `${skill.name}: shipped skills must stay invocable from both surfaces`,
  )
  console.log(
    `skill  ${skill.name.padEnd(10)} desc=${String(skill.description.length).padStart(3)} body=${String(skill.content.length).padStart(5)} chars  invocation=model+user`,
  )
}

// -------------------------------------------------------------------- roles

const roster = loadRoster(join(ROOT, 'roles'))
check(
  roster.order.join(',') === EXPECTED_ROLES.join(','),
  `roster is ${roster.order.join(',')}, expected ${EXPECTED_ROLES.join(',')}`,
)
for (const roleName of roster.order) {
  const role = roster.roles.get(roleName)
  check(role.toolName === roleName, `${roleName}: toolName does not match its key`)
  check(role.summary.length > 20, `${roleName}: summary is too short to route on`)
  check(role.persona.length > 400, `${roleName}: persona is too short to define a role`)
  check(role.toolFilter !== undefined, `${roleName}: every role must declare a toolFilter`)
  for (const [kind, names] of Object.entries(role.toolFilter ?? {})) {
    for (const name of names) {
      check(
        !CONDITIONAL_TOOLS.has(name),
        `${roleName}: toolFilter.${kind} names "${name}", which only exists while an optional bundle is enabled`,
      )
    }
  }
  check(
    role.agentOptions === undefined,
    `${roleName}: ships with a pinned model (${JSON.stringify(role.agentOptions)}); the default roster must follow the main session`,
  )
  console.log(
    `role   ${roleName.padEnd(10)} persona=${String(role.persona.length).padStart(4)} chars  filter=${JSON.stringify(role.toolFilter)}`,
  )
}

const description = describeRoster(roster)
for (const roleName of roster.order) {
  check(description.includes(`\`${roleName}\``), `tool description does not mention the role "${roleName}"`)
  check(description.includes(roster.roles.get(roleName).summary), `tool description omits the summary of "${roleName}"`)
}
check(description.includes('send_message'), 'tool description must tell the model how to continue a background child')

// ----------------------------------------------------------------- dispatch

const oracle = roster.roles.get('oracle')
const args = { role: 'oracle', description: 'review auth', prompt: 'TASK: review the auth flow' }
const following = buildChildRequest(oracle, args, { id: 'parent' })
check(
  !Object.hasOwn(following, 'agentOptions'),
  'a role with an empty model must send no agentOptions at all, so the child inherits the main session route',
)
check(
  Object.keys(following).sort().join(',') === 'label,parent,persona,prompt,toolFilter',
  `unexpected request keys: ${Object.keys(following)}`,
)
check(following.persona === oracle.persona, 'the request must carry the role persona verbatim')
check(following.toolFilter === oracle.toolFilter, 'the request must carry the role toolFilter verbatim')
check(following.parent.id === 'parent', 'the request must carry the calling agent')
check(following.prompt[0].text === args.prompt, 'the brief must be the only thing the child is told')

const pinned = buildChildRequest(
  { ...oracle, agentOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'high' } },
  args,
  { id: 'parent' },
)
check(
  JSON.stringify(pinned.agentOptions) === JSON.stringify({ model: 'gpt-5.6-sol', reasoningEffort: 'high' }),
  `a configured role must send exactly the configured subset, got ${JSON.stringify(pinned.agentOptions)}`,
)

check(unknownRoleMessage('nope', roster).includes('atlas'), 'the unknown-role error must list the valid roles')
throws(() => validateArgs({ description: 'x', prompt: 'y' }, 'subagent', roster), /"role" is required/, 'missing role')
throws(
  () => validateArgs({ role: 'oracle', description: '  ', prompt: 'y' }, 'subagent', roster),
  /"description" is required/,
  'blank description',
)
throws(
  () => validateArgs({ role: 'oracle', description: 'x', prompt: 'y', run_in_background: 'yes' }, 'subagent', roster),
  /must be a boolean/,
  'wrong run_in_background type',
)
throws(() => validateArgs({ role: 'nope', description: 'x', prompt: 'y' }, 'subagent', roster), /unknown role/, 'unknown role')
validateArgs({ role: 'oracle', description: 'x', prompt: 'y' }, 'subagent', roster)

// --- the registered tool, against a stub Service --------------------------

check(mounted !== undefined, 'the plugin must register exactly one tool')
check(mounted.name === 'subagent', `the dispatch tool must be named "subagent", got "${mounted.name}"`)
check(mounted.parameters.required.join(',') === 'role,description,prompt', `unexpected required fields: ${mounted.parameters.required}`)
check(
  mounted.parameters.properties.role.enum.join(',') === roster.order.join(','),
  'the role enum must list every role in the roster',
)
check(mounted.parameters.additionalProperties === false, 'the schema must refuse unknown fields')
check(mounted.output.render({}, 'x')[0].text === 'x', 'the tool must render its string result as text')

const call = await mounted.execute({ role: 'oracle', description: 'review auth', prompt: 'TASK: x' }, { agent: { id: 'parent' } })
check(call === 'started subagent child-1 (role: oracle)', `unexpected background result: ${call}`)
check(started.length === 1, 'one dispatch must produce exactly one start call')
check(started[0].provider === 'spawn' && started[0].label === 'review auth', 'the start spec must carry the provider and label')
check(!Object.hasOwn(started[0].request, 'agentOptions'), 'the background start must not pin a route for a role with no model')

const foreground = await mounted.execute(
  { role: 'oracle', description: 'review auth', prompt: 'TASK: x', run_in_background: false },
  { agent: { id: 'parent' } },
)
check(foreground === 'the answer', `a foreground call must return the child's text, got ${JSON.stringify(foreground)}`)

const failing = makeCtx()
failing.subagents.start = async () => ({
  id: 'run-2',
  result: Promise.resolve({ stopReason: 'max-tokens', output: [{ type: 'text', text: 'partial' }] }),
  dispose: async () => {},
})
apply(failing, {})
let failureMessage
try {
  await mounted.execute({ role: 'oracle', description: 'x', prompt: 'y', run_in_background: false }, { agent: { id: 'parent' } })
} catch (error) {
  failureMessage = String(error.message)
}
check(
  failureMessage !== undefined && failureMessage.includes('token limit') && failureMessage.includes('partial'),
  `a non-completed stop reason must surface as an error with the partial output, got ${JSON.stringify(failureMessage)}`,
)

const withoutPersona = stubProvider({ capabilities: { persona: false, toolFilter: true, agentOptions: true } })
let mountError
try {
  apply(makeCtx(withoutPersona), {})
} catch (error) {
  mountError = String(error.message)
}
check(
  mountError !== undefined && mountError.includes('persona'),
  `a provider without the persona capability must fail at mount, got ${JSON.stringify(mountError)}`,
)
console.log(`dispatch tool registered as "${mounted.name}" with ${roster.order.length} roles; stub start/foreground/error paths exercised`)

// ------------------------------------------------------------ malformed data

const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-ulanworker-verify-'))
try {
  const writeSkill = (label, text) => {
    const directory = join(fixtureRoot, 'skills', label)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'SKILL.md')
    writeFileSync(file, text)
    return { directory, file }
  }

  const accepted = [
    [
      'policy-model-off',
      '---\nname: x\ndescription: a routed skill\ndisable-model-invocation: true\n---\nbody\n',
      (skill) => skill.invocation.modelInvocable === false && skill.invocation.userInvocable === true,
    ],
    [
      'policy-user-off',
      '---\nname: x\ndescription: a routed skill\nuser-invocable: "no"\n---\nbody\n',
      (skill) => skill.invocation.modelInvocable === true && skill.invocation.userInvocable === false,
    ],
    [
      'policy-on',
      '---\nname: x\ndescription: a routed skill\nuser-invocable: ON\n---\nbody\n',
      (skill) => skill.invocation.userInvocable === true,
    ],
  ]
  for (const [label, text, assertion] of accepted) {
    const written = writeSkill(label, text)
    const result = buildRegistration(written.file, written.directory, label)
    check(result.skill !== undefined, `${label}: expected a skill, got warning "${result.warning}"`)
    if (result.skill !== undefined) check(assertion(result.skill), `${label}: invocation policy did not match the frontmatter`)
  }

  const rejectedSkills = [
    ['legacy-key', '---\nname: x\ndescription: a routed skill\nmodelInvocable: false\n---\nbody\n', /unsupported/],
    ['bad-boolean', '---\nname: x\ndescription: a routed skill\nuser-invocable: maybe\n---\nbody\n', /must be a boolean/],
    ['no-description', '---\nname: x\n---\nbody\n', /needs non-empty name and description/],
    ['no-frontmatter', 'just a body\n', /no YAML frontmatter/],
  ]
  for (const [label, text, pattern] of rejectedSkills) {
    const written = writeSkill(label, text)
    const result = buildRegistration(written.file, written.directory, label)
    check(result.skill === undefined, `${label}: expected a skip, got a registration`)
    check(
      result.warning !== undefined && pattern.test(result.warning),
      `${label}: warning "${result.warning}" does not match ${pattern}`,
    )
  }

  const missing = buildRegistration(join(fixtureRoot, 'nope', 'SKILL.md'), join(fixtureRoot, 'nope'), 'nope')
  check(
    missing.skill === undefined && /cannot read/.test(String(missing.warning)),
    'missing file: expected a "cannot read" warning',
  )

  // --- role fixtures --------------------------------------------------------
  const writeRole = (root, label, yml, persona) => {
    const directory = join(root, label)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'role.yml'), yml)
    if (persona !== undefined) writeFileSync(join(directory, 'persona.md'), persona)
    return directory
  }
  const goodRole = 'toolName: solo\ntitle: Solo\nsummary: A fixture role used only by the checks.\n'
  const persona = 'You are a fixture.\n'

  const rolesRoot = join(fixtureRoot, 'roster')
  mkdirSync(rolesRoot, { recursive: true })
  writeRole(rolesRoot, 'solo', goodRole, persona)
  check(loadRoster(rolesRoot).order.join(',') === 'solo', 'fixture roster should hold exactly one role')

  writeRole(rolesRoot, 'disabled', `${goodRole}enabled: false\n`, persona)
  check(loadRoster(rolesRoot).order.join(',') === 'solo', 'a disabled role must not appear in the roster')

  const duplicateRoot = join(fixtureRoot, 'duplicate')
  mkdirSync(duplicateRoot, { recursive: true })
  writeRole(duplicateRoot, 'one', goodRole, persona)
  writeRole(duplicateRoot, 'two', 'toolName: solo\ntitle: Solo\nsummary: A second fixture role claiming the same name.\n', persona)
  throws(() => loadRoster(duplicateRoot), /declared twice/, 'duplicate toolName')

  const cases = [
    ['no-persona', goodRole, undefined, /no readable persona\.md/],
    ['empty-persona', goodRole, '   \n', /persona\.md is empty/],
    ['bad-name', 'toolName: Not_Kebab\ntitle: X\nsummary: A malformed fixture role with a bad name.\n', persona, /lower-kebab-case/],
    ['filter-empty', `${goodRole}toolFilter:\n  deny: []\n`, persona, /must be a non-empty list/],
    ['filter-neither', `${goodRole}toolFilter:\n  other: [read]\n`, persona, /names neither/],
    ['model-space', `${goodRole}model: "gpt 5"\n`, persona, /must not contain whitespace/],
    ['bad-enabled', `${goodRole}enabled: maybe\n`, persona, /enabled must be a boolean/],
  ]
  for (const [label, yml, body, pattern] of cases) {
    const root = join(fixtureRoot, 'cases', label)
    mkdirSync(root, { recursive: true })
    writeRole(root, 'role', yml, body)
    throws(() => loadRoster(root), pattern, `role fixture ${label}`)
  }

  const allDisabled = join(fixtureRoot, 'all-disabled')
  mkdirSync(allDisabled, { recursive: true })
  writeRole(allDisabled, 'role', `${goodRole}enabled: no\n`, persona)
  throws(() => loadRoster(allDisabled), /no enabled roles/, 'roster with everything disabled')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
check(!existsSync(fixtureRoot), 'temp fixture directory was not removed')

// ------------------------------------------------------------------ surface

const fragment = readFileSync(join(ROOT, 'preset-plugins.yml'), 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('#'))
  .join('\n')
const anchor = `${ROW_INDENT}- id: agent-instructions`
const inherited = fragment.slice(fragment.indexOf(anchor)).replace(/\s+$/, '')
const patched = applySurfaceDelta(inherited, SURFACE_DELTA, 'preset-plugins.yml')

const before = splitRows(inherited)
const after = splitRows(patched)
check(
  after.order.length === before.order.length + SURFACE_DELTA.insert.length,
  `the surface must gain exactly ${SURFACE_DELTA.insert.length} row(s), gained ${after.order.length - before.order.length}`,
)
check(
  after.order.filter((id) => !before.order.includes(id)).join(',') === SURFACE_DELTA.insert.map((row) => row.id).join(','),
  'the only new rows must be the declared insertions',
)
for (const id of after.order) {
  if (before.order.includes(id)) continue
  const expected = `${ROW_INDENT}- id: ${id}\n${FIELD_INDENT}name: ${SURFACE_DELTA.insert.find((row) => row.id === id).name}`
  check(after.rows.get(id).lines.join('\n').trimEnd() === expected, `inserted row "${id}" is not the declared two-line row`)
}
for (const id of before.order) {
  const was = before.rows.get(id)
  const is = after.rows.get(id).lines.join('\n')
  if (SURFACE_DELTA.disable.includes(id)) {
    const flag = `${was.indent}  disabled: true`
    check(is === [was.lines[0], flag, ...was.lines.slice(1)].join('\n'), `row "${id}" must differ only by the added disabled flag`)
  } else {
    check(is === was.lines.join('\n'), `row "${id}" changed but is not in SURFACE_DELTA.disable`)
  }
}

// The emitted preset must carry exactly this surface. The build writes the
// persona row and the skill row, then appends the transformed rows verbatim, so
// a transform that silently did nothing would surface here rather than in a
// session.
const generated = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const marker = '        plugins:\n'
const emitted = generated.slice(generated.indexOf(marker) + marker.length).replace(/\s+$/, '')
check(emitted.includes(`${ROW_INDENT}- id: persona\n`), 'the emitted preset must open its plugin list with the persona row')
check(
  emitted.includes(`${ROW_INDENT}- id: ulanworker\n${FIELD_INDENT}name: dsh-ulanworker\n`),
  'the emitted preset must carry exactly one row for this bundle',
)
check(
  emitted.endsWith(patched),
  'cordis.patch.yml was not generated from the declared surface delta; run `node build.mjs`',
)

// The prompt and the roster are two files that must agree: a role renamed in
// one and not the other would leave the orchestrator naming a role that does
// not exist.
const promptText = readFileSync(join(ROOT, 'prompts', 'sisyphus.md'), 'utf8')
const rolesUsed = [...promptText.matchAll(/role="([a-z][a-z0-9-]*)"/g)].map((match) => match[1])
check(rolesUsed.length >= 8, `the prompt should exercise the roster, found ${rolesUsed.length} role references`)
for (const used of new Set(rolesUsed)) {
  check(roster.roles.has(used), `prompts/sisyphus.md names role "${used}", which is not in the roster`)
}
for (const roleName of roster.order) {
  check(
    rolesUsed.includes(roleName) || promptText.includes(`\`${roleName}\``),
    `role "${roleName}" is in the roster but never mentioned in prompts/sisyphus.md`,
  )
}
const stillEnabled = (id) => !splitRows(patched).rows.get(id).lines.some((line) => line.includes('disabled: true'))
check(stillEnabled('tool-subagent-fork'), 'the prompt tells the model to use subagent_fork, so that row must stay enabled')
check(stillEnabled('tool-subagent-control'), 'the prompt tells the model to use send_message, which that row provides')
check(!stillEnabled('tool-subagent'), 'the shipped delegation tool must be disabled in favour of the role dispatcher')

throws(
  () => applySurfaceDelta(inherited, { disable: ['no-such-row'], insert: [], insertAfter: 'delegation' }, 'fixture'),
  /is not a row of fixture/,
  'delta naming a missing row',
)
throws(
  () => applySurfaceDelta(inherited, { disable: [], insert: [], insertAfter: 'no-such-row' }, 'fixture'),
  /is not a row of fixture/,
  'delta anchored on a missing row',
)
throws(
  () => applySurfaceDelta(inherited, { disable: [], insert: [{ id: 'tool-skill', name: 'x' }], insertAfter: 'delegation' }, 'fixture'),
  /already exists/,
  'delta inserting a duplicate row',
)

if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `\nPASS: ${new Set(registered.map((skill) => skill.name)).size} skills, ${roster.order.length} roles, request shaping, and a surface delta of ` +
    `${SURFACE_DELTA.disable.length} disabled + ${SURFACE_DELTA.insert.length} inserted row(s)`,
)
