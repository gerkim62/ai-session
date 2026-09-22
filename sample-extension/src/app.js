/**
 * Sample Extension App UI Logic
 *
 * Manages prompt input, provider toggles, and streaming response columns.
 * Communicates with background.js via chrome.runtime.connect port messaging.
 */

// --- State ---
let port = null
let isLoading = false
let activeProviders = new Set()
let requestCounter = 0

// --- DOM refs ---
const promptInput = document.getElementById('prompt-input')
const btnSend = document.getElementById('btn-send')
const toggles = {
  chatgpt: document.getElementById('toggle-chatgpt'),
  claude: document.getElementById('toggle-claude'),
  gemini: document.getElementById('toggle-gemini'),
}
const cols = {
  chatgpt: document.getElementById('col-chatgpt'),
  claude: document.getElementById('col-claude'),
  gemini: document.getElementById('col-gemini'),
}
const bodies = {
  chatgpt: document.getElementById('body-chatgpt'),
  claude: document.getElementById('body-claude'),
  gemini: document.getElementById('body-gemini'),
}
const statuses = {
  chatgpt: document.getElementById('status-chatgpt'),
  claude: document.getElementById('status-claude'),
  gemini: document.getElementById('status-gemini'),
}

// --- Column visibility ---
function updateColumnVisibility() {
  for (const [provider, toggle] of Object.entries(toggles)) {
    cols[provider].classList.toggle('hidden', !toggle.checked)
  }
}

for (const toggle of Object.values(toggles)) {
  toggle.addEventListener('change', updateColumnVisibility)
}
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
    const { type, provider, requestId, text, error } = msg

    switch (type) {
      case 'CHUNK':
        setStatus(provider, 'streaming...', 'loading')
        setBody(provider, text)
        break

      case 'DONE':
        setStatus(provider, 'done', 'done')
        activeProviders.delete(provider)
        checkAllDone()
        break

      case 'ERROR':
        setStatus(provider, 'error', 'error')
        setBody(provider, '⚠ ' + error)
        activeProviders.delete(provider)
        checkAllDone()
        break

      case 'ABORTED':
        setStatus(provider, 'aborted', '')
        activeProviders.delete(provider)
        checkAllDone()
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
