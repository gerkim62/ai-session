# AI Session Free

A modular, zero-dependency JavaScript library and Chrome extension package that queries **ChatGPT**, **Claude**, **Gemini**, **Kimi**, **Copilot**, and **DeepSeek** headlessly using existing browser login sessions — **no API keys** and **no tab switching** required.

Can be consumed directly as an **npm library package** (via Git/pnpm) in any browser extension, or run as a standalone sample extension.

---

## Architecture Overview

```text
ai-session-free/
├── package.json              # Library package definition with ESM exports
├── pnpm-workspace.yaml       # Workspace linking root package to sample-extension
├── rules.json                # DeclarativeNetRequest rules (Origin/Referer spoofing)
├── upstream-sources.json     # Upstream tracking registry with exact blob SHAs (dev only)
├── check-upstream.sh         # Upstream integrity audit script (dev only)
├── src/                      # Library Core (pure ESM)
│   ├── index.js              # Unified entry: exports sendPrompt & all 6 providers
│   ├── bridge.js             # Universal web token bridge for content scripts
│   ├── providers/
│   │   ├── chatgpt.js        # sendPrompt(prompt, { onChunk, signal } = {})
│   │   ├── claude.js         # sendPrompt(prompt, { onChunk, signal } = {})
│   │   ├── gemini.js         # sendPrompt(prompt, { onChunk, signal } = {})
│   │   ├── kimi.js           # sendPrompt(prompt, { onChunk, signal } = {})
│   │   ├── copilot.js        # sendPrompt(prompt, { onChunk, signal } = {})
│   │   └── deepseek.js       # sendPrompt(prompt, { onChunk, signal } = {})
│   └── utils/
│       ├── crypto.js         # Shared UUID generation
│       ├── deepseek-pow.js   # Embedded SHA3-256 WASM PoW solver for DeepSeek
│       ├── http.js           # Shared cookie string / HTTP error helpers
│       ├── log.js            # Shared structured logger factory
│       ├── rules.js          # Dynamic DeclarativeNetRequest rules (collision-free 91001-91007)
│       └── sse-parser.js     # SSE streaming fetch helper (powered by eventsource-parser)
└── sample-extension/         # Working sample Chrome Extension (Vite)
    ├── package.json          # Depends on "ai-session-free": "workspace:*"
    ├── vite.config.js        # Vite build config (auto-copies rules.json from library)
    ├── public/
    │   ├── manifest.json     # Extension Manifest V3
    │   └── content-scripts/  # Lightweight token bridges for Kimi and DeepSeek
    │       ├── kimi-bridge.js
    │       └── deepseek-bridge.js
    ├── app.html              # UI dashboard for all 6 providers
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
- `ai-session-free/kimi`
- `ai-session-free/copilot`
- `ai-session-free/deepseek`
- `ai-session-free/bridge` (universal token bridge for content scripts)
- `ai-session-free/rules` (declarativeNetRequest rules & dynamic helpers)

### 2. Root Dispatcher Import
Import the root module when you need dynamic model selection:

```javascript
import { sendPrompt, chatgpt, claude, gemini, kimi, copilot, deepseek, getProvider } from 'ai-session-free'

// Call by string identifier:
await sendPrompt('kimi', "Summarize this article", {
  onChunk: (chunk) => updateUI(chunk),
  signal: controller.signal
})

// Or call a namespace directly:
await copilot.sendPrompt("Hello Copilot", { onChunk: (text) => console.log(text) })
```

### 3. Diagnostic Debug Logging (`onLog`)
Every `sendPrompt` accepts an optional `onLog` callback to trace raw HTTP requests, cookies, PoW puzzle solving, and streaming events in real time:

```javascript
import { sendPrompt } from 'ai-session-free'

await sendPrompt('deepseek', "Hello", {
  onChunk: (chunk) => console.log(chunk),
  onLog: (entry) => {
    // entry: { timestamp, provider, level, category, message, data }
    console.log(`[${entry.category}] ${entry.message}`, entry.data)
  }
})
```

### 4. Pre-Flight Session Detection (`checkSession` / `checkAuth`)
Verify whether sessions are active before sending prompts, without triggering unnecessary conversation turns or latency:

```javascript
import { checkSession, claude, chatgpt, gemini, kimi, copilot, deepseek } from 'ai-session-free'

// Fast auth check across all providers (default mode: 'cookie')
const status = await checkSession()
// Returns:
// {
//   available: ['claude', 'copilot'],
//   providers: {
//     claude: { authenticated: true, loginUrl: 'https://claude.ai/' },
//     copilot: { authenticated: true, loginUrl: 'https://copilot.microsoft.com/' },
//     chatgpt: { authenticated: false, loginUrl: 'https://chatgpt.com/auth/login', reason: 'Missing session token cookie' },
//     gemini: { authenticated: false, loginUrl: 'https://gemini.google.com/', reason: 'Missing __Secure-1PSID cookie' },
//     kimi: { authenticated: false, loginUrl: 'https://kimi.moonshot.cn/', reason: 'Missing refresh_token' },
//     deepseek: { authenticated: false, loginUrl: 'https://chat.deepseek.com/', reason: 'Missing userToken' }
//   }
// }

// Or verify live endpoint reachability:
const liveStatus = await checkSession({
  mode: 'network',
  providers: ['claude', 'kimi', 'deepseek'], // optional provider filter
  signal: abortController.signal              // optional cancellation
})

// Or query an individual provider directly:
const isKimiReady = await kimi.checkAuth({ mode: 'cookie' })
// Returns: { authenticated: boolean, loginUrl: string, reason?: string }
```

### 5. Structured HTTP Status & Error Codes
Errors thrown during prompt execution or auth checks carry structured metadata on standard `Error` objects:

| Property | Type | Description |
| :--- | :--- | :--- |
| `err.status` | `number \| null` | HTTP response status (e.g. `401`, `403`, `429`), or `null` for pre-network failures |
| `err.code` | `string` | Machine-readable error code (`AUTH_REQUIRED`, `FORBIDDEN`, `CLOUDFLARE_CHALLENGE`, `RATE_LIMITED`, `HTTP_ERROR`) |
| `err.provider`| `string` | Associated provider identifier (`'chatgpt'`, `'claude'`, `'gemini'`, `'kimi'`, `'copilot'`, `'deepseek'`) |
| `err.actionUrl`| `string \| undefined` | Actionable resolution URL (e.g. login URL on `AUTH_REQUIRED`, challenge URL on `CLOUDFLARE_CHALLENGE`) |

---

## Extension Integration Guide (Zero-Copy)

Integrating `ai-session-free` into any Chrome extension requires **zero manual file copying**:
- **No copying `rules.json`**: Network header spoofing is managed automatically via dynamic rules.
- **No copying bridge scripts**: Token synchronization is bundled directly into `'ai-session-free/bridge'`.

---

### 1. Minimal `manifest.json` Configuration

Add the required permissions, host permissions, and WebAssembly CSP to your extension's `manifest.json`:

```json
{
  "permissions": [
    "cookies",
    "storage",
    "declarativeNetRequestWithHostAccess"
  ],
  "host_permissions": [
    "https://*.chatgpt.com/*",
    "https://*.openai.com/*",
    "https://claude.ai/*",
    "https://*.google.com/*",
    "https://gemini.google.com/*",
    "https://*.kimi.ai/*",
    "https://*.kimi.com/*",
    "https://*.kimi.moonshot.cn/*",
    "https://*.bing.com/*",
    "https://copilot.microsoft.com/*",
    "https://chat.deepseek.com/*"
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

> [!NOTE]
> - `"storage"` is used by the token bridge to cache Web `localStorage` credentials for Kimi and DeepSeek.
> - `'wasm-unsafe-eval'` in `content_security_policy` is required to run DeepSeek's embedded high-speed WebAssembly Proof-of-Work (PoW) solver.
> - **No static `rules.json` or `rule_resources` declaration is required.**

---

### 2. Token Bridge Integration (`ai-session-free/bridge`)

While ChatGPT, Claude, Gemini, and Copilot authenticate using browser cookies (`chrome.cookies`), **Kimi** and **DeepSeek** store their auth tokens (`refresh_token` and `userToken`) in web `localStorage`. Chrome extensions cannot read cross-origin web `localStorage` directly from background service workers.

`ai-session-free/bridge` automatically detects when the user is on Kimi or DeepSeek, extracts their session tokens, and syncs them seamlessly to `chrome.storage.local`.

#### Case A: If your extension already has a content script (e.g. matching `<all_urls>`)
Add a single line to your existing content script (e.g. `src/content.tsx` or `src/content.js`):

```typescript
import 'ai-session-free/bridge';
```

#### Case B: If your extension does not have an existing content script
Register a content script targeting the Kimi and DeepSeek domains in your `manifest.json`:

```json
{
  "content_scripts": [
    {
      "matches": [
        "https://*.kimi.ai/*",
        "https://*.kimi.com/*",
        "https://*.kimi.moonshot.cn/*",
        "https://chat.deepseek.com/*"
      ],
      "js": ["content-bridge.js"],
      "run_at": "document_idle"
    }
  ]
}
```
*(Where `content-bridge.js` is bundled from `import 'ai-session-free/bridge'`).*

---

### 3. Dynamic Network Rules & Rule Coexistence

To prevent CORS and browser origin blocks, requests to AI web endpoints require spoofed `Origin` and `Referer` headers.

`ai-session-free` installs these rules automatically at runtime via `chrome.declarativeNetRequest.updateDynamicRules` whenever `checkSession()` or `sendPrompt()` runs in your background service worker.

#### Coexistence Guarantee with Your Extension's Rules:
1. **Dedicated Isolated Rule IDs (`91001` – `91007`):** The library registers rules strictly in the `91001–91007` ID range. When refreshing, it passes `removeRuleIds: [91001...91007]` — **it never removes, modifies, or collides with any dynamic rules your extension creates**.
2. **Strict Domain Scoping:** Rules strictly match only the 6 AI provider domains. Requests to your extension's own backend APIs (e.g. internal servers, SakaHub, etc.) are **never intercepted or modified**.
3. **Static Ruleset Independence:** If your extension declares its own `rules.json` via `rule_resources`, Chrome isolates static rulesets and dynamic rules in separate namespaces. Both operate concurrently without conflict.
4. **Self-Healing:** If your extension or another module ever resets dynamic rules, `ai-session-free` automatically verifies `chrome.declarativeNetRequest.getDynamicRules()` and non-destructively re-installs only its own 7 rules.

#### Opt-Out (Manual Rule Management):
If you prefer to manage all DNR rules yourself in a static `rules.json` file and do not want `ai-session-free` to register dynamic rules, call `disableDynamicRules()` in your background service worker:

```typescript
import { disableDynamicRules } from 'ai-session-free';

// Disables automatic dynamic rule registration
disableDynamicRules();
```

---

### 4. First-Class TypeScript Support

`ai-session-free` provides full TypeScript definitions directly in the package (`index.d.ts`). No custom declaration files or local `.d.ts` workarounds are needed:

```typescript
import {
  sendPrompt,
  checkSession,
  getProviderMetadata,
  getAllProvidersMetadata,
} from 'ai-session-free';
import type {
  ProviderName,
  CheckSessionOptions,
  PromptOptions,
  ProviderAuthResult,
  HttpError,
} from 'ai-session-free';

// Fully typed session availability check
const status = await checkSession({ mode: 'network' });
console.log('Available providers:', status.available);

// Fully typed prompt execution
const response: string = await sendPrompt('deepseek', 'Review this code', {
  thinking: true,
  search: false,
  onChunk: (text: string) => console.log('Chunk:', text),
});
```

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
   - Ensure you are logged into the services you wish to use ([ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), [Gemini](https://gemini.google.com), [Kimi](https://kimi.moonshot.cn), [Copilot](https://copilot.microsoft.com), [DeepSeek](https://chat.deepseek.com)).
   - Click the extension icon in your Chrome toolbar to open `app.html`.

---

## Code Extraction & Upstream Source Attribution

The core reverse-engineering logic in this library was extracted and adapted from battle-tested open-source implementations, strictly tracking verified git commits and blob SHAs in `upstream-sources.json`:

| Local File | Upstream Repository | Upstream File & Permalink | Commit SHA | Extraction Notes |
| :--- | :--- | :--- | :--- | :--- |
| [`src/providers/chatgpt.js`](src/providers/chatgpt.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/apis/chatgpt-web.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/apis/chatgpt-web.mjs#L99-L150) | `12db6b8` | Extracts Sentinel chat-requirements, SHA3-512 Proof-of-Work (PoW) generation, device ID / session token cookies, and SSE streaming. |
| [`src/providers/claude.js`](src/providers/claude.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/clients/claude/index.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/clients/claude/index.mjs#L269-L318) | `12db6b8` | Extracts Claude sessionKey cookie handling, organization retrieval, temporary conversation creation and auto-cleanup. Model parameter is omitted to prevent `model_not_allowed` errors. |
| [`src/providers/gemini.js`](src/providers/gemini.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox)<br>and [HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API) | [`src/services/clients/bard/index.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/services/clients/bard/index.mjs#L65-L136)<br>and [`src/gemini_webapi/client.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/8c5b1dcbf54ecf093551cc20bd25cef438190ba8/src/gemini_webapi/client.py) | `12db6b8`<br>`8c5b1dc` | Extracts `__Secure-1PSID` and `__Secure-1PSIDTS` cookies, parses `SNlM0e` anti-CSRF token, queries `StreamGenerate`, and targets candidate 0 with card content fallback. |
| [`src/providers/kimi.js`](src/providers/kimi.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/apis/moonshot-web.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/6554b8e190367eb785a218aa95ab822e11895a98/src/services/apis/moonshot-web.mjs) | `6554b8e` | Extracts Kimi localStorage `refresh_token` flow, token rotation (`/api/auth/token/refresh`), conversation lifecycle (`POST /api/chat`, `DELETE /api/chat/{id}`), and SSE completion stream. |
| [`src/providers/copilot.js`](src/providers/copilot.js) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/services/clients/bing/index.mjs`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/6554b8e190367eb785a218aa95ab822e11895a98/src/services/clients/bing/index.mjs) | `6554b8e` | Extracts Bing `_U` cookie auth, `Sec-MS-GEC` token, `/turing/conversation/create` handshake, and Sydney SignalR WebSocket streaming client with 15s keepalive ping. |
| [`src/providers/deepseek.js`](src/providers/deepseek.js) | [Fly143/deepseek-free-api](https://github.com/Fly143/deepseek-free-api) | [`pow_native.py`](https://github.com/Fly143/deepseek-free-api/blob/48be2bf57b6ec3ca9bbf87034c76aa8a846c9c61/pow_native.py) | `48be2bf` | Extracts DeepSeek `userToken` flow, `DeepSeekHashV1` WASM-accelerated challenge solver, chat session creation/cleanup, and SSE delta stream parsing. |
| [`src/utils/sse-parser.js`](src/utils/sse-parser.js) | [rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser) | [`src/index.ts`](https://github.com/rexxars/eventsource-parser) | `npm` | Streaming Server-Sent Events parser powered by official npm package `eventsource-parser`. |
| [`rules.json`](rules.json) | [ChatGPTBox-dev/chatGPTBox](https://github.com/ChatGPTBox-dev/chatGPTBox) | [`src/rules.json`](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/12db6b8401340a6b29efb75e114095bb736db8a2/src/rules.json) | `12db6b8` | Declarative Net Request rules configured to spoof `Origin` and `Referer` headers for all supported AI provider domains. |

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
