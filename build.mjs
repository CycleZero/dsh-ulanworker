/**
 * Generate `cordis.patch.yml` for the Sisyphus bundle.
 *
 * Two inputs, one output:
 *
 *  - `prompts/sisyphus.md` is the ported system prompt, kept as plain Markdown
 *    so it can be read, diffed and reviewed like any other document.
 *  - `preset-plugins.yml` is the tool surface, lifted verbatim from the shipped
 *    `standard` preset so this preset exposes exactly the same tools as the
 *    deployment's default agent and nothing more.
 *
 * The prompt is embedded as a YAML literal block scalar (`|-`), which performs
 * no escaping at all: backticks, quotes, `!!`, and XML tags all survive
 * verbatim. The only rule the generator enforces is that the prompt contains no
 * `{{...}}` group, because `@deepseek-ai/dsh-persona` renders its `prefix` as a
 * template and would resolve such a group against registered prompt variables.
 *
 * Run `node build.mjs` after editing either input, then reinstall the bundle.
 * `node build.mjs --check` regenerates in memory and exits non-zero when the
 * committed patch is stale.
 *
 * @module dsh-ulanworker/build
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SURFACE_DELTA, applySurfaceDelta } from './surface-delta.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PROMPT_FILE = join(ROOT, 'prompts', 'sisyphus.md')
const PLUGINS_FILE = join(ROOT, 'preset-plugins.yml')
const OUTPUT_FILE = join(ROOT, 'cordis.patch.yml')

/** Row id of the preset declaration; the Loader convention is `preset-<id>`. */
const ROW_ID = 'preset-sisyphus'
/** Roster position; ids 1-4 are the shipped web presets. */
const ORDER = 5
/** The first row of the inherited tool surface, right after the persona row. */
const SURFACE_ANCHOR = '          - id: agent-instructions'
/** Indentation of the persona `prefix:` key line. */
const KEY_INDENT = '              '
/** Indentation of the block scalar's content; one two-space level deeper. */
const CONTENT_INDENT = `${KEY_INDENT}  `

const prompt = readPrompt()
const surface = readSurface()
const patch = render(prompt, surface)
assertBlockScalarRoundTrips(patch, prompt)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUTPUT_FILE, 'utf8')
  } catch {
    console.error('cordis.patch.yml is missing; run `node build.mjs`')
    process.exit(1)
  }
  if (current !== patch) {
    console.error('cordis.patch.yml is stale; run `node build.mjs`')
    process.exit(1)
  }
  console.log('cordis.patch.yml is up to date')
  process.exit(0)
}

writeFileSync(OUTPUT_FILE, patch)
console.log(`wrote cordis.patch.yml (${patch.length} chars, prompt ${prompt.length} chars)`)

/**
 * Read and validate the ported prompt.
 *
 * @returns the prompt text, without its trailing newline.
 */
function readPrompt() {
  const raw = readFileSync(PROMPT_FILE, 'utf8').replace(/\r\n/g, '\n')
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (text.trim() === '') throw new Error(`${PROMPT_FILE} is empty`)
  if (text.includes('{{')) {
    throw new Error(
      `${PROMPT_FILE} contains a "{{...}}" group; the persona prefix is a template and would resolve it. Escape or reword it.`,
    )
  }
  if (text.includes('\t')) throw new Error(`${PROMPT_FILE} contains a tab; YAML block scalars require spaces`)
  if (/^[ \t]*#/m.test(text.split('\n')[0] ?? '')) {
    throw new Error(`${PROMPT_FILE} starts with a YAML comment; the first line would be swallowed by the block scalar header`)
  }
  return text
}

/**
 * Read the inherited tool surface, split off its persona row, and apply the
 * declared delta.
 *
 * The persona row differs by preset, so it is regenerated; everything from the
 * first real tool row onward is copied byte for byte, then exactly the rows in
 * {@link SURFACE_DELTA} are disabled or inserted. Any other difference is a
 * build failure, which is what keeps "this preset has the shipped tool surface
 * plus a named replacement" a checked fact rather than a claim.
 *
 * @returns the surface rows this preset ships.
 */
function readSurface() {
  const raw = readFileSync(PLUGINS_FILE, 'utf8').replace(/\r\n/g, '\n')
  const body = raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
  const index = body.indexOf(SURFACE_ANCHOR)
  if (index === -1) {
    throw new Error(`${PLUGINS_FILE} does not contain the expected anchor row "${SURFACE_ANCHOR.trim()}"`)
  }
  return applySurfaceDelta(body.slice(index).replace(/\s+$/, ''), SURFACE_DELTA, PLUGINS_FILE)
}

/**
 * Prove the emitted block scalar decodes back to the prompt.
 *
 * A YAML literal block scalar strips exactly the block's own indentation, so
 * removing that prefix from every non-empty line of the emitted block must
 * reproduce the input byte for byte. This catches the one failure that would
 * otherwise stay invisible until a session rendered a truncated persona.
 *
 * @param patchText - the rendered patch document.
 * @param promptText - the prompt it was rendered from.
 */
function assertBlockScalarRoundTrips(patchText, promptText) {
  const lines = patchText.split('\n')
  const header = lines.findIndex((line) => line === `${KEY_INDENT}prefix: |-`)
  if (header === -1) throw new Error('rendered patch has no persona block scalar header')
  const block = []
  for (const line of lines.slice(header + 1)) {
    if (line === '') {
      block.push('')
      continue
    }
    if (!line.startsWith(CONTENT_INDENT)) break
    block.push(line.slice(CONTENT_INDENT.length))
  }
  while (block.length > 0 && block[block.length - 1] === '') block.pop()
  const decoded = block.join('\n')
  if (decoded !== promptText) {
    const at = [...decoded].findIndex((char, index) => char !== promptText[index])
    throw new Error(
      `persona block scalar does not round-trip: decoded ${decoded.length} chars vs prompt ${promptText.length} chars, first difference at ${at}`,
    )
  }
}

/**
 * Render the whole patch document.
 *
 * @param promptText - the validated Sisyphus prompt.
 * @param surfaceRows - inherited tool rows, already indented for a preset list.
 * @returns the patch YAML.
 */
function render(promptText, surfaceRows) {
  const block = promptText
    .split('\n')
    .map((line) => (line === '' ? '' : `${CONTENT_INDENT}${line}`))
    .join('\n')

  return `# Generated by build.mjs from prompts/sisyphus.md and preset-plugins.yml.
# Do not edit by hand: edit the prompt, run \`node build.mjs\`, then reinstall
# the bundle so the preset revision picks up the new body.
#
# The bundle inserts one agent preset declaration. It overrides no shipped row,
# so \`standard\`, \`ptc\`, \`minimal\` and \`cordis\` are untouched and remain
# selectable; "Sisyphus" simply appears beside them on the roster.
- insert:
    - id: ${ROW_ID}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: sisyphus
        name: Sisyphus
        description: Orchestration agent ported from OhMyOpenCode's Sisyphus, with the ultrawork and handoff skills bundled.
        order: ${ORDER}
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
${block}
              suffix: Your working directory is {{cwd}}.
          - id: ulanworker-skills
            name: dsh-ulanworker
${surfaceRows}
`
}
