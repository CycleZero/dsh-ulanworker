/**
 * The declared difference between this preset's tool surface and the shipped
 * `standard` preset's.
 *
 * `preset-plugins.yml` is lifted verbatim from `@deepseek-ai/dsh-web-app`'s
 * `presets/standard.patch.yml`, which is what makes "this preset exposes the
 * shipped tools plus a named replacement" a checked fact: every row is copied
 * byte for byte, and the only rows this module touches are the ones listed
 * below. Naming a row that does not exist is a build failure, not a silent
 * no-op.
 *
 * @module dsh-ulanworker/surface-delta
 */

/** @type {{ disable: string[], insert: { id: string, name: string }[], insertAfter: string }} */
export const SURFACE_DELTA = {
  /** The shipped delegation tool this bundle replaces with its role dispatcher. */
  disable: ['tool-subagent'],
  /** Rows inserted after the anchor: this bundle's single plugin entry. */
  insert: [{ id: 'ulanworker', name: 'dsh-ulanworker' }],
  /**
   * Sibling the replacement is inserted after. The `delegation` group holds the
   * replaced row, but the replacement lands as a top-level preset row: the group
   * isolates `workflowEngine`, and this tool needs no part of that.
   */
  insertAfter: 'delegation',
}

/** Indentation of a top-level row's `- id:` line. */
const ROW_INDENT = '          '
/** Indentation of a key inside a top-level row. */
const FIELD_INDENT = `${ROW_INDENT}  `

/**
 * Split a preset plugin list into its rows.
 *
 * Rows nest (the `delegation` and `compaction` groups hold their own lists), so
 * every `- id:` line counts as a row regardless of depth, and each row records
 * its own indentation for later rewriting.
 *
 * @param text - the plugin list.
 * @returns row ids in order, plus each row's indent and lines.
 */
export function splitRows(text) {
  const rows = new Map()
  const order = []
  let current
  for (const line of text.split('\n')) {
    const match = /^(\s*)- id: (\S+)$/.exec(line)
    if (match !== null) {
      current = { id: match[2], indent: match[1], lines: [line] }
      order.push(match[2])
      rows.set(match[2], current)
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  return { rows, order }
}

/**
 * Disable the replaced rows and insert the replacement rows.
 *
 * @param text - the inherited plugin list.
 * @param delta - the declared difference.
 * @param source - file name, for error messages.
 * @returns the transformed list.
 * @throws when a named row is missing or a row id repeats.
 */
export function applySurfaceDelta(text, delta, source = 'preset-plugins.yml') {
  const { rows, order } = splitRows(text)
  for (const id of delta.disable) {
    if (!rows.has(id)) throw new Error(`SURFACE_DELTA disables "${id}", which is not a row of ${source}`)
  }
  if (!rows.has(delta.insertAfter)) {
    throw new Error(`SURFACE_DELTA inserts after "${delta.insertAfter}", which is not a row of ${source}`)
  }
  for (const row of delta.insert) {
    if (rows.has(row.id)) throw new Error(`SURFACE_DELTA inserts "${row.id}", which already exists in ${source}`)
  }
  if (new Set(order).size !== order.length) throw new Error(`${source} repeats a row id`)

  // A group row owns every following row indented deeper than it, so the
  // insertion point is after that whole subtree — never between a group's
  // `config:` key and its children.
  const anchorIndex = order.indexOf(delta.insertAfter)
  const anchorIndent = rows.get(delta.insertAfter).indent.length
  let insertAt = anchorIndex + 1
  while (insertAt < order.length && rows.get(order[insertAt]).indent.length > anchorIndent) insertAt += 1

  const insertedBlock = delta.insert
    .map((row) => `${ROW_INDENT}- id: ${row.id}\n${FIELD_INDENT}name: ${row.name}`)
    .join('\n')

  const blocks = order.map((id) => {
    const row = rows.get(id)
    if (!delta.disable.includes(id)) return row.lines.join('\n')
    const [head, ...rest] = row.lines
    return [head, `${row.indent}  disabled: true`, ...rest].join('\n')
  })
  blocks.splice(insertAt, 0, insertedBlock)
  return blocks.join('\n').replace(/\s+$/, '')
}
