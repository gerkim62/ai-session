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
import { buildCookieString, assertOk } from '../utils/http.js'

const log = createLogger('claude')

// --- Helpers ---

async function getClaudeAuth(onLog) {
  const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai/' })
  log(onLog, 'debug', 'COOKIE', 'Retrieved all cookies for https://claude.ai/', cookies)
  const sessionCookie = cookies.find((c) => c.name === 'sessionKey')
  if (!sessionCookie?.value) {
    throw new Error('Claude: Not logged in. Please log in at https://claude.ai')
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
  await assertOk(resp, 'Claude organizations', { onLog, log })
  const text = await resp.text()
  if (text.includes('available in certain regions')) {
    log(onLog, 'error', 'REGION_BLOCK', 'Claude region restriction detected', { text })
    throw new Error('Claude: Not available in your region')
  }
  const orgs = JSON.parse(text)
  log(onLog, 'info', 'NETWORK_RESPONSE', 'Retrieved Claude organizations list', orgs)
  if (!orgs?.length) throw new Error('Claude: No organizations found')
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
  await assertOk(resp, 'Claude createConversation', { onLog, log })
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
    log(onLog, 'error', 'ERROR', `Claude failed: ${err.message || String(err)}`, { stack: err.stack })
    throw err
  } finally {
    if (orgId && convoId && cookieStr) {
      await deleteConversation(orgId, convoId, cookieStr, onLog)
    }
  }
}
