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
