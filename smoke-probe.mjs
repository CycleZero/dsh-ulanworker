/**
 * Smoke-test probe: compose one child per role in a live DSH process.
 *
 * `verify.mjs` drives the plugin against a stub context, which cannot catch a
 * role whose `toolFilter` names a tool this deployment does not have:
 * `tools.restrict()` rejects unknown names while the child is being composed,
 * and only a real `ctx.subagents` can say so. This probe exists so that check
 * runs against the real Service.
 *
 * It is not part of the bundle. `smoke.mjs` inserts it into a headless profile
 * through `--patch` alongside the plugin itself, then asks the model to call
 * `role_smoke` and reads the per-role report it returns.
 *
 * @module dsh-ulanworker/smoke-probe
 */

import { appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildChildRequest, loadRoster } from './subagent.js'

/** Plugin row name used by the generated patch. */
export const name = 'ulanworker-smoke'

/** The tool registry and the subagent Service this probe drives. */
export const inject = ['tools', 'subagents']

/** Roster root, resolved beside this module so the probe works from any cwd. */
const ROLES_DIR = fileURLToPath(new URL('./roles/', import.meta.url))

/**
 * Where the report lands. The probe writes it itself rather than trusting the
 * model to echo a result verbatim, which it does not reliably do.
 */
const REPORT_FILE = process.env.DSH_ULANWORKER_SMOKE_REPORT ?? join(tmpdir(), 'dsh-ulanworker-smoke-report.txt')

/**
 * Register the `role_smoke` tool.
 *
 * @param ctx - the context that owns the registration.
 * @param config - the plugin config; `provider` names the subagent backend.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const provider = settings.provider ?? 'spawn'
  const roster = loadRoster(ROLES_DIR)

  ctx.tools.register({
    name: 'role_smoke',
    description:
      'Compose and start one child for every role, returning one line per role. This is a diagnostic used by the bundle smoke test.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, exec) {
      const lines = []
      rmSync(REPORT_FILE, { force: true })
      for (const roleName of roster.order) {
        const role = roster.roles.get(roleName)
        try {
          const request = buildChildRequest(
            role,
            { description: `smoke ${roleName}`, prompt: 'Reply with the single word OK.' },
            exec.agent,
          )
          const started = await ctx.subagents.startContinuable({
            provider,
            label: `smoke ${roleName}`,
            request,
            signal: exec.signal,
          })
          lines.push(`role ${roleName}: OK ${started.childId}`)
        } catch (error) {
          lines.push(`role ${roleName}: FAIL ${String(error?.message ?? error)}`)
        }
      }
      const report = lines.join('\n')
      appendFileSync(REPORT_FILE, `${report}\n`)
      return report
    },
  })
}
