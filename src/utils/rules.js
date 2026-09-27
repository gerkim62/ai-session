/**
 * Declarative Net Request rules for Origin/Referer header spoofing.
 * Supports programmatic dynamic installation in MV3 via chrome.declarativeNetRequest.updateDynamicRules.
 *
 * Uses dedicated namespaced rule IDs (91001 - 91007) to ensure 100% collision-free
 * coexistence with any dynamic or static rules the host extension already defines.
 */

import { createLogger } from './log.js'

const log = createLogger('system')

export const RULE_ID_OFFSET = 91000

export const NET_RULES = [
  {
    id: 91001,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://chatgpt.com' },
        { header: 'Referer', operation: 'set', value: 'https://chatgpt.com/' },
      ],
    },
    condition: {
      requestDomains: ['chatgpt.com'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
  {
    id: 91002,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://claude.ai' },
        { header: 'Referer', operation: 'set', value: 'https://claude.ai/' },
      ],
    },
    condition: {
      requestDomains: ['claude.ai'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
  {
    id: 91003,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://gemini.google.com' },
        { header: 'Referer', operation: 'set', value: 'https://gemini.google.com/' },
      ],
    },
    condition: {
      requestDomains: ['gemini.google.com'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
  {
    id: 91004,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://kimi.ai' },
        { header: 'Referer', operation: 'set', value: 'https://kimi.ai/' },
      ],
    },
    condition: {
      requestDomains: ['kimi.ai', 'www.kimi.ai'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
  {
    id: 91005,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://www.bing.com' },
        { header: 'Referer', operation: 'set', value: 'https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx' },
      ],
    },
    condition: {
      requestDomains: ['sydney.bing.com', 'www.bing.com', 'bing.com', 'copilot.microsoft.com'],
      resourceTypes: ['xmlhttprequest', 'websocket', 'other'],
    },
  },
  {
    id: 91006,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://chat.deepseek.com' },
        { header: 'Referer', operation: 'set', value: 'https://chat.deepseek.com/' },
      ],
    },
    condition: {
      requestDomains: ['chat.deepseek.com'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
  {
    id: 91007,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://www.kimi.com' },
        { header: 'Referer', operation: 'set', value: 'https://www.kimi.com/' },
      ],
    },
    condition: {
      requestDomains: ['kimi.com', 'kimi.moonshot.cn', 'www.kimi.com'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  },
]

let rulesInstalled = false
let dynamicRulesDisabled = false
let initPromise = null

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
 * @param {(entry: object) => void} [onLog]
 * @returns {Promise<boolean>}
 */
export async function setupDynamicRules(onLog) {
  if (dynamicRulesDisabled) return false
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) {
    return false
  }

  const ruleIds = NET_RULES.map((r) => r.id)
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds,
      addRules: NET_RULES,
    })
    rulesInstalled = true
    log(onLog, 'debug', 'DYNAMIC_RULES', 'Configured DeclarativeNetRequest dynamic rules', {
      ruleCount: NET_RULES.length,
    })
    return true
  } catch (err) {
    console.warn('[ai-session-free] Failed to configure dynamic rules:', err)
    log(onLog, 'warn', 'DYNAMIC_RULES_ERROR', `Failed to configure dynamic rules: ${err.message || String(err)}`, {
      error: err.message || String(err),
    })
    return false
  }
}

/**
 * Ensures rules are installed and active. If another part of the extension
 * modified or cleared dynamic rules, this safely re-installs ai-session-free's rules.
 * Uses an in-flight promise mutex to prevent concurrent registration races and
 * avoids redundant writes if rules 91001-91007 are already present.
 *
 * @param {(entry: object) => void} [onLog]
 * @returns {Promise<void>}
 */
export async function ensureDynamicRules(onLog) {
  if (dynamicRulesDisabled || rulesInstalled) return
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.getDynamicRules) return

  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules()
      const hasAllRules = NET_RULES.every((r) => existing.some((e) => e.id === r.id))

      if (hasAllRules) {
        rulesInstalled = true
        return
      }
      await setupDynamicRules(onLog)
    } catch {
      await setupDynamicRules(onLog)
    } finally {
      initPromise = null
    }
  })()

  return initPromise
}
