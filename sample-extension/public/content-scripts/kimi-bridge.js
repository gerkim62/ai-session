// kimi-bridge.js — Runs on *.kimi.ai, *.kimi.com, and *.kimi.moonshot.cn
// Automatically syncs Kimi session tokens to chrome.storage.local
(function syncKimiToken() {
  function findTokens() {
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

      // Also inspect all localStorage keys in case tokens are stored under other keys or in JSON
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (!key) continue
        const val = window.localStorage.getItem(key)
        if (!val || typeof val !== 'string') continue

        // Check if value is a raw JWT token (starts with eyJ)
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
          } catch {
            // Ignore non-JSON
          }
        }
      }

      if (refreshToken || accessToken) {
        return { refreshToken, accessToken, origin }
      }
    } catch {
      // Storage access blocked or restricted
    }
    return null
  }

  function sync() {
    const tokens = findTokens()
    if (!tokens) return false

    const { refreshToken, accessToken, origin } = tokens
    const update = { kimi_origin: origin }
    if (refreshToken) update.kimi_refresh_token = refreshToken
    if (accessToken) update.kimi_access_token = accessToken

    chrome.storage.local.get(['kimi_refresh_token', 'kimi_access_token', 'kimi_origin'], (res) => {
      const changed =
        res.kimi_refresh_token !== refreshToken ||
        res.kimi_access_token !== accessToken ||
        res.kimi_origin !== origin

      if (changed) {
        chrome.storage.local.set(update, () => {
          console.log(
            `%c[ai-session-free] Synced Kimi tokens from ${origin}! You can now close this tab.`,
            'color: #00d26a; font-weight: bold;',
            { hasRefreshToken: !!refreshToken, hasAccessToken: !!accessToken, origin },
          )
        })
      }
    })
    return true
  }

  // Initial attempt
  const found = sync()

  // Poll for up to 60 seconds (catches token set after interactive login in SPA)
  let elapsed = 0
  const interval = setInterval(() => {
    elapsed += 1000
    if (sync() || elapsed >= 60000) {
      clearInterval(interval)
    }
  }, 1000)

  // Also listen for storage events across tabs
  window.addEventListener('storage', () => sync())
})()
