/**
 * @module utils/manifest
 * Manifest configuration constants and runtime diagnostic validator.
 */

export const REQUIRED_PERMISSIONS = [
  'cookies',
  'storage',
  'declarativeNetRequestWithHostAccess',
]

export const PROVIDER_HOST_PERMISSIONS = {
  chatgpt: ['https://*.chatgpt.com/*', 'https://*.openai.com/*'],
  claude: ['https://claude.ai/*'],
  gemini: ['https://*.google.com/*', 'https://gemini.google.com/*'],
  kimi: ['https://*.kimi.ai/*', 'https://*.kimi.com/*', 'https://*.kimi.moonshot.cn/*'],
  copilot: ['https://*.bing.com/*', 'https://copilot.microsoft.com/*'],
  deepseek: ['https://chat.deepseek.com/*'],
}

/**
 * Complete list of host permissions required to support all 6 AI providers.
 * Can be spread directly into manifest.json / manifest.config.ts.
 */
export const HOST_PERMISSIONS = Array.from(
  new Set(Object.values(PROVIDER_HOST_PERMISSIONS).flat())
)

let hasWarnedManifest = false

/**
 * Validates the running extension's manifest at runtime and logs clear,
 * actionable diagnostics in DevTools if permissions or CSP are missing.
 *
 * @param {string} [targetProvider] Optional specific provider to validate
 * @returns {{ valid: boolean, missingHostPermissions: string[], missingCsp: boolean }}
 */
export function validateManifest(targetProvider) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) {
    return { valid: true, missingHostPermissions: [], missingCsp: false }
  }

  try {
    const manifest = chrome.runtime.getManifest()
    const hostPermissions = manifest.host_permissions || []
    const csp = manifest.content_security_policy?.extension_pages || ''

    const providersToCheck = targetProvider
      ? [targetProvider]
      : Object.keys(PROVIDER_HOST_PERMISSIONS)

    const missingHostPermissions = []

    for (const provider of providersToCheck) {
      const required = PROVIDER_HOST_PERMISSIONS[provider] || []
      for (const pattern of required) {
        // Strip wildcards and protocol for basic matching check
        const domainMatch = pattern.replace(/^https?:\/\/(\*\.)?/, '').replace(/\/\*$/, '')
        const hasMatch = hostPermissions.some((p) => p.includes(domainMatch) || p === '<all_urls>')
        if (!hasMatch && !missingHostPermissions.includes(pattern)) {
          missingHostPermissions.push(pattern)
        }
      }
    }

    const missingCsp =
      (providersToCheck.includes('deepseek') || !targetProvider) &&
      !csp.includes('wasm-unsafe-eval')

    const valid = missingHostPermissions.length === 0 && !missingCsp

    if (!valid && !hasWarnedManifest) {
      if (missingHostPermissions.length > 0) {
        console.warn(
          `[ai-session-free] ⚠ Missing host_permissions in manifest.json for AI providers:\n` +
            missingHostPermissions.map((p) => `  - "${p}"`).join('\n') +
            `\nAdd these to your manifest.json "host_permissions" to avoid fetch/CORS blocks.`
        )
      }
      if (missingCsp) {
        console.warn(
          `[ai-session-free] ⚠ DeepSeek requires "wasm-unsafe-eval" in content_security_policy to solve Proof-of-Work puzzles.\n` +
            `Add to manifest.json: "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
        )
      }
      hasWarnedManifest = true
    }

    return { valid, missingHostPermissions, missingCsp }
  } catch (err) {
    return { valid: true, missingHostPermissions: [], missingCsp: false }
  }
}
