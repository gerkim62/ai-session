/**
 * @module utils/sse-parser
 * SSE (Server-Sent Events) streaming fetch utility powered by eventsource-parser.
 */

import { createParser } from 'eventsource-parser'

export { createParser }

/**
 * Fetch an SSE endpoint and call onMessage for each event.
 * @param {string} url
 * @param {object} options - fetch options + onMessage, onError callbacks
 */
export async function fetchSSE(url, options) {
  const { onMessage, onError, ...fetchOptions } = options
  let resp
  try {
    resp = await fetch(url, fetchOptions)
  } catch (err) {
    if (err.name === 'AbortError') return
    if (onError) await onError(err)
    return
  }
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    let errMsg = `HTTP ${resp.status}`
    try {
      const errJson = JSON.parse(errBody)
      const detail = errJson.error?.message || errJson.message || errJson.detail
      if (detail) errMsg += `: ${detail}`
      else errMsg += `: ${errBody.slice(0, 200)}`
    } catch {
      if (errBody) errMsg += `: ${errBody.slice(0, 200)}`
      else if (resp.statusText) errMsg += `: ${resp.statusText}`
    }
    if (onError) await onError(new Error(errMsg))
    return
  }

  const decoder = new TextDecoder()
  const parser = createParser({
    onEvent(event) {
      if (typeof onMessage === 'function') {
        onMessage(event.data)
      }
    },
  })

  const reader = resp.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
  } catch (err) {
    if (err.name === 'AbortError') return
    if (onError) await onError(err)
  }
}
