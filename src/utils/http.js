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
 * Throw a descriptive error if a fetch Response is not ok, logging the error if a logger is provided.
 * @param {Response} resp
 * @param {string} [label] - Context label prepended to the error message
 * @param {object} [options]
 * @param {((entry: import('./log.js').LogEntry) => void)} [options.onLog] - Diagnostic log callback
 * @param {Function} [options.log] - Provider logger instance created with createLogger
 */
export async function assertOk(resp, label = '', { onLog, log } = {}) {
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
  throw new Error(`${prefix}HTTP ${resp.status}: ${body.slice(0, 200)}`)
}

