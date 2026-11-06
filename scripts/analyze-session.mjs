// analyze-session.mjs — turn one DSH v4 session log into the exact facts the
// acceptance report needs, as JSON on stdout.
//
//   node analyze-session.mjs <sessionDir | session.v4.jsonl.zstd>
//
// It answers, from the durable log alone (no host, no guesses):
//   * how many request/header events exist, and where, in wall-clock time
//   * every ask_senior tool/call → tool/result window (start, end, seconds)
//   * whether a request/header was emitted INSIDE a tool window (must be 0)
//   * the JSON payload of each ask_senior result (status / code / guidance)
//   * the provider/model each request header routed to
//   * the tool names declared in the first request header
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [, , target] = process.argv
if (target === undefined) {
  console.error('usage: node analyze-session.mjs <sessionDir | session.v4.jsonl.zstd>')
  process.exit(2)
}

let file = target
if (fs.statSync(target).isDirectory()) file = path.join(target, 'session.v4.jsonl.zstd')

/** Split on the zstd frame magic and decompress frame by frame. */
function decompressFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(MAGIC, at + 4)
  }
  const parts = []
  let k = 0
  while (k < offsets.length) {
    const start = offsets[k]
    let next = k + 1
    let ok = false
    while (next <= offsets.length) {
      const end = next < offsets.length ? offsets[next] : buf.length
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
        ok = true
        k = next
        break
      } catch {
        next += 1
      }
    }
    if (!ok) k += 1
  }
  return Buffer.concat(parts)
}

const raw = fs.readFileSync(file)
const isZstd = raw.length > 4 && raw.readUInt32LE(0) === 0xfd2fb528
const text = (isZstd ? decompressFrames(raw) : raw).toString('utf8')
const events = []
for (const line of text.split('\n')) {
  if (line.length === 0) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* partial trailing frame line */
  }
}

const stampOf = (event) => {
  const candidates = [event.ts, event.time, event.at, event.timestamp, event.data?.ts, event.createdAt]
  for (const value of candidates) if (typeof value === 'number') return value
  return undefined
}

const headers = []
const calls = []
const results = []
const toolNames = []

for (const event of events) {
  const type = String(event.type ?? '')
  const at = stampOf(event)
  if (type === 'request/header') {
    const config = event.data?.config ?? event.data?.header?.config ?? {}
    headers.push({ seq: event.seq, at, provider: config.provider, model: config.model })
    if (toolNames.length === 0) {
      const declared = event.data?.tools ?? event.data?.header?.tools ?? []
      if (Array.isArray(declared)) for (const tool of declared) toolNames.push(tool?.name ?? tool?.tool?.name)
    }
  } else if (type === 'tool/call') {
    calls.push({
      seq: event.seq,
      at,
      callId: event.data?.callId ?? event.data?.id ?? event.data?.call?.id,
      name: event.data?.name ?? event.data?.call?.name,
      arguments: event.data?.arguments ?? event.data?.call?.arguments
    })
  } else if (type === 'tool/result') {
    // v4 shape: {message: {toolCallId, content: ContentBlock[], isError}}
    const message = event.data?.message ?? {}
    const content = message.content ?? event.data?.content ?? event.data?.result?.content
    const textParts = Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text)
      : []
    results.push({
      seq: event.seq,
      at,
      callId: message.toolCallId ?? event.data?.callId ?? event.data?.id,
      isError: message.isError === true || event.data?.isError === true,
      text: textParts.join('')
    })
  }
}

/** `ask_senior` invocations, joined call→result, with the request headers that landed inside them. */
const asks = []
for (const call of calls) {
  if (call.name !== 'ask_senior') continue
  const result = results.find((r) => (call.callId !== undefined ? r.callId === call.callId : r.seq > call.seq))
  const end = result === undefined ? undefined : result.at
  const insideHeaders = call.at === undefined || end === undefined
    ? []
    : headers.filter((h) => h.at !== undefined && h.at > call.at && h.at < end).length
  let payload
  try {
    payload = result === undefined ? undefined : JSON.parse(result.text)
  } catch {
    payload = undefined
  }
  asks.push({
    callSeq: call.seq,
    callAt: call.at,
    arguments: call.arguments,
    resultAt: end,
    seconds: call.at === undefined || end === undefined ? undefined : (end - call.at) / 1000,
    headersInsideCall: insideHeaders,
    status: payload?.status,
    code: payload?.code,
    route: payload?.route,
    guidance: payload?.guidance,
    questions: payload?.questions
  })
}

console.log(
  JSON.stringify(
    {
      file,
      eventCount: events.length,
      firstTool: toolNames,
      headerCount: headers.length,
      headers,
      askCount: asks.length,
      asks
    },
    null,
    2
  )
)
