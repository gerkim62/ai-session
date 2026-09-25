/**
 * Sample Extension App UI Logic
 *
 * Manages prompt input, provider toggles, streaming response columns,
 * and full-stack Run I/O Debug Console with on/off, clear, filter, and JSON download.
 */

import { getAllProvidersMetadata, getProviderMetadata } from 'ai-session-free'

// --- State ---
let port = null
let isLoading = false
let activeProviders = new Set()
let requestCounter = 0

// Debug State (in-memory for active tab session)
let isDebugMode = false
let debugLogs = []
let activeFilter = 'all'

// --- DOM containers ---
const promptInput = document.getElementById('prompt-input')
const btnSend = document.getElementById('btn-send')
const providerTogglesContainer = document.getElementById('provider-toggles')
const responsesContainer = document.getElementById('responses')
const debugFiltersContainer = document.getElementById('debug-filters')
const errorFilterPill = debugFiltersContainer?.querySelector('[data-filter="error"]')

// --- Dynamically generate provider UI elements from library metadata ---
const providersMeta = getAllProvidersMetadata()
const toggles = {}
const cols = {}
const bodies = {}
const statuses = {}

for (const [provider, meta] of Object.entries(providersMeta)) {
  // 1. Toggle checkbox
  const label = document.createElement('label')
  label.className = 'provider-toggle'
  label.dataset.provider = provider
  label.innerHTML = `
    <input type="checkbox" id="toggle-${provider}" checked>
    <span class="dot"></span>
    ${meta.displayName || provider}
  `
  providerTogglesContainer.appendChild(label)
  toggles[provider] = label.querySelector('input')

  // 2. Response column
  const col = document.createElement('div')
  col.className = 'response-col'
  col.id = `col-${provider}`
  col.innerHTML = `
    <div class="col-header" data-provider="${provider}">
      <span class="provider-dot"></span>
      ${meta.displayName || provider}
      <span class="col-status" id="status-${provider}">idle</span>
    </div>
    <div class="col-body empty" id="body-${provider}">Waiting for prompt...</div>
  `
  responsesContainer.appendChild(col)
  cols[provider] = col
  bodies[provider] = col.querySelector(`#body-${provider}`)
  statuses[provider] = col.querySelector(`#status-${provider}`)

  // 3. Debug filter pill
  if (debugFiltersContainer && errorFilterPill) {
    const pill = document.createElement('button')
    pill.className = 'filter-pill'
    pill.dataset.filter = provider
    pill.textContent = meta.displayName || provider
    debugFiltersContainer.insertBefore(pill, errorFilterPill)
  }
}

// Session DOM refs
const btnCheckSession = document.getElementById('btn-check-session')
const sessionBadges = document.getElementById('session-badges')

// Debug DOM refs
const btnDebugFab = document.getElementById('btn-debug-fab')
const debugBadge = document.getElementById('debug-badge')
const debugDrawer = document.getElementById('debug-drawer')
const debugToggle = document.getElementById('debug-toggle')
const debugToggleStatus = document.getElementById('debug-toggle-status')
const btnDebugClear = document.getElementById('btn-debug-clear')
const btnDebugCopy = document.getElementById('btn-debug-copy')
const btnDebugDownload = document.getElementById('btn-debug-download')
const btnDebugClose = document.getElementById('btn-debug-close')
const debugStats = document.getElementById('debug-stats')
const debugLogList = document.getElementById('debug-log-list')
const filterPills = document.querySelectorAll('.filter-pill')

// --- UI State Persistence (localStorage) ---
const STORAGE_KEY = 'ai_session_ui_state'

function loadUIState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    console.warn('Failed to load UI state from localStorage:', err)
    return null
  }
}

function saveUIState() {
  try {
    const togglesState = {}
    for (const [provider, toggle] of Object.entries(toggles)) {
      togglesState[provider] = toggle.checked
    }
    const state = {
      toggles: togglesState,
      isDebugMode,
      activeFilter,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.warn('Failed to save UI state to localStorage:', err)
  }
}

function restoreUIState() {
  const savedState = loadUIState()
  if (!savedState) return

  // Restore provider checkboxes
  if (savedState.toggles && typeof savedState.toggles === 'object') {
    for (const [provider, checked] of Object.entries(savedState.toggles)) {
      if (toggles[provider] && typeof checked === 'boolean') {
        toggles[provider].checked = checked
      }
    }
  }

  // Restore Debug Mode switch
  if (typeof savedState.isDebugMode === 'boolean') {
    isDebugMode = savedState.isDebugMode
    if (debugToggle) debugToggle.checked = isDebugMode
    if (debugToggleStatus) debugToggleStatus.textContent = isDebugMode ? 'Debug: ON' : 'Debug: OFF'
    if (btnDebugFab) btnDebugFab.classList.toggle('active', isDebugMode)
  }

  // Restore active log filter pill
  if (typeof savedState.activeFilter === 'string') {
    const matchingPill = Array.from(filterPills).find(
      (p) => p.getAttribute('data-filter') === savedState.activeFilter
    )
    if (matchingPill) {
      activeFilter = savedState.activeFilter
      for (const pill of filterPills) {
        pill.classList.toggle('active', pill === matchingPill)
      }
    }
  }
}

// --- Column visibility ---
function updateColumnVisibility() {
  for (const [provider, toggle] of Object.entries(toggles)) {
    cols[provider].classList.toggle('hidden', !toggle.checked)
  }
}

for (const toggle of Object.values(toggles)) {
  toggle.addEventListener('change', () => {
    updateColumnVisibility()
    saveUIState()
  })
}

// Restore saved settings on initial load
restoreUIState()
updateColumnVisibility()

// --- Status helpers ---
function setStatus(provider, status, cssClass = '') {
  statuses[provider].textContent = status
  statuses[provider].className = 'col-status ' + cssClass
}

function setBody(provider, text, isEmpty = false) {
  bodies[provider].textContent = text
  bodies[provider].classList.toggle('empty', isEmpty)
}

// --- Port connection ---
function connectPort() {
  port = chrome.runtime.connect({ name: 'ai-prompt' })

  port.onMessage.addListener((msg) => {
    const { type, provider, requestId, text, error, entry } = msg

    switch (type) {
      case 'CHUNK':
        setStatus(provider, 'streaming...', 'loading')
        setBody(provider, text)
        break

      case 'DONE':
        setStatus(provider, 'done', 'done')
        if (bodies[provider] && (bodies[provider].querySelector('.loading-dots') || !bodies[provider].textContent.trim())) {
          setBody(provider, '(No response received)', true)
        }
        activeProviders.delete(provider)
        checkAllDone()
        break

      case 'SESSION_STATUS':
        if (btnCheckSession) {
          btnCheckSession.disabled = false
          btnCheckSession.textContent = '🔄 Check Sessions'
        }
        if (msg.status) {
          renderSessionStatus(msg.status)
        }
        break

      case 'SESSION_STATUS_ERROR':
        if (btnCheckSession) {
          btnCheckSession.disabled = false
          btnCheckSession.textContent = '🔄 Check Sessions'
        }
        console.error('Session check failed:', msg.error)
        break

      case 'ERROR': {
        setStatus(provider, 'error', 'error')
        const bodyEl = bodies[provider]
        bodyEl.innerHTML = ''
        bodyEl.classList.remove('empty')

        if (msg.code) {
          const badge = document.createElement('div')
          badge.className = 'error-code-badge'
          badge.textContent = `${msg.code}${msg.status ? ` (HTTP ${msg.status})` : ''}`
          bodyEl.appendChild(badge)
        }

        const msgDiv = document.createElement('div')
        msgDiv.textContent = '⚠ ' + error
        bodyEl.appendChild(msgDiv)

        const loginUrl = msg.actionUrl || getProviderMetadata(provider)?.loginUrl || 'https://google.com'

        if (msg.code === 'AUTH_REQUIRED') {
          const link = document.createElement('a')
          link.className = 'error-action-link'
          link.href = loginUrl
          link.target = '_blank'
          link.rel = 'noreferrer noopener'
          if (provider === 'kimi' || provider === 'deepseek') {
            link.textContent = `Open ${provider.toUpperCase()} to sync session ↗`
            const hint = document.createElement('div')
            hint.className = 'error-hint'
            hint.style.cssText = 'font-size: 11px; color: var(--text-dim); margin-top: 6px; line-height: 1.4;'
            hint.textContent = 'A one-time visit syncs your session into storage. Once synced, you can close the tab.'
            bodyEl.appendChild(link)
            bodyEl.appendChild(hint)
          } else {
            link.textContent = `Sign in to ${provider.toUpperCase()} ↗`
            bodyEl.appendChild(link)
          }
        } else if (msg.code === 'CLOUDFLARE_CHALLENGE') {
          const link = document.createElement('a')
          link.className = 'error-action-link'
          link.href = msg.actionUrl || getProviderMetadata(provider)?.challengeUrl || loginUrl
          link.target = '_blank'
          link.rel = 'noreferrer noopener'
          link.textContent = `Open ${provider.toUpperCase()} tab to verify ↗`
          bodyEl.appendChild(link)
        } else if (msg.code === 'FORBIDDEN') {
          const link = document.createElement('a')
          link.className = 'error-action-link'
          link.href = loginUrl
          link.target = '_blank'
          link.rel = 'noreferrer noopener'
          link.textContent = `Visit ${provider.toUpperCase()} ↗`
          bodyEl.appendChild(link)
        }

        activeProviders.delete(provider)
        checkAllDone()
        break
      }

      case 'ABORTED':
        setStatus(provider, 'aborted', '')
        activeProviders.delete(provider)
        checkAllDone()
        break

      case 'DEBUG_LOG':
        if (entry) {
          handleDebugLog(entry)
        }
        break
    }
  })

  port.onDisconnect.addListener(() => {
    port = null
  })
}

function checkAllDone() {
  if (activeProviders.size === 0) {
    isLoading = false
    btnSend.textContent = 'Send'
    btnSend.classList.remove('btn-stop')
    btnSend.classList.add('btn-send')
    btnSend.disabled = false
    promptInput.disabled = false
  }
}

// --- Send prompt ---
function sendPrompt() {
  const prompt = promptInput.value.trim()
  if (!prompt) return

  const selected = Object.entries(toggles)
    .filter(([, toggle]) => toggle.checked)
    .map(([name]) => name)

  if (selected.length === 0) {
    alert('Please select at least one AI provider.')
    return
  }

  if (!port) connectPort()

  isLoading = true
  activeProviders = new Set(selected)

  btnSend.textContent = 'Stop'
  btnSend.classList.remove('btn-send')
  btnSend.classList.add('btn-stop')
  promptInput.disabled = true

  for (const provider of selected) {
    setStatus(provider, 'sending...', 'loading')
    setBody(provider, '', true)
    bodies[provider].innerHTML = '<span class="loading-dots"><span>•</span><span>•</span><span>•</span></span>'
    bodies[provider].classList.add('empty')
  }

  for (const provider of selected) {
    const requestId = `${provider}-${++requestCounter}`
    port.postMessage({
      type: 'SEND_PROMPT',
      provider,
      prompt,
      requestId,
      debug: isDebugMode,
    })
  }
}

function stopAll() {
  if (port) {
    port.disconnect()
    port = null
  }
  isLoading = false
  activeProviders.clear()
  checkAllDone()
}

// --- Event handlers ---
btnSend.addEventListener('click', () => {
  if (isLoading) {
    stopAll()
  } else {
    sendPrompt()
  }
})

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
    e.preventDefault()
    sendPrompt()
  }
})

// ==========================================
// --- Debug Mode & Run I/O Console Logic ---
// ==========================================

function formatTime(isoString) {
  try {
    const d = new Date(isoString)
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return isoString || ''
  }
}

function matchesFilter(entry, filter) {
  if (filter === 'all') return true
  if (filter === 'error') return entry.level === 'error'
  return entry.provider?.toLowerCase() === filter.toLowerCase()
}

function createLogEntryElement(entry) {
  const div = document.createElement('div')
  div.className = `log-entry level-${entry.level || 'info'}`

  const meta = document.createElement('div')
  meta.className = 'log-meta'

  const time = document.createElement('span')
  time.className = 'log-time'
  time.textContent = formatTime(entry.timestamp)
  meta.appendChild(time)

  if (entry.provider) {
    const prov = document.createElement('span')
    prov.className = `log-provider ${entry.provider}`
    prov.textContent = entry.provider
    meta.appendChild(prov)
  }

  if (entry.category) {
    const cat = document.createElement('span')
    cat.className = 'log-category'
    cat.textContent = entry.category
    meta.appendChild(cat)
  }

  if (entry.level) {
    const lvl = document.createElement('span')
    lvl.className = `log-level ${entry.level}`
    lvl.textContent = entry.level
    meta.appendChild(lvl)
  }

  div.appendChild(meta)

  const msg = document.createElement('div')
  msg.className = 'log-msg'
  msg.textContent = entry.message || ''
  div.appendChild(msg)

  if (entry.data !== undefined && entry.data !== null) {
    const details = document.createElement('details')
    details.className = 'log-details'
    const summary = document.createElement('summary')
    summary.textContent = 'Payload / Details'
    const pre = document.createElement('pre')
    try {
      pre.textContent = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)
    } catch {
      pre.textContent = String(entry.data)
    }
    details.appendChild(summary)
    details.appendChild(pre)
    div.appendChild(details)
  }

  return div
}

function handleDebugLog(entry) {
  debugLogs.push(entry)

  // Update counters
  debugBadge.textContent = debugLogs.length
  debugStats.textContent = `${debugLogs.length} events`

  // If empty state is shown, remove it
  const emptyState = debugLogList.querySelector('.debug-empty')
  if (emptyState) {
    debugLogList.innerHTML = ''
  }

  // If entry matches current filter, append to log viewer
  if (matchesFilter(entry, activeFilter)) {
    const elem = createLogEntryElement(entry)
    debugLogList.appendChild(elem)
    debugLogList.scrollTop = debugLogList.scrollHeight
  }
}

function reRenderLogs() {
  debugLogList.innerHTML = ''
  const filtered = debugLogs.filter((entry) => matchesFilter(entry, activeFilter))

  if (filtered.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'debug-empty'
    empty.innerHTML = debugLogs.length === 0
      ? '<span>No debug logs captured yet.</span><span>Turn Debug Mode <strong>ON</strong> and send a prompt to inspect live I/O.</span>'
      : `<span>No events matching filter "<strong>${activeFilter}</strong>".</span>`
    debugLogList.appendChild(empty)
    return
  }

  for (const entry of filtered) {
    debugLogList.appendChild(createLogEntryElement(entry))
  }
  debugLogList.scrollTop = debugLogList.scrollHeight
}

// Drawer Toggle
btnDebugFab.addEventListener('click', () => {
  debugDrawer.classList.toggle('open')
})

btnDebugClose.addEventListener('click', () => {
  debugDrawer.classList.remove('open')
})

// Debug ON / OFF Toggle
debugToggle.addEventListener('change', () => {
  isDebugMode = debugToggle.checked
  debugToggleStatus.textContent = isDebugMode ? 'Debug: ON' : 'Debug: OFF'
  btnDebugFab.classList.toggle('active', isDebugMode)
  saveUIState()
})

// Clear logs
btnDebugClear.addEventListener('click', () => {
  debugLogs = []
  debugBadge.textContent = '0'
  debugStats.textContent = '0 events'
  reRenderLogs()
})

function getDebugExportPayload() {
  return {
    exportDate: new Date().toISOString(),
    userAgent: navigator.userAgent,
    totalEvents: debugLogs.length,
    events: debugLogs,
  }
}

function flashCopySuccess(btn, text) {
  const original = btn.textContent
  btn.textContent = text
  btn.classList.add('btn-copied')
  setTimeout(() => {
    btn.textContent = original
    btn.classList.remove('btn-copied')
  }, 2000)
}

// Copy JSON
if (btnDebugCopy) {
  btnDebugCopy.addEventListener('click', async () => {
    if (debugLogs.length === 0) {
      alert('No debug logs recorded to copy.')
      return
    }

    const jsonStr = JSON.stringify(getDebugExportPayload(), null, 2)
    try {
      await navigator.clipboard.writeText(jsonStr)
      flashCopySuccess(btnDebugCopy, '✓ Copied!')
    } catch {
      // Fallback if clipboard API restricted in some extension contexts
      const textarea = document.createElement('textarea')
      textarea.value = jsonStr
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      flashCopySuccess(btnDebugCopy, '✓ Copied!')
    }
  })
}

// Download JSON
btnDebugDownload.addEventListener('click', () => {
  if (debugLogs.length === 0) {
    alert('No debug logs recorded to download.')
    return
  }

  const exportPayload = getDebugExportPayload()

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  a.href = url
  a.download = `ai-session-debug-${timestamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
})

// Filter pills
for (const pill of filterPills) {
  pill.addEventListener('click', () => {
    for (const p of filterPills) p.classList.remove('active')
    pill.classList.add('active')
    activeFilter = pill.getAttribute('data-filter')
    saveUIState()
    reRenderLogs()
  })
}

// --- Pre-flight Session Detection UI ---
function renderSessionStatus(result) {
  if (!sessionBadges) return
  sessionBadges.innerHTML = ''
  for (const [provider, info] of Object.entries(result.providers)) {
    const badge = document.createElement(info.authenticated ? 'span' : 'a')
    badge.className = `session-badge ${info.authenticated ? 'ready' : 'error'}`
    badge.title = info.reason || (info.authenticated ? 'Active session' : 'Click to log in')
    if (!info.authenticated) {
      badge.href = info.loginUrl || '#'
      badge.target = '_blank'
      badge.rel = 'noreferrer noopener'
    }

    const dot = document.createElement('span')
    dot.className = 'session-badge-dot'
    badge.appendChild(dot)

    const label = document.createElement('span')
    label.textContent = `${provider.toUpperCase()}: ${info.authenticated ? 'Ready' : 'Login'}`
    badge.appendChild(label)

    sessionBadges.appendChild(badge)
  }
}

function requestCheckSession(mode = 'cookie') {
  if (!port) connectPort()
  if (btnCheckSession) {
    btnCheckSession.disabled = true
    btnCheckSession.textContent = 'Checking...'
  }
  port.postMessage({
    type: 'CHECK_SESSION',
    options: { mode },
    debug: isDebugMode,
    requestId: 'session_check_' + Date.now(),
  })
}

if (btnCheckSession) {
  btnCheckSession.addEventListener('click', () => {
    requestCheckSession('network')
  })
}

// Initial session check on popup load
requestCheckSession('cookie')
