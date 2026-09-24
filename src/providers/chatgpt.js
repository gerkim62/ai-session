/**
 * @module providers/chatgpt
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
 *   - js-sha3 (npm dependency)
 */

import { sha3_512 } from 'js-sha3'
import { fetchSSE } from '../utils/sse-parser.js'
import { createLogger } from '../utils/log.js'
import { generateUUID } from '../utils/crypto.js'
import { buildCookieString, createHttpError } from '../utils/http.js'

const log = createLogger('chatgpt')

// --- Cookie / Token helpers ---

async function getCookieValue(url, name, onLog) {
  const cookie = await chrome.cookies.get({ url, name })
  log(onLog, 'debug', 'COOKIE', `Queried cookie "${name}" for ${url}`, cookie)
  return cookie?.value || null
}

async function getAccessToken(onLog) {
  const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' })
  log(onLog, 'debug', 'COOKIE', 'Retrieved all cookies for https://chatgpt.com/', cookies)
  const cookieStr = buildCookieString(cookies)

  const reqHeaders = { ...(cookieStr && { Cookie: cookieStr }) }
  log(onLog, 'info', 'NETWORK_REQUEST', 'Fetching ChatGPT session token', {
    url: 'https://chatgpt.com/api/auth/session',
    headers: reqHeaders,
  })

  const resp = await fetch('https://chatgpt.com/api/auth/session', {
    credentials: 'include',
    headers: reqHeaders,
  })

  log(onLog, 'info', 'NETWORK_RESPONSE', `Session endpoint responded with status ${resp.status}`, {
    status: resp.status,
    statusText: resp.statusText,
  })

  if (resp.status === 403) {
    throw createHttpError('ChatGPT: Cloudflare block. Try opening chatgpt.com in a tab first.', 403, 'chatgpt', 'CLOUDFLARE_CHALLENGE')
  }
  if (!resp.ok) {
    throw createHttpError(`ChatGPT: HTTP ${resp.status}`, resp.status, 'chatgpt')
  }
  const data = await resp.json().catch(() => ({}))
  log(onLog, 'debug', 'AUTH', 'Parsed session response data', data)
  if (!data.accessToken) {
    throw createHttpError('ChatGPT: Not logged in. Please log in at https://chatgpt.com', null, 'chatgpt', 'AUTH_REQUIRED')
  }
  return data.accessToken
}

async function getRequirements(accessToken, onLog) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }
  log(onLog, 'info', 'NETWORK_REQUEST', 'Requesting sentinel chat-requirements', {
    url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements',
    headers: reqHeaders,
  })

  const resp = await fetch('https://chatgpt.com/backend-api/sentinel/chat-requirements', {
    method: 'POST',
    headers: reqHeaders,
  })
  const data = await resp.json().catch(() => ({}))
  log(onLog, 'info', 'NETWORK_RESPONSE', 'Received sentinel requirements', {
    status: resp.status,
    body: data,
  })
  return data
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

// --- Text cleaner ---

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
  out = out.replace(/\ue200entity\ue202\["(?:[^"\\]|\\.)*"(?:,\s*"((?:[^"\\]|\\.)*)"\s*)?[^\ue201]*$/g, (_, name) => {
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

// --- Main send function ---

/**
 * @typedef {Object} PromptOptions
 * @property {(chunk: string) => void} [onChunk] - Called with accumulated answer text
 * @property {AbortSignal} [signal] - Abort signal to cancel the request
 * @property {(entry: import('../utils/log.js').LogEntry) => void} [onLog] - Called with diagnostic log events
 */

/**
 * Send a prompt to ChatGPT web and stream the response.
 * @param {string} prompt
 * @param {PromptOptions} [options]
 * @returns {Promise<string>} final answer text
 */
export async function sendPrompt(prompt, { onChunk, signal, onLog } = {}) {
  log(onLog, 'info', 'PROMPT_START', 'Starting ChatGPT prompt execution', { prompt })

  try {
    const accessToken = await getAccessToken(onLog)

    const requirements = await getRequirements(accessToken, onLog).catch((err) => {
      log(onLog, 'warn', 'REQUIREMENTS_ERROR', 'Failed to retrieve requirements; proceeding without', { error: err.message })
      return null
    })

    let proofToken = null
    if (requirements?.proofofwork?.required) {
      log(onLog, 'info', 'POW_START', 'Starting Proof-of-Work puzzle', {
        seed: requirements.proofofwork.seed,
        difficulty: requirements.proofofwork.difficulty,
      })
      proofToken = generateProofToken(
        requirements.proofofwork.seed,
        requirements.proofofwork.difficulty,
      )
      if (proofToken.startsWith('gAAAAABwQ8Lk')) {
        log(onLog, 'warn', 'POW_FALLBACK', 'Proof-of-Work puzzle timed out; fallback token used', { proofToken })
      } else {
        log(onLog, 'info', 'POW_SOLVED', 'Proof-of-Work solved', { proofToken })
      }
    }

    const oaiDeviceId = await getCookieValue('https://chatgpt.com/', 'oai-did', onLog)
    const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' })
    const cookieStr = buildCookieString(cookies)

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

    const reqHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(cookieStr && { Cookie: cookieStr }),
      ...(requirements?.token && { 'Openai-Sentinel-Chat-Requirements-Token': requirements.token }),
      ...(proofToken && { 'Openai-Sentinel-Proof-Token': proofToken }),
      ...(oaiDeviceId && { 'Oai-Device-Id': oaiDeviceId }),
      'Oai-Language': 'en-US',
    }

    log(onLog, 'info', 'NETWORK_REQUEST', 'Dispatching conversation request to /backend-api/conversation', {
      url,
      headers: reqHeaders,
      body,
    })

    let answer = ''

    await fetchSSE(url, {
      provider: 'chatgpt',
      method: 'POST',
      signal,
      headers: reqHeaders,
      body: JSON.stringify(body),
      onMessage(message) {
        log(onLog, 'debug', 'SSE_RAW', 'Raw SSE message event', { raw: message })
        if (message.trim() === '[DONE]') {
          log(onLog, 'info', 'SSE_DONE', 'Received [DONE] sentinel')
          return
        }
        try {
          const data = JSON.parse(message)
          if (data.message?.author?.role !== "assistant") return
          const text = data.message?.content?.parts?.[0]
          if (typeof text === 'string' && data.message?.content?.content_type === 'text') {
            answer = cleanChatGPTText(text)
            log(onLog, 'debug', 'STREAM', 'Accumulated stream text', { answer })
            if (onChunk) onChunk(answer)
          }
        } catch (parseErr) {
          log(onLog, 'warn', 'SSE_PARSE_WARN', 'Failed to parse intermediate SSE message as JSON', {
            raw: message,
            error: parseErr.message,
          })
        }
      },
      onError(err) {
        log(onLog, 'error', 'SSE_ERROR', 'Error occurred during SSE streaming', {
          error: err.message,
          stack: err.stack,
        })
        throw err
      },
    })

    log(onLog, 'info', 'PROMPT_COMPLETE', 'ChatGPT stream finished successfully', { answer })
    return answer
  } catch (err) {
    let errMsg = err.message || String(err)
    if (errMsg.includes('403') && errMsg.includes('Unusual activity')) {
      errMsg = 'ChatGPT: Security challenge (HTTP 403: Unusual activity). Please keep https://chatgpt.com open in an active tab, refresh it or send a message there, and try again.'
      err.code = 'CLOUDFLARE_CHALLENGE'
      err.status = err.status || 403
    }
    err.message = errMsg
    if (!err.provider) err.provider = 'chatgpt'
    log(onLog, 'error', 'ERROR', `ChatGPT failed: ${errMsg}`, {
      stack: err.stack,
    })
    throw err
  }
}

/**
 * Pre-flight authentication check for ChatGPT.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie'] - 'cookie' for fast passive inspection, 'network' to ping /api/auth/session
 * @param {AbortSignal} [options.signal]
 * @param {(entry: import('../utils/log.js').LogEntry) => void} [options.onLog]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog } = {}) {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' })
    log(onLog, 'debug', 'COOKIE', 'checkAuth: retrieved cookies for https://chatgpt.com/', cookies)
    const hasToken = cookies.some((c) => c.name.includes('session-token'))
    if (!hasToken) {
      log(onLog, 'warn', 'AUTH_CHECK_FAIL', 'checkAuth: missing session-token cookie')
      return {
        authenticated: false,
        loginUrl: 'https://chatgpt.com/auth/login',
        reason: 'Missing session token cookie',
      }
    }

    if (mode === 'network') {
      const cookieStr = buildCookieString(cookies)
      const reqHeaders = { ...(cookieStr && { Cookie: cookieStr }) }
      log(onLog, 'info', 'NETWORK_REQUEST', 'checkAuth: verifying ChatGPT session endpoint', {
        url: 'https://chatgpt.com/api/auth/session',
      })
      const resp = await fetch('https://chatgpt.com/api/auth/session', {
        credentials: 'include',
        headers: reqHeaders,
        signal,
      })

      if (resp.status === 403) {
        log(onLog, 'warn', 'SECURITY_CHALLENGE', 'checkAuth: ChatGPT returned HTTP 403 (Cloudflare challenge)')
        return {
          authenticated: false,
          loginUrl: 'https://chatgpt.com/',
          reason: 'Cloudflare challenge',
        }
      }

      if (resp.status === 200) {
        const data = await resp.json().catch(() => ({}))
        if (data?.accessToken) {
          log(onLog, 'info', 'AUTH_CHECK_SUCCESS', 'checkAuth: ChatGPT authenticated successfully')
          return {
            authenticated: true,
            loginUrl: 'https://chatgpt.com/',
          }
        }
      }

      log(onLog, 'warn', 'AUTH_CHECK_FAIL', `checkAuth: ChatGPT session endpoint returned HTTP ${resp.status} without accessToken`)
      return {
        authenticated: false,
        loginUrl: 'https://chatgpt.com/auth/login',
        reason: `Unauthenticated (HTTP ${resp.status})`,
      }
    }

    log(onLog, 'info', 'AUTH_CHECK_SUCCESS', 'checkAuth: ChatGPT authenticated successfully')
    return {
      authenticated: true,
      loginUrl: 'https://chatgpt.com/',
    }
  } catch (err) {
    log(onLog, 'error', 'AUTH_CHECK_ERROR', `ChatGPT checkAuth error: ${err.message}`, { error: err.message })
    return {
      authenticated: false,
      loginUrl: 'https://chatgpt.com/auth/login',
      reason: err.message,
    }
  }
}
