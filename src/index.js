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
