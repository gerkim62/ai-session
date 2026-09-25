/**
 * @module ai-session-free
 * AI Session Free — Core Library Entry Point
 *
 * Query ChatGPT, Claude, and Gemini headlessly using existing browser sessions.
 */

import * as chatgpt from './providers/chatgpt.js'
import * as claude from './providers/claude.js'
import * as gemini from './providers/gemini.js'
import * as kimi from './providers/kimi.js'
import * as copilot from './providers/copilot.js'
import * as deepseek from './providers/deepseek.js'
import { NET_RULES, setupDynamicRules, ensureDynamicRules, disableDynamicRules } from './utils/rules.js'

export { chatgpt, claude, gemini, kimi, copilot, deepseek }
export { createHttpError } from './utils/http.js'
export { NET_RULES, setupDynamicRules, ensureDynamicRules, disableDynamicRules }

export const providers = {
  chatgpt,
  claude,
  gemini,
  kimi,
  copilot,
  deepseek,
}

/**
 * Returns static metadata for a given provider name without needing cookies or network calls.
 * @param {string} name
 * @returns {{ id: string, displayName: string, shortName: string, loginUrl: string, challengeUrl: string, homeUrl: string } | null}
 */
export function getProviderMetadata(name) {
  return providers[name]?.metadata || null
}

/**
 * Returns metadata for all registered providers.
 * @returns {Record<string, { id: string, displayName: string, shortName: string, loginUrl: string, challengeUrl: string, homeUrl: string }>}
 */
export function getAllProvidersMetadata() {
  const result = {}
  for (const [key, p] of Object.entries(providers)) {
    if (p.metadata) {
      result[key] = p.metadata
    }
  }
  return result
}

/**
 * Get a provider module by string name.
 * @param {'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'copilot' | 'deepseek'} name
 */
export function getProvider(name) {
  const provider = providers[name]
  if (!provider) {
    throw new Error(`Unknown provider "${name}". Valid providers: ${Object.keys(providers).join(', ')}`)
  }
  return provider
}

/**
 * @typedef {Object} ProviderMetadata
 * @property {string} id
 * @property {string} displayName
 * @property {string} shortName
 * @property {string} loginUrl
 * @property {string} challengeUrl
 * @property {string} homeUrl
 */

/**
 * @typedef {Object} ProviderAuthResult
 * @property {boolean} authenticated
 * @property {string} loginUrl
 * @property {string} [challengeUrl]
 * @property {string} [reason]
 * @property {ProviderMetadata} [metadata]
 */

/**
 * Check session status across providers.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie'] - 'cookie' for fast passive check, 'network' for reachability check
 * @param {Array<'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'copilot' | 'deepseek'>} [options.providers] - List of providers to check (defaults to all)
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
  await ensureDynamicRules()
  const entries = await Promise.all(
    targetProviders.map(async (name) => {
      const provider = getProvider(name)
      const metadata = provider.metadata
      try {
        const result = await provider.checkAuth({ mode, signal, onLog })
        return [
          name,
          {
            loginUrl: metadata?.loginUrl || 'https://google.com',
            challengeUrl: metadata?.challengeUrl,
            metadata,
            ...result,
          },
        ]
      } catch (err) {
        return [
          name,
          {
            authenticated: false,
            loginUrl: metadata?.loginUrl || 'https://google.com',
            challengeUrl: metadata?.challengeUrl,
            reason: err.message || String(err),
            metadata,
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
 * @param {'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'copilot' | 'deepseek'} providerName
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk]
 * @param {AbortSignal} [options.signal]
 * @param {(entry: object) => void} [options.onLog]
 * @returns {Promise<string>}
 */
export async function sendPrompt(providerName, prompt, { onChunk, signal, onLog, ...rest } = {}) {
  await ensureDynamicRules()
  const provider = getProvider(providerName)
  try {
    return await provider.sendPrompt(prompt, { onChunk, signal, onLog, ...rest })
  } catch (err) {
    if (provider.metadata) {
      if (err.code === 'AUTH_REQUIRED' && !err.actionUrl) {
        err.actionUrl = provider.metadata.loginUrl
      } else if (err.code === 'CLOUDFLARE_CHALLENGE' && !err.actionUrl) {
        err.actionUrl = provider.metadata.challengeUrl
      }
    }
    throw err
  }
}
