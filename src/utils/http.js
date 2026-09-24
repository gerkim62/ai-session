/**
 * @module utils/http
 * Shared HTTP / cookie utilities for provider modules.
 */

/**
 * Build a semicolon-delimited cookie string from a chrome.cookies result array.
 * @param {Array<{name: string, value: string}>} cookies
 * @returns {string}
 */
export function buildCookieString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * Create an Error decorated with status, code, provider metadata, and actionUrl.
 * @param {string} message
 * @param {number|null} [status]
 * @param {string} [provider]
 * @param {string} [code]
 * @param {string|null} [actionUrl]
 * @returns {Error & { status: number|null, code: string, provider?: string, actionUrl?: string }}
 */
export function createHttpError(message, status = null, provider, code, actionUrl = null) {
  const err = new Error(message)
  err.status = status ?? null
  if (provider) err.provider = provider

  if (code) {
    err.code = code
  } else if (status === 401) {
    err.code = 'AUTH_REQUIRED'
  } else if (status === 403) {
    err.code = /cloudflare|challenge|turnstile/i.test(message) ? 'CLOUDFLARE_CHALLENGE' : 'FORBIDDEN'
  } else if (status === 429) {
    err.code = 'RATE_LIMITED'
  } else if (typeof status === 'number' && status > 0) {
    err.code = 'HTTP_ERROR'
  } else {
    err.code = 'AUTH_REQUIRED'
  }

  // Attach actionable resolution URL
  if (actionUrl) {
    err.actionUrl = actionUrl
  }

  return err
}

/**
 * Throw a descriptive error if a fetch Response is not ok, logging the error if a logger is provided.
 * @param {Response} resp
 * @param {string} [label] - Context label prepended to the error message
 * @param {object} [options]
 * @param {((entry: import('./log.js').LogEntry) => void)} [options.onLog] - Diagnostic log callback
 * @param {Function} [options.log] - Provider logger instance created with createLogger
 * @param {string} [options.provider] - Provider name to attach to thrown error
 */
export async function assertOk(resp, label = '', { onLog, log, provider } = {}) {
  if (resp.ok) return
  const body = await resp.text().catch(() => '')
  if (typeof log === 'function') {
    const errorDesc = label ? `${label} failed with HTTP ${resp.status}` : `HTTP ${resp.status} error`
    log(onLog, 'error', 'NETWORK_RESPONSE', errorDesc, {
      status: resp.status,
      body,
    })
  }
  const prefix = label ? `${label}: ` : ''
  throw createHttpError(`${prefix}HTTP ${resp.status}: ${body.slice(0, 200)}`, resp.status, provider)
}

