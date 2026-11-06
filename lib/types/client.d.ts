/**
 * dsh-senior-adviser — browser half type surface.
 *
 * A hand-written client bundle in the platform's `window.__ModuleLoader__`
 * factory format. It registers ONE `settings.plugins.tab` entry ("上级顾问")
 * and reads every value from an existing host seam — see lib/client.js.
 *
 * @module dsh-senior-adviser/client
 */
import type { Context } from '@deepseek-ai/cordis'

/** Locale dictionary namespace owned by the card. */
export declare const NS: 'settings.seniorAdviser'
/** Required client services (services, not packages). */
export declare const inject: readonly [
  'slots',
  'locale',
  'configForms',
  'remote',
  'remote.llm',
  'remote.session',
  'remote.settings'
]
/**
 * Register the card.
 * @param ctx - client context.
 */
export declare function apply(ctx: Context): void

export {}
