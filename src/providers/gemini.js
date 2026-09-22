/**
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
 *   - Response is NOT SSE — it's a batch JSON format with )]}\' prefix
 */

// --- Cookie & token helpers ---

async function getCookies() {
  const psid = await chrome.cookies.get({
    url: 'https://gemini.google.com/',
    name: '__Secure-1PSID',
  })
  const psidts = await chrome.cookies.get({
    url: 'https://gemini.google.com/',
    name: '__Secure-1PSIDTS',
  })

  if (!psid?.value) {
    throw new Error('Gemini: Not logged in. Please log in at https://gemini.google.com')
  }

  let cookieStr = `__Secure-1PSID=${psid.value}`
  if (psidts?.value) {
    cookieStr += `; __Secure-1PSIDTS=${psidts.value}`
  }
  return cookieStr
}

async function getRequestParams(cookies) {
  const resp = await fetch('https://gemini.google.com/', {
    headers: { Cookie: cookies },
  })
  const text = await resp.text()

  const snlm0eMatch = text.match(/"SNlM0e":\s*"([^"]+)"/)
  const cfb2hMatch = text.match(/"cfb2h":\s*"([^"]+)"/)

  if (!snlm0eMatch) {
    throw new Error(
      'Gemini: Could not extract SNlM0e token. Cookie may be expired. ' +
        'Please visit https://gemini.google.com and refresh your session.',
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

// --- Main send function ---

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

/**
 * Send a prompt to Gemini web and return the response.
 * Note: Gemini does NOT stream via SSE — the full response comes in one batch.
 * @param {string} prompt
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onChunk] - called once with the full answer
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} answer text
 */
export async function sendPrompt(prompt, { onChunk, signal } = {}) {
  const cookies = await getCookies()
  const { at, bl } = await getRequestParams(cookies)

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

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { Cookie: cookies },
    body,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const data = await resp.text()
  const rawAnswer = parseResponse(data)
  const answer = cleanGeminiText(rawAnswer)

  if (!answer) {
    throw new Error('Gemini: Empty response. Session may have expired.')
  }

  if (onChunk) onChunk(answer)
  return answer
}
