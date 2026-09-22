# AI Session Free

A modular, zero-dependency JavaScript library and Chrome extension package that queries **ChatGPT**, **Claude**, and **Gemini** headlessly using existing browser login sessions — **no API keys** and **no tab switching** required.

Can be consumed directly as an **npm library package** (via Git/pnpm) in any browser extension, or run as a standalone sample extension.

---

## Architecture Overview

```text
ai-session-free/
├── package.json              # Library package definition with ESM exports
├── pnpm-workspace.yaml       # Workspace linking root package to sample-extension
├── rules.json                # DeclarativeNetRequest rules (Origin/Referer spoofing)
├── upstream-sources.json     # Upstream tracking registry (dev only)
├── check-upstream.sh         # Upstream integrity audit script (dev only)
├── src/                      # Library Core (pure ESM)
│   ├── index.js              # Unified entry: exports sendPrompt, chatgpt, claude, gemini
│   ├── providers/
│   │   ├── chatgpt.js        # sendPrompt(prompt, { onChunk, signal } = {})
│   │   ├── claude.js         # sendPrompt(prompt, { onChunk, signal } = {})
│   │   └── gemini.js         # sendPrompt(prompt, { onChunk, signal } = {})
│   └── utils/
│       ├── crypto.js         # Shared UUID generation
│       ├── http.js           # Shared cookie string / HTTP error helpers
│       ├── log.js            # Shared structured logger factory
│       └── sse-parser.js     # SSE streaming fetch helper (powered by eventsource-parser)
└── sample-extension/         # Working sample Chrome Extension (Vite)
    ├── package.json          # Depends on "ai-session-free": "workspace:*"
    ├── vite.config.js        # Vite build config (auto-copies rules.json from library)
    ├── public/
    │   └── manifest.json     # Extension Manifest V3
    ├── app.html              # UI dashboard
    └── src/
        ├── app.css           # UI styles
        ├── app.js            # UI logic
        └── background.js     # Imports directly from 'ai-session-free'
```

---

## Installing as an npm Package

You can install this repository directly into any extension project using `pnpm` (or `npm`/`yarn`) without publishing to the npm registry:

```bash
pnpm add git+https://github.com/<your-username>/ai-session-free.git
```

Or in a local pnpm workspace:
```json
{
  "dependencies": {
    "ai-session-free": "workspace:*"
  }
}
```

---

## Library Usage (Clean Code API)

Each provider and the root module export a unified, destructured functional interface adhering to Clean Code principles:

### 1. Subpath Import (Tree-Shakeable)
Import only the specific provider you need — bundlers will exclude unused providers:

```javascript
import { sendPrompt } from 'ai-session-free/chatgpt'

const answer = await sendPrompt("Explain quantum computing in simple terms", {
  onChunk: (text) => console.log("Stream update:", text),
  signal: abortController.signal
})
```

Subpaths available:
- `ai-session-free/chatgpt`
- `ai-session-free/claude`
- `ai-session-free/gemini`

### 2. Root Dispatcher Import
Import the root module when you need dynamic model selection:

```javascript
import { sendPrompt, chatgpt, claude, gemini, getProvider } from 'ai-session-free'

// Call by string identifier:
await sendPrompt('claude', "Summarize this article", {
  onChunk: (chunk) => updateUI(chunk),
  signal: controller.signal
})

// Or call a namespace directly:
await gemini.sendPrompt("Hello Gemini", { onChunk: (text) => console.log(text) })
```

### 3. Diagnostic Debug Logging (`onLog`)
Every `sendPrompt` accepts an optional `onLog` callback to trace raw HTTP requests, cookies, PoW puzzle solving, and streaming events in real time:

```javascript
import { sendPrompt } from 'ai-session-free'

await sendPrompt('chatgpt', "Hello", {
  onChunk: (chunk) => console.log(chunk),
  onLog: (entry) => {
    // entry: { timestamp, provider, level, category, message, data }
    console.log(`[${entry.category}] ${entry.message}`, entry.data)
  }
})
```

---

## Required Extension Permissions

Any Chrome extension consuming this library must include the following permissions in its `manifest.json`:

```json
{
  "permissions": [
    "cookies",
    "declarativeNetRequestWithHostAccess"
  ],
  "host_permissions": [
    "https://*.chatgpt.com/*",
    "https://*.openai.com/*",
    "https://claude.ai/*",
    "https://*.google.com/*",
    "https://gemini.google.com/*"
  ],
  "declarative_net_request": {
    "rule_resources": [
      {
        "id": "ruleset",
        "enabled": true,
        "path": "rules.json"
      }
    ]
  }
}
```

Copy `rules.json` from the package into your extension's assets so `Origin` and `Referer` headers are properly spoofed in background requests.

---

## Running the Sample Extension

The `sample-extension` directory contains a complete, working Chrome Extension built with Vite:

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Build the extension**:
   ```bash
   pnpm --filter sample-extension build
   # or watch mode for development:
   pnpm --filter sample-extension dev
   ```

3. **Load in Chrome**:
   - Open Chrome and navigate to `chrome://extensions`.
   - Enable **Developer mode** (toggle in top right).
   - Click **Load unpacked** and select `sample-extension/dist/`.
   - Ensure you are logged into [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), and [Gemini](https://gemini.google.com).
   - Click the extension icon in your Chrome toolbar to open `app.html`.

---

## Code Extraction & Upstream Source Attribution

The core reverse-engineering logic in this library was extracted and adapted from battle-tested open-source implementations:

| Local File | Upstream Repository | Upstream File & Permalink | Commit SHA | Extraction Notes |
| :--- | :--- | :--- | :--- | :--- |
| [`src/providers/chatgpt.js`](src/providers/chatgpt.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/apis/chatgpt-web.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/apis/chatgpt-web.mjs#L99-L150) | `12db6b8` | Extracts Sentinel chat-requirements, SHA3-512 Proof-of-Work (PoW) generation, device ID / session token cookies, and SSE streaming. Researched from [chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) to properly parse PUA citations and entity tokens. |
| [`src/providers/claude.js`](src/providers/claude.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/clients/claude/index.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/clients/claude/index.mjs#L269-L318) | `12db6b8` | Extracts Claude sessionKey cookie handling, organization retrieval, temporary conversation creation and auto-cleanup. Model parameter is omitted to prevent `model_not_allowed` errors. |
| [`src/providers/gemini.js`](src/providers/gemini.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox)<br>and [HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API) | [`src/services/clients/bard/index.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/clients/bard/index.mjs#L65-L136)<br>and [`src/gemini_webapi/client.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/8c5b1dcbf54ecf093551cc20bd25cef438190ba8/src/gemini_webapi/client.py) | `12db6b8`<br>`8c5b1dc` | Extracts `__Secure-1PSID` and `__Secure-1PSIDTS` cookies, parses `SNlM0e` anti-CSRF token, queries `StreamGenerate`, and targets candidate 0 with card content fallback. |
| [`src/utils/sse-parser.js`](src/utils/sse-parser.js) | [rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser) | [`src/index.ts`](https://github.com/rexxars/eventsource-parser) | `npm` | Streaming Server-Sent Events parser powered by official npm package `eventsource-parser`. |
| [`rules.json`](rules.json) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/rules.json`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/rules.json) | `12db6b8` | Declarative Net Request rules configured to spoof `Origin` and `Referer` headers specifically for `chatgpt.com`, `claude.ai`, and `gemini.google.com`. |


---

## Upstream Monitoring & Change Detection

Run the audit script at any time to verify if upstream repos have modified the reverse-engineered endpoints:

```bash
./check-upstream.sh
```

To download upstream updates and generate unified diffs:
```bash
./check-upstream.sh --diff
```
