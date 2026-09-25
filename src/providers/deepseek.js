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
  log(onLog, 'debug', 'STORAGE', 'Retrieved DeepSeek userToken from storage')
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

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({}),
  })

  await assertOk(resp, 'DeepSeek createChatSession', { onLog, log, provider: 'deepseek' })
  const data = await resp.json()

  const sessionId = data?.data?.biz_data?.chat_session?.id || data?.data?.biz_data?.id

  if (!sessionId) {
    throw createHttpError('DeepSeek: Failed to obtain chat_session_id', resp.status, 'deepseek', 'HTTP_ERROR')
  }

  log(onLog, 'info', 'NETWORK_RESPONSE', 'Created DeepSeek session', { sessionId })
  return sessionId
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
  try {
    log(onLog, 'info', 'NETWORK_REQUEST', 'Deleting temporary DeepSeek session', { sessionId })
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: DEEPSEEK_BASE,
      },
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

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  })

  await assertOk(resp, 'DeepSeek create_pow_challenge', { onLog, log, provider: 'deepseek' })
  const data = await resp.json()
  const challenge = data?.data?.biz_data?.challenge

  if (!challenge) {
    throw createHttpError('DeepSeek: Missing PoW challenge in response', resp.status, 'deepseek', 'HTTP_ERROR')
  }

  log(onLog, 'info', 'POW_CHALLENGE', 'Solving DeepSeek PoW challenge', {
    algorithm: challenge.algorithm,
    difficulty: challenge.difficulty,
  })

  const solved = await solveDeepSeekPoW(challenge)
  log(onLog, 'info', 'POW_SOLVED', 'DeepSeek PoW solved successfully')
  return solved
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
    search = true,
    temporary = true,
    token,
  } = {},
) {
  log(onLog, 'info', 'PROMPT_START', 'Starting DeepSeek prompt execution', { prompt })

  const userToken = await getValidToken(token, onLog)
  const sessionId = await createChatSession(userToken, { signal, onLog })
  const powResponse = await getPowResponse(userToken, { signal, onLog })

  let fullResponse = ''

  try {
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

          // Content chunk from fragments
          const val = parsed.v
          const path = parsed.p || ''

          if (typeof val === 'string' && val) {
            // Check if it is regular response content or thinking
            if (path.includes('fragments') || path.includes('content')) {
              fullResponse += val
              log(onLog, 'debug', 'STREAM', 'Accumulated response text', { delta: val, length: fullResponse.length })
              if (onChunk) onChunk(fullResponse)
            }
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
    log(onLog, 'error', 'ERROR', `DeepSeek failed: ${err.message || String(err)}`, { stack: err.stack })
    throw err
  } finally {
    if (temporary) {
      await deleteChatSession(sessionId, userToken, { onLog })
    }
  }
}
