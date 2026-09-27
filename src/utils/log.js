/**
 * @module utils/log
 * Shared structured logging utility for provider modules with built-in
 * sensitive data masking and redaction.
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
 * @typedef {Object} MaskOptions
 * @property {boolean} [maskSensitive=true] - Whether masking is enabled
 * @property {number} [textMaxLength=60] - Max character preview length for prompts/responses
 */

const SENSITIVE_KEY_REGEX =
  /^(authorization|cookie|cookies|accesstoken|access_token|refreshtoken|refresh_token|usertoken|user_token|sessionkey|session_key|sessiontoken|session_token|psid|psidts|__secure-1psid|__secure-1psidts|_u|snlm0e|cfb2h|prooftoken|proof_token|sec_access_token|encryptedsignature|signature|password|secret|api_key|apikey|x-sydney-encryptedconversationsignature|openai-sentinel-proof-token|openai-sentinel-chat-requirements-token|x-ds-pow-response)$/i

const PROMPT_KEY_REGEX = /^(prompt)$/i

const RESPONSE_KEY_REGEX =
  /^(answer|delta|raw|rawpayload|rawpayloadpreview|rawanswerpreview|completion)$/i

/**
 * Mask a secret string (token, password, key) while preserving debug utility:
 * - If >= 12 chars: first 6 chars + ...[+N chars]... + last 4 chars
 * - If < 12 chars: first 1 char + *** + last 1 char + [len=N]
 * - If <= 2 chars: *** [len=N]
 *
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (typeof value !== 'string') return value
  if (!value) return ''
  const len = value.length

  if (len <= 2) {
    return `*** [len=${len}]`
  }

  if (len < 12) {
    return `${value[0]}***${value[len - 1]} [len=${len}]`
  }

  const prefix = value.slice(0, 6)
  const suffix = value.slice(-4)
  const hiddenCount = len - 10
  return `${prefix}...[+${hiddenCount} chars]...${suffix}`
}

/**
 * Mask a semicolon-separated cookie header string (e.g. "a=123; b=456")
 * Preserves cookie names while masking the corresponding values.
 *
 * @param {string} cookieStr
 * @returns {string}
 */
export function maskCookieString(cookieStr) {
  if (typeof cookieStr !== 'string') return cookieStr
  if (!cookieStr) return ''

  return cookieStr
    .split(';')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return ''
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) {
        return maskSecret(trimmed)
      }
      const name = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      return `${name}=${maskSecret(val)}`
    })
    .filter(Boolean)
    .join('; ')
}

/**
 * Truncate long prompt or AI response text to a safe preview with length metadata.
 *
 * @param {string} text
 * @param {number} [maxLength=60]
 * @returns {string}
 */
export function maskTextPreview(text, maxLength = 60) {
  if (typeof text !== 'string') return text
  if (!text) return ''
  if (text.length <= maxLength) return text

  const remaining = text.length - maxLength
  return `${text.slice(0, maxLength)}... [+${remaining} chars]`
}

/**
 * Scan arbitrary strings and sanitize embedded Bearer tokens or sensitive cookie assignments.
 *
 * @param {string} str
 * @returns {string}
 */
export function maskStringSecrets(str) {
  if (typeof str !== 'string' || !str) return str

  // 1. Mask Bearer <token>
  let out = str.replace(/Bearer\s+([A-Za-z0-9_\-.~+/=]{6,})/gi, (_, tok) => `Bearer ${maskSecret(tok)}`)

  // 2. Mask known sensitive key=value occurrences
  out = out.replace(
    /\b(__Secure-1PSID(?:TS)?|sessionKey|_U|oai-did|userToken|access_token|refresh_token)=([^;,\s"']+)/gi,
    (_, name, val) => `${name}=${maskSecret(val)}`
  )

  return out
}

/**
 * Recursively mask sensitive credentials and truncate prompts/completions in data payloads.
 *
 * @param {*} data - Raw data payload to sanitize
 * @param {MaskOptions} [options]
 * @param {WeakSet<object>} [seen] - Cycle detection set
 * @returns {*} Sanitized copy of data
 */
export function maskSensitiveData(data, options = {}, seen = new WeakSet()) {
  if (options.maskSensitive === false) {
    return data
  }

  if (data === null || data === undefined) {
    return data
  }

  const textMaxLength = typeof options.textMaxLength === 'number' ? options.textMaxLength : 60

  // String handling
  if (typeof data === 'string') {
    // If string is JSON formatted, try to parse and sanitize the internal structure
    const trimmed = data.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed)
        const sanitized = maskSensitiveData(parsed, options, seen)
        return JSON.stringify(sanitized)
      } catch {
        // Fall through to regex string masking
      }
    }
    return maskStringSecrets(data)
  }

  // Non-object primitives (numbers, booleans, symbols)
  if (typeof data !== 'object') {
    return data
  }

  // Circular reference guard
  if (seen.has(data)) {
    return '[Circular]'
  }
  seen.add(data)

  // Error handling
  if (data instanceof Error) {
    return {
      name: data.name,
      message: maskStringSecrets(data.message),
      code: data.code,
      status: data.status,
      actionUrl: data.actionUrl,
      provider: data.provider,
      ...(data.stack && { stack: maskStringSecrets(data.stack) }),
    }
  }

  // Array handling
  if (Array.isArray(data)) {
    return data.map((item) => {
      // Check if item is a chrome cookie object { name, value, ... }
      if (item && typeof item === 'object' && typeof item.name === 'string' && 'value' in item) {
        return {
          ...item,
          value: maskSecret(item.value),
        }
      }
      return maskSensitiveData(item, options, seen)
    })
  }

  // Check if object is a single chrome cookie object { name, value, domain, ... }
  if (typeof data.name === 'string' && typeof data.value === 'string' && ('domain' in data || 'path' in data)) {
    return {
      ...data,
      value: maskSecret(data.value),
    }
  }

  // Generic object handling
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    // Ignore internal masking directive
    if (key === '_maskSensitive') continue

    // 1. Sensitive secret keys (tokens, auth, cookies)
    if (SENSITIVE_KEY_REGEX.test(key)) {
      if (typeof value === 'string') {
        if (/^authorization$/i.test(key)) {
          if (value.toLowerCase().startsWith('bearer ')) {
            result[key] = `Bearer ${maskSecret(value.slice(7).trim())}`
          } else {
            result[key] = maskSecret(value)
          }
        } else if (/^cookies?$/i.test(key)) {
          result[key] = maskCookieString(value)
        } else {
          result[key] = maskSecret(value)
        }
      } else if (Array.isArray(value)) {
        result[key] = maskSensitiveData(value, options, seen)
      } else if (value && typeof value === 'object') {
        // e.g. { psid: { name, value }, psidts: { name, value } }
        result[key] = maskSensitiveData(value, options, seen)
      } else {
        result[key] = value
      }
      continue
    }

    // 2. User prompt keys
    if (PROMPT_KEY_REGEX.test(key)) {
      if (typeof value === 'string') {
        result[key] = maskTextPreview(value, textMaxLength)
      } else {
        result[key] = maskSensitiveData(value, options, seen)
      }
      continue
    }

    // 3. AI response / stream content keys
    if (RESPONSE_KEY_REGEX.test(key)) {
      if (typeof value === 'string') {
        result[key] = maskTextPreview(value, textMaxLength)
      } else {
        result[key] = maskSensitiveData(value, options, seen)
      }
      continue
    }

    // 4. Special nested fields (e.g. Gemini 'f.req', ChatGPT/Kimi 'messages')
    if (key === 'f.req') {
      if (typeof value === 'string') {
        result[key] = maskTextPreview(value, textMaxLength)
      } else {
        result[key] = maskSensitiveData(value, options, seen)
      }
      continue
    }

    if (key === 'messages' && Array.isArray(value)) {
      result[key] = value.map((msg) => {
        if (!msg || typeof msg !== 'object') return msg
        const copy = { ...msg }
        if (typeof copy.content === 'string') {
          copy.content = maskTextPreview(copy.content, textMaxLength)
        } else if (copy.content && typeof copy.content === 'object') {
          const contentCopy = { ...copy.content }
          if (Array.isArray(contentCopy.parts)) {
            contentCopy.parts = contentCopy.parts.map((part) =>
              typeof part === 'string' ? maskTextPreview(part, textMaxLength) : maskSensitiveData(part, options, seen)
            )
          }
          copy.content = contentCopy
        }
        return copy
      })
      continue
    }

    // 5. Default recursive sanitization for nested objects/arrays
    result[key] = maskSensitiveData(value, options, seen)
  }

  return result
}

/**
 * Create a provider-scoped log function with automatic sensitive data masking.
 *
 * @param {string} provider - Provider identifier baked into every log entry
 * @param {MaskOptions} [defaultOptions] - Optional default masking options
 * @returns {(onLog: ((entry: LogEntry) => void) | undefined, level: string, category: string, message: string, data?: any, logOptions?: MaskOptions) => void}
 */
export function createLogger(provider, defaultOptions = {}) {
  return function log(onLog, level, category, message, data, logOptions) {
    if (typeof onLog === 'function') {
      try {
        const maskSensitive =
          logOptions?.maskSensitive ??
          onLog.maskSensitive ??
          (typeof data === 'object' && data !== null && '_maskSensitive' in data
            ? data._maskSensitive
            : defaultOptions?.maskSensitive ?? true)

        let safeData = data
        let safeMessage = message

        if (maskSensitive !== false) {
          const mergedOptions = { ...defaultOptions, ...logOptions, maskSensitive }
          safeData = maskSensitiveData(data, mergedOptions)
          safeMessage = maskStringSecrets(message)
        }

        onLog({
          timestamp: new Date().toISOString(),
          provider,
          level,
          category,
          message: safeMessage,
          data: safeData,
        })
      } catch {
        // Do not let logger failures interrupt execution
      }
    }
  }
}
