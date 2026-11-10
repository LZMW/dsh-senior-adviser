/**
 * dsh-senior-adviser — host (Node) half type surface.
 *
 * The plugin is a Cordis function plugin: `{ name, inject, Config, apply }`.
 * `apply(ctx, config)` registers exactly one tool (`ask_senior`) and never
 * registers an agent, an activation, or a subagent.
 *
 * @module dsh-senior-adviser
 */
import type Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

/** One `code_changes` entry as delivered inside the protocol payload. */
export interface SeniorAdviserCodeChange {
  file?: string
  line?: number
  old?: string
  new?: string
}

/** Arguments accepted by `ask_senior`. */
export interface SeniorAdviserArguments {
  turn_kind: 'ask' | 'report'
  /** Required for `ask`: the phenomenon, error text, and what was already tried. */
  problem?: string
  /** Required for `report`: what was done after the previous guidance. */
  attempted?: {
    actions?: string[]
    result?: string
    new_error?: string
    feedback?: string
  }
  /**
   * Optional absolute paths of local images (png/jpg/jpeg/webp/gif) to send
   * with the consult. The plugin reads the bytes and commits them through the
   * host attachment store, so the adviser receives real image blocks. This is
   * the only way a tool-less consultant can be shown a screenshot.
   */
  attachments?: string[]
}

/** Token accounting echoed from the assembled stream (host-owned numbers). */
export interface SeniorAdviserUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** The exact route the request used, plus the window/max-tokens that were applied. */
export interface SeniorAdviserRoute {
  provider?: string
  model?: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * The canonical `ask_senior` result. `status` is `error` only for the
 * structured-degradation paths (never for a thrown exception — the tool body
 * contains everything).
 */
export interface SeniorAdviserResult {
  status: 'aligning' | 'guiding' | 'error'
  /** Present when `status === 'error'`. */
  code?: string
  /** Human-readable failure or explanation. */
  message?: string
  turn_kind?: 'ask' | 'report'
  /** 1-based position of this call inside the session's consult chain. */
  round?: number
  route?: SeniorAdviserRoute
  usage?: SeniorAdviserUsage
  questions: string[]
  analysis: string | null
  guidance: string | null
  action_items: string[]
  code_changes: SeniorAdviserCodeChange[]
  verification: string | null
  needs_another_iteration: boolean
  resolved: boolean
  requires_human_intervention: boolean
}

/** Structured `code` values the tool can return instead of throwing. */
export type SeniorAdviserErrorCode =
  | 'NO_PRIOR_GUIDANCE'
  | 'ROUNDS_EXHAUSTED'
  | 'MISSING_INPUT'
  | 'NO_ROUTE'
  | 'ROUTE_UNAVAILABLE'
  | 'INVALID_JSON'
  | 'EMPTY_RESPONSE'
  | 'PROTOCOL_VIOLATION'
  | 'ALIGNING_WITHOUT_QUESTIONS'
  | 'GUIDING_WITHOUT_GUIDANCE'
  | 'REPORT_REQUIRES_GUIDING'
  | 'ABORTED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL'

/**
 * Plugin config. EVERY field is `.volatile()`, which is what makes the entry
 * appear in `ctx.settings.describe()` at all (see 00-取证.md §1.4) and what
 * makes edits apply without remounting the plugin.
 */
export interface SeniorAdviserConfig {
  /** Provider route id; empty = follow the calling agent. */
  provider: string
  /** Model id; empty = follow the calling agent. */
  model: string
  /** 0 = use `resolveModelInfo().context.contextWindow`; >0 = override. */
  contextWindow: number
  /** 0 = use `resolveModelInfo().defaultMaxTokens`. */
  maxTokens: number
  /** How many user turns of text-only transcript to attach (a count, not tokens). */
  historyTurns: number
  /** Reasoning-effort id from the model's `reasoning.efforts[]`; empty = model default (field omitted). */
  reasoningEffort: string
  /** Zero-cost round cap; exceeding it returns ROUNDS_EXHAUSTED without a request. */
  maxRounds: number
  /** The five principles; empty = built-in. The contract paragraph is always appended. */
  persona: string
}

/** Plugin name registered with the Loader. */
export declare const name: 'dsh-senior-adviser'
/** Required Cordis services. */
export declare const inject: readonly ['llm', 'tools']
/** Config schema (schemastery). */
export declare const Config: Schema<SeniorAdviserConfig>
/**
 * Mount the tool.
 * @param ctx - host context providing `llm` and `tools`.
 * @param config - volatile config refs (read with `.get()` at call time).
 */
export declare function apply(ctx: Context, config: SeniorAdviserConfig): void

export {}

