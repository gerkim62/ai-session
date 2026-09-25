/**
 * @module providers/deepseek
 * DeepSeek Web Provider
 *
 * Reverse-engineered DeepSeek web API using userToken session auth
 * and client-side Keccak-256 Proof-of-Work (PoW) challenge solving.
 *
 * Adapted from:
 *   https://github.com/Fly143/deepseek-free-api
 *
 * Features:
 *   - Auto-extracts userToken from chrome.storage.local
 *   - Computes DeepSeekHashV1 client-side PoW verification
 *   - Ephemeral chat session lifecycle (create, stream, delete)
 *   - Supports deep thinking mode (R1) and online search
 */

import { fetchSSE } from '../utils/sse-parser.js'
import { createLogger } from '../utils/log.js'
import { assertOk, createHttpError } from '../utils/http.js'
import { solveDeepSeekPoW } from '../utils/deepseek-pow.js'
import { getJwtExp } from '../utils/crypto.js'

export const metadata = {
  id: 'deepseek',
  displayName: 'DeepSeek (chat.deepseek.com)',
  shortName: 'DeepSeek',
  loginUrl: 'https://chat.deepseek.com/',
  challengeUrl: 'https://chat.deepseek.com/',
  homeUrl: 'https://chat.deepseek.com/',
}

const log = createLogger('deepseek')

const DEEPSEEK_BASE = 'https://chat.deepseek.com'

/**
 * Retrieve stored DeepSeek token from chrome.storage.local.
 * @returns {Promise<string>}
 */
async function getStoredToken() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const data = await chrome.storage.local.get(['deepseek_user_token'])
    return data.deepseek_user_token || ''
  }
  return ''
}


/**
 * Obtain a valid DeepSeek user token.
 * @param {string} [tokenOverride]
 * @param {Function} [onLog]
 * @returns {Promise<string>}
 */
async function getValidToken(tokenOverride, onLog) {
  log(onLog, 'debug', 'STORAGE', 'Checking chrome.storage.local for DeepSeek userToken')
  const token = tokenOverride || (await getStoredToken())
  if (!token) {
    log(onLog, 'warn', 'AUTH', 'DeepSeek userToken not found in chrome.storage.local', {
      loginUrl: metadata.loginUrl,
      reason: 'Session token not found. Please click the link to open DeepSeek (https://chat.deepseek.com) once to sync your login session. Once synced, you can close the tab.',
    })
    throw createHttpError(
      'DeepSeek: Session token not found. Please click the link below to open DeepSeek once to sync your session. Once synced, you can close the tab.',
      null,
      'deepseek',
      'AUTH_REQUIRED',
      metadata.loginUrl,
    )
  }

  // Fast client-side JWT expiration check
  const exp = getJwtExp(token)
  if (exp) {
    const now = Math.floor(Date.now() / 1000)
    if (now >= exp - 30) {
      log(onLog, 'warn', 'AUTH', 'DeepSeek userToken in storage is expired', {
        exp: new Date(exp * 1000).toISOString(),
        now: new Date().toISOString(),
      })
      throw createHttpError(
        'DeepSeek: Session token has expired. Please open DeepSeek (https://chat.deepseek.com) to refresh your session.',
        null,
        'deepseek',
        'AUTH_REQUIRED',
        metadata.loginUrl,
      )
    }
  }

  log(onLog, 'debug', 'STORAGE', 'Retrieved valid DeepSeek userToken from storage')
  return token
}

/**
 * Create a new chat session on DeepSeek.
 * @param {string} token
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<string>} Chat session ID
 */
async function createChatSession(token, { signal, onLog } = {}) {
  const url = `${DEEPSEEK_BASE}/api/v0/chat_session/create`
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: DEEPSEEK_BASE,
    Referer: `${DEEPSEEK_BASE}/`,
  }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Creating DeepSeek chat session', { url })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ agent: 'chat' }),
    })

    await assertOk(resp, 'DeepSeek createChatSession', { onLog, log, provider: 'deepseek' })
    const data = await resp.json()

    if (data?.code && data.code !== 0) {
      log(onLog, 'error', 'NETWORK_RESPONSE', `DeepSeek session creation error: ${data.msg || data.code}`, {
        code: data.code,
        msg: data.msg,
      })
      const isAuth = data.code === 40001 || data.code === 40002
      throw createHttpError(
        `DeepSeek: ${data.msg || 'Session creation failed'} (code ${data.code})`,
        data.code,
        'deepseek',
        isAuth ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
        metadata.loginUrl,
      )
    }

    const sessionId = data?.data?.biz_data?.chat_session?.id || data?.data?.biz_data?.id

    if (!sessionId) {
      log(onLog, 'error', 'NETWORK_RESPONSE', 'DeepSeek session creation returned no session ID', { data })
      throw createHttpError('DeepSeek: Failed to obtain chat_session_id', resp.status, 'deepseek', 'HTTP_ERROR')
    }

    log(onLog, 'info', 'NETWORK_RESPONSE', 'Created DeepSeek session', { sessionId })
    return sessionId
  } catch (err) {
    if (err.name !== 'AbortError') {
      log(onLog, 'error', 'NETWORK_ERROR', `DeepSeek createChatSession failed: ${err.message}`, { error: err.message, code: err.code })
    }
    throw err
  }
}

/**
 * Delete a temporary chat session on DeepSeek.
 * @param {string} sessionId
 * @param {string} token
 * @param {object} [options]
 * @param {Function} [options.onLog]
 */
async function deleteChatSession(sessionId, token, { onLog } = {}) {
  const url = `${DEEPSEEK_BASE}/api/v0/chat_session/delete`
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: DEEPSEEK_BASE,
    Referer: `${DEEPSEEK_BASE}/`,
  }
  try {
    log(onLog, 'info', 'NETWORK_REQUEST', 'Deleting temporary DeepSeek session', { sessionId })
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat_session_id: sessionId }),
    })
    log(onLog, 'debug', 'NETWORK_RESPONSE', 'Deleted temporary DeepSeek session', { status: resp.status })
  } catch (err) {
    log(onLog, 'warn', 'CLEANUP_ERROR', 'Failed to delete DeepSeek session', { error: err.message })
  }
}

/**
 * Request and solve the Proof-of-Work challenge.
 * @param {string} token
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<string>} Base64 PoW response header value
 */
async function getPowResponse(token, { signal, onLog } = {}) {
  const url = `${DEEPSEEK_BASE}/api/v0/chat/create_pow_challenge`
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: DEEPSEEK_BASE,
    Referer: `${DEEPSEEK_BASE}/`,
  }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Requesting DeepSeek PoW challenge', { url })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    })

    await assertOk(resp, 'DeepSeek create_pow_challenge', { onLog, log, provider: 'deepseek' })
    const data = await resp.json()

    if (data?.code && data.code !== 0) {
      log(onLog, 'error', 'NETWORK_RESPONSE', `DeepSeek PoW challenge error: ${data.msg || data.code}`, {
        code: data.code,
        msg: data.msg,
      })
      const isAuth = data.code === 40001 || data.code === 40002
      throw createHttpError(
        `DeepSeek: ${data.msg || 'PoW challenge request failed'} (code ${data.code})`,
        data.code,
        'deepseek',
        isAuth ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
        metadata.loginUrl,
      )
    }

    const challenge = data?.data?.biz_data?.challenge

    if (!challenge) {
      log(onLog, 'error', 'NETWORK_RESPONSE', 'DeepSeek PoW challenge missing from response', { data })
      throw createHttpError('DeepSeek: Missing PoW challenge in response', resp.status, 'deepseek', 'HTTP_ERROR')
    }

    log(onLog, 'info', 'POW_CHALLENGE', 'Solving DeepSeek PoW challenge', {
      algorithm: challenge.algorithm,
      difficulty: challenge.difficulty,
    })

    const solved = await solveDeepSeekPoW(challenge)
    log(onLog, 'info', 'POW_SOLVED', 'DeepSeek PoW solved successfully')
    return solved
  } catch (err) {
    if (err.name !== 'AbortError') {
      log(onLog, 'error', 'NETWORK_ERROR', `DeepSeek getPowResponse failed: ${err.message}`, { error: err.message, code: err.code })
    }
    throw err
  }
}

/**
 * Check authentication status for DeepSeek.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie']
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @param {string} [options.token]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog, token } = {}) {
  try {
    log(onLog, 'debug', 'STORAGE', 'Checking DeepSeek auth status in chrome.storage.local')
    const activeToken = token || (await getStoredToken())

    if (!activeToken) {
      log(onLog, 'warn', 'AUTH', 'No DeepSeek userToken found in chrome.storage.local')
      return {
        authenticated: false,
        loginUrl: metadata.loginUrl,
        reason: 'DeepSeek session token not found. Please open DeepSeek (https://chat.deepseek.com) once to sync your session. Once synced, you can close the tab.',
      }
    }

    // Check JWT expiration if parseable
    const exp = getJwtExp(activeToken)
    if (exp) {
      const now = Math.floor(Date.now() / 1000)
      if (now >= exp - 30) {
        return {
          authenticated: false,
          loginUrl: metadata.loginUrl,
          reason: 'DeepSeek session token has expired. Please open DeepSeek (https://chat.deepseek.com) to refresh.',
        }
      }
    }

    if (mode === 'cookie') {
      return { authenticated: true, loginUrl: metadata.loginUrl }
    }

    // Network check: verify token via user profile endpoint
    const resp = await fetch(`${DEEPSEEK_BASE}/api/v0/users/current`, {
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${activeToken}`,
        Origin: DEEPSEEK_BASE,
      },
      signal,
    })

    if (!resp.ok) {
      return {
        authenticated: false,
        loginUrl: metadata.loginUrl,
        reason: `HTTP ${resp.status}: Token rejected`,
      }
    }

    const data = await resp.json().catch(() => ({}))
    if (data?.code && data.code !== 0) {
      return {
        authenticated: false,
        loginUrl: metadata.loginUrl,
        reason: `${data.msg || 'Token rejected'} (code ${data.code})`,
      }
    }

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
 * Send a prompt to DeepSeek and stream or return the full answer.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @param {boolean} [options.thinking=false] - Enable R1 reasoning mode
 * @param {boolean} [options.search=true] - Enable online web search
 * @param {boolean} [options.temporary=true] - Auto-delete session after stream
 * @param {string} [options.token] - User token override
 * @returns {Promise<string>} Full response text
 */
export async function sendPrompt(
  prompt,
  {
    onChunk,
    signal,
    onLog,
    thinking = false,
    search = false,
    temporary = true,
    token,
  } = {},
) {
  log(onLog, 'info', 'PROMPT_START', 'Starting DeepSeek prompt execution', { prompt, thinking, search })

  let sessionId = null
  let userToken = null
  let fullResponse = ''
  let isFinished = false

  try {
    userToken = await getValidToken(token, onLog)

    // Parallelize session creation and PoW challenge to minimize latency
    const [createdSessionId, powResponse] = await Promise.all([
      createChatSession(userToken, { signal, onLog }),
      getPowResponse(userToken, { signal, onLog }),
    ])
    sessionId = createdSessionId

    const streamUrl = `${DEEPSEEK_BASE}/api/v0/chat/completion`
    const body = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: search,
      model_type: 'default',
    }

    log(onLog, 'info', 'STREAM_START', 'Starting DeepSeek SSE completion stream', {
      url: streamUrl,
      thinking,
      search,
    })

    await fetchSSE(streamUrl, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        'x-ds-pow-response': powResponse,
        Origin: DEEPSEEK_BASE,
        Referer: `${DEEPSEEK_BASE}/a/chat/s/${sessionId}`,
      },
      body: JSON.stringify(body),
      signal,
      onLog,
      onMessage: (message) => {
        if (isFinished) return
        const raw = typeof message === 'string' ? message : message?.data
        if (!raw) return
        if (raw.trim() === '[DONE]') return

        try {
          const parsed = JSON.parse(raw)

          // Error payload detection
          if (parsed.type === 'error' || parsed.code >= 40000) {
            const errMsg = parsed.msg || parsed.content || 'DeepSeek error'
            throw createHttpError(`DeepSeek: ${errMsg}`, parsed.code || null, 'deepseek', 'HTTP_ERROR')
          }

          // Handle completion status signal
          if (parsed.p === 'response/status') {
            log(onLog, 'debug', 'STATUS', `DeepSeek response status: ${parsed.v}`, { status: parsed.v })
            if (parsed.v === 'COMPLETED' || parsed.v === 'FINISHED') {
              isFinished = true
              return
            }
          }

          // Handle session title generation event
          const path = String(parsed.p || '')
          if (path.includes('title') || path.includes('session') || path.includes('conversation')) {
            log(onLog, 'debug', 'TITLE', 'DeepSeek generated session title', { title: parsed.v })
            return
          }

          // Extract delta from multiple supported SSE response schemas
          let delta = ''
          if (typeof parsed.choices?.[0]?.delta?.content === 'string') {
            delta = parsed.choices[0].delta.content
          } else if (typeof parsed.choices?.[0]?.text === 'string') {
            delta = parsed.choices[0].text
          } else if (typeof parsed.delta?.content === 'string') {
            delta = parsed.delta.content
          } else if (typeof parsed.content === 'string') {
            delta = parsed.content
          } else if (typeof parsed.text === 'string') {
            delta = parsed.text
          } else if (typeof parsed.v === 'string') {
            const isNonContent = path.includes('status') || path.includes('search_query') || path.includes('meta')
            if (!isNonContent) {
              delta = parsed.v
            }
          } else if (Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (typeof item === 'string') delta += item
              else if (item && typeof item.content === 'string') delta += item.content
              else if (item && typeof item.text === 'string') delta += item.text
            }
          } else if (parsed.v && typeof parsed.v === 'object') {
            const frags = parsed.v?.response?.fragments || parsed.v?.fragments || parsed.response?.fragments
            if (Array.isArray(frags)) {
              for (const frag of frags) {
                if (typeof frag?.content === 'string') delta += frag.content
                else if (typeof frag?.text === 'string') delta += frag.text
              }
            } else if (typeof parsed.v.content === 'string') {
              delta = parsed.v.content
            } else if (typeof parsed.v.text === 'string') {
              delta = parsed.v.text
            }
          }

          if (delta) {
            fullResponse += delta
            log(onLog, 'debug', 'STREAM', 'Accumulated response text', { delta, length: fullResponse.length })
            if (onChunk) onChunk(fullResponse)
          } else {
            log(onLog, 'debug', 'STREAM_MSG', 'Non-content SSE event', {
              p: parsed.p || null,
              keys: Object.keys(parsed),
              v: parsed.v,
            })
          }
        } catch (e) {
          if (e.provider === 'deepseek') throw e
          // Ignore non-JSON lines
        }
      },
      onError: (err) => {
        log(onLog, 'error', 'STREAM_ERROR', 'DeepSeek SSE stream error', { error: err.message })
        throw err
      },
    })

    log(onLog, 'info', 'STREAM_FINISH', 'Completed DeepSeek stream', { responseLength: fullResponse.length })
    if (!fullResponse) {
      log(onLog, 'error', 'EMPTY_RESPONSE', 'DeepSeek completed stream with empty response')
      throw createHttpError('DeepSeek: Empty response received from server.', 500, 'deepseek', 'EMPTY_RESPONSE', metadata.loginUrl)
    }

    log(onLog, 'info', 'PROMPT_COMPLETE', 'DeepSeek finished successfully', {
      answer: fullResponse,
      length: fullResponse.length,
    })

    return fullResponse
  } catch (err) {
    if (err && !err.provider) err.provider = 'deepseek'
    if (err && err.code === 'AUTH_REQUIRED' && !err.actionUrl) {
      err.actionUrl = metadata.loginUrl
    }
    log(onLog, 'error', 'PROMPT_ERROR', `DeepSeek prompt execution failed: ${err.message || String(err)}`, {
      code: err.code || null,
      status: err.status || null,
    })
    throw err
  } finally {
    if (temporary && sessionId && userToken) {
      await deleteChatSession(sessionId, userToken, { onLog })
    }
  }
}
