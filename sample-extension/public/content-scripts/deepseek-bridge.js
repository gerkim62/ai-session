// deepseek-bridge.js — Runs on chat.deepseek.com
// Automatically syncs DeepSeek userToken to chrome.storage.local
(function syncDeepSeekToken() {
  function sync() {
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
        chrome.storage.local.get(['deepseek_user_token'], (res) => {
          if (res.deepseek_user_token !== token) {
            chrome.storage.local.set({ deepseek_user_token: token }, () => {
              console.log(
                '[ai-session-free] Synced DeepSeek userToken to extension storage. You can now close this tab!',
              )
            })
          }
        })
        return true
      }
    } catch {
      // Storage access blocked or unavailable
    }
    return false
  }

  // Initial attempt
  if (!sync()) {
    // Poll for the first 30 seconds (catches token written after interactive login)
    let elapsed = 0
    const interval = setInterval(() => {
      elapsed += 1000
      if (sync() || elapsed >= 30000) {
        clearInterval(interval)
      }
    }, 1000)
  }

  // Re-sync on storage events (across tabs)
  window.addEventListener('storage', (e) => {
    if (e.key === 'userToken') sync()
  })
})()
