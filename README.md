# dsh-ulanworker

把 OhMyOpenCode（原 oh-my-opencode）的 **Sisyphus 编排提示词**移植成 DeepSeek Harness 的一个智能体预设，
并把 `ultrawork` 与 `handoff` 两个技能打进同一个插件里。

> 移植正文来自上游 SUL-1.0 许可的项目，本仓库整体按同一许可分发。
> 修改范围与来源见 [NOTICE.md](NOTICE.md)，许可原文见 [LICENSE.md](LICENSE.md)。
>
> 仓库：<https://github.com/CycleZero/dsh-ulanworker> —— 公开仓库。
> 公开分发按 SUL-1.0 的约束进行：免费、非商业用途，并保留 [NOTICE.md](NOTICE.md) 与 [LICENSE.md](LICENSE.md)。

装完之后：

- 新建会话时预设列表里多一个 **Sisyphus**，它的系统提示词就是移植后的 Sisyphus 正文；
- 在 Sisyphus 会话里 `/ultrawork`、`/handoff` 直接可用，也可以被模型通过 `skill` 工具加载；
- 没有覆盖任何出厂预设，`standard` / `ptc` / `minimal` / `cordis` 原样保留。

## 目录

```
dsh-ulanworker/
├── package.json         插件清单（dsh.bundle.patch 指向下面的补丁）
├── build.mjs            生成器：把提示词 + 工具面渲染成 cordis.patch.yml
├── surface-delta.js     声明并施加"与出厂 standard 预设的差异"
├── prompts/sisyphus.md  移植后的系统提示词（唯一正文来源）
├── preset-plugins.yml   工具面：逐字取自出厂 standard 预设
├── cordis.patch.yml     生成物，不要手改
├── index.js             预设内插件：把 skills/ 下的技能注册进 skill 注册表
├── subagent.js          预设内插件：角色化派发工具（替换原生 subagent）
├── yaml-lite.js         两个加载器共用的极简 YAML 解析
├── roles/<name>/
│   ├── role.yml         角色定义：toolName / summary / model / toolFilter
│   └── persona.md       该角色的系统提示词
├── skills/
│   ├── ultrawork/SKILL.md
│   └── handoff/SKILL.md
├── verify.mjs           离线自检：技能、角色、派发请求、工具面差异
└── locale/{zh,en}.json  Plugin Manager 卡片文案
```

## 安装

在本工作区的会话里：

```text
plugin_manager(action="install_bundle",
               target="/home/poyuan/文档/deepseek-harness/default-workspace/dsh-ulanworker")
```

它会把包装进当前 profile 的依赖并选中该 bundle。装完后新开会话即可在预设列表里选 **Sisyphus**。
换 profile（例如 `headless`）需要在该 profile 的会话里重复这一步——插件是按 profile 安装的。

## 改提示词

正文只有 `prompts/sisyphus.md` 一份。改完必须重新生成补丁再重装，否则运行的是旧正文：

```bash
node build.mjs          # 重新生成 cordis.patch.yml
node build.mjs --check  # 只检查补丁是否与正文同步
```

生成器会拒绝三种会让预设静默损坏的输入：正文含 `{{...}}`（persona 的 `prefix` 是模板，会被当变量解析）、
正文含制表符、以及工具面锚点行缺失。

## 这个预设长什么样

| 层 | 内容 |
|---|---|
| `persona.prefix` | 移植后的 Sisyphus 正文，34,411 字符（上游 fallback/default 家族实测 31,457 字符） |
| `persona.suffix` | `Your working directory is {{cwd}}.`，与出厂 `standard` 一致 |
| 工具面 | 与出厂 `standard` 预设逐行相同（bash、read/write/edit、glob/grep、jobs、skill、goal、plan mode、compaction、subagent 全家、ask-user、todo、web、present） |
| 技能 | `ultrawork`、`handoff`，由 `index.js` 以 runtime 技能注册进预设作用域 |

工具面不是手抄的：`preset-plugins.yml` 是从 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
里整块抽出来的，构建时逐字拼进去。这样"提示词里写到的工具"与"会话里真实存在的工具"不会漂移。
校验脚本会断言两者逐行相等（18 行）。

## 移植映射：删掉了什么，换成了什么

上游提示词大量引用 OpenCode 插件专有的东西。原则是**留思想、换机制**：凡是 DSH 没有的一律不出现，
但那条规则想达到的效果必须留下。

| 上游 | DSH 里的处理 | 保留的思想 |
|---|---|---|
| `task(subagent_type=..., load_skills=[...], run_in_background=true)` | `subagent`（fresh）/ `subagent_fork`（继承上下文），后台续用式 | 委派优先、六段式 brief、一次只委派一件事 |
| `task(task_id="ses_...")` 续用 | `send_message` 给同一个子智能体 | 续用省 70% token，绝不为了追问新开一个 |
| `background_output(task_id="bg_...")` / `background_cancel` | 删除。子智能体结束会收到一次结算通知；后台 shell 作业才用 `job_output` / `job_kill` | 绝不轮询、结束回合等通知、绝不留活进程 |
| `oracle` 专家 | `subagent(role="oracle")`：只读 persona + deny 写类工具，见 `<Oracle_Usage>` | 独立第二意见、依赖它的实现必须等它、结果没回来不许交付 |
| `metis` / `momus` / `prometheus` / `plan` | `ask_user_question` 澄清 + 工作区计划文件 + 对抗式 reviewer 子智能体 | 先定性再动手、把计划写下来、计划也要被攻击一遍 |
| `atlas`（待办编排器） | 就是本预设自己 | 用 todo 驱动执行 |
| `explore` / `librarian` 专家 | 直接 `grep`/`glob`/`read` 并行；面太宽时发并行 search 子智能体；外部资料用 `web_search`/`web_fetch` | "委派过的搜索自己不重做"（Anti-Duplication 整节保留） |
| `lsp_diagnostics` | 项目自己的 typecheck / lint / build / test 命令，用 `bash` 跑 | 证据条款：没有干净输出就不算完成 |
| category（visual-engineering / ultrabrain / deep-low…） | 删除。改为 `subagent(role=…)` 选角色 + 在 brief 里点名技能 | 委派前必须评估全部技能、按领域挑执行者 |
| `todowrite` / `TaskCreate` | `todo_write` | 立刻建、立刻标、绝不批量 |
| `apply_patch`、`rg`、`interactive_bash` | `edit`/`write`、`grep` 工具、`bash` + 后台作业 | 用工具做工具的事 |
| `.omo/plans/*.md`、notepad 文件协议 | 换成 `.dsh/plans/*.md` 与 `.dsh/notepad/*.md`，见下节 | 状态落在纸上，不落在上下文里；压缩或丢上下文后先读回自己的笔记再继续 |
| `background_cancel(all=true)` 禁令 | 换成 DSH 的对应禁令：不留后台作业/端口、子智能体未终结不许收尾 | 清理是要留回执的动作 |

另外补了三条 DSH 侧的事实约束，因为不写会误导：

- `workflow` 与 Agent Teams **只在用户明确要求时**才启用，ultrawork 模式本身不构成授权；
- 子智能体的委派深度默认封顶一层，所以 brief 里不能让它再开子智能体；
- 本部署没有 LSP 快捷通道，"诊断"就是项目自己的那条命令。

上游那些**从实时 catalog 渲染**的动态节（工具选型表、委派表、category+技能指南）没有对应物，
移植成静态文本，规则保留、表格按 DSH 的真实工具面重写。

## 角色化派发：`subagent(role=…)`

原生的 `subagent` 工具被**替换**成一个角色化派发工具：它同样是 `ctx.subagents` 的消费者，但多了一张角色表和一次参数映射。主 agent 派发时选的是角色，每个角色带着自己的系统提示词、工具白名单和默认模型出发。

| role | 职责 | toolFilter |
|---|---|---|
| `oracle` | 只读高智商顾问：架构决策、硬调试、自查 | deny `write` `edit` + 委派类 |
| `metis` | 动手前的预规划：必须先把哪些事定下来 | 同上 |
| `momus` | 计划对抗式评审：缺口、假设、不可验证项 | 同上 |
| `plan` | 结构化工作分解：顺序、依赖、并行、验收 | 同上 |
| `explore` | 代码库检索：并行多角度，返回 `path:line` | 同上 |
| `librarian` | 外部检索：官方文档、上游源码、生产实践 | 同上 |
| `looker` | 读图/截图/PDF 并报告内容 | allow `read` `read_image` `glob` `grep` |
| `atlas` | 端到端执行一份写好的计划并留下证据 | 全工具，仅 deny 委派类 |

**模型语义**（每个角色的 `role.yml`）：`model` / `provider` / `reasoningEffort` **留空就跟随主会话**，填了就只用填的那些字段，其余字段仍从主会话继承。

```yaml
# roles/oracle/role.yml
model: ""              # 空 → 请求里根本不带 agentOptions → 继承主会话路由
# model: gpt-5.6-sol   # 非空 → agentOptions: { model: gpt-5.6-sol }
```

这条规则是**结构性的**，不是文档承诺：留空时 `buildChildRequest()` 返回的对象里没有 `agentOptions` 键，`verify.mjs` 直接断言这一点。

改角色只需编辑 `roles/<name>/`，加角色只需新建一个目录（`enabled: false` 可摘掉某个角色而不删文件），然后 `node build.mjs && set_bundle` 关开一次。

### 与出厂工具面的差异是声明式的

`preset-plugins.yml` 逐字来自出厂 `standard` 预设，`surface-delta.js` 声明这唯一的差异：禁用 `tool-subagent`，插入 `ulanworker-subagent`。构建会断言"除了这两行，其余每一行都逐字节未变"，并断言生成物确实来自这份差异。所以"只替换了派发工具、其它一行没动"是**被检查的事实**，不是说法。

### 一个部署约束

以 `link:` 方式装进 profile 的 bundle，其**自身的 import 从工作区解析**——`@deepseek-ai/*` 那些包只在 DSH 安装目录里，加载不到。所以这个工具不走 `defineTool`，直接用 `ctx.tools.register({...})` 注册手写 JSON Schema 的工具，并且不 import 任何 DSH 包。副作用是它也完全不依赖 DSH 内部 API，只有 `ctx.tools` 与 `ctx.subagents` 两个服务接缝。

## 工作状态目录：`.dsh/`

上游把计划写进 `.omo/plans/*.md`，把 notepad 扔进 `mktemp` 临时文件。两者在 DSH 里统一到工作区的
`.dsh/` 下——这个目录本来就已经被 `handoff` 技能用来落盘接续文档（`.dsh/handoff/`），所以是"沿用既有约定"
而不是新发明一个：

| 路径 | 内容 | 谁写 |
|---|---|---|
| `.dsh/plans/<YYYYMMDD-HHmmss>-<slug>.md` | 2 步以上任务的书面计划；todo 是它的实时游标，两者不能互相替代 | 智能体自己 |
| `.dsh/notepad/<YYYYMMDD-HHmmss>-<slug>.md` | 持久 notepad：Plan / Scenarios / Now / Todo / Findings / Learnings，初始化一次后**只追加** | 智能体自己 |
| `.dsh/handoff/` | 用户要交接时由 `handoff` 技能落盘的接续文档 | `handoff` 技能 |

写进提示词的硬规则：

- 有计划文件时，**先写计划文件，再把每一步镜像进 `todo_write`**；
- 发现、决策、跑过的命令、证据文件路径**当场追加**，不留到回合结束；
- 出现压缩提示、历史被摘要、或已经看不到自己前面的步骤时：**先停下重读 notepad 与计划文件**，
  从 `## Now` 续上，不重新规划、不重做已完成的步骤；
- 走不通的路也要留在 `## Learnings` 里——那是接手回合最便宜的一条信息；
- `.dsh/` 是工作状态不是交付物：不提交、不当成果展示、不中途整理。

`## Phase 3 - Completion` 的收尾清单里因此多了一条：计划文件与 notepad 必须与真实发生的事一致。
评估计划时，`Plan saved to .dsh/plans/*.md` 会触发"把该文件路径原样交给 reviewer 子智能体"这条 Key Trigger——
与上游把 `.omo/plans/*.md` 路径交给 Momus 是同一个动作。

## 保真度对照

| 上游结构 | 移植后 |
|---|---|
| `<agent-identity>` | 保留，身份覆盖语义一致 |
| `<Role>` | 保留 |
| `<Behavior_Instructions>` Phase 0 / 1 / 2A / 2B / 2C / 3 | 全部保留，含 Step 1.5 轮次局部意图重置、Step 2.5 上下文完备闸门 |
| `<Oracle_Usage>` | → `<Consultant_Usage>` |
| `.omo/plans/*.md` 计划触发 | → `.dsh/plans/*.md`（路径交给 reviewer 子智能体） |
| notepad 持久草稿协议 | → `.dsh/notepad/*.md`，`<Durable State>` 节 + 收尾清单一条 |
| `<Task_Management>` | 保留 |
| `<Tone_and_Style>` | 逐字保留 |
| `<Constraints>` | 保留 Hard Blocks / Anti-Patterns / Soft Guidelines 三段 |

上游 `default.ts` 里那份是**死代码**（全仓库零调用），线上跑的是 `sisyphus-dynamic-prompt-*` 拼出来的版本，
后者多出 `<agent-identity>` 与 Step 1.5 / Step 2.5 两个闸门。这里按**线上版本**移植，所以比 `default.ts` 更完整。

## 验证状态

已经做到的：

- `install_bundle` 首次返回 `application: applied`、`changed: true`、无 warning；`list_bundles` 显示
  `dsh-ulanworker` `enabled:true, installed:true`，`rows` 里是 `preset-sisyphus`；
- 随后做了一次 `set_bundle enabled=false` → `enabled=true` 往返，两次都 `applied` 且无 warning，
  以强制这一层补丁重新激活，确保磁盘上的 `index.js` 与 `cordis.patch.yml` 就是当前生效的代际；
- `preset-sisyphus` 行在合成配置里存活，状态与出厂预设同为 `schema`，配置满足
  `@deepseek-ai/dsh-agent-preset` 的 schema（`id` + `plugins` 必填）；
- **`dsh --profile web --dump-config` 输出里的 persona `prefix` 反解回来与
  `prompts/sisyphus.md` 逐字节相等（35,978 字符）**——即运行时拿到的正文就是这份文件；
- 同一份 dump 里确认：21 个顶层行、`ulanworker-subagent` 行在、`delegation` 组里原生
  `tool-subagent` `disabled: true`、`tool-subagent-fork` 与 `tool-subagent-control` 仍启用；
- 工具面差异是**声明式且被断言**的：除 `surface-delta.js` 里那一禁一插，其余每一行与出厂
  `standard` 逐字节相同，且生成物确实等于 `applySurfaceDelta(preset-plugins.yml, SURFACE_DELTA)`；
- 补丁 YAML 可解析；生成器自带的块标量反解断言在每次 `node build.mjs` 时都会跑；
  负向对照：往正文里塞一个 `{{cwd}}` 会让构建以非零码退出；
- `node verify.mjs` 通过，四组检查：
  1. **技能**：`name` / `description` / `whenToUse` / `metadata` 全部解析；正文恰好等于去掉
     frontmatter 的正文；`resourceBase` 指向各自目录；`disable-model-invocation` / `user-invocable`
     的拼写与语义与文件系统 provider 一致；缺 frontmatter、缺 description、非法布尔值、旧键名
     四条拒绝路径按预期告警并跳过；
  2. **角色**：8 个角色齐全且排序稳定；每个都有非空 persona（>400 字符）、summary、toolFilter；
     **默认不钉任何模型**；重复 toolName、缺/空 persona、非 kebab 名、空 filter、filter 两项都不写、
     model 含空格、`enabled` 拼错七条畸形角色全部按预期抛错；`enabled: false` 的角色被摘掉；
     全部禁用的花名册报错；
  3. **派发**：用一个桩 `ctx.subagents` **真的跑了一遍注册出来的工具**——断言工具名、必填字段、
     role enum 等于花名册；后台调用返回 `started subagent child-1 (role: oracle)` 且启动 spec 里
     **没有 `agentOptions` 键**；前台调用返回子 agent 文本；`max-tokens` 停止原因变成带部分输出的报错；
     provider 缺 `persona` 能力时**挂载即失败**而不是首次派发才炸；
  4. **工具面 + 提示词一致性**：提示词里 `role="…"` 出现的每个角色都在花名册里，花名册里每个角色
     都在提示词里出现过；提示词依赖的 `subagent_fork` / `send_message` 对应行仍启用，原生
     `tool-subagent` 确实被禁用。临时 fixture 目录已删除；
- 全文审计：移植后的提示词里不再出现 Oracle、lsp_diagnostics、todowrite、background_output、
  `.omo/`、category 名、metis/momus/atlas 等不存在的东西；出现的每个工具名都在 DSH 工具表里；
  计划与 notepad 只落在 `.dsh/` 下。

**我没有验证到的**：预设被选中时真正渲染出的系统提示词，以及会话内的技能目录与 `/ultrawork` 的注入。
预设是按会话选择的，当前会话跑的是 `standard`，无法自我切换。请你这样确认（约 10 秒）：

1. 新开一个会话，在预设选择里选 **Sisyphus**；
2. 问它"你是谁"——应答自己是 Sisyphus；
3. 输入 `/ultrawork` 或 `/handoff`——应直接注入技能正文；
4. 让主 agent 派一次活（例如"用 explore 找一下 X 在哪"）——工具表里应只有**一个** `subagent`，
   带 `role` 枚举，且它能返回一个子 agent id。

任何一步不对，把现象告诉我，我按 `--dump-config` 与插件日志继续查。

### 重复安装会怎样

对已安装的 bundle 再跑一次 `install_bundle` 会返回 `application: failed` 且 `error.code` 为
`ambiguous-install`。这不是损坏：pnpm 报告无变化后，管理器无法从前后依赖差异里认出"这次装的是谁"，
于是一路回滚（`changed: false`）。已装状态不变，`list_bundles` 仍是 `enabled/installed`。
改了 `index.js` 想要新代际时，用 `set_bundle` 关一次再开一次，比重复 install 干净。


## 已知取舍

- 技能正文在插件里有一份副本，与 `~/.dsh/skills/` 下的同名技能并存。在 Sisyphus 会话里 runtime 注册优先；
  改技能时注意**两处**，否则会出现"改了没生效"。
- `preset-plugins.yml` 是出厂 `standard` 预设的快照。DSH 升级后若要同步工具面，需要重新抽取一次。
- 提示词正文保留英文（上游原文即英文，"尽可能还原"优先于翻译）。
- 角色 persona 是**重写**而非逐字移植：OmO 的 oracle 单文件 28 KB、metis 21 KB，逐字搬会把 DSH 没有的
  工具写进子 agent 的指令里。这里保留的是角色契约（职责、必须/禁止、输出形状、工具纪律），每个约 1.7–2.4 KB。
- 派发工具**不暴露** `provider` / `model` / `reasoning_effort` 三个按次参数：那属于 Host 的
  `subagent-model-selection` 策略，其执行代码没有导出，自己实现等于绕过用户的 allowlist。
  要按次选模型就去开那个 Host 设置；要按角色钉模型就写 `role.yml`。
- 角色子 agent **不能再委派**（Host 委派深度默认 1），所以 `atlas` 是执行者而不是二级编排者。
