/**
 * dsh-ulanworker — bundles the `ultrawork` and `handoff` skills into the Sisyphus
 * agent preset.
 *
 * The skills live beside this module as ordinary `skills/<name>/SKILL.md` files
 * with YAML frontmatter, the same shape `@deepseek-ai/dsh-skill-filesystem`
 * discovers. They are read once at activation and registered as runtime skills
 * through `ctx.skills.register(...)`, which gives them two surfaces at once:
 *
 *  - model-invocable, so they appear in the session skill catalog and load
 *    through the `skill` tool;
 *  - user-invocable, so `/ultrawork` and `/handoff` inject the body directly.
 *
 * Registering from inside the preset keeps the preset self-contained: the
 * bodies travel with the plugin, resolve relative to this module no matter
 * where the bundle directory moves, and outrank the same-named copies a user
 * may have under `$DSH_HOME/skills` for sessions that select the preset.
 *
 * A skill whose frontmatter is missing or malformed is reported and skipped: a
 * half-parsed skill would enter the catalog with an empty routing description
 * and never be selected, which is worse than being visibly absent. The
 * `disable-model-invocation` and `user-invocable` keys are honored with the
 * same spellings the filesystem provider accepts, so a body moved between the
 * two sources keeps its invocation policy.
 *
 * @module dsh-ulanworker
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter } from './yaml-lite.js'

/** Plugin row name; matches the entry in `cordis.patch.yml`. */
export const name = 'dsh-ulanworker'

/** The skill registry this plugin contributes to. */
export const inject = ['skills']

/** Frontmatter keys this loader understands beyond `name`/`description`. */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/** Directory holding one subdirectory per bundled skill. */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills')

/**
 * Register every bundled skill into the calling scope's layer.
 *
 * @param ctx - the plugin context that owns the registration.
 * @param _config - the row's config; this plugin accepts none.
 */
export function apply(ctx, _config) {
  ctx.effect(
    () => {
      const disposers = []
      for (const entry of skillDirectories(SKILLS_DIR)) {
        const directory = join(SKILLS_DIR, entry)
        const file = join(directory, 'SKILL.md')
        const result = buildRegistration(file, directory, entry)
        if (result.warning !== undefined) {
          ctx.logger?.warn?.(`dsh-ulanworker: ${result.warning}`)
          continue
        }
        disposers.push(ctx.skills.register(result.skill))
      }
      return () => {
        while (disposers.length > 0) disposers.pop()()
      }
    },
    'dsh-ulanworker: bundled skills',
  )
}

/**
 * List the skill subdirectories of one root, sorted for a stable order.
 *
 * @param root - absolute path of the bundled skills root.
 * @returns subdirectory names; empty when the root is missing.
 */
function skillDirectories(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Turn one skill file into a registration input.
 *
 * Pure: it reads the file and validates it, and never touches the registry, so
 * a caller can inspect the exact payload a session would receive.
 *
 * @param file - absolute path of the skill's `SKILL.md`.
 * @param directory - absolute path of the skill's own directory.
 * @param fallbackName - directory name, used only in the warning text.
 * @returns exactly one of `skill` or `warning`.
 */
export function buildRegistration(file, directory, fallbackName) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { warning: `cannot read ${file}: ${String(error)}` }
  }

  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) {
    return { warning: `${file} has no YAML frontmatter; skill "${fallbackName}" skipped` }
  }

  const { fields, body } = parsed
  try {
    const invocation = readInvocation(fields)
    const skillName = fields.name
    const description = fields.description
    if (typeof skillName !== 'string' || skillName === '' || typeof description !== 'string' || description === '') {
      return { warning: `${file} needs non-empty name and description; skill "${fallbackName}" skipped` }
    }
    return {
      skill: {
        name: skillName,
        description,
        ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
        ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
        invocation,
        // `runtime` is the registry's own source label; without it the merged
        // candidate would carry an undefined origin and log as "from undefined".
        source: 'runtime',
        path: file,
        resourceBase: { kind: 'directory', path: directory },
        content: body,
      },
    }
  } catch (error) {
    return { warning: `${file} has invalid frontmatter; skill "${fallbackName}" skipped (${String(error)})` }
  }
}

/**
 * Resolve a skill's invocation policy, mirroring the filesystem provider.
 *
 * @param fields - parsed top-level frontmatter fields.
 * @returns the policy the registry will store.
 * @throws when a key uses a spelling the contract rejects.
 */
function readInvocation(fields) {
  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(fields, legacy)) {
      throw new TypeError(`frontmatter field "${legacy}" is unsupported; use "disable-model-invocation" or "user-invocable"`)
    }
  }
  const disableModelInvocation = frontmatterBoolean(fields, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(fields, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * Read one optional boolean frontmatter key.
 *
 * @param fields - parsed top-level frontmatter fields.
 * @param key - the key to read.
 * @returns the boolean, or undefined when the key is absent.
 * @throws when a present value is not one of the accepted spellings.
 */
function frontmatterBoolean(fields, key) {
  if (!Object.hasOwn(fields, key)) return undefined
  const value = fields[key]
  if (value === '1') return true
  if (value === '0') return false
  switch (String(value).toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      throw new TypeError(`frontmatter field "${key}" must be a boolean`)
  }
}

/**
 * Split one Markdown file into its frontmatter fields and its instruction body.
 *
 * @param raw - the whole file.
 * @returns parsed fields plus the body, or undefined without frontmatter.
 */
export { parseFrontmatter }
