# NOTICE

## What this is

`dsh-ulanworker` is a **DeepSeek Harness (DSH) plugin** that adds one agent preset —
**Sisyphus** — and bundles two skills, `ultrawork` and `handoff`.

The preset's system prompt is a **port**, not a copy: it is derived from the
Sisyphus orchestrator prompt of **oh-my-opencode / oh-my-openagent** and rewritten
against DSH's real tool surface.

## Upstream

| | |
|---|---|
| Project | oh-my-openagent (formerly oh-my-opencode) |
| Repository | https://github.com/code-yeongyu/oh-my-openagent |
| Version read | v5.1.32, branch `dev` |
| Files consulted | `packages/omo-opencode/src/agents/sisyphus/*`, `agents/dynamic-agent-*.ts`, `agents/sisyphus-agent-factory.ts`, `plugin/system-transform.ts`, `hooks/keyword-detector/*`, `packages/prompts-core/prompts/ultrawork/*` |
| License | Sustainable Use License 1.0 (SUL-1.0) — see [LICENSE.md](LICENSE.md) |

This project is **not affiliated with, endorsed by, or sponsored by** the upstream
project or its author. All upstream names belong to their respective owners.

## Scope of modification

Derived from upstream (modified):

- `prompts/sisyphus.md` — the ported Sisyphus system prompt. Section structure,
  wording and ordering follow upstream's shipped `fallback` (Claude-family)
  builder, which is what actually runs upstream. Modified by:
  - replacing OpenCode-plugin-only surfaces (`task(subagent_type=…)`,
    `background_output`, `bg_`/`ses_` ids, `lsp_diagnostics`, `apply_patch`,
    the `oracle`/`metis`/`momus`/`atlas` subagents, the category system,
    `.omo/plans/*.md` and the notepad `mktemp` protocol) with DSH equivalents
    (`subagent`, `subagent_fork`, `send_message`, `job_output`/`job_kill`,
    `todo_write`, the project's own typecheck/lint/test commands, read-only
    consultant subagents, `.dsh/plans/` and `.dsh/notepad/`);
  - adding a `### Durable State: Plan File & Notepad` section and one
    completion-checklist item;
  - dropping content with no DSH counterpart rather than inventing a target
    for it.
- `preset-plugins.yml` — the tool rows, lifted verbatim from the shipped
  `standard` preset of `@deepseek-ai/dsh-web-app`, which is part of DeepSeek
  Harness, not of the upstream project.

Original to this project:

- `index.js` — the skill loader (frontmatter parsing, invocation policy,
  registration).
- `build.mjs` — the patch generator, including the block-scalar round-trip
  assertion.
- `verify.mjs` — the offline checks.
- `package.json`, `locale/*.json`, `cordis.patch.yml` (generated), this notice.

The two bundled skills (`skills/ultrawork/SKILL.md`, `skills/handoff/SKILL.md`)
are the author's own DSH-targeted work, themselves ported from upstream's
ultrawork directive and `/handoff` command template; they are covered by the
same license notice as the prompt.

## License of this repository

Because it distributes a derivative of SUL-1.0 content, the repository as a whole
is offered under the same terms: **Sustainable Use License 1.0** — personal,
internal-business, or otherwise non-commercial use, and redistribution only free
of charge for non-commercial purposes, with this notice and `LICENSE.md`
preserved. See [LICENSE.md](LICENSE.md) for the binding text.
