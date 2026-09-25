/**
 * @module utils/crypto
 * Shared cryptographic utilities.
 */

/**
 * Generate a v4 UUID using the Web Crypto API.
 * @returns {string}
 */
export function generateUUID() {
  return crypto.randomUUID()
}

/**
 * Safely decodes a base64url-encoded string across both browser and Node environments.
 * @param {string} base64url
 * @returns {string}
 */
export function decodeBase64Url(base64url) {
  const raw = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=')
  if (typeof atob === 'function') {
    return atob(padded)
  }
  return Buffer.from(padded, 'base64').toString('binary')
}

/**
 * Decode JWT JSON payload without external dependencies.
 * @param {string} jwt
 * @returns {Record<string, any> | null}
 */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const decoded = decodeBase64Url(parts[1])
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

/**
 * Decode JWT expiration timestamp in seconds.
 * @param {string} jwt
 * @returns {number | null} Expiration timestamp in seconds, or null if not parseable
 */
export function getJwtExp(jwt) {
  const payload = decodeJwtPayload(jwt)
  return payload && typeof payload.exp === 'number' ? payload.exp : null
}
