/**
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

// --- Helpers ---

function uuid() {
  return crypto.randomUUID()
}

async function getClaudeAuth() {
  const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai/' })
  const sessionCookie = cookies.find((c) => c.name === 'sessionKey')
  if (!sessionCookie?.value) {
    throw new Error('Claude: Not logged in. Please log in at https://claude.ai')
  }
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  return { sessionKey: sessionCookie.value, cookieStr }
}

function makeHeaders(cookieStr) {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream,text/event-stream',
    Cookie: cookieStr,
  }
}

async function getOrganizationId(cookieStr) {
  const resp = await fetch('https://claude.ai/api/organizations', {
    credentials: 'include',
    headers: makeHeaders(cookieStr),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Claude organizations HTTP ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const text = await resp.text()
  if (text.includes('available in certain regions')) {
    throw new Error('Claude: Not available in your region')
  }
  const orgs = JSON.parse(text)
  if (!orgs?.length) throw new Error('Claude: No organizations found')
  return orgs[0].uuid
}

async function createConversation(orgId, cookieStr, signal) {
  const resp = await fetch(
    `https://claude.ai/api/organizations/${orgId}/chat_conversations`,
    {
      method: 'POST',
      credentials: 'include',
      headers: makeHeaders(cookieStr),
      signal,
      body: JSON.stringify({ name: '', uuid: uuid() }),
    },
  )
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Claude createConversation HTTP ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  if (!data?.uuid) throw new Error('Claude: Failed to create conversation')
  return data.uuid
}

async function deleteConversation(orgId, convoId, cookieStr) {
  try {
    await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convoId}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: makeHeaders(cookieStr),
      },
    )
  } catch {
    // best-effort cleanup
  }
}

// --- Main send function ---

/**
 * Send a prompt to Claude web and stream the response.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk] - called with accumulated answer text
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} final answer text
 */
export async function sendPrompt(prompt, { onChunk, signal } = {}) {
  const { cookieStr } = await getClaudeAuth()
  const orgId = await getOrganizationId(cookieStr)
  const convoId = await createConversation(orgId, cookieStr, signal)

  let fullResponse = ''

  try {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convoId}/completion`

    // IMPORTANT: model is intentionally omitted to avoid "model_not_allowed" errors.
    // Claude will use the default model for the user's plan.
    const body = {
      prompt,
      attachments: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    }

    await fetchSSE(url, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: makeHeaders(cookieStr),
      body: JSON.stringify(body),
      onMessage(message) {
        try {
          const parsed = JSON.parse(message)
          if (parsed.error) {
            throw new Error(`Claude API error: ${JSON.stringify(parsed.error)}`)
          }
          if (parsed.completion) {
            fullResponse += parsed.completion
            if (onChunk) onChunk(fullResponse)
          }
        } catch (e) {
          if (e.message?.startsWith('Claude API error')) throw e
          // ignore parse errors on intermediate chunks
        }
      },
      onError(err) {
        throw err
      },
    })
  } finally {
    // Clean up single-turn conversation
    await deleteConversation(orgId, convoId, cookieStr)
  }

  return fullResponse
}
