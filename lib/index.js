// dsh-senior-adviser — "上级顾问": one blocking LLM consult, not an agent.
//
// It is deliberately NOT:
//   * an agent / subagent (no subagent runtime, no activation, no child id),
//   * a tool-using model (ctx.llm.stream() is called WITHOUT `tools`),
//   * a context manager (no token math, no truncation, no summarization),
//   * a state store (session history IS the state; settings live in the profile).
//
// The single branch point is the contract paragraph appended to the persona:
// `turn_kind: 'ask'` -> judge sufficiency, then reflect (aligning) or advise
// (guiding); `turn_kind: 'report'` -> grade the previous guidance first.
//
// Shape of the one-shot call is copied from the only official precedent,
// @deepseek-ai/dsh-compaction-basic/lib/index.js:312-326 (BlockAssembler +
// `for await` over ctx.llm.stream + explicit finish check).

import z from '@deepseek-ai/schemastery'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'

const name = 'dsh-senior-adviser'
const inject = ['llm', 'tools', 'attachments', 'fs']

const TOOL_NAME = 'ask_senior'

// ── persona ───────────────────────────────────────────────────────────────
// The five principles are the original SYSTEM_PROMPT's five, with every
// MCP-only sentence removed: `sync_context` does not exist here, and the
// consultant has no way to "upload" anything, so the honest statement is that
// its information surface is exactly this request plus the transcript.
const PRINCIPLES = `你是远程技术顾问，协助本地 AI 排查编程问题。

**你的信息面**：你只能看到本地 AI 这一次请求里给你的内容（problem / attempted），
以及下面附带的最近若干轮对话文本。你没有文件系统、终端、网络检索或任何工具——
你既无法自己去看代码，也无法执行任何东西。凡是对话记录与本次请求里没有出现过的
文件内容、配置项、版本号、环境事实，一律视为**未知**。

**取舍**：这些原则偏向严谨而非速度。对于 trivial 问题，用你自己的判断。

## 1. 只基于已有信息判断

**你看到什么就基于什么。不要猜你没看到的东西。**

- 请求里给了代码或报错 → 引用它，指出具体位置。
- 没给的文件路径、配置项、环境信息 → 不要假设它们存在。问。
- 如果根因可能在你看不到的代码里 → 列出可疑方向，要求对方把对应片段贴上来。
- 不要说"检查你的 package.json"如果 package.json 没在对话里出现——先要到它。

## 2. 信息不全不给方案

**不要猜。不要假设。缺信息就先问。**

- 没有具体错误信息 → 问。没有相关代码 → 要求贴出来。
- 如果问题有多种可能根因，列出它们——不要默默挑一个开始指导。
- 5W1H 缺口检查：What（什么现象）When（何时触发）Where（哪个文件）How（如何复现）
- 别给出基于"可能是 X"的猜测性方案。确认了再给。

## 3. 最小可执行指导

**基于已看到的内容给出具体修改。不画饼。不写教科书。**

- 有代码 → 给具体 diff（old/new），文件用对话里出现过的那个名字。
- 没有代码 → 说清楚改哪个文件的哪段逻辑，让对方去定位行号。
- 不要建议安装新库/新工具，除非问题只能用它们解决。
- 不要建议"考虑重构"——对方不是来听架构建议的。

自问："本地 AI 拿着我的指导能不能直接改代码？" 如果不能，重写。

## 4. 承认边界

**不知道就说不知道。解决不了就交给人。**

- 问题超出代码层面（硬件、网络、权限、第三方服务）→ requires_human_intervention=true
- 连续两轮同一方向没进展 → 换个思路，或 requires_human_intervention=true
- 不要编造不存在的 API、配置项、文件路径
- 不确定的结论前面加"推测: "，不要当事实陈述`

const PROTOCOL = `## 输出格式

只输出一个 JSON 对象，不要包裹解释文字，不要用 Markdown 代码围栏。两种模式字段完全一致：

[模式 A: aligning — 信息不足，需要反问]
{"status":"aligning","questions":["具体问题1——说清楚要什么文件或信息","具体问题2"],"analysis":null,"guidance":null,"action_items":[],"code_changes":[],"verification":null,"needs_another_iteration":true,"resolved":false,"requires_human_intervention":false}

[模式 B: guiding — 信息充足，给出指导]
{"status":"guiding","questions":[],"analysis":"根因分析","guidance":"解决步骤","action_items":["步骤1","步骤2"],"code_changes":[{"file":"对话里出现过的文件名","line":42,"old":"一字不差摘取的原文","new":"修改后的代码"}],"verification":"如何确认修好了","needs_another_iteration":false,"resolved":false,"requires_human_intervention":false}

**字段约束**
- questions：反问要具体——"请贴出 X 文件的 Y 函数"而不是"请提供更多信息"
- code_changes.file：只能用对话里出现过的或对方明确提到的文件名，不要编造
- code_changes.old：必须从对话内容中一字不差摘取，不要臆造
- analysis：2-4 句话说清根因
- guidance：像 code review comment
- verification：不知道项目的测试命令时，描述验证逻辑让对方执行`

// The ONLY branch point of the whole plugin.
const CONTRACT_ASK = `## 本轮契约（turn_kind = ask）

先判断信息够不够，再决定这一轮的角色：

- 不够 → \`status="aligning"\`，questions 列出你实际缺的东西，guidance 必须为 null。
- 够 → \`status="guiding"\`，给可执行的最小方案。

**禁止**：假装已经看到执行结果；假设对方已经改过、跑过、报过错。你没有执行记录，
只有对方写下来的文字。`

const CONTRACT_REPORT = `## 本轮契约（turn_kind = report）

对方已经按你的上一轮指导动过手，现在回来汇报。顺序不能反：

1. **先评估上一轮指导被执行得对不对**——逐条对照你上一轮的 action_items / code_changes
   与下面 attempted 里写明的 actions / result / new_error / feedback。指出偏差
   （改错了、改漏了、改了别处、没按顺序验证）。
2. **再给下一轮**指导。

**禁止**：把问题重新从零分析一遍；无视 attempted 直接给新方案。
**status 只允许 \`guiding"\`**——即使信息还不够，也要在 guidance 里说明缺什么、要求补什么，
而不是退回 aligning。问题确实解决了就把 resolved 置为 true 并说明验证依据。`

// ── response schema (same field set as the original CONSULT_RESPONSE_SCHEMA) ──
const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }] }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['aligning', 'guiding', 'error'] },
    code: { type: 'string' },
    message: { type: 'string' },
    turn_kind: { type: 'string' },
    round: { type: 'number' },
    route: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        contextWindow: { type: 'number' },
        maxTokens: { type: 'number' }
      }
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        totalTokens: { type: 'number' },
        cacheReadTokens: { type: 'number' },
        cacheWriteTokens: { type: 'number' },
        reasoningTokens: { type: 'number' }
      }
    },
    questions: { type: 'array', items: { type: 'string' } },
    analysis: nullableText,
    guidance: nullableText,
    action_items: { type: 'array', items: { type: 'string' } },
    code_changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          old: { type: 'string' },
          new: { type: 'string' }
        }
      }
    },
    verification: nullableText,
    needs_another_iteration: { type: 'boolean' },
    resolved: { type: 'boolean' },
    requires_human_intervention: { type: 'boolean' }
  }
}

const Config = z.object({
  provider: z.string().default('').volatile().description('顾问模型的服务商路由 id，空 = 跟随调用方'),
  model: z.string().default('').volatile().description('顾问模型 id，空 = 跟随调用方'),
  contextWindow: z
    .number()
    .min(0)
    .max(20000000)
    .default(0)
    .volatile()
    .description('0 = 使用 resolveModelInfo 返回的窗口；>0 = 覆盖（面板会显示 已从 N 覆盖为 M）'),
  maxTokens: z
    .number()
    .min(0)
    .max(1000000)
    .default(0)
    .volatile()
    .description('0 = 使用 resolveModelInfo 的 defaultMaxTokens'),
  historyTurns: z.number().min(0).max(100).default(10).volatile().description('附带多少轮会话历史（条数，不是 token）'),
  reasoningEffort: z
    .string()
    .default('')
    .volatile()
    .description('推理等级 id，空 = 模型默认（不传 reasoningEffort）；取值来自模型元数据 reasoning.efforts[].id'),
  maxRounds: z.number().min(1).max(50).default(8).volatile().description('一次咨询最多几轮，超限零成本拒绝'),
  persona: z.string().default('').volatile().description('五条原则原文；空 = 使用内置')
})

// ── small helpers ─────────────────────────────────────────────────────────
function read(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    const inner = value.get()
    return inner === undefined || inner === null ? fallback : inner
  }
  return value
}

function strArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0)
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Brace-balanced object extraction: the last-resort tolerant parse (U2). */
function firstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Three-stage tolerant parse; `undefined` means "not an object at all". */
function parseProtocol(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim()
  const candidates = [raw]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null && fenced[1] !== undefined) candidates.push(fenced[1].trim())
  const balanced = firstBalancedObject(raw)
  if (balanced !== undefined) candidates.push(balanced)
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const parsed = safeParse(candidate)
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  return undefined
}

// ── session-derived state (the host session log IS the storage) ────────────
/**
 * Walk the derived history once and answer: how many `ask_senior` calls this
 * session already made, and what the last protocol result said.
 * No cache, no file, no token math — just the host's own projection.
 *
 * Two result carriers are accepted because both exist in the durable log: a
 * first-class tool-role message (`{role:'tool', toolCallId, content}` — what
 * this build derives, see dsh-llm/message.d.ts:152-157) and, defensively, a
 * `tool-result` block inside a user message (the shape some projections carry).
 */
function scanSession(session) {
  const state = { calls: 0, lastGuidance: null, lastStatus: null }
  if (session === undefined || session === null || typeof session.deriveMessages !== 'function') return state
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return state
  }
  const absorb = (text) => {
    const parsed = parseProtocol(text)
    if (parsed === undefined || (parsed.status !== 'aligning' && parsed.status !== 'guiding')) return
    state.lastStatus = parsed.status
    if (parsed.status === 'guiding' && typeof parsed.guidance === 'string' && parsed.guidance.length > 0) {
      state.lastGuidance = parsed.guidance
    }
  }
  for (const message of messages) {
    if (message === null || message === undefined) continue
    const content = message.content
    if (!Array.isArray(content)) continue
    if (message.role === 'tool') {
      absorb(textOf(content))
      continue
    }
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'tool-call' && block.name === TOOL_NAME) {
        state.calls += 1
        continue
      }
      if (block.type === 'tool-result') absorb(textOf(block.content))
    }
  }
  return state
}

/** Image media types the host attachment store accepts (dsh-attachment-local). */
const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * Turn caller-supplied image paths into durable image blocks the request can
 * carry.
 *
 * Why the plugin reads the bytes itself: `ctx.fs` is an abstract provider
 * (watch / processPathFromHostPath / sandboxMode only — see
 * dsh-fs/lib/index.js) and exposes no read, while this plugin already runs in
 * the host Node process. So the bytes come from `node:fs/promises` and are
 * committed through the SAME store the browser upload path uses
 * (`attachments.saveImages`), which normalizes and content-addresses them.
 *
 * @returns durable image blocks, plus one text line per rejected path.
 */
async function loadImageAttachments(paths, attachments) {
  const blocks = []
  const problems = []
  for (const raw of paths) {
    const path = String(raw).trim()
    if (path.length === 0) continue
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    const mediaType = IMAGE_MEDIA_TYPES[ext]
    if (mediaType === undefined) {
      problems.push('[图片未发送：' + JSON.stringify(path) + ' 不是支持的图片格式（png/jpg/jpeg/webp/gif）]')
      continue
    }
    let data
    try {
      data = new Uint8Array(await readFile(path))
    } catch (error) {
      problems.push('[图片未发送：读取 ' + JSON.stringify(path) + ' 失败（' + (error instanceof Error ? error.message : String(error)) + '）]')
      continue
    }
    try {
      const refs = await attachments.saveImages([{ data, mediaType, name: path.slice(path.lastIndexOf('/') + 1).slice(path.lastIndexOf('\\') + 1) }])
      const ref = refs[0]
      if (ref === undefined) {
        problems.push('[图片未发送：' + JSON.stringify(path) + ' 存储未返回引用]')
        continue
      }
      blocks.push({ type: 'image', attachment: ref })
    } catch (error) {
      problems.push('[图片未发送：' + JSON.stringify(path) + ' 入库失败（' + (error instanceof Error ? error.message : String(error)) + '）]')
    }
  }
  return { blocks, problems }
}

/**
 * Attachment surfaces extracted from the derived history.
 *
 * Images: durable image blocks from the retained window, in message order.
 * They are copied VERBATIM into the consult request's user content, so the
 * host's own projection re-reads the normalized copies through the attachments
 * service and inlines them for models that accept image input; a text-only
 * consultant model degrades to placeholders at the adapter boundary. Blocks
 * already offloaded by the host (`offloaded === true`) render as placeholders.
 *
 * Files: the host protocol has NO file channel to the model (pi-ai's
 * MODALITIES are text+image only, and `userContent` drops file blocks), so a
 * file reaches the consultant only as an information line naming it, its size,
 * and its read-only stored path — the local AI (which has file tools) is
 * responsible for relaying the contents.
 */
function attachmentSurfaces(messages, resolveFilePath) {
  const images = []
  const fileLines = []
  if (!Array.isArray(messages)) return { images, fileLines }
  const imageRefOf = (ref) =>
    ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string'
      ? null
      : { type: 'image', attachment: ref }
  const fileLineOf = (ref) => {
    if (ref === null || typeof ref !== 'object' || typeof ref.name !== 'string') return null
    const bytes = typeof ref.bytes === 'number' && Number.isFinite(ref.bytes) ? ref.bytes : null
    const path = typeof resolveFilePath === 'function' ? resolveFilePath(ref) : undefined
    const size = bytes === null ? '' : ' (' + bytes + ' bytes)'
    const where = typeof path === 'string' && path.length > 0 ? '，只读副本：' + JSON.stringify(path) : ''
    return '[文件 ' + JSON.stringify(ref.name) + size + where + ']'
  }
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'image') {
        if (block.offloaded === true) {
          fileLines.push('[图片已因请求上限被省略：' + String(block.attachment?.attachmentId ?? '未知附件') + ']')
          continue
        }
        const image = imageRefOf(block.attachment)
        if (image !== null) images.push(image)
        continue
      }
      if (block.type === 'file') {
        const line = fileLineOf(block.attachment)
        if (line !== null) fileLines.push(line)
      }
    }
  }
  return { images, fileLines }
}

/** Last `historyTurns` *user turns* of text-only conversation, rendered flat. */
function transcript(messages, historyTurns) {
  if (!Array.isArray(messages) || historyTurns <= 0) return ''
  const rows = []
  for (const message of messages) {
    const role = message === null || message === undefined ? undefined : message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message.content)
    if (text.length === 0) continue
    rows.push({ role, text })
  }
  let start = 0
  if (historyTurns > 0) {
    let seen = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].role !== 'user') continue
      seen += 1
      if (seen > historyTurns) {
        start = i + 1
        break
      }
    }
  }
  return rows
    .slice(start)
    .map((row) => (row.role === 'user' ? '### 本地 AI\n' : '### 你（顾问）\n') + row.text)
    .join('\n\n')
}

function normalizeProtocol(parsed, turnKind) {
  const status = parsed.status
  if (status !== 'aligning' && status !== 'guiding') {
    return { error: 'PROTOCOL_VIOLATION', message: 'status 必须是 "aligning" 或 "guiding"' }
  }
  if (turnKind === 'report' && status !== 'guiding') {
    return { error: 'REPORT_REQUIRES_GUIDING', message: 'turn_kind=report 时 status 只允许 "guiding"' }
  }
  const questions = strArray(parsed.questions)
  const guidance = typeof parsed.guidance === 'string' && parsed.guidance.trim().length > 0 ? parsed.guidance : null
  const analysis = typeof parsed.analysis === 'string' && parsed.analysis.trim().length > 0 ? parsed.analysis : null
  const verification =
    typeof parsed.verification === 'string' && parsed.verification.trim().length > 0 ? parsed.verification : null
  if (status === 'aligning' && questions.length === 0) {
    return { error: 'ALIGNING_WITHOUT_QUESTIONS', message: 'status=aligning 时 questions 不能为空' }
  }
  if (status === 'guiding' && guidance === null) {
    return { error: 'GUIDING_WITHOUT_GUIDANCE', message: 'status=guiding 时 guidance 不能为空' }
  }
  const codeChanges = []
  if (Array.isArray(parsed.code_changes)) {
    for (const item of parsed.code_changes) {
      if (item === null || typeof item !== 'object') continue
      const entry = {}
      if (typeof item.file === 'string') entry.file = item.file
      if (typeof item.old === 'string') entry.old = item.old
      if (typeof item.new === 'string') entry.new = item.new
      if (typeof item.line === 'number' && Number.isFinite(item.line)) entry.line = item.line
      if (Object.keys(entry).length > 0) codeChanges.push(entry)
    }
  }
  return {
    status,
    questions: status === 'aligning' ? questions : [],
    // 模式 A is all-or-nothing: an aligning answer carries no findings at all.
    analysis: status === 'aligning' ? null : analysis,
    guidance: status === 'aligning' ? null : guidance,
    action_items: strArray(parsed.action_items),
    code_changes: status === 'aligning' ? [] : codeChanges,
    verification: status === 'aligning' ? null : verification,
    needs_another_iteration: parsed.needs_another_iteration === true,
    resolved: parsed.resolved === true,
    requires_human_intervention: parsed.requires_human_intervention === true
  }
}

function emptyProtocol(status, code, message) {
  return {
    status,
    code,
    message,
    questions: [],
    analysis: null,
    guidance: null,
    action_items: [],
    code_changes: [],
    verification: null,
    needs_another_iteration: false,
    resolved: false,
    requires_human_intervention: false
  }
}

function usageOf(usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  const out = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function finishFailure(finish) {
  if (finish === undefined || finish === null) return { code: 'PROVIDER_ERROR', message: 'no finish chunk' }
  if (finish.kind === 'aborted') return { code: 'ABORTED', message: '调用被中止（exec.signal）' }
  if (finish.kind === 'error') {
    const failure = finish.failure
    const detail =
      failure === undefined || failure === null
        ? 'unknown provider failure'
        : String(failure.message === undefined ? failure.code : failure.message)
    return { code: 'PROVIDER_ERROR', message: detail }
  }
  return undefined
}

function apply(ctx, config) {
  const CONFIG = config === undefined || config === null ? {} : config

  /**
   * Execution-world read path of one durable file reference, via the same
   * seams the host's own `fileReadPath` uses (dsh-llm): attachments
   * `fileHostPath` + fs `processPathFromHostPath`. Either service missing or
   * failing yields `undefined` — the info line simply omits the path.
   */
  function attachmentFilePath(ref) {
    if (ref === null || typeof ref !== 'object') return undefined
    let hostPath
    try {
      const attachments = ctx.get('attachments')
      hostPath = attachments?.fileHostPath?.(ref)
    } catch {
      return undefined
    }
    if (hostPath === undefined) return undefined
    try {
      return ctx.get('fs')?.processPathFromHostPath?.(hostPath)
    } catch {
      return undefined
    }
  }

  // Declare that this entry owns its settings page (the card ships in
  // lib/client.js). Opportunistic: a composition without settings still runs.
  try {
    const settings = ctx.get('settings')
    if (settings !== undefined && settings !== null && typeof settings.configure === 'function') {
      ctx.effect(() => settings.configure({ auto: false }), 'senior-adviser: own settings page')
    }
  } catch {
    /* settings is optional */
  }

  async function consult(args, exec) {
    const turnKind = args.turn_kind
    const historyTurns = read(CONFIG.historyTurns, 10)
    const maxRounds = read(CONFIG.maxRounds, 8)
    const session = exec.agent === undefined ? undefined : exec.agent.session
    const state = scanSession(session)
    const base = { turn_kind: turnKind, round: state.calls + 1 }
    /** Structured refusal: same envelope as a protocol answer, never a throw. */
    const fail = (code, message) => ({ ...emptyProtocol('error', code, message), ...base })

    // ── zero-cost preflight (no provider request below this line) ──────────
    if (state.calls >= maxRounds) {
      return fail(
        'ROUNDS_EXHAUSTED',
        '本轮咨询已用 ' + state.calls + '/' + maxRounds + ' 轮（settings: maxRounds）。请把结论写进对话，或调高上限。'
      )
    }
    if (turnKind === 'report' && state.lastGuidance === null) {
      return fail('NO_PRIOR_GUIDANCE', '会话中没有前置 guiding 指导可评估；先用 turn_kind=ask 取得指导。')
    }
    if (turnKind === 'ask' && (typeof args.problem !== 'string' || args.problem.trim().length === 0)) {
      return fail('MISSING_INPUT', 'turn_kind=ask 需要非空的 problem。')
    }
    if (turnKind === 'report' && (args.attempted === undefined || args.attempted === null || typeof args.attempted !== 'object')) {
      return fail('MISSING_INPUT', 'turn_kind=report 需要 attempted 对象 { actions, result, new_error?, feedback? }。')
    }

    // ── route ─────────────────────────────────────────────────────────────
    const agentOptions = exec.agent === undefined ? undefined : exec.agent.options
    const provider = read(CONFIG.provider, '') || (agentOptions === undefined ? '' : String(agentOptions.provider || ''))
    const model = read(CONFIG.model, '') || (agentOptions === undefined ? '' : String(agentOptions.model || ''))
    if (provider.length === 0 || model.length === 0) {
      return fail('NO_ROUTE', '没有可用路由：settings.provider/model 为空且调用方没有模型。')
    }

    let info
    try {
      info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
    } catch (error) {
      return fail(
        'ROUTE_UNAVAILABLE',
        '无法解析模型 ' + provider + '/' + model + '：' + (error instanceof Error ? error.message : String(error))
      )
    }

    const configuredWindow = read(CONFIG.contextWindow, 0)
    const declaredWindow = info.context === undefined || info.context === null ? 0 : Number(info.context.contextWindow || 0)
    const contextWindow = configuredWindow > 0 ? configuredWindow : declaredWindow
    const configuredMax = read(CONFIG.maxTokens, 0)
    const maxTokens = configuredMax > 0 ? configuredMax : Number(info.defaultMaxTokens || 0)

    // ── prompt ────────────────────────────────────────────────────────────
    const personaBase = read(CONFIG.persona, '')
    const system = [
      personaBase !== undefined && personaBase !== null && String(personaBase).trim().length > 0 ? String(personaBase) : PRINCIPLES,
      PROTOCOL,
      turnKind === 'report' ? CONTRACT_REPORT : CONTRACT_ASK
    ].join('\n\n')

    const derived = session === undefined || typeof session.deriveMessages !== 'function' ? [] : session.deriveMessages()
    const history = transcript(derived, historyTurns)
    const surfaces = attachmentSurfaces(derived, (ref) => attachmentFilePath(ref))

    // Caller-supplied images (the local AI's own files): read here, committed
    // through the same attachment store the browser upload path uses, so the
    // adviser sees them exactly like a user-attached image.
    const requestedPaths = Array.isArray(args.attachments) ? args.attachments : []
    const attachmentsService = ctx.get('attachments')
    const loaded =
      requestedPaths.length === 0
        ? { blocks: [], problems: [] }
        : attachmentsService === undefined || attachmentsService === null
          ? { blocks: [], problems: ['[图片未发送：本环境没有 attachments 服务，无法存放图片]'] }
          : await loadImageAttachments(requestedPaths, attachmentsService)

    const sections = []
    if (loaded.problems.length > 0) sections.push('【本地 AI 附带的图片未能发送】\n' + loaded.problems.join('\n'))
    if (surfaces.fileLines.length > 0) {
      sections.push(
        '【会话中出现过的文件（内容不在本请求里）】\n' +
          surfaces.fileLines.join('\n') +
          '\n这些文件的实际内容由本地 AI 负责读取转述；缺内容时在 questions 里点名索取。'
      )
    }
    if (history.length > 0) sections.push('【最近对话（文本记录）】\n' + history)
    if (state.lastGuidance !== null) sections.push('【上一轮指导（原文，逐字保留）】\n' + state.lastGuidance)
    if (turnKind === 'report') {
      sections.push('【本轮汇报 attempted】\n' + JSON.stringify(args.attempted))
    } else {
      sections.push('【本轮问题 problem】\n' + String(args.problem))
    }
    sections.push('【轮次】第 ' + (state.calls + 1) + ' 轮 / 上限 ' + maxRounds)

    // History images AND caller-supplied images ride the SAME user message:
    // the host projection re-reads them through the attachments service and
    // inlines base64 for image-capable consultant models; text-only models
    // degrade to placeholders (adapter).
    const content = [{ type: 'text', text: sections.join('\n\n') }, ...surfaces.images, ...loaded.blocks]
    const messages = [{ role: 'user', content }]

    // `temperature` is deliberately absent: no config knob — the request uses
    // the provider/API default. `reasoningEffort` is omitted when unset so the
    // adapter's model-default effort applies (dsh-llm resolveCallWithInfo).
    const effortId = String(read(CONFIG.reasoningEffort, '') || '').trim()
    const options = {
      provider,
      model,
      system,
      messages,
      ...(maxTokens > 0 ? { maxTokens } : {}),
      ...(effortId.length > 0 ? { reasoningEffort: effortId } : {}),
      // `tools` is deliberately absent: the consultant has no callable surface.
      signal: exec.signal
    }

    // ── the blocking call ─────────────────────────────────────────────────
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      return {
        ...emptyProtocol('error', 'PROVIDER_ERROR', error instanceof Error ? error.message : String(error)),
        ...base,
        route: { provider, model, contextWindow, maxTokens }
      }
    }

    const failure = finishFailure(assembler.finish)
    const blocks = assembler.finish !== undefined && assembler.finish !== null && assembler.finish.kind === 'aborted'
      ? assembler.interruptedBlocks()
      : assembler.blocks()
    const raw = blocks
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    const route = { provider, model, contextWindow, maxTokens }
    const usage = usageOf(assembler.usage)

    if (failure !== undefined) {
      return { ...emptyProtocol('error', failure.code, failure.message), ...base, route, ...(usage === undefined ? {} : { usage }) }
    }

    const parsed = parseProtocol(raw)
    if (parsed === undefined) {
      return {
        ...emptyProtocol(
          'error',
          raw.length === 0 ? 'EMPTY_RESPONSE' : 'INVALID_JSON',
          '顾问返回的内容不是合法 JSON 对象：' + raw.slice(0, 400)
        ),
        ...base,
        route,
        ...(usage === undefined ? {} : { usage })
      }
    }

    const normalized = normalizeProtocol(parsed, turnKind)
    if (normalized.error !== undefined) {
      return {
        ...emptyProtocol('error', normalized.error, normalized.message),
        ...base,
        route,
        ...(usage === undefined ? {} : { usage })
      }
    }

    return {
      status: normalized.status,
      ...base,
      route,
      ...(usage === undefined ? {} : { usage }),
      questions: normalized.questions,
      analysis: normalized.analysis,
      guidance: normalized.guidance,
      action_items: normalized.action_items,
      code_changes: normalized.code_changes,
      verification: normalized.verification,
      needs_another_iteration: normalized.needs_another_iteration,
      resolved: normalized.resolved,
      requires_human_intervention: normalized.requires_human_intervention
    }
  }

  const tool = defineTool({
    name: TOOL_NAME,
    description:
      '向"上级顾问"发起一次阻塞式咨询（不是子代理，顾问没有工具、看不见你的文件）。' +
      'turn_kind=ask 提交问题，顾问判断信息够不够：不够则回 status=aligning + questions，' +
      '够则回 status=guiding + guidance。按指导改完代码后用 turn_kind=report 提交 attempted，' +
      '顾问会先评估上一轮指导执行得对不对，再给下一轮。一次调用占住整个回合，直到顾问说完。' +
      '可用 attachments 传本地图片绝对路径（png/jpg/jpeg/webp/gif），顾问能直接看图；' +
      '返回结构化 JSON（status/questions/analysis/guidance/action_items/code_changes/verification/...）；' +
      '失败时返回 status=error + code（NO_PRIOR_GUIDANCE / ROUNDS_EXHAUSTED / INVALID_JSON / PROVIDER_ERROR ...），不抛异常。',
    parameters: {
      turn_kind: {
        type: 'string',
        required: true,
        enum: ['ask', 'report'],
        description: 'ask = 提问题，要求顾问判断信息够不够；report = 汇报执行结果，要求顾问先评估上一轮指导'
      },
      problem: {
        type: 'string',
        description: 'turn_kind=ask 时必填：现象、报错原文、已尝试过什么、涉及的文件片段（顾问看不到别的东西）'
      },
      attempted: {
        type: 'object',
        additionalProperties: false,
        description: 'turn_kind=report 时必填：按上一轮指导做了什么、结果如何',
        properties: {
          actions: { type: 'array', items: { type: 'string' }, description: '逐条列出实际执行的动作' },
          result: { type: 'string', description: '执行后的实际结果：测试输出、新的报错、或"通过"' },
          new_error: { type: 'string', description: '新出现的报错原文' },
          feedback: { type: 'string', description: '对上一轮指导的评价/疑问' }
        }
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description:
          '可选：要发给顾问的本地图片绝对路径（png/jpg/jpeg/webp/gif），插件会读取并随请求发送。' +
          '顾问没有文件工具，这是把截图/设计稿/报错画面给它看的唯一方式；非图片文件不会被发送。'
      }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // Compact single-line JSON: machine-recoverable for the next round
        // (see 00-取证.md U1) and directly readable by the model.
        return [{ type: 'text', text: JSON.stringify(value) }]
      }
    },
    async execute(args, exec) {
      try {
        return await consult(args, exec)
      } catch (error) {
        return emptyProtocol('error', 'INTERNAL', error instanceof Error ? error.message : String(error))
      }
    }
  })

  ctx.effect(() => ctx.tools.register(tool), 'senior-adviser: ask_senior')
}

// Pure helpers exposed for the offline test suite (no host, no network).
const __internals = {
  parseProtocol,
  normalizeProtocol,
  transcript,
  scanSession,
  attachmentSurfaces,
  firstBalancedObject,
  strArray,
  textOf
}

export { Config, apply, inject, name, __internals, attachmentSurfaces }

