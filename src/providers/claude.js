/**
 * @module providers/claude
 * Claude Web Provider
 *
 * Reverse-engineered Claude web API using session cookie auth.
 *
 * Extracted from:
 *   https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8/src/services/clients/claude/index.mjs
 *
 * Key adaptations:
 *   - Stripped class abstraction to a single sendPrompt() function
 *   - Model parameter is OMITTED from request body (avoids model_not_allowed error)
 *   - Conversation is created, used, then deleted (single-turn)
 */

import { fetchSSE } from '../utils/sse-parser.js'
import { createLogger } from '../utils/log.js'
import { generateUUID } from '../utils/crypto.js'
import { buildCookieString, assertOk, createHttpError } from '../utils/http.js'

const log = createLogger('claude')

// --- Helpers ---

async function getClaudeAuth(onLog) {
  const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai/' })
  log(onLog, 'debug', 'COOKIE', 'Retrieved all cookies for https://claude.ai/', cookies)
  const sessionCookie = cookies.find((c) => c.name === 'sessionKey')
  if (!sessionCookie?.value) {
    throw createHttpError('Claude: Not logged in. Please log in at https://claude.ai', null, 'claude', 'AUTH_REQUIRED')
  }
  const cookieStr = buildCookieString(cookies)
  return { sessionKey: sessionCookie.value, cookieStr }
}

function makeHeaders(cookieStr) {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream,text/event-stream',
    Cookie: cookieStr,
  }
}

async function getOrganizationId(cookieStr, onLog) {
  const headers = makeHeaders(cookieStr)
  log(onLog, 'info', 'NETWORK_REQUEST', 'Fetching Claude organizations', {
    url: 'https://claude.ai/api/organizations',
    headers,
  })

  const resp = await fetch('https://claude.ai/api/organizations', {
    credentials: 'include',
    headers,
  })
  await assertOk(resp, 'Claude organizations', { onLog, log, provider: 'claude' })
  const text = await resp.text()
  if (text.includes('available in certain regions')) {
    log(onLog, 'error', 'REGION_BLOCK', 'Claude region restriction detected', { text })
    throw createHttpError('Claude: Not available in your region', 403, 'claude', 'FORBIDDEN')
  }
  const orgs = JSON.parse(text)
  log(onLog, 'info', 'NETWORK_RESPONSE', 'Retrieved Claude organizations list', orgs)
  if (!orgs?.length) throw createHttpError('Claude: No organizations found', null, 'claude', 'AUTH_REQUIRED')
  return orgs[0].uuid
}

async function createConversation(orgId, cookieStr, signal, onLog) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`
  const headers = makeHeaders(cookieStr)
  const body = { name: '', uuid: generateUUID() }

  log(onLog, 'info', 'NETWORK_REQUEST', 'Creating temporary chat conversation', {
    url,
    headers,
    body,
  })

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    signal,
    body: JSON.stringify(body),
  })
  await assertOk(resp, 'Claude createConversation', { onLog, log, provider: 'claude' })
  const data = await resp.json()
  log(onLog, 'info', 'NETWORK_RESPONSE', 'Created temporary conversation', data)
  if (!data?.uuid) throw new Error('Claude: Failed to create conversation')
  return data.uuid
}

async function deleteConversation(orgId, convoId, cookieStr, onLog) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convoId}`
  log(onLog, 'info', 'CLEANUP', 'Deleting temporary conversation', { url })
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      headers: makeHeaders(cookieStr),
    })
    log(onLog, 'info', 'CLEANUP_RESPONSE', `Delete conversation HTTP ${resp.status}`)
  } catch (err) {
    log(onLog, 'warn', 'CLEANUP_ERROR', 'Failed to delete temporary conversation', { error: err.message })
  }
}

// --- Main send function ---

/**
 * @typedef {Object} PromptOptions
 * @property {(chunk: string) => void} [onChunk] - Called with accumulated answer text
 * @property {AbortSignal} [signal] - Abort signal to cancel the request
 * @property {(entry: import('../utils/log.js').LogEntry) => void} [onLog] - Called with diagnostic log events
 */

/**
 * Send a prompt to Claude web and stream the response.
 * @param {string} prompt
 * @param {PromptOptions} [options]
 * @returns {Promise<string>} final answer text
 */
export async function sendPrompt(prompt, { onChunk, signal, onLog } = {}) {
  log(onLog, 'info', 'PROMPT_START', 'Starting Claude prompt execution', { prompt })

  let orgId = null
  let convoId = null
  let cookieStr = null

  try {
    const auth = await getClaudeAuth(onLog)
    cookieStr = auth.cookieStr
    orgId = await getOrganizationId(cookieStr, onLog)
    convoId = await createConversation(orgId, cookieStr, signal, onLog)

    let fullResponse = ''

    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convoId}/completion`

    // IMPORTANT: model is intentionally omitted to avoid "model_not_allowed" errors.
    // Claude will use the default model for the user's plan.
    const body = {
      prompt,
      attachments: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    }

    const headers = makeHeaders(cookieStr)
    log(onLog, 'info', 'NETWORK_REQUEST', 'Dispatching completion request to Claude', {
      url,
      headers,
      body,
    })

    await fetchSSE(url, {
      provider: 'claude',
      method: 'POST',
      credentials: 'include',
      signal,
      headers,
      body: JSON.stringify(body),
      onMessage(message) {
        log(onLog, 'debug', 'SSE_RAW', 'Raw Claude SSE chunk', { raw: message })
        try {
          const parsed = JSON.parse(message)
          if (parsed.error) {
            log(onLog, 'error', 'API_ERROR', 'Claude returned error object in stream', parsed.error)
            throw new Error(`Claude API error: ${JSON.stringify(parsed.error)}`)
          }
          if (parsed.completion) {
            fullResponse += parsed.completion
            log(onLog, 'debug', 'STREAM', 'Accumulated response text', { length: fullResponse.length })
            if (onChunk) onChunk(fullResponse)
          }
        } catch (e) {
          if (e.message?.startsWith('Claude API error')) throw e
          // ignore parse errors on intermediate chunks
        }
      },
      onError(err) {
        log(onLog, 'error', 'SSE_ERROR', 'Claude SSE error', { error: err.message, stack: err.stack })
        throw err
      },
    })

    log(onLog, 'info', 'PROMPT_COMPLETE', 'Claude finished successfully', { length: fullResponse.length })
    return fullResponse
  } catch (err) {
    if (err && !err.provider) err.provider = 'claude'
    log(onLog, 'error', 'ERROR', `Claude failed: ${err.message || String(err)}`, { stack: err.stack })
    throw err
  } finally {
    if (orgId && convoId && cookieStr) {
      await deleteConversation(orgId, convoId, cookieStr, onLog)
    }
  }
}

/**
 * Pre-flight authentication check for Claude.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie'] - 'cookie' for fast passive inspection, 'network' to ping /api/organizations
 * @param {AbortSignal} [options.signal]
 * @param {(entry: import('../utils/log.js').LogEntry) => void} [options.onLog]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog } = {}) {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai/' })
    log(onLog, 'debug', 'COOKIE', 'checkAuth: retrieved cookies for https://claude.ai/', cookies)
    const sessionCookie = cookies.find((c) => c.name === 'sessionKey')
    if (!sessionCookie?.value) {
      return {
        authenticated: false,
        loginUrl: 'https://claude.ai/login',
        reason: 'Missing sessionKey cookie',
      }
    }

    if (mode === 'network') {
      const cookieStr = buildCookieString(cookies)
      const headers = makeHeaders(cookieStr)
      log(onLog, 'info', 'NETWORK_REQUEST', 'checkAuth: verifying Claude organizations endpoint', {
        url: 'https://claude.ai/api/organizations',
      })
      const resp = await fetch('https://claude.ai/api/organizations', {
        credentials: 'include',
        headers,
        signal,
      })
      if (!resp.ok) {
        const reason = resp.status === 403 ? 'Forbidden' : `HTTP ${resp.status}`
        return {
          authenticated: false,
          loginUrl: 'https://claude.ai/login',
          reason,
        }
      }
      const text = await resp.text().catch(() => '')
      if (text.includes('available in certain regions')) {
        return {
          authenticated: false,
          loginUrl: 'https://claude.ai/',
          reason: 'Not available in your region',
        }
      }
      let orgs
      try {
        orgs = JSON.parse(text)
      } catch {
        orgs = null
      }
      if (!orgs?.length) {
        return {
          authenticated: false,
          loginUrl: 'https://claude.ai/',
          reason: 'No organizations found',
        }
      }
    }

    return {
      authenticated: true,
      loginUrl: 'https://claude.ai/',
    }
  } catch (err) {
    log(onLog, 'error', 'AUTH_CHECK_ERROR', `Claude checkAuth error: ${err.message}`, { error: err.message })
    return {
      authenticated: false,
      loginUrl: 'https://claude.ai/login',
      reason: err.message,
    }
  }
}
