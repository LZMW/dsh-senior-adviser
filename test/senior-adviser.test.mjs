// Offline test suite: no host, no network, no model.
//
// It covers exactly the structural claims the plugin makes:
//   * the request options never carry `tools`,
//   * `exec.signal` reaches `ctx.llm.stream`,
//   * `for await` completes before execute resolves,
//   * the zero-cost preflights (NO_PRIOR_GUIDANCE / ROUNDS_EXHAUSTED) never
//     touch the provider,
//   * the protocol normalizer enforces the aligning/guiding invariants,
//   * the report round carries the previous guidance verbatim.

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Config, __internals, apply, inject, name } from '../lib/index.js'

const { parseProtocol, normalizeProtocol, transcript, scanSession, attachmentSurfaces } = __internals

const enc = (value) => JSON.stringify(value)

// ── harness ────────────────────────────────────────────────────────────────

/** A fake Cordis host: `llm.stream` records its options and replays `reply`. */
function fakeHost(reply, options = {}) {
  const calls = []
  const registered = []
  const listeners = []
  const services = new Map(
    Object.entries({
      attachments: {
        fileHostPath: (ref) => 'C:\\attachments\\v1\\files\\ab\\' + String(ref?.attachmentId ?? '') + '\\' + String(ref?.name ?? 'file')
      },
      fs: {
        processPathFromHostPath: (hostPath) => 'C:\\ws\\' + String(hostPath ?? '').split('\\').pop()
      }
    })
  )
  const ctx = {
    effect(factory) {
      const dispose = typeof factory === 'function' ? factory() : undefined
      listeners.push(typeof dispose === 'function' ? dispose : () => {})
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      }
    },
    llm: {
      resolveModelInfo: async (provider, model) => {
        if (options.routeError !== undefined) throw new Error(options.routeError)
        return {
          provider,
          id: model,
          name: model,
          context: { contextWindow: options.window === undefined ? 1000000 : options.window },
          defaultMaxTokens: options.defaultMaxTokens === undefined ? 384000 : options.defaultMaxTokens
        }
      },
      stream(streamOptions) {
        calls.push(streamOptions)
        const text = typeof reply === 'function' ? reply(streamOptions) : reply
        async function* run() {
          if (options.finish !== undefined) {
            for await (const chunk of []) void chunk
            yield { type: 'finish', reason: options.finish }
            return
          }
          if (text !== null) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          }
          yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return run()
      }
    }
  }
  return { ctx, calls, registered }
}

/** A fake session whose derived history is exactly `messages`. */
function fakeSession(messages) {
  return { deriveMessages: () => messages }
}

function fakeExec({ messages = [], provider = 'zhipu', model = 'glm-4.7', session = true } = {}) {
  const agent = session
    ? { options: { provider, model }, session: fakeSession(messages) }
    : { options: { provider, model } }
  const controller = new AbortController()
  return { agent, signal: controller.signal, controller }
}

/** Messages shaped like `Session.deriveMessages()` output. */
function turn(userText, assistantText) {
  const out = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  if (assistantText !== undefined) out.push({ role: 'assistant', content: [{ type: 'text', text: assistantText }] })
  return out
}

/** One prior consult round as it appears in a derived history. */
function priorRound(callId, args, result) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'ask_senior', arguments: enc(args) }]
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: enc(result) }] }]
    }
  ]
}

const guiding = {
  status: 'guiding',
  questions: [],
  analysis: 'root cause',
  guidance: '把 src/a.ts 第 12 行的 await 补上',
  action_items: ['edit src/a.ts'],
  code_changes: [],
  verification: 'run tests',
  needs_another_iteration: true,
  resolved: false,
  requires_human_intervention: false
}

/** Register the tool through the real plugin body and return it. */
function loadTool(host, config = {}) {
  apply(host.ctx, config)
  assert.equal(host.registered.length, 1, 'exactly one tool registered')
  return host.registered[0]
}

// ── structure ──────────────────────────────────────────────────────────────

test('plugin exports the Cordis function-plugin shape', () => {
  assert.equal(name, 'dsh-senior-adviser')
  assert.deepEqual([...inject], ['llm', 'tools'], 'only hard dependencies: a session-scoped fs would stall a root plugin')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'schemastery schemas are callable')
})

test('every config field is volatile (otherwise no settings card, no live edit)', () => {
  for (const field of ['provider', 'model', 'contextWindow', 'maxTokens', 'historyTurns', 'reasoningEffort', 'maxRounds', 'persona']) {
    const node = Config.dict[field]
    assert.ok(node !== undefined, field + ' declared')
    assert.equal(node.meta.volatile, true, field + ' must be volatile')
  }
  assert.equal(Config.dict.temperature, undefined, 'temperature knob removed: API default temperature')
})

test('tool schema: turn_kind enum is enforced before execute, no apiKey surface', () => {
  const tool = loadTool(fakeHost('{}'))
  assert.equal(tool.name, 'ask_senior')
  assert.deepEqual(tool.parameters.properties.turn_kind.enum, ['ask', 'report'])
  assert.equal(tool.parameters.required?.includes('turn_kind') ?? true, true)
  assert.equal(tool.timeoutMs, undefined, 'no deadline: blocking is the point')
  assert.equal(tool.isConcurrencySafe, undefined, 'exclusive: owns the whole turn')
  assert.doesNotMatch(JSON.stringify(tool.parameters), /api[_-]?key/i)
})

// ── the invariants ─────────────────────────────────────────────────────────

test('one request: no `tools` field, `signal` forwarded, blocking await', async () => {
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const exec = fakeExec()
  const value = await tool.execute({ turn_kind: 'ask', problem: '测试挂了' }, exec)

  assert.equal(host.calls.length, 1, 'exactly one llm.stream call')
  const options = host.calls[0]
  assert.equal(Object.hasOwn(options, 'tools'), false, 'tools must be absent')
  assert.equal(Object.hasOwn(options, 'temperature'), false, 'temperature omitted: API default')
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false, 'reasoningEffort omitted by default: model default effort')
  assert.equal(options.signal, exec.signal, 'exec.signal must reach the provider call')
  assert.equal(options.provider, 'zhipu')
  assert.equal(options.model, 'glm-4.7')
  assert.equal(typeof options.system, 'string')
  assert.match(options.system, /本轮契约（turn_kind = ask）/)
  assert.ok(Array.isArray(options.messages) && options.messages.length === 1)

  // the call returned only after the stream finished
  assert.equal(value.status, 'guiding')
  assert.equal(value.guidance, guiding.guidance)
  assert.equal(value.route.contextWindow, 1000000)
  assert.equal(value.route.maxTokens, 384000)
  assert.equal(value.round, 1)
  assert.equal(value.usage.totalTokens, 19)
})

test('aligning: questions non-empty, guidance coerced to null', async () => {
  const reply = enc({ ...guiding, status: 'aligning', questions: ['贴出报错原文'], guidance: 'should be dropped' })
  const host = fakeHost(reply)
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(value.status, 'aligning')
  assert.deepEqual(value.questions, ['贴出报错原文'])
  assert.equal(value.guidance, null)
  assert.equal(value.analysis, null)
  assert.deepEqual(value.code_changes, [])
})

test('report without prior guiding: NO_PRIOR_GUIDANCE and zero provider calls', async () => {
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute({ turn_kind: 'report', attempted: { actions: ['x'], result: 'ok' } }, fakeExec())
  assert.equal(value.status, 'error')
  assert.equal(value.code, 'NO_PRIOR_GUIDANCE')
  assert.equal(host.calls.length, 0, 'the preflight must not reach the provider')
})

test('report carries the previous guidance verbatim and grades it first', async () => {
  const messages = [
    ...turn('帮我看个 bug'),
    ...priorRound('call-1', { turn_kind: 'ask', problem: '帮我看个 bug' }, guiding)
  ]
  const host = fakeHost(enc({ ...guiding, guidance: '第二轮指导', resolved: true }))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute(
    { turn_kind: 'report', attempted: { actions: ['edit src/a.ts'], result: '测试通过', feedback: '改了但还有告警' } },
    fakeExec({ messages })
  )

  const prompt = host.calls[0].messages[0].content[0].text
  assert.ok(prompt.includes(guiding.guidance), 'previous guidance must appear verbatim')
  assert.ok(prompt.includes('改了但还有告警'), 'attempted.feedback must appear')
  assert.match(host.calls[0].system, /本轮契约（turn_kind = report）/)
  assert.equal(value.round, 2)
  assert.equal(value.status, 'guiding')
  assert.equal(value.resolved, true)
})

test('rounds cap: ROUNDS_EXHAUSTED without a provider call', async () => {
  const messages = [
    ...turn('a'),
    ...priorRound('c1', { turn_kind: 'ask', problem: 'a' }, guiding),
    ...priorRound('c2', { turn_kind: 'report', attempted: {} }, guiding)
  ]
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7', maxRounds: 2 })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'again' }, fakeExec({ messages }))
  assert.equal(value.code, 'ROUNDS_EXHAUSTED')
  assert.equal(host.calls.length, 0)
})

test('provider failures degrade to structured errors, never throw', async () => {
  const host = fakeHost(null, { finish: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } })
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(value.status, 'error')
  assert.equal(value.code, 'PROVIDER_ERROR')
  assert.match(value.message, /429/)
})

test('unknown route degrades to ROUTE_UNAVAILABLE', async () => {
  const host = fakeHost(enc(guiding), { routeError: 'no adapter for "nope"' })
  const tool = loadTool(host, { provider: 'nope', model: 'nope' })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(value.code, 'ROUTE_UNAVAILABLE')
  assert.match(value.message, /no adapter/)
})

test('aborted finish yields ABORTED, not a protocol error', async () => {
  const host = fakeHost(null, { finish: { kind: 'aborted', failure: { code: 'USER_ABORT', message: 'stopped' } } })
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(value.status, 'error')
  assert.equal(value.code, 'ABORTED')
})

test('contextWindow/maxTokens config overrides the resolved values', async () => {
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7', contextWindow: 32000, maxTokens: 2048 })
  const value = await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(value.route.contextWindow, 32000)
  assert.equal(value.route.maxTokens, 2048)
  assert.equal(host.calls[0].maxTokens, 2048)
})

test('reasoningEffort config forwards to the stream options verbatim', async () => {
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: 'high' })
  await tool.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(host.calls[0].reasoningEffort, 'high')

  const hostEmpty = fakeHost(enc(guiding))
  const toolEmpty = loadTool(hostEmpty, { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: '  ' })
  await toolEmpty.execute({ turn_kind: 'ask', problem: 'x' }, fakeExec())
  assert.equal(Object.hasOwn(hostEmpty.calls[0], 'reasoningEffort'), false, 'blank effort = model default')
})

// ── parsing / normalization ────────────────────────────────────────────────

test('parseProtocol: plain, fenced, surrounded by prose, and hopeless', () => {
  assert.deepEqual(parseProtocol('{"status":"guiding"}'), { status: 'guiding' })
  assert.deepEqual(parseProtocol('```json\n{"status":"aligning"}\n```'), { status: 'aligning' })
  assert.deepEqual(parseProtocol('好的，我的判断是：\n{"status":"guiding","guidance":"x"}\n以上。'), {
    status: 'guiding',
    guidance: 'x'
  })
  assert.equal(parseProtocol('完全不是 JSON'), undefined)
  assert.equal(parseProtocol('[1,2,3]'), undefined)
})

test('normalizeProtocol enforces the two states', () => {
  assert.equal(normalizeProtocol({ status: 'aligning', questions: [] }).error, 'ALIGNING_WITHOUT_QUESTIONS')
  assert.equal(normalizeProtocol({ status: 'guiding' }).error, 'GUIDING_WITHOUT_GUIDANCE')
  assert.equal(normalizeProtocol({ status: 'guiding', guidance: 'x' }, 'report').status, 'guiding')
  assert.equal(normalizeProtocol({ status: 'aligning', questions: ['q'] }, 'report').error, 'REPORT_REQUIRES_GUIDING')
  assert.equal(normalizeProtocol({ status: 'wat' }).error, 'PROTOCOL_VIOLATION')
})

test('transcript keeps the last N user turns and drops tool noise', () => {
  const messages = [
    ...turn('第一轮', '收到'),
    ...turn('第二轮', '收到'),
    ...turn('第三轮', '收到'),
    { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'NOISE' }] }] }
  ]
  const text = transcript(messages, 2)
  assert.ok(!text.includes('第一轮'), 'older turns dropped')
  assert.ok(text.includes('第二轮') && text.includes('第三轮'))
  assert.ok(!text.includes('NOISE'))
})

// ── attachment surfaces (v1.2.0) ───────────────────────────────────────────

const imageRef = (id, name) => ({ attachmentId: 'sha256:' + id, name, width: 512, height: 512, mediaType: 'image/png' })
const fileRef = (id, name, bytes) => ({ attachmentId: 'sha256:' + id, name, bytes })
const withAttachments = (messages) => [
  ...messages,
  {
    role: 'user',
    content: [
      { type: 'text', text: '看看这个' },
      { type: 'image', attachment: imageRef('img1', '截图.png') },
      { type: 'file', attachment: fileRef('fil1', '报错.log', 2048) }
    ]
  }
]

test('attachmentSurfaces: images pass verbatim, files become info lines with the read-only path', () => {
  const resolve = (ref) => 'C:\\ws\\' + String(ref.name)
  const surfaces = attachmentSurfaces(withAttachments(turn('a')), resolve)
  assert.equal(surfaces.images.length, 1)
  assert.deepEqual(surfaces.images[0], { type: 'image', attachment: imageRef('img1', '截图.png') })
  assert.equal(surfaces.fileLines.length, 1)
  assert.match(surfaces.fileLines[0], /\[文件 "报错\.log" \(2048 bytes\)，只读副本：/)
  assert.match(surfaces.fileLines[0], /C:\\\\ws\\\\报错\.log/, 'quoted execution-world path')
})

test('attachmentSurfaces: offloaded images render placeholders, non-user content ignored', () => {
  const messages = [
    ...turn('a'),
    {
      role: 'user',
      content: [{ type: 'image', attachment: imageRef('img2', 'b.png'), offloaded: true }]
    },
    {
      role: 'assistant',
      content: [{ type: 'image', attachment: imageRef('img3', 'c.png') }]
    }
  ]
  const surfaces = attachmentSurfaces(messages)
  assert.equal(surfaces.images.length, 0, 'offloaded and assistant images are not re-sent')
  assert.equal(surfaces.fileLines.length, 1)
  assert.match(surfaces.fileLines[0], /图片已因请求上限被省略/)
})

test('attachmentSurfaces: missing path resolver or services just omits the path', () => {
  const surfaces = attachmentSurfaces(withAttachments(turn('a')))
  assert.equal(surfaces.images.length, 1)
  assert.match(surfaces.fileLines[0], /\[文件 "报错\.log" \(2048 bytes\)\]$/, 'no path when resolver absent')
})

test('consult request carries history images verbatim and the file info section', async () => {
  const host = fakeHost(enc(guiding))
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const exec = fakeExec({ messages: withAttachments(turn('帮我看这个报错')) })
  await tool.execute({ turn_kind: 'ask', problem: '报错如图' }, exec)

  const options = host.calls[0]
  const userContent = options.messages[0].content
  const images = userContent.filter((block) => block.type === 'image')
  assert.equal(images.length, 1, 'exactly one verbatim image block')
  assert.equal(images[0].attachment.attachmentId, 'sha256:img1')
  const prompt = userContent[0].text
  assert.match(prompt, /【会话中出现过的文件（内容不在本请求里）】/)
  assert.match(prompt, /报错\.log/)
  assert.match(prompt, /本地 AI 负责读取转述/)
})

// ── caller-supplied images (v1.3.0) ────────────────────────────────────────

test('attachments argument is declared as an array of strings', () => {
  const tool = loadTool(fakeHost('{}'))
  const schema = tool.parameters.properties.attachments
  assert.ok(schema !== undefined, 'attachments parameter declared')
  assert.equal(schema.type, 'array')
  assert.equal(schema.items.type, 'string')
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, { turn_kind: 'ask', problem: 'x', attachments: ['a.png'] }), [])
  assert.ok(validateJsonSchemaValue(tool.parameters, { turn_kind: 'ask', problem: 'x', attachments: 'a.png' }).length > 0)
})

test('caller image paths are read, stored, and placed in the request', async () => {
  const stored = []
  const host = fakeHost(enc(guiding))
  host.ctx.get = (name) => {
    if (name === 'attachments') {
      return {
        saveImages: async (inputs) => {
          stored.push(...inputs)
          return inputs.map((input, index) => ({
            attachmentId: 'sha256:stored' + index,
            name: input.name,
            width: 64,
            height: 64,
            mediaType: input.mediaType
          }))
        }
      }
    }
    if (name === 'fs') return { processPathFromHostPath: (p) => p }
    return undefined
  }
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const pngPath = fileURLToPath(new URL('./fixtures/pixel.png', import.meta.url))
  const value = await tool.execute({ turn_kind: 'ask', problem: '看图', attachments: [pngPath] }, fakeExec())

  assert.equal(value.status, 'guiding')
  assert.equal(stored.length, 1, 'one image committed through the attachment store')
  assert.equal(stored[0].mediaType, 'image/png')
  assert.ok(stored[0].data instanceof Uint8Array && stored[0].data.length > 0, 'real bytes were read')
  const images = host.calls[0].messages[0].content.filter((block) => block.type === 'image')
  assert.equal(images.length, 1)
  assert.equal(images[0].attachment.attachmentId, 'sha256:stored0')
})

test('unsupported or unreadable caller paths degrade to a prompt note, not an error', async () => {
  const host = fakeHost(enc(guiding))
  host.ctx.get = (name) => (name === 'attachments' ? { saveImages: async () => [] } : undefined)
  const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
  const value = await tool.execute(
    { turn_kind: 'ask', problem: '看图', attachments: ['C:\\nope\\missing.png', 'C:\\nope\\report.pdf'] },
    fakeExec()
  )
  assert.equal(value.status, 'guiding', 'the consult still runs')
  const prompt = host.calls[0].messages[0].content[0].text
  assert.match(prompt, /【本地 AI 附带的图片未能发送】/)
  assert.match(prompt, /不是支持的图片格式/)
  assert.match(prompt, /读取/)
  assert.equal(host.calls[0].messages[0].content.filter((b) => b.type === 'image').length, 0)
})

test('scanSession counts consults and recovers the last guidance', () => {
  const state = scanSession(
    fakeSession([
      ...turn('a'),
      ...priorRound('c1', { turn_kind: 'ask', problem: 'a' }, { status: 'aligning', questions: ['q'] }),
      ...priorRound('c2', { turn_kind: 'ask', problem: 'a' }, guiding)
    ])
  )
  assert.equal(state.calls, 2)
  assert.equal(state.lastStatus, 'guiding')
  assert.equal(state.lastGuidance, guiding.guidance)
})

test('scanSession reads the tool-ROLE carrier this build actually derives', () => {
  // Real v4 shape: the result is a first-class tool message, not a block.
  const state = scanSession(
    fakeSession([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'ask_senior', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: enc(guiding) }] }
    ])
  )
  assert.equal(state.calls, 1)
  assert.equal(state.lastStatus, 'guiding')
  assert.equal(state.lastGuidance, guiding.guidance)
})

test('scanSession tolerates a session-less execution', () => {
  assert.deepEqual(scanSession(undefined), { calls: 0, lastGuidance: null, lastStatus: null })
})

// ── the registry's own two enforcements ────────────────────────────────────
// The registry validates model arguments BEFORE the body and the returned
// value AFTER it, both against these exact schemas. Exercising them here is
// what makes #17 (illegal turn_kind never reaches execute) and the output
// contract offline-checkable.

test('argument schema rejects an illegal turn_kind before the body runs', () => {
  const tool = loadTool(fakeHost('{}'))
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, { turn_kind: 'ask', problem: 'x' }), [])
  const violations = validateJsonSchemaValue(tool.parameters, { turn_kind: 'bogus', problem: 'x' })
  assert.ok(violations.length > 0, 'illegal enum value must be rejected by the registry')
})

test('every result shape satisfies the declared output schema', async () => {
  const cases = [
    [fakeHost(enc(guiding)), { turn_kind: 'ask', problem: 'x' }],
    [fakeHost(enc({ status: 'aligning', questions: ['q'] })), { turn_kind: 'ask', problem: 'x' }],
    [fakeHost(enc(guiding)), { turn_kind: 'report', attempted: {} }],
    [fakeHost(null, { finish: { kind: 'error', failure: { message: 'boom' } } }), { turn_kind: 'ask', problem: 'x' }]
  ]
  for (const [host, args] of cases) {
    const tool = loadTool(host, { provider: 'zhipu', model: 'glm-4.7' })
    const value = await tool.execute(args, fakeExec())
    const violations = validateJsonSchemaValue(tool.output.schema, value)
    assert.deepEqual(violations, [], JSON.stringify(value).slice(0, 200))
    assert.equal(typeof value.status, 'string')
  }
})


