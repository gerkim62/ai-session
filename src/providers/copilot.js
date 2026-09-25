/**
 * @module providers/copilot
 * Copilot (Microsoft Bing) Provider
 *
 * Reverse-engineered Microsoft Copilot / Bing Chat web API using cookie session auth.
 *
 * Adapted from:
 *   https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/src/services/clients/bing/index.mjs
 *
 * Features:
 *   - Uses _U session cookie from .bing.com
 *   - Performs turing/conversation/create handshake with Sec-MS-GEC verification
 *   - Establishes WebSocket connection to Sydney ChatHub using SignalR protocol
 *   - Streams progressive answer deltas to onChunk
 */

import { createLogger } from '../utils/log.js'
import { generateUUID } from '../utils/crypto.js'
import { buildCookieString, assertOk, createHttpError } from '../utils/http.js'

export const metadata = {
  id: 'copilot',
  displayName: 'Copilot (Microsoft Bing)',
  shortName: 'Copilot',
  loginUrl: 'https://copilot.microsoft.com/',
  challengeUrl: 'https://copilot.microsoft.com/',
  homeUrl: 'https://copilot.microsoft.com/',
}

const log = createLogger('copilot')

const RECORD_SEPARATOR = '\x1e'

/**
 * Generate a random hexadecimal string.
 * @param {number} size
 * @returns {string}
 */
function genRanHex(size) {
  return [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
}

/**
 * Retrieve Bing cookies from the browser cookie store.
 * @param {Function} [onLog]
 * @returns {Promise<{ cookies: Array<{name: string, value: string}>, cookieStr: string, userToken?: string }>}
 */
async function getBingCookies(onLog) {
  if (typeof chrome === 'undefined' || !chrome.cookies) {
    throw createHttpError('Copilot: chrome.cookies API unavailable', null, 'copilot', 'AUTH_REQUIRED', metadata.loginUrl)
  }

  const cookies = await chrome.cookies.getAll({ domain: 'bing.com' })
  log(onLog, 'debug', 'COOKIE', 'Retrieved Bing cookies', cookies)

  const uCookie = cookies.find((c) => c.name === '_U')
  if (!uCookie?.value) {
    throw createHttpError(
      'Copilot: Not logged in. Please sign in at https://copilot.microsoft.com or https://www.bing.com',
      null,
      'copilot',
      'AUTH_REQUIRED',
      metadata.loginUrl,
    )
  }

  return {
    cookies,
    cookieStr: buildCookieString(cookies),
    userToken: uCookie.value,
  }
}

/**
 * Perform conversation creation handshake.
 * @param {string} cookieStr
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ conversationId: string, clientId: string, encryptedSignature: string }>}
 */
async function createConversation(cookieStr, { signal, onLog } = {}) {
  const url = 'https://www.bing.com/turing/conversation/create?bundleVersion=1.864.15'
  const headers = {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'sec-ms-gec': genRanHex(64).toUpperCase(),
    'sec-ms-gec-version': '1-115.0.1866.1',
    'x-ms-client-request-id': generateUUID(),
    'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.10.0 OS/Win32',
    cookie: cookieStr,
    Referer: 'https://www.bing.com/search?q=Bing+AI&showconv=1',
  }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Creating Copilot conversation', { url })

  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  })

  await assertOk(resp, 'Copilot conversation creation', { onLog, log, provider: 'copilot' })
  const encryptedSignature = resp.headers.get('x-sydney-encryptedconversationsignature') || ''
  const data = await resp.json()

  if (data?.result?.value === 'UnauthorizedRequest') {
    throw createHttpError('Copilot: Unauthorized session. Please sign in again at https://copilot.microsoft.com', 401, 'copilot', 'AUTH_REQUIRED', metadata.loginUrl)
  }

  if (!data?.conversationId || !data?.clientId) {
    throw createHttpError(
      `Copilot: Unexpected handshake response: ${data?.result?.message || 'Missing conversation IDs'}`,
      resp.status,
      'copilot',
      'HTTP_ERROR',
    )
  }

  log(onLog, 'info', 'NETWORK_RESPONSE', 'Copilot conversation created', {
    conversationId: data.conversationId,
    clientId: data.clientId,
    hasSignature: !!encryptedSignature,
  })

  return {
    conversationId: data.conversationId,
    clientId: data.clientId,
    encryptedSignature,
  }
}

/**
 * Check authentication status for Copilot.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie']
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog } = {}) {
  try {
    const { cookieStr } = await getBingCookies(onLog)

    if (mode === 'cookie') {
      return { authenticated: true, loginUrl: metadata.loginUrl }
    }

    // Network reachability check: perform handshake
    await createConversation(cookieStr, { signal, onLog })
    return { authenticated: true, loginUrl: metadata.loginUrl }
  } catch (err) {
    return {
      authenticated: false,
      loginUrl: metadata.loginUrl,
      reason: err.message || String(err),
    }
  }
}

/**
 * Send a prompt to Copilot via Sydney WebSocket and stream the answer.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @param {'Balanced' | 'Creative' | 'Precise'} [options.tone='Balanced']
 * @returns {Promise<string>}
 */
export async function sendPrompt(
  prompt,
  {
    onChunk,
    signal,
    onLog,
    tone = 'Balanced',
  } = {},
) {
  log(onLog, 'info', 'PROMPT_START', 'Starting Copilot prompt execution', { prompt, tone })

  const { cookieStr } = await getBingCookies(onLog)
  const { conversationId, clientId, encryptedSignature } = await createConversation(cookieStr, { signal, onLog })

  let toneOption = 'galileo'
  if (tone.toLowerCase() === 'creative') {
    toneOption = 'h3imaginative'
  } else if (tone.toLowerCase() === 'precise') {
    toneOption = 'h3precise'
  }

  return new Promise((resolve, reject) => {
    let ws
    let pingInterval
    let fullResponse = ''
    let replySoFar = ''
    let isSettled = false

    const cleanup = () => {
      if (pingInterval) clearInterval(pingInterval)
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close()
        } catch {
          // Socket cleanup error ignored
        }
      }
    }

    const settleResolve = (val) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      log(onLog, 'info', 'PROMPT_COMPLETE', 'Copilot finished successfully', { answer: val, length: val.length })
      resolve(val)
    }

    const settleReject = (err) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      reject(err)
    }

    if (signal?.aborted) {
      return settleReject(createHttpError('Copilot: Request aborted', null, 'copilot', 'ABORTED'))
    }

    const abortHandler = () => {
      settleReject(createHttpError('Copilot: Request aborted', null, 'copilot', 'ABORTED'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })

    const wsUrl = `wss://sydney.bing.com/sydney/ChatHub?sec_access_token=${encodeURIComponent(encryptedSignature)}`
    log(onLog, 'info', 'WEBSOCKET_CONNECT', 'Connecting to Sydney ChatHub', { wsUrl: 'wss://sydney.bing.com/sydney/ChatHub' })

    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      return settleReject(createHttpError(`Copilot: Failed to open WebSocket: ${err.message}`, null, 'copilot', 'NETWORK_ERROR'))
    }

    ws.onopen = () => {
      log(onLog, 'debug', 'WEBSOCKET_OPEN', 'Connected to Sydney ChatHub, sending protocol handshake')
      // SignalR protocol handshake
      ws.send(`{"protocol":"json","version":1}${RECORD_SEPARATOR}`)
    }

    ws.onerror = (event) => {
      log(onLog, 'error', 'WEBSOCKET_ERROR', 'Copilot WebSocket error', { event })
      settleReject(createHttpError('Copilot: WebSocket connection failed', null, 'copilot', 'NETWORK_ERROR'))
    }

    ws.onclose = (event) => {
      log(onLog, 'debug', 'WEBSOCKET_CLOSE', 'Copilot WebSocket closed', { code: event.code, reason: event.reason })
      if (!isSettled) {
        if (fullResponse) {
          settleResolve(fullResponse)
        } else {
          settleReject(createHttpError(`Copilot: Connection closed prematurely (code ${event.code})`, null, 'copilot', 'NETWORK_ERROR'))
        }
      }
    }

    ws.onmessage = (event) => {
      const data = String(event.data)
      const rawObjects = data.split(RECORD_SEPARATOR).filter(Boolean)

      for (const raw of rawObjects) {
        let msg
        try {
          msg = JSON.parse(raw)
        } catch {
          continue
        }

        // SignalR Handshake acknowledgment
        if (Object.keys(msg).length === 0) {
          log(onLog, 'debug', 'WEBSOCKET_HANDSHAKE', 'SignalR handshake acknowledged, starting ping loop and chat invocation')

          // Start ping keepalive
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(`{"type":6}${RECORD_SEPARATOR}`)
            }
          }, 15000)

          // Send chat invocation message
          const chatInvocation = {
            arguments: [
              {
                source: 'cib',
                optionsSets: [
                  'nlu_direct_response_filter',
                  'deepleo',
                  'disable_emoji_spoken_text',
                  'responsible_ai_policy_235',
                  'enablemm',
                  toneOption,
                  'dtappid',
                  'cricinfo',
                  'cricinfov2',
                  'dv3sugg',
                  'nojbfedge',
                ],
                sliceIds: ['222dtappid', '225cricinfo', '224locals0'],
                traceId: genRanHex(32),
                isStartOfSession: true,
                message: {
                  author: 'user',
                  text: prompt,
                  messageType: 'Chat',
                },
                encryptedConversationSignature: encryptedSignature,
                participant: {
                  id: clientId,
                },
                conversationId,
              },
            ],
            invocationId: '0',
            target: 'chat',
            type: 4,
          }

          log(onLog, 'info', 'WEBSOCKET_SEND', 'Sending chat invocation payload', { tone: toneOption })
          ws.send(`${JSON.stringify(chatInvocation)}${RECORD_SEPARATOR}`)
          continue
        }

        // Streaming progress message (type: 1)
        if (msg.type === 1) {
          const botMessage = msg.arguments?.[0]?.messages?.[0]
          if (botMessage && botMessage.author === 'bot') {
            if (botMessage.contentOrigin === 'Apology') {
              log(onLog, 'warn', 'SAFETY_APOLOGY', 'Copilot returned safety apology')
            }
            const updatedText = botMessage.text || ''
            if (updatedText && updatedText !== replySoFar) {
              const diff = updatedText.slice(replySoFar.length)
              replySoFar = updatedText
              fullResponse = updatedText
              if (onChunk && diff) onChunk(fullResponse)
            }
          }
        } else if (msg.type === 2) {
          // Completed message (type: 2)
          log(onLog, 'info', 'WEBSOCKET_COMPLETE', 'Copilot response complete', { length: fullResponse.length })
          if (!fullResponse) {
            settleReject(createHttpError('Copilot: Empty response received from server.', 500, 'copilot', 'EMPTY_RESPONSE', metadata.loginUrl))
          } else {
            settleResolve(fullResponse)
          }
        } else if (msg.type === 3) {
          // Error or invocation complete with potential error
          if (msg.error) {
            log(onLog, 'error', 'WEBSOCKET_INVOCATION_ERROR', 'Copilot invocation error', { error: msg.error })
            settleReject(createHttpError(`Copilot: ${msg.error}`, null, 'copilot', 'HTTP_ERROR'))
          }
        }
      }
    }
  })
}
