/**
 * The subset of YAML this bundle reads, in one place.
 *
 * Both loaders — the skill bodies in `skills/<name>/SKILL.md` and the role
 * definitions in `roles/<name>/role.yml` — need the same thing: top-level
 * `key: value` scalars, one nested map of the same shape, inline flow
 * sequences (`[a, b]`), and single- or double-quoted strings. Pulling in a real
 * YAML dependency for that would add a package to a bundle that otherwise has
 * none, so this module is the whole parser and it refuses everything it does
 * not understand rather than guessing.
 *
 * @module dsh-ulanworker/yaml-lite
 */

/** Keys that introduce a nested map when their value is empty. */
const BLOCK_KEY = /^([A-Za-z0-9_-]+):\s*$/
/** A scalar entry, at either indentation level. */
const ENTRY = /^[ \t]*([A-Za-z0-9_-]+):[ \t]*(.*)$/

/**
 * Parse the supported subset into a plain object.
 *
 * @param text - the document body, without frontmatter fences.
 * @returns top-level fields; a nested block becomes an object of its own.
 */
export function parseSimpleYaml(text) {
  const fields = {}
  let nestedKey
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indented = /^[ \t]/.test(line)
    const match = ENTRY.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = match[2].trim()
    if (!indented) {
      if (value === '' && BLOCK_KEY.test(line)) {
        nestedKey = key
        fields[key] = {}
        continue
      }
      nestedKey = undefined
      fields[key] = parseScalar(value)
      continue
    }
    if (nestedKey !== undefined && typeof fields[nestedKey] === 'object' && fields[nestedKey] !== null) {
      fields[nestedKey][key] = parseScalar(value)
    }
  }
  return fields
}

/**
 * Split a Markdown file into its YAML frontmatter fields and its body.
 *
 * @param raw - the whole file.
 * @returns parsed fields plus the body, or undefined when the file has no
 *   frontmatter block or never closes it.
 */
export function parseFrontmatter(raw) {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return undefined

  return {
    fields: parseSimpleYaml(lines.slice(1, end).join('\n')),
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  }
}

/**
 * Read one scalar: a flow sequence, a quoted string, or a plain value.
 *
 * @param value - the raw scalar text, already trimmed.
 * @returns the parsed value.
 */
export function parseScalar(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((entry) => unquote(entry.trim()))
  }
  return unquote(value)
}

/**
 * Strip one layer of YAML quoting from a scalar.
 *
 * @param value - the raw scalar text.
 * @returns the unquoted value.
 */
export function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}
