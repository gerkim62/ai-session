/**
 * Declarative Net Request rules for Origin/Referer header spoofing.
 * Supports programmatic dynamic installation in MV3 via chrome.declarativeNetRequest.updateDynamicRules.
 *
 * Uses dedicated namespaced rule IDs (91001 - 91007) to ensure 100% collision-free
 * coexistence with any dynamic or static rules the host extension already defines.
 */

export const RULE_ID_OFFSET = 91000

export const NET_RULES = [
  {
    id: 91001,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://chatgpt.com' },
        { operation: 'set', header: 'referer', value: 'https://chatgpt.com' },
      ],
    },
    condition: {
      requestDomains: ['chatgpt.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 91002,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://claude.ai' },
        { operation: 'set', header: 'referer', value: 'https://claude.ai' },
      ],
    },
    condition: {
      requestDomains: ['claude.ai'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 91003,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://gemini.google.com' },
        { operation: 'set', header: 'referer', value: 'https://gemini.google.com' },
      ],
    },
    condition: {
      requestDomains: ['gemini.google.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 91004,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://kimi.ai' },
        { operation: 'set', header: 'referer', value: 'https://kimi.ai/' },
      ],
    },
    condition: {
      requestDomains: ['kimi.ai', 'www.kimi.ai'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 91005,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://www.bing.com' },
        { operation: 'set', header: 'referer', value: 'https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx' },
      ],
    },
    condition: {
      requestDomains: ['sydney.bing.com', 'www.bing.com', 'bing.com', 'copilot.microsoft.com'],
      resourceTypes: ['xmlhttprequest', 'websocket'],
    },
  },
  {
    id: 91006,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://chat.deepseek.com' },
        { operation: 'set', header: 'referer', value: 'https://chat.deepseek.com/' },
      ],
    },
    condition: {
      requestDomains: ['chat.deepseek.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 91007,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { operation: 'set', header: 'origin', value: 'https://www.kimi.com' },
        { operation: 'set', header: 'referer', value: 'https://www.kimi.com/' },
      ],
    },
    condition: {
      requestDomains: ['kimi.com', 'kimi.moonshot.cn', 'www.kimi.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  },
]

let rulesInstalled = false
let dynamicRulesDisabled = false

/**
 * Opt-out: disable automatic dynamic rule registration if the host extension
 * prefers to manage DNR rules exclusively through its own static rulesets.
 */
export function disableDynamicRules() {
  dynamicRulesDisabled = true
}

/**
 * Automatically registers or refreshes dynamic declarativeNetRequest rules.
 * Safe to call multiple times (idempotent).
 * Only adds/removes rule IDs in the dedicated 91001-91007 range, never touching
 * any custom dynamic rules the host extension created.
 *
 * @returns {Promise<boolean>}
 */
export async function setupDynamicRules() {
  if (dynamicRulesDisabled) return false
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) {
    return false
  }
  try {
    const ruleIds = NET_RULES.map((r) => r.id)
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds,
      addRules: NET_RULES,
    })
    rulesInstalled = true
    return true
  } catch (err) {
    console.warn('[ai-session-free] Failed to configure dynamic rules:', err)
    return false
  }
}

/**
 * Ensures rules are installed and active. If another part of the extension
 * modified or cleared dynamic rules, this safely re-installs ai-session-free's rules.
 */
export async function ensureDynamicRules() {
  if (dynamicRulesDisabled) return
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.getDynamicRules) return

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules()
    const hasOurRules = existing.some((r) => r.id >= 91001 && r.id <= 91007)
    if (!hasOurRules) {
      await setupDynamicRules()
    }
  } catch {
    if (!rulesInstalled) {
      await setupDynamicRules()
    }
  }
}
