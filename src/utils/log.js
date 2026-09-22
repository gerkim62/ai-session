/**
 * @module utils/log
 * Shared structured logging utility for provider modules.
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} provider - Provider name (e.g. 'chatgpt', 'claude', 'gemini')
 * @property {'debug'|'info'|'warn'|'error'} level
 * @property {string} category - Event category (e.g. 'NETWORK_REQUEST', 'SSE_RAW')
 * @property {string} message - Human-readable description
 * @property {*} [data] - Optional payload / diagnostic details
 */

/**
 * Create a provider-scoped log function.
 * @param {string} provider - Provider identifier baked into every log entry
 * @returns {(onLog: ((entry: LogEntry) => void) | undefined, level: string, category: string, message: string, data?: any) => void}
 */
export function createLogger(provider) {
  return function log(onLog, level, category, message, data) {
    if (typeof onLog === 'function') {
      try {
        onLog({
          timestamp: new Date().toISOString(),
          provider,
          level,
          category,
          message,
          data,
        })
      } catch {
        // Do not let logger failures interrupt execution
      }
    }
  }
}
