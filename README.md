# dsh-senior-adviser（上级顾问）

一个 **DSH 插件**：把"向远程大模型请教"做成**一次阻塞的 LLM 对话**。

- **不是 agent** —— 不创建 activation，不产生 childId，不碰 `ctx.subagents`
- **不是 subagent** —— 调用方原地等待，没有任何"后台继续"
- **不是 MCP server** —— 没有 stdio、没有子进程、没有快照上传
- **顾问没有手** —— `ctx.llm.stream()` 调用里**省略 `tools`**，模型在协议层没有可调用对象
- **附件可达**（1.2.0 起）—— 会话历史里的用户图片随请求**原样透传**（支持看图的模型直接看到图）；文件渲染成「名称+大小+只读路径」信息行（宿主协议层没有文件通道，见下）

它只做一件事：拦在路中间，**收完整个 stream 才返回**。

## 它解决什么问题

本地 AI 的失败模式不是"不会改"，而是**在信息不足时照样给方案**。这个插件把"我还不能答"变成一等公民：

| `turn_kind` | 顾问被要求 | 顾问被禁止 |
|---|---|---|
| `ask` | 先判断信息够不够 → 不够回 `aligning` + `questions`；够回 `guiding` + `guidance` | 假装已看到执行结果 |
| `report` | **先评估上一轮指导被执行得对不对**，再给下一轮 | 重新从零分析问题；`status` 只允许 `guiding` |

`aligning | guiding` 两态来自原项目（`LZMW/mcp-aurai-server`）的五条原则；本插件只搬设计，不搬代码。

## 安装

```powershell
# 1) 包放进 profile 的 node_modules（与 dsh-role-guard / team-delegate 同位置）
Copy-Item L:\超级工作间\dsh-senior-adviser C:\Users\29493\.dsh\profiles\desktop\node_modules\dsh-senior-adviser -Recurse

# 2) 在 C:\Users\29493\.dsh\profiles\desktop\cordis.patch.yml 末尾加（desktop 无 live reload）
# - insert:
#     - id: senior-adviser            # id 就是设置的命名空间，必须是 senior-adviser
#       name: dsh-senior-adviser      # 包名
#       config:
#         provider: opencode-go
#         model: deepseek-v4.1-flash

# 3) 重启 DeepSeek Harness（desktop profile 不支持 patch 热重载）
```

> ⚠️ **必须用 `- insert:` 建条目**。顶层单独一个 `- id: X` + `name: X` **不会**建出条目（实测）。
> ⚠️ 条目 id 必须是 `senior-adviser`：`SettingsForms` 的 `ns` 就是 profile 条目 id，而包名是 `dsh-senior-adviser`。

## 设置

**设置 → 内置插件 → 「上级顾问」**

| 字段 | 类型 | 来源 / 默认 |
|---|---|---|
| `provider` | 下拉 | `ctx.llm.listProviders()`（经 `remote.llm.listProviders()`） |
| `model` | 下拉 | `remote.session.modelCatalog()`，随 provider 变，**不能手填** |
| `contextWindow` | 只读展示 + 可覆盖 | `resolveModelInfo().context.contextWindow`；覆盖时显示 `已从 <N> 覆盖为 <M>` |
| `maxTokens` | 数字 | 0 = `resolveModelInfo().defaultMaxTokens` |
| `historyTurns` | 数字 | 10（**条数**，不是 token） |
| `reasoningEffort` | 下拉 | 模型元数据 `reasoning.efforts[]`，随模型变化；默认 = 模型默认推理等级（请求里省略该字段） |
| `maxRounds` | 数字 | 8（超限零成本拒绝） |
| `persona` | 文本域 | 五条原则原文；空 = 内置 |

**没有 apiKey 输入框，没有"新建服务商"，不创造模型** —— 这里只挑已经存在的路由。

所有字段都是 `.volatile()`：改完**立刻生效**，不需要重启（`loader/volatile-update`）。

## 工具

```
ask_senior(
  turn_kind: 'ask' | 'report',     # 枚举，必填；非法值在进 execute 之前被参数校验拒绝
  problem?:   string,              # ask 用
  attempted?: { actions[], result, new_error?, feedback? },  # report 用
  attachments?: string[]           # 可选：本地图片绝对路径，插件读取后随请求发送
)
```

返回（字段与 `CONSULT_RESPONSE_SCHEMA` 同构）：

```json
{"status":"aligning|guiding|error","code?":"…","turn_kind":"ask","round":1,
 "route":{"provider":"…","model":"…","contextWindow":1000000,"maxTokens":384000},
 "usage":{…},"questions":[],"analysis":null,"guidance":null,"action_items":[],
 "code_changes":[{"file":"…","line":8,"old":"…","new":"…"}],"verification":null,
 "needs_another_iteration":false,"resolved":false,"requires_human_intervention":false}
```

**结构化降级（永不抛异常打断 agent loop）**：
`NO_PRIOR_GUIDANCE` / `ROUNDS_EXHAUSTED` / `MISSING_INPUT` / `NO_ROUTE` / `ROUTE_UNAVAILABLE` /
`INVALID_JSON` / `EMPTY_RESPONSE` / `PROTOCOL_VIOLATION` / `ALIGNING_WITHOUT_QUESTIONS` /
`GUIDING_WITHOUT_GUIDANCE` / `REPORT_REQUIRES_GUIDING` / `ABORTED` / `PROVIDER_ERROR` / `INTERNAL`

其中 `NO_PRIOR_GUIDANCE`、`ROUNDS_EXHAUSTED`、`MISSING_INPUT`、`NO_ROUTE` 是**本地预检**：0 次 provider 请求。

## 为什么文件只能"信息行"，图片却能真透传

宿主模型请求的模态词表只有 **text + image** 两种（pi-ai `MODALITIES`），用户消息内容转换里
**file 块会被直接丢弃**（`userContent` 的 `default: break`）——整条管线（主会话与插件一致）
不存在"把文件发给模型"的通道。文件到达模型的唯一形态是 dsh-llm `projectFilesToText` 渲染的
「名称+字节+sha256+只读路径」文本行。因此本插件对两种附件的处理是：

| 来源 | 处理 | 到达顾问的形态 |
|---|---|---|
| **`attachments` 参数**（本地 AI 主动指定路径） | 插件用 `node:fs` 读字节 → `attachments.saveImages()` 入库归一化 | 真 image 块，顾问直接看图 |
| 会话历史图片（未卸载） | **原样复制** image 块进请求 | 支持看图的模型收到 base64 内联图；纯文本模型由适配器降级为占位符 |
| 会话历史图片（宿主已卸载） | 渲染占位符 | `[图片已因请求上限被省略：…]` |
| 文件 | 渲染信息行 + 提示顾问可点名索取内容 | `[文件 "名" (N bytes)，只读副本："路径"]` |

**为什么 `attachments` 参数是必要的**：顾问没有工具，看不见任何本地文件。会话历史里的图片只在"用户刚好在聊天里贴过图"时存在；
本地 AI 自己生成的截图/渲染图（如 Puppeteer 截图、生成的图表）无法进入顾问视野。`attachments` 让本地 AI 主动把
任意本地图片路径交给顾问，走的是与浏览器上传完全相同的附件入库路径（`saveImages` 归一化 + 内容寻址）。

非图片路径（pdf/docx/…）不会被发送——宿主协议层没有文件通道，会以一行提示出现在提示词里。

图片上限由宿主管：默认 20MiB base64 / 请求、单图归一化目标约 1MiB / 2048px（`DEFAULT_MAX_REQUEST_IMAGE_BYTES` 等）。

## 不自己算 token

原项目手写 token 预算在 143K–168K 区间 100% 丢上下文，根因是**自己算 token**。本插件的约束：

- 不出现任何 token 估算、压缩、摘要、按长度截断
- 窗口用 `resolveModelInfo()`、超窗由 adapter 报、压缩交给 `dsh-compaction-basic`
- 唯一限制上下文的是 `historyTurns` —— **条数**

## 验证

```powershell
# 一条命令：离线结构 + 行为（28 个用例，真 BlockAssembler / 真 validateJsonSchemaValue）
cd L:\超级工作间\dsh-senior-adviser
node --test test/senior-adviser.test.mjs
# 预期：tests 28 / pass 28 / fail 0
```

> 仓库里的 `node_modules` 是指向 `C:\Users\29493\.dsh\profiles\node_modules` 的 junction
> （插件按名字解析 `@deepseek-ai/dsh-llm` / `dsh-tools` / `schemastery`，与安装到 profile 后一致）。
> 复制进 profile 时**不要**复制这个 junction。

真机两条（隔离 `DSH_HOME`，不碰用户会话）：

```powershell
# 一次性 agent 面：跑一次真实咨询并落会话日志
.\scripts\run-advtest.ps1 -Profile advheadless -Task "调用 ask_senior，turn_kind='ask'，problem='…'"

# Web 面：起设置页（端口 59988），看「设置 → 内置插件 → 上级顾问」
.\scripts\run-advtest.ps1 -Profile advtest -Web -Port 59988

# 把会话日志变成断言用的事实（request/header 计数、call→result 间隔、route、status）
node scripts\analyze-session.mjs "L:\超级工作间\.dsh-advtest\sessions\<workspace>\<session>"
```

> `scripts\run-advtest.ps1` 从你自己的 `.credentials.yaml` 读 key 注入子进程环境，**不打印、不复制**。

desktop 侧自查（重启之后）：

```
设置 → 内置插件 → 上级顾问 → 选 provider/model
新会话里让它调一次 ask_senior
%USERPROFILE%\.dsh\sessions\...\session.v4.jsonl.zstd 里应能看到 ask_senior 在工具列表首位
```

## 已知限制

1. **面板显示的 contextWindow 是"适配器声明值"**，不是 `resolveModelInfo` 的返回值 —— 浏览器侧没有对应 Remote 面（`dsh-llm/lib/typert.remote-client.d.ts` 只暴露 `listProviders/listConfigurableProviders/discoverModels`）。真值由每次 `ask_senior` 的 `route.contextWindow` 回显，两者在本机实测相等。
2. **`SETTINGS_CONFLICT` 在 `- insert:` 挂载的条目上不可用**：`configEditor.edit()` 会追加同 id 的第二条条目，导致 `describe()` 的 revision 不再前进（实测同一 revision 连写两次都被接受）。这是宿主侧缺口，复现步骤见 `02-验收报告.md` #11。
3. **没有结构化输出**：`GenerateOptions` 不支持 JSON schema，协议靠"提示词 + 三级容错解析 + 语义校验"保证，不是协议级强制。
4. **超长 guidance 可能被工具结果剪裁器截断**（8192 字符），导致下一轮取不回原文而退化为 `NO_PRIOR_GUIDANCE`。

## 目录

```
lib/index.js          宿主面：Config + apply + ask_senior（唯一一处 ctx.llm.stream）
lib/client.js         浏览器面：settings.plugins.tab 里的「上级顾问」卡片
lib/types/*.d.ts      两面类型
test/                 28 个离线用例（node --test test/senior-adviser.test.mjs）
scripts/              隔离 profile 启动器 + 会话日志分析器
00-取证.md            源码取证与 U1–U5
01-设计提取.md        5 条设计结论核对 + 开发 profile 选择
02-验收报告.md        21 条断言逐条命令与输出
```


