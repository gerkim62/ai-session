/**
 * ChatGPT Web Provider
 *
 * Reverse-engineered ChatGPT web API using the Sentinel PoW flow.
 *
 * Extracted from:
 *   https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8/src/services/apis/chatgpt-web.mjs
 *
 * Key functions adapted:
 *   - generateProofToken (lines 99-150)
 *   - getRequirements / getArkoseToken / generateAnswersWithChatgptWebApi
 *
 * Dependencies:
 *   - js-sha3 (bundled below as a minimal sha3_512 implementation)
 */

import '../../vendor/sha3.min.js'
import { fetchSSE } from '../utils/sse-parser.js'

function getSha3() {
  if (typeof globalThis !== 'undefined' && globalThis.sha3_512) return globalThis.sha3_512
  if (typeof self !== 'undefined' && self.sha3_512) return self.sha3_512
  if (typeof window !== 'undefined' && window.sha3_512) return window.sha3_512
  console.warn('[chatgpt] sha3_512 not found. PoW will use fallback.')
  return { create: () => ({ update: () => ({ hex: () => 'f'.repeat(128) }) }) }
}

// --- Cookie / Token helpers ---

async function getCookieValue(url, name) {
  const cookie = await chrome.cookies.get({ url, name })
  return cookie?.value || null
}

async function getAccessToken() {
  const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' })
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const resp = await fetch('https://chatgpt.com/api/auth/session', {
    credentials: 'include',
    headers: { ...(cookieStr && { Cookie: cookieStr }) },
  })
  if (resp.status === 403) throw new Error('ChatGPT: Cloudflare block. Try opening chatgpt.com in a tab first.')
  const data = await resp.json().catch(() => ({}))
  if (!data.accessToken) throw new Error('ChatGPT: Not logged in. Please log in at https://chatgpt.com')
  return data.accessToken
}

async function getRequirements(accessToken) {
  const resp = await fetch('https://chatgpt.com/backend-api/sentinel/chat-requirements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  })
  return resp.json()
}

// --- Proof-of-Work solver ---
// Source: ChatGPTBox chatgpt-web.mjs lines 99-150

function toBase64(str) {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function generateProofToken(seed, diff) {
  const sha3_512 = getSha3()
  const cores = [1, 2, 4]
  const screens = [3008, 4010, 6000]

  const core = cores[Math.floor(Math.random() * cores.length)]
  const screen = screens[Math.floor(Math.random() * screens.length)] + core
  const parseTime = new Date().toString()

  const config = [
    screen,
    parseTime,
    4294705152,
    0,
    navigator.userAgent,
    'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js',
    'dpl=1440a687921de39ff5ee56b92807faaadce73f13',
    'en',
    'en-US',
    4294705152,
    'plugins\u2212[object PluginArray]',
    cores[Math.floor(Math.random() * cores.length)],
    screens[Math.floor(Math.random() * screens.length)],
  ]

  const diffLen = diff.length

  for (let i = 0; i < 200000; i++) {
    config[3] = i
    const jsonData = JSON.stringify(config)
    const base = toBase64(jsonData)
    const hashValue = sha3_512.create().update(seed + base)

    if (hashValue.hex().substring(0, diffLen) <= diff) {
      return 'gAAAAAB' + base
    }
  }

  // Fallback
  return 'gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + toBase64(`"${seed}"`)
}

// --- Main send function ---

function generateUUID() {
  return crypto.randomUUID()
}

function cleanChatGPTText(text) {
  if (!text) return ''
  let out = text

  // 1. Completed entity tags: \ue200entity\ue202["category","Name",...]\ue201 -> "Name"
  // Note: Delimiter is \ue201, matching ChatGPT PUA protocol (researched from pionxzh/chatgpt-exporter PR #328 & Issue #259)
  out = out.replace(/\ue200entity\ue202(\[[^\ue201]*\])\ue201/g, (_, jsonStr) => {
    try {
      const arr = JSON.parse(jsonStr)
      return arr[1] || arr[0] || ''
    } catch {
      const matches = [...jsonStr.matchAll(/"([^"]+)"/g)]
      return (matches[1] && matches[1][1]) || (matches[0] && matches[0][1]) || ''
    }
  })

  // 2. Incomplete entity tag during streaming: \ue200entity\ue202["category","Name"...
  out = out.replace(/\ue200entity\ue202\["(?:[^"\\]|\\.)*"(?:,\s*"((?:[^"\\]|\\.)*)")?[^\ue201]*$/g, (_, name) => {
    return name || ''
  })

  // 3. Completed citation tags: \ue200cite\ue202...\ue201 -> ""
  out = out.replace(/\ue200cite\ue202[^\ue201]*\ue201/g, '')

  // 4. Incomplete citation tag at end of streaming chunk
  out = out.replace(/\ue200cite\ue202[^\ue201]*$/g, '')

  // 5. Remove any leftover PUA control markers (\ue200 - \ue205) without deleting surrounding text
  out = out.replace(/[\ue200-\ue205]/g, '')

  return out
}

/**
 * Send a prompt to ChatGPT web and stream the response.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk] - called with accumulated answer text
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} final answer text
 */
export async function sendPrompt(prompt, { onChunk, signal } = {}) {
  const accessToken = await getAccessToken()

  const requirements = await getRequirements(accessToken).catch(() => null)

  let proofToken = null
  if (requirements?.proofofwork?.required) {
    proofToken = generateProofToken(
      requirements.proofofwork.seed,
      requirements.proofofwork.difficulty,
    )
  }

  const oaiDeviceId = await getCookieValue('https://chatgpt.com/', 'oai-did')
  const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' })
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const messageId = generateUUID()
  const parentMessageId = generateUUID()

  const url = 'https://chatgpt.com/backend-api/conversation'
  const body = {
    action: 'next',
    messages: [
      {
        id: messageId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
      },
    ],
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_rate_limit: false,
    suggestions: [],
    model: 'auto',
    parent_message_id: parentMessageId,
    timezone_offset_min: new Date().getTimezoneOffset(),
    history_and_training_disabled: true,
  }

  let answer = ''

  await fetchSSE(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(cookieStr && { Cookie: cookieStr }),
      ...(requirements?.token && { 'Openai-Sentinel-Chat-Requirements-Token': requirements.token }),
      ...(proofToken && { 'Openai-Sentinel-Proof-Token': proofToken }),
      ...(oaiDeviceId && { 'Oai-Device-Id': oaiDeviceId }),
      'Oai-Language': 'en-US',
    },
    body: JSON.stringify(body),
    onMessage(message) {
      if (message.trim() === '[DONE]') return
      try {
        const data = JSON.parse(message)
        const text = data.message?.content?.parts?.[0]
        if (typeof text === 'string' && data.message?.content?.content_type === 'text') {
          answer = cleanChatGPTText(text)
          if (onChunk) onChunk(answer)
        }
      } catch {
        // ignore parse errors on intermediate chunks
      }
    },
    onError(err) {
      throw err
    },
  })

  return answer
}
