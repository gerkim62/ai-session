/**
 * Sample Extension Background Service Worker
 *
 * Demonstrates consuming the `ai-session-free` library package.
 */

import { sendPrompt } from 'ai-session-free'

// Track active AbortControllers per port
const activeRequests = new Map()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-prompt') return

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'SEND_PROMPT') return

    const { provider: providerName, prompt, requestId, debug } = msg
    const controller = new AbortController()
    activeRequests.set(requestId, controller)

    try {
      await sendPrompt(providerName, prompt, {
        signal: controller.signal,
        onLog: debug
          ? (entry) => {
              try {
                port.postMessage({
                  type: 'DEBUG_LOG',
                  requestId,
                  provider: providerName,
                  entry,
                })
              } catch {
                // Port disconnected
              }
            }
          : undefined,
        onChunk: (chunk) => {
          try {
            port.postMessage({
              type: 'CHUNK',
              requestId,
              provider: providerName,
              text: chunk,
            })
          } catch {
            controller.abort()
          }
        },
      })

      port.postMessage({
        type: 'DONE',
        requestId,
        provider: providerName,
      })
    } catch (err) {
      if (err.name === 'AbortError') {
        port.postMessage({
          type: 'ABORTED',
          requestId,
          provider: providerName,
        })
      } else {
        try {
          port.postMessage({
            type: 'ERROR',
            requestId,
            provider: providerName,
            error: err.message || String(err),
          })
        } catch {
          // Port disconnected
        }
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })

  port.onDisconnect.addListener(() => {
    for (const [id, controller] of activeRequests) {
      controller.abort()
      activeRequests.delete(id)
    }
  })
})

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('app.html'),
  })
})
