/**
 * @module providers/kimi
 * Kimi (Moonshot AI) Provider
 *
 * Reverse-engineered Kimi web API supporting both International (kimi.ai)
 * and Mainland China (kimi.moonshot.cn / kimi.com) environments.
 *
 * Adapted from:
 *   https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/src/services/apis/moonshot-web.mjs
 *
 * Features:
 *   - Auto-extracts access_token / refresh_token from chrome.storage.local
 *   - Supports both direct access_token auth (kimi.ai) and refresh_token rotation
 *   - Cluster-aware routing (automatically routes to kimi.ai or kimi.moonshot.cn)
 *   - Ephemeral single-turn conversation lifecycle (create, stream, delete)
 *   - Auto-routes to Kimi's latest server model by omitting model param (avoids maintenance on model deprecations)
 */

import { fetchSSE } from '../utils/sse-parser.js'
import { createLogger } from '../utils/log.js'
import { assertOk, createHttpError } from '../utils/http.js'

export const metadata = {
  id: 'kimi',
  displayName: 'Kimi (kimi.ai)',
  shortName: 'Kimi',
  loginUrl: 'https://kimi.ai/',
  challengeUrl: 'https://kimi.ai/',
  homeUrl: 'https://kimi.ai/',
}

const log = createLogger('kimi')

/**
 * Retrieve stored Kimi tokens from chrome.storage.local.
 * @returns {Promise<{ refreshToken: string, accessToken: string, origin: string }>}
 */
async function getStoredTokens() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const data = await chrome.storage.local.get([
      'kimi_refresh_token',
      'kimi_access_token',
      'kimi_origin',
    ])
    return {
      refreshToken: data.kimi_refresh_token || '',
      accessToken: data.kimi_access_token || '',
      origin: data.kimi_origin || 'https://kimi.ai',
    }
  }
  return { refreshToken: '', accessToken: '', origin: 'https://kimi.ai' }
}

/**
 * Save updated Kimi tokens to chrome.storage.local.
 * @param {string} refreshToken
 * @param {string} [accessToken]
 * @param {string} [origin]
 */
async function saveStoredTokens(refreshToken, accessToken = '', origin = '') {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const update = {}
    if (refreshToken) update.kimi_refresh_token = refreshToken
    if (accessToken) update.kimi_access_token = accessToken
    if (origin) update.kimi_origin = origin
    await chrome.storage.local.set(update)
  }
}

/**
 * Refresh the ephemeral access token using the long-lived refresh token.
 * @param {string} refreshToken
 * @param {string} [origin]
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ accessToken: string, refreshToken: string, origin: string }>}
 */
async function refreshAccessToken(refreshToken, origin = 'https://kimi.ai', { signal, onLog } = {}) {
  const url = `${origin}/api/auth/token/refresh`
  const headers = {
    Accept: '*/*',
    Authorization: `Bearer ${refreshToken}`,
    Origin: origin,
  }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Refreshing Kimi access token', {
    url,
    origin,
    headers: { ...headers, Authorization: 'Bearer [REDACTED]' },
  })

  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  })

  await assertOk(resp, 'Kimi token refresh', { onLog, log, provider: 'kimi' })
  const data = await resp.json()

  if (!data?.access_token) {
    throw createHttpError('Kimi: Invalid token refresh response', resp.status, 'kimi', 'AUTH_REQUIRED', metadata.loginUrl)
  }

  const newAccessToken = data.access_token
  const newRefreshToken = data.refresh_token || refreshToken

  log(onLog, 'info', 'NETWORK_RESPONSE', 'Successfully refreshed Kimi tokens', {
    hasAccessToken: !!newAccessToken,
    hasNewRefreshToken: !!data.refresh_token,
    origin,
  })

  // Persist the rotated tokens directly to chrome.storage.local
  await saveStoredTokens(newRefreshToken, newAccessToken, origin)

  return { accessToken: newAccessToken, refreshToken: newRefreshToken, origin }
}

/**
 * Extract expiration time from JWT token if available.
 * @param {string} token
 * @returns {number | null} Timestamp in ms, or null
 */
function getJwtExp(token) {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(base64))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Obtain a valid access token and cluster origin.
 * @param {object} [options]
 * @param {string} [options.token] - Explicit token override
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ accessToken: string, origin: string }>}
 */
async function getValidAccessToken({ token, signal, onLog } = {}) {
  log(onLog, 'debug', 'STORAGE', 'Checking chrome.storage.local for Kimi credentials')
  let { refreshToken, accessToken, origin } = await getStoredTokens()

  if (token) {
    if (token.startsWith('eyJ')) {
      accessToken = token
    } else {
      refreshToken = token
    }
    log(onLog, 'debug', 'AUTH', 'Using provided explicit token override')
  }

  log(onLog, 'debug', 'STORAGE', 'Kimi tokens in storage', {
    hasRefreshToken: !!refreshToken,
    hasAccessToken: !!accessToken,
    origin,
  })

  // 1. If accessToken exists, check its JWT expiration or ping /api/user with timeout
  if (accessToken) {
    const exp = getJwtExp(accessToken)
    const now = Date.now()

    if (exp && now < exp - 30000) {
      // Token is valid with > 30s remaining
      log(onLog, 'info', 'AUTH', 'Kimi access token is valid (active JWT session)', {
        expiresInSeconds: Math.round((exp - now) / 1000),
        origin,
      })
      return { accessToken, origin }
    }

    if (exp && now >= exp - 30000) {
      log(onLog, 'info', 'AUTH', 'Kimi access token has expired; refreshing with refresh_token', {
        expiredAgoSeconds: Math.round((now - exp) / 1000),
      })
    } else {
      // Non-JWT token or missing exp: ping /api/user with 3s timeout
      try {
        log(onLog, 'debug', 'AUTH', `Verifying Kimi access token via ${origin}/api/user`)
        const timeoutCtrl = new AbortController()
        const timeoutId = setTimeout(() => timeoutCtrl.abort(), 3000)
        const userResp = await fetch(`${origin}/api/user`, {
          headers: {
            Accept: '*/*',
            Authorization: `Bearer ${accessToken}`,
            Origin: origin,
          },
          signal: signal || timeoutCtrl.signal,
        })
        clearTimeout(timeoutId)
        if (userResp.ok) {
          log(onLog, 'info', 'AUTH', 'Kimi access token is valid!')
          return { accessToken, origin }
        }
        log(onLog, 'warn', 'AUTH', `Kimi access token verification returned HTTP ${userResp.status}`)
      } catch (err) {
        log(onLog, 'debug', 'AUTH', 'Network check on access token skipped/failed, proceeding', err.message)
        if (!refreshToken) {
          return { accessToken, origin }
        }
      }
    }
  }

  // 2. If access token is expired or missing, try refreshing if refreshToken exists
  if (refreshToken) {
    try {
      log(onLog, 'info', 'AUTH', 'Refreshing Kimi token via refresh_token')
      const refreshed = await refreshAccessToken(refreshToken, origin, { signal, onLog })
      return { accessToken: refreshed.accessToken, origin }
    } catch (err) {
      log(onLog, 'warn', 'AUTH', 'Failed to refresh Kimi token', err.message)
    }
  }

  // 3. No valid tokens found
  log(onLog, 'warn', 'AUTH', 'Kimi session token not found in chrome.storage.local', {
    loginUrl: metadata.loginUrl,
    reason: 'Please open https://kimi.ai once while logged in to sync your session into extension storage. Once synced, you can close the tab.',
  })

  throw createHttpError(
    'Kimi: Session token not found. Please click the link below to open Kimi (https://kimi.ai) once to sync your login session. Once synced, you can close the tab.',
    null,
    'kimi',
    'AUTH_REQUIRED',
    metadata.loginUrl,
  )
}

/**
 * Create a new conversation on Kimi.
 * @param {string} accessToken
 * @param {string} origin
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @returns {Promise<string>} Conversation ID
 */
async function createConversation(accessToken, origin = 'https://kimi.ai', { signal, onLog } = {}) {
  const url = `${origin}/api/chat`
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: origin,
  }
  const body = { name: '未命名会话', is_example: false }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Creating Kimi conversation', { url, origin, body })

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
  })

  await assertOk(resp, 'Kimi create conversation', { onLog, log, provider: 'kimi' })
  const data = await resp.json()

  if (!data?.id) {
    throw createHttpError('Kimi: Failed to create conversation', resp.status, 'kimi', 'HTTP_ERROR')
  }

  log(onLog, 'info', 'NETWORK_RESPONSE', 'Created Kimi conversation', { conversationId: data.id })
  return data.id
}

/**
 * Delete a temporary conversation from Kimi.
 * @param {string} conversationId
 * @param {string} accessToken
 * @param {string} origin
 * @param {object} [options]
 * @param {Function} [options.onLog]
 */
async function deleteConversation(conversationId, accessToken, origin = 'https://kimi.ai', { onLog } = {}) {
  const url = `${origin}/api/chat/${conversationId}`
  try {
    log(onLog, 'info', 'NETWORK_REQUEST', 'Deleting temporary Kimi conversation', { url, conversationId, origin })
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${accessToken}`,
        Origin: origin,
      },
    })
    log(onLog, 'debug', 'NETWORK_RESPONSE', 'Deleted temporary Kimi conversation', { status: resp.status, conversationId })
  } catch (err) {
    log(onLog, 'warn', 'CLEANUP_ERROR', 'Failed to delete temporary Kimi conversation', { error: err.message, conversationId })
  }
}

/**
 * Check authentication status for Kimi.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie']
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @param {string} [options.token]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog, token } = {}) {
  try {
    log(onLog, 'debug', 'STORAGE', 'Checking Kimi auth status in chrome.storage.local')
    const { refreshToken, accessToken, origin } = await getStoredTokens()
    const activeToken = token || accessToken || refreshToken

    log(onLog, 'debug', 'STORAGE', 'Kimi token presence', {
      hasRefreshToken: !!refreshToken,
      hasAccessToken: !!accessToken,
      hasActiveToken: !!activeToken,
      origin,
    })

    if (!activeToken) {
      log(onLog, 'warn', 'AUTH', 'No Kimi token found in chrome.storage.local')
      return {
        authenticated: false,
        loginUrl: metadata.loginUrl,
        reason: 'Kimi session token not found. Please open Kimi (https://kimi.ai) once to sync your session. Once synced, you can close the tab.',
      }
    }

    if (mode === 'cookie') {
      return { authenticated: true, loginUrl: metadata.loginUrl }
    }

    // Network mode: verify reachability
    await getValidAccessToken({ token, signal, onLog })
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
 * Send a prompt to Kimi and stream or return the full answer.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onLog]
 * @param {string} [options.model] - Optional model identifier (e.g. 'k1.5', 'k1.5-thinking'). Omitted by default to let Kimi's server auto-route to the latest default model without requiring client updates.
 * @param {boolean} [options.temporary=true] - Auto-delete conversation after stream
 * @param {boolean} [options.useSearch=true] - Enable online web search
 * @param {string} [options.token] - Refresh token override
 * @returns {Promise<string>} Full response text
 */
export async function sendPrompt(
  prompt,
  {
    onChunk,
    signal,
    onLog,
    model,
    temporary = true,
    useSearch = true,
    token,
  } = {},
) {
  log(onLog, 'info', 'PROMPT_START', 'Starting Kimi prompt execution', { prompt })

  const { accessToken, origin } = await getValidAccessToken({ token, signal, onLog })
  const conversationId = await createConversation(accessToken, origin, { signal, onLog })

  let fullResponse = ''
  let resolvedModel = (model && model !== 'auto' && model !== 'default') ? model : ''

  try {
    const streamUrl = `${origin}/api/chat/${conversationId}/completion/stream`
    const body = {
      kimiplus_id: 'kimi',
      messages: [{ role: 'user', content: prompt }],
      refs: [],
      use_search: useSearch,
      use_deep_research: false,
      use_semantic_memory: false,
    }

    if (resolvedModel) {
      body.model = resolvedModel
    }

    log(onLog, 'info', 'STREAM_START', 'Starting Kimi SSE completion stream', {
      url: streamUrl,
      origin,
      model: body.model || 'auto (server default)',
      useSearch,
    })

    await fetchSSE(streamUrl, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        Origin: origin,
      },
      body: JSON.stringify(body),
      signal,
      onLog,
      onMessage: (message) => {
        const raw = typeof message === 'string' ? message : message?.data
        if (!raw) return

        try {
          const parsed = JSON.parse(raw)

          if (parsed.error || parsed.event === 'error') {
            const errMsg = parsed.error?.message || parsed.error?.msg || parsed.msg || JSON.stringify(parsed.error || parsed)
            log(onLog, 'error', 'API_ERROR', 'Kimi returned error in stream', { error: errMsg })
            throw createHttpError(`Kimi error: ${errMsg}`, null, 'kimi', 'HTTP_ERROR')
          }

          // Capture actual model resolved by Kimi server (e.g. "kimi")
          if (parsed.model && !resolvedModel) {
            resolvedModel = parsed.model
          }

          if (parsed.event === 'req') {
            log(onLog, 'debug', 'STREAM_EVENT', 'Kimi server acknowledged request', {
              id: parsed.id,
              model: parsed.model,
              groupId: parsed.group_id,
            })
          } else if (parsed.event === 'resp') {
            log(onLog, 'info', 'STREAM_EVENT', 'Kimi generation started', {
              id: parsed.id,
              model: parsed.model,
              groupId: parsed.group_id,
            })
          } else if (parsed.event === 'loading') {
            log(onLog, 'debug', 'STREAM_EVENT', `Kimi server loading: ${parsed.loading}`, {
              loading: parsed.loading,
            })
          } else if (parsed.event === 'rename') {
            log(onLog, 'debug', 'STREAM_EVENT', `Kimi conversation titled: "${parsed.text}"`, {
              title: parsed.text,
            })
          } else if (parsed.event === 'zone_set') {
            log(onLog, 'debug', 'STREAM_EVENT', `Kimi zone configured: ${parsed.zone_type}`, {
              zoneType: parsed.zone_type,
              zoneIndex: parsed.idx_z,
            })
          } else if (parsed.event === 'cmpl') {
            let textChunk = ''
            if (typeof parsed.text === 'string') {
              textChunk = parsed.text
            } else if (parsed.choices?.[0]?.delta?.content) {
              textChunk = parsed.choices[0].delta.content
            }

            if (textChunk) {
              fullResponse += textChunk
              log(onLog, 'debug', 'STREAM', 'Accumulated response text', {
                delta: textChunk,
                length: fullResponse.length,
              })
              if (onChunk) onChunk(fullResponse)
            }
          } else if (parsed.event === 'done') {
            log(onLog, 'debug', 'STREAM_EVENT', 'Kimi text completion done')
          } else if (parsed.event === 'all_done') {
            log(onLog, 'info', 'STREAM_EVENT', 'Kimi stream all_done received')
          } else if (parsed.event !== 'ping') {
            log(onLog, 'debug', 'STREAM_EVENT', `Kimi event: ${parsed.event || 'chunk'}`, parsed)
          }
        } catch (e) {
          if (e.provider === 'kimi') throw e
          // Non-JSON or empty lines in SSE stream
        }
      },
      onError: (err) => {
        log(onLog, 'error', 'STREAM_ERROR', 'Kimi SSE stream error', { error: err.message })
        throw err
      },
    })

    log(onLog, 'info', 'STREAM_FINISH', 'Completed Kimi stream', { responseLength: fullResponse.length })

    if (!fullResponse) {
      log(onLog, 'error', 'EMPTY_RESPONSE', 'Kimi completed stream with empty response')
      throw createHttpError(
        'Kimi: Empty response received from server. Your session may have expired or was rate-limited.',
        500,
        'kimi',
        'EMPTY_RESPONSE',
        metadata.loginUrl,
      )
    }

    log(onLog, 'info', 'PROMPT_COMPLETE', 'Kimi finished successfully', {
      answer: fullResponse,
      length: fullResponse.length,
      model: resolvedModel || body.model || 'kimi',
    })

    return fullResponse
  } catch (err) {
    if (err && !err.provider) err.provider = 'kimi'
    if (err && err.code === 'AUTH_REQUIRED' && !err.actionUrl) {
      err.actionUrl = metadata.loginUrl
    }
    log(onLog, 'error', 'ERROR', `Kimi failed: ${err.message || String(err)}`, { stack: err.stack })
    throw err
  } finally {
    if (temporary) {
      await deleteConversation(conversationId, accessToken, origin, { onLog })
    }
  }
}
