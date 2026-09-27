/**
 * Sample Extension Background Service Worker
 *
 * Demonstrates consuming the `ai-session-free` library package.
 */

import { sendPrompt, checkSession, maskSensitiveData, maskStringSecrets } from 'ai-session-free'

// Track active AbortControllers per port
const activeRequests = new Map()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-prompt') return

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'CHECK_SESSION') {
      const { options = {}, requestId, debug, maskSensitive = true } = msg
      try {
        const result = await checkSession({
          ...options,
          maskSensitive,
          onLog: debug
            ? (entry) => {
                try {
                  port.postMessage({
                    type: 'DEBUG_LOG',
                    requestId,
                    provider: entry.provider || 'system',
                    entry,
                  })
                } catch {
                  // Port disconnected
                }
              }
            : undefined,
        })
        port.postMessage({
          type: 'SESSION_STATUS',
          requestId,
          status: result,
        })
      } catch (err) {
        port.postMessage({
          type: 'SESSION_STATUS_ERROR',
          requestId,
          error: err.message || String(err),
        })
      }
      return
    }

    if (msg.type !== 'SEND_PROMPT') return

    const { provider: providerName, prompt, requestId, debug, maskSensitive = true } = msg
    const controller = new AbortController()
    activeRequests.set(requestId, controller)

    try {
      await sendPrompt(providerName, prompt, {
        signal: controller.signal,
        maskSensitive,
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
        if (debug) {
          try {
            const rawEntry = {
              timestamp: new Date().toISOString(),
              provider: providerName,
              level: 'error',
              category: 'PROMPT_ERROR',
              message: err.message || String(err),
              data: {
                code: err.code || null,
                status: err.status || null,
                actionUrl: err.actionUrl || null,
              },
            }
            port.postMessage({
              type: 'DEBUG_LOG',
              requestId,
              provider: providerName,
              entry: maskSensitive ? maskSensitiveData(rawEntry) : rawEntry,
            })
          } catch {
            // Port disconnected
          }
        }
        try {
          port.postMessage({
            type: 'ERROR',
            requestId,
            provider: providerName,
            error: err.message || String(err),
            status: err.status ?? null,
            code: err.code || null,
            actionUrl: err.actionUrl || null,
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
