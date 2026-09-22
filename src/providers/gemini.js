/**
 * @module providers/gemini
 * Gemini Web Provider
 *
 * Reverse-engineered Gemini (formerly Bard) web API.
 *
 * Adapted from TWO sources:
 *   1. ChatGPTBox Bard client:
 *      https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8/src/services/clients/bard/index.mjs
 *   2. HanaokaYuzu/Gemini-API Python client (for reference on cookies and endpoints):
 *      https://github.com/HanaokaYuzu/Gemini-API/blob/8c5b1dc/src/gemini_webapi/client.py
 *
 * Key details:
 *   - Requires __Secure-1PSID and __Secure-1PSIDTS cookies from google.com
 *   - Extracts SNlM0e and cfb2h tokens from gemini.google.com HTML
 *   - POSTs to /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   - Response is NOT SSE — it's a batch JSON format with )]}' prefix
 */

import { createLogger } from '../utils/log.js'
import { assertOk, createHttpError } from '../utils/http.js'

const log = createLogger('gemini')

// --- Cookie & token helpers ---

async function getCookies(onLog) {
  const psid = await chrome.cookies.get({
    url: 'https://gemini.google.com/',
    name: '__Secure-1PSID',
  })
  const psidts = await chrome.cookies.get({
    url: 'https://gemini.google.com/',
    name: '__Secure-1PSIDTS',
  })

  log(onLog, 'debug', 'COOKIE', 'Retrieved Gemini authentication cookies', {
    psid,
    psidts,
  })

  if (!psid?.value) {
    throw createHttpError('Gemini: Not logged in. Please log in at https://gemini.google.com', null, 'gemini', 'AUTH_REQUIRED')
  }

  let cookieStr = `__Secure-1PSID=${psid.value}`
  if (psidts?.value) {
    cookieStr += `; __Secure-1PSIDTS=${psidts.value}`
  }
  return cookieStr
}

async function getRequestParams(cookies, onLog) {
  log(onLog, 'info', 'NETWORK_REQUEST', 'Requesting gemini.google.com to extract anti-CSRF token and build label', {
    url: 'https://gemini.google.com/',
    headers: { Cookie: cookies },
  })

  const resp = await fetch('https://gemini.google.com/', {
    headers: { Cookie: cookies },
  })
  await assertOk(resp, 'Gemini request params', { onLog, log, provider: 'gemini' })
  const text = await resp.text()

  const snlm0eMatch = text.match(/"SNlM0e":\s*"([^"]+)"/)
  const cfb2hMatch = text.match(/"cfb2h":\s*"([^"]+)"/)

  log(onLog, 'info', 'TOKEN_EXTRACT', 'Parsed SNlM0e and cfb2h from page HTML', {
    snlm0eFound: Boolean(snlm0eMatch),
    snlm0e: snlm0eMatch?.[1] || null,
    cfb2hFound: Boolean(cfb2hMatch),
    cfb2h: cfb2hMatch?.[1] || null,
  })

  if (!snlm0eMatch) {
    throw createHttpError(
      'Gemini: Could not extract SNlM0e token. Cookie may be expired. ' +
        'Please visit https://gemini.google.com and refresh your session.',
      401,
      'gemini',
      'AUTH_REQUIRED',
    )
  }

  return {
    at: snlm0eMatch[1],  // anti-CSRF token
    bl: cfb2hMatch?.[1] || '',  // boq hash
  }
}

// --- Response parser ---
// Response parser using candidate extraction (matching HanaokaYuzu/Gemini-API client)
function parseResponse(text) {
  let answer = ''
  let fallbackLongest = ''

  const lines = text.split('\n')
  for (const line of lines) {
    if (!line.includes('wrb.fr')) continue

    try {
      const outerData = JSON.parse(line)
      const partBodyStr = outerData?.[0]?.[2]
      if (!partBodyStr) continue

      const partJson = JSON.parse(partBodyStr)

      // 1. Candidate extraction (partJson[4] is candidates_list)
      // HanaokaYuzu/Gemini-API selects candidates[0] as primary candidate
      const candidates = partJson?.[4]
      if (Array.isArray(candidates) && candidates.length > 0) {
        const primaryCand = candidates[0]
        if (Array.isArray(primaryCand)) {
          let candText = ''
          if (Array.isArray(primaryCand[1]) && typeof primaryCand[1][0] === 'string') {
            candText = primaryCand[1][0]
          }

          // If candText is a card placeholder or SWML descriptor, look at cand[22]
          if (
            !candText ||
            candText.startsWith('SWML_') ||
            /^https?:\/\/googleusercontent\.com\/card_content\/\d+/.test(candText)
          ) {
            if (Array.isArray(primaryCand[22]) && typeof primaryCand[22][0] === 'string') {
              candText = primaryCand[22][0]
            }
          }

          if (candText && !candText.startsWith('SWML_')) {
            answer = candText
          }
        }
      }

      // 2. Collect fallback strings if candidate not yet found
      if (!answer) {
        const findStrings = (obj) => {
          if (typeof obj === 'string') {
            if (
              obj.length > fallbackLongest.length &&
              !obj.startsWith('SWML_') &&
              !obj.startsWith('c_') &&
              !obj.startsWith('r_') &&
              !obj.startsWith('rc_') &&
              !obj.startsWith('http://googleusercontent') &&
              !obj.startsWith('https://googleusercontent') &&
              !obj.startsWith('f.req')
            ) {
              fallbackLongest = obj
            }
          } else if (Array.isArray(obj)) {
            for (const item of obj) findStrings(item)
          }
        }
        findStrings(partJson)
      }
    } catch {
      // skip unparseable lines
    }
  }

  return answer || fallbackLongest
}

// --- Text cleaner ---

function cleanGeminiText(text) {
  if (!text) return ''
  return text
    // Replace artifact placeholders with space/newline to prevent fusing adjacent words
    .replace(/https?:\/\/googleusercontent\.com\/(?:\w+\/)+\d+\n*/g, '\n\n')
    .replace(/https?:\/\/googleusercontent\.com\/\S+/g, ' ')
    .replace(/SWML_[A-Z0-9_]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// --- Main send function ---

/**
 * @typedef {Object} PromptOptions
 * @property {(chunk: string) => void} [onChunk] - Called once with the full answer
 * @property {AbortSignal} [signal] - Abort signal to cancel the request
 * @property {(entry: import('../utils/log.js').LogEntry) => void} [onLog] - Called with diagnostic log events
 */

/**
 * Send a prompt to Gemini web and return the response.
 * Note: Gemini does NOT stream via SSE — the full response comes in one batch.
 * @param {string} prompt
 * @param {PromptOptions} [options]
 * @returns {Promise<string>} answer text
 */
export async function sendPrompt(prompt, { onChunk, signal, onLog } = {}) {
  log(onLog, 'info', 'PROMPT_START', 'Starting Gemini prompt execution', { prompt })

  try {
    const cookies = await getCookies(onLog)
    const { at, bl } = await getRequestParams(cookies, onLog)

    const url =
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' +
      new URLSearchParams({ bl, rt: 'c', _reqid: '0' })

    const body = new URLSearchParams({
      at,
      'f.req': JSON.stringify([
        null,
        `[[${JSON.stringify(prompt)}],null,${JSON.stringify(['', '', ''])}]`,
      ]),
    })

    const bodyObj = Object.fromEntries(body.entries())
    log(onLog, 'info', 'NETWORK_REQUEST', 'Dispatching request to StreamGenerate endpoint', {
      url,
      headers: { Cookie: cookies },
      body: bodyObj,
    })

    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { Cookie: cookies },
      body,
    })

    await assertOk(resp, 'Gemini', { onLog, log, provider: 'gemini' })

    const data = await resp.text()
    log(onLog, 'info', 'NETWORK_RESPONSE', `StreamGenerate responded with ${resp.status}`, {
      status: resp.status,
      bytesReceived: data.length,
      rawPayloadPreview: data.slice(0, 1000),
    })

    const rawAnswer = parseResponse(data)
    log(onLog, 'debug', 'PARSED_RAW', 'Extracted raw answer candidate from payload', {
      rawAnswerLength: rawAnswer.length,
      rawAnswerPreview: rawAnswer.slice(0, 300),
    })

    const answer = cleanGeminiText(rawAnswer)
    log(onLog, 'debug', 'CLEANED_TEXT', 'Cleaned answer text', {
      answerLength: answer.length,
    })

    if (!answer) {
      log(onLog, 'error', 'EMPTY_RESPONSE', 'Gemini returned an empty response after cleaning', {
        rawPayload: data,
      })
      throw createHttpError('Gemini: Empty response. Session may have expired.', 401, 'gemini', 'AUTH_REQUIRED')
    }

    if (onChunk) onChunk(answer)
    log(onLog, 'info', 'PROMPT_COMPLETE', 'Gemini completed successfully', { answerLength: answer.length })
    return answer
  } catch (err) {
    if (err && !err.provider) err.provider = 'gemini'
    log(onLog, 'error', 'ERROR', `Gemini failed: ${err.message || String(err)}`, { stack: err.stack })
    throw err
  }
}

/**
 * Pre-flight authentication check for Gemini.
 * @param {object} [options]
 * @param {'cookie' | 'network'} [options.mode='cookie'] - 'cookie' for fast passive inspection, 'network' to ping https://gemini.google.com/
 * @param {AbortSignal} [options.signal]
 * @param {(entry: import('../utils/log.js').LogEntry) => void} [options.onLog]
 * @returns {Promise<{ authenticated: boolean, loginUrl: string, reason?: string }>}
 */
export async function checkAuth({ mode = 'cookie', signal, onLog } = {}) {
  try {
    const psid = await chrome.cookies.get({
      url: 'https://gemini.google.com/',
      name: '__Secure-1PSID',
    })
    log(onLog, 'debug', 'COOKIE', 'checkAuth: queried __Secure-1PSID cookie for Gemini', psid)
    if (!psid?.value) {
      log(onLog, 'warn', 'AUTH_CHECK_FAIL', 'checkAuth: missing __Secure-1PSID cookie')
      return {
        authenticated: false,
        loginUrl: 'https://gemini.google.com/',
        reason: 'Missing __Secure-1PSID cookie',
      }
    }

    if (mode === 'network') {
      const psidts = await chrome.cookies.get({
        url: 'https://gemini.google.com/',
        name: '__Secure-1PSIDTS',
      })
      let cookieStr = `__Secure-1PSID=${psid.value}`
      if (psidts?.value) {
        cookieStr += `; __Secure-1PSIDTS=${psidts.value}`
      }
      log(onLog, 'info', 'NETWORK_REQUEST', 'checkAuth: verifying Gemini endpoint reachability', {
        url: 'https://gemini.google.com/',
      })
      const resp = await fetch('https://gemini.google.com/', {
        headers: { Cookie: cookieStr },
        signal,
      })
      if (!resp.ok) {
        log(onLog, 'warn', 'AUTH_CHECK_FAIL', `checkAuth: Gemini endpoint returned HTTP ${resp.status}`)
        return {
          authenticated: false,
          loginUrl: 'https://gemini.google.com/',
          reason: `HTTP ${resp.status}`,
        }
      }
      const text = await resp.text().catch(() => '')
      const snlm0eMatch = text.match(/"SNlM0e":\s*"([^"]+)"/)
      if (!snlm0eMatch) {
        log(onLog, 'warn', 'AUTH_CHECK_FAIL', 'checkAuth: anti-CSRF token SNlM0e not found in page HTML')
        return {
          authenticated: false,
          loginUrl: 'https://gemini.google.com/',
          reason: 'Missing anti-CSRF token (session may be expired)',
        }
      }
    }

    log(onLog, 'info', 'AUTH_CHECK_SUCCESS', 'checkAuth: Gemini authenticated successfully')
    return {
      authenticated: true,
      loginUrl: 'https://gemini.google.com/',
    }
  } catch (err) {
    log(onLog, 'error', 'AUTH_CHECK_ERROR', `Gemini checkAuth error: ${err.message}`, { error: err.message })
    return {
      authenticated: false,
      loginUrl: 'https://gemini.google.com/',
      reason: err.message,
    }
  }
}
