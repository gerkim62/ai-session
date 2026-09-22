// SSE (Server-Sent Events) parser
// Extracted from: https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8/src/utils/eventsource-parser.mjs
// Original source: https://www.npmjs.com/package/eventsource-parser/v/1.1.1

export function createParser(onParse) {
  let isFirstChunk
  let decoder
  let buffer
  let startingPosition
  let startingFieldLength
  let eventId
  let eventName
  let data
  let discardTrailingNewline

  reset()

  return { feed, reset }

  function reset() {
    isFirstChunk = true
    decoder = new TextDecoder()
    buffer = ''
    startingPosition = 0
    startingFieldLength = -1
    eventId = undefined
    eventName = undefined
    data = ''
    discardTrailingNewline = false
  }

  function feed(chunk) {
    buffer += decoder.decode(chunk, { stream: true })
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length)
    }
    isFirstChunk = false
    const length = buffer.length
    let position = 0
    while (position < length) {
      if (discardTrailingNewline) {
        if (buffer[position] === '\n') ++position
        discardTrailingNewline = false
      }
      let lineLength = -1
      let fieldLength = startingFieldLength
      for (let index = position + startingPosition; lineLength < 0 && index < length; ++index) {
        const character = buffer[index]
        if (character === ':' && fieldLength < 0) {
          fieldLength = index - position
        } else if (character === '\r') {
          discardTrailingNewline = true
          lineLength = index - position
        } else if (character === '\n') {
          lineLength = index - position
        }
      }
      if (lineLength < 0) {
        startingPosition = length - position
        startingFieldLength = fieldLength
        break
      } else {
        startingPosition = 0
        startingFieldLength = -1
      }
      parseEventStreamLine(buffer, position, fieldLength, lineLength)
      position += lineLength + 1
    }
    if (position === length) {
      buffer = ''
    } else if (position > 0) {
      buffer = buffer.slice(position)
    }
  }

  function parseEventStreamLine(lineBuffer, index, fieldLength, lineLength) {
    if (lineLength === 0) {
      if (data.length > 0) {
        onParse({
          type: 'event',
          id: eventId,
          event: eventName || undefined,
          data: data.slice(0, -1),
        })
        data = ''
        eventId = undefined
      }
      eventName = undefined
      return
    }
    const noValue = fieldLength < 0
    const field = lineBuffer.slice(index, index + (noValue ? lineLength : fieldLength))
    let step = 0
    if (noValue) {
      step = lineLength
    } else if (lineBuffer[index + fieldLength + 1] === ' ') {
      step = fieldLength + 2
    } else {
      step = fieldLength + 1
    }
    const position2 = index + step
    const valueLength = lineLength - step
    const value = lineBuffer.slice(position2, position2 + valueLength).toString()
    if (field === 'data') {
      data += value ? value + '\n' : '\n'
    } else if (field === 'event') {
      eventName = value
    } else if (field === 'id' && !value.includes('\0')) {
      eventId = value
    }
  }
}

const BOM = [239, 187, 191]
function hasBom(buffer) {
  return BOM.every((charCode, index) => buffer.charCodeAt(index) === charCode)
}

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
  const parser = createParser((event) => {
    if (event.type === 'event') {
      onMessage(event.data)
    }
  })
  const reader = resp.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(value)
    }
  } catch (err) {
    if (err.name === 'AbortError') return
    if (onError) await onError(err)
  }
}
