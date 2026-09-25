/**
 * @module ai-session-free/bridge
 * Universal Web Token Bridge for Content Scripts.
 *
 * Automatically detects whether the current page is Kimi or DeepSeek,
 * extracts session tokens from window.localStorage, and syncs them
 * seamlessly to chrome.storage.local.
 *
 * Usage in any existing extension content script:
 *   import 'ai-session-free/bridge'
 * Or programmatically:
 *   import { syncWebTokens } from 'ai-session-free/bridge'
 *   syncWebTokens()
 */

export function syncDeepSeekToken() {
  if (typeof window === 'undefined' || !window.location) return false
  const host = window.location.hostname
  if (!host.includes('deepseek.com')) return false

  try {
    const raw =
      window.localStorage.getItem('userToken') ||
      window.localStorage.userToken ||
      ''
    let token = raw
    if (raw && typeof raw === 'string' && raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        token = parsed.value || parsed.token || raw
      } catch {
        // Keep raw string
      }
    }
    if (token && typeof token === 'string' && token.length > 10) {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['deepseek_user_token'], (res) => {
          if (res.deepseek_user_token !== token) {
            chrome.storage.local.set({ deepseek_user_token: token }, () => {
              console.log('[ai-session-free] Synced DeepSeek userToken to extension storage')
            })
          }
        })
      }
      return true
    }
  } catch {
    // Storage access blocked or unavailable
  }
  return false
}

export function syncKimiToken() {
  if (typeof window === 'undefined' || !window.location) return false
  const host = window.location.hostname
  if (!host.includes('kimi.ai') && !host.includes('kimi.com') && !host.includes('moonshot.cn')) {
    return false
  }

  try {
    const origin = window.location.origin
    let refreshToken =
      window.localStorage.getItem('refresh_token') ||
      window.localStorage.refresh_token ||
      ''
    let accessToken =
      window.localStorage.getItem('access_token') ||
      window.localStorage.access_token ||
      window.localStorage.getItem('token') ||
      window.localStorage.token ||
      ''

    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key) continue
      const val = window.localStorage.getItem(key)
      if (!val || typeof val !== 'string') continue

      if (val.startsWith('eyJ')) {
        if (!refreshToken && key.toLowerCase().includes('refresh')) {
          refreshToken = val
        } else if (!accessToken) {
          accessToken = val
        }
      } else if (val.startsWith('{') && val.includes('token')) {
        try {
          const parsed = JSON.parse(val)
          if (parsed.refresh_token && !refreshToken) refreshToken = parsed.refresh_token
          if (parsed.access_token && !accessToken) accessToken = parsed.access_token
          if (parsed.token && !accessToken) accessToken = parsed.token
        } catch {}
      }
    }

    if (refreshToken || accessToken) {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const update = { kimi_origin: origin }
        if (refreshToken) update.kimi_refresh_token = refreshToken
        if (accessToken) update.kimi_access_token = accessToken
        chrome.storage.local.get(['kimi_refresh_token', 'kimi_access_token'], (res) => {
          if (res.kimi_refresh_token !== refreshToken || res.kimi_access_token !== accessToken) {
            chrome.storage.local.set(update, () => {
              console.log('[ai-session-free] Synced Kimi tokens to extension storage')
            })
          }
        })
      }
      return true
    }
  } catch {
    // Storage access blocked or unavailable
  }
  return false
}

export function syncWebTokens() {
  const isDeepSeek = syncDeepSeekToken()
  const isKimi = syncKimiToken()
  return isDeepSeek || isKimi
}

// Auto-run if executed inside a browser page / content script
if (typeof window !== 'undefined' && window.location) {
  if (!syncWebTokens()) {
    let elapsed = 0
    const interval = setInterval(() => {
      elapsed += 1000
      if (syncWebTokens() || elapsed >= 30000) {
        clearInterval(interval)
      }
    }, 1000)
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'userToken' || e.key === 'refresh_token' || e.key === 'access_token') {
      syncWebTokens()
    }
  })
}
