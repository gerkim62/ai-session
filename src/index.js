/**
 * @module ai-session-free
 * AI Session Free — Core Library Entry Point
 *
 * Query ChatGPT, Claude, and Gemini headlessly using existing browser sessions.
 */

import * as chatgpt from './providers/chatgpt.js'
import * as claude from './providers/claude.js'
import * as gemini from './providers/gemini.js'

export { chatgpt, claude, gemini }
export { createHttpError } from './utils/http.js'

export const providers = {
  chatgpt,
  claude,
  gemini,
}

/**
 * Get a provider module by string name.
 * @param {'chatgpt' | 'claude' | 'gemini'} name
 */
export function getProvider(name) {
  const provider = providers[name]
  if (!provider) {
    throw new Error(`Unknown provider "${name}". Valid providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

/**
 * @typedef {Object} ProviderAuthResult
 * @property {boolean} authenticated
 * @property {string} loginUrl
 * @property {string} [reason]
 */

/**
 * Check session status across providers.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie'] - 'cookie' for fast passive check, 'network' for reachability check
 * @param {Array<'chatgpt' | 'claude' | 'gemini'>} [options.providers] - List of providers to check (defaults to all)
 * @param {AbortSignal} [options.signal] - Abort signal to cancel network requests
 * @param {(entry: object) => void} [options.onLog] - Diagnostic log callback
 * @returns {Promise<{ available: string[], providers: Record<string, ProviderAuthResult> }>}
 */
export async function checkSession({
  mode = 'cookie',
  providers: targetProviders = Object.keys(providers),
  signal,
  onLog,
} = {}) {
  const defaultLoginUrls = {
    chatgpt: 'https://chatgpt.com/auth/login',
    claude: 'https://claude.ai/login',
    gemini: 'https://gemini.google.com/',
  }

  const entries = await Promise.all(
    targetProviders.map(async (name) => {
      const provider = getProvider(name)
      try {
        const result = await provider.checkAuth({ mode, signal, onLog })
        return [name, result]
      } catch (err) {
        return [
          name,
          {
            authenticated: false,
            loginUrl: defaultLoginUrls[name] || 'https://google.com',
            reason: err.message || String(err),
          },
        ]
      }
    }),
  )

  const providersMap = Object.fromEntries(entries)
  const available = Object.keys(providersMap).filter((name) => providersMap[name].authenticated)

  return { available, providers: providersMap }
}

/**
 * Unified prompt dispatcher.
 * @param {'chatgpt' | 'claude' | 'gemini'} providerName
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk]
 * @param {AbortSignal} [options.signal]
 * @param {(entry: object) => void} [options.onLog]
 * @returns {Promise<string>}
 */
export async function sendPrompt(providerName, prompt, { onChunk, signal, onLog } = {}) {
  const provider = getProvider(providerName)
  return provider.sendPrompt(prompt, { onChunk, signal, onLog })
}
