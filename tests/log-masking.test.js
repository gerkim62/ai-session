/**
 * Unit tests for log masking utilities in src/utils/log.js
 * Run with: node tests/log-masking.test.js
 */

import {
  maskSecret,
  maskCookieString,
  maskTextPreview,
  maskStringSecrets,
  maskSensitiveData,
  createLogger,
} from '../src/utils/log.js'

let passed = 0
let failed = 0

function assert(desc, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${desc}`)
    passed++
  } else {
    console.error(`  ✗ ${desc}`)
    console.error(`    Expected: ${JSON.stringify(expected)}`)
    console.error(`    Actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

function assertIncludes(desc, actual, substr) {
  if (typeof actual === 'string' && actual.includes(substr)) {
    console.log(`  ✓ ${desc}`)
    passed++
  } else {
    console.error(`  ✗ ${desc}`)
    console.error(`    Expected to include: ${JSON.stringify(substr)}`)
    console.error(`    Actual:              ${JSON.stringify(actual)}`)
    failed++
  }
}

function assertNotIncludes(desc, actual, substr) {
  if (typeof actual === 'string' && !actual.includes(substr)) {
    console.log(`  ✓ ${desc}`)
    passed++
  } else {
    console.error(`  ✗ ${desc}`)
    console.error(`    Expected NOT to include: ${JSON.stringify(substr)}`)
    console.error(`    Actual:                  ${JSON.stringify(actual)}`)
    failed++
  }
}

// ========================
// maskSecret
// ========================
console.log('\n--- maskSecret ---')

assert('empty string stays empty', maskSecret(''), '')
assert('non-string number passthrough', maskSecret(42), 42)

// <= 2 chars
assert('1-char: *** [len=1]', maskSecret('a'), '*** [len=1]')
assert('2-char: *** [len=2]', maskSecret('ab'), '*** [len=2]')

// 3-11 chars (short)
assert('3-char: f***z [len=3]', maskSecret('foz'), 'f***z [len=3]')
assert('11-char first+last+len', maskSecret('abcdefghijk'), 'a***k [len=11]')

// >= 12 chars
const long = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
const maskedLong = maskSecret(long)
assertIncludes('long: starts with prefix', maskedLong, 'eyJhbG')
assertIncludes('long: has [+N chars]', maskedLong, '[+')
assertIncludes('long: has suffix', maskedLong, 'sw5c')
assertNotIncludes('long: does not include middle', maskedLong, 'KKF2QT4fwpMe')

// 12-char exactly
const s12 = '123456789012'
const m12 = maskSecret(s12)
assertIncludes('12-char: prefix', m12, '123456')
assertIncludes('12-char: [+2 chars]', m12, '[+2 chars]')
assertIncludes('12-char: suffix', m12, '9012')

// ========================
// maskCookieString
// ========================
console.log('\n--- maskCookieString ---')

const cookieStr = '__Secure-1PSID=abc123defghij; __Secure-1PSIDTS=xyz789qrstuv; SID=shortval'
const maskedCookie = maskCookieString(cookieStr)

assertIncludes('preserves cookie name __Secure-1PSID', maskedCookie, '__Secure-1PSID=')
assertIncludes('preserves cookie name __Secure-1PSIDTS', maskedCookie, '__Secure-1PSIDTS=')
assertIncludes('preserves cookie name SID', maskedCookie, 'SID=')
assertNotIncludes('hides __Secure-1PSID value', maskedCookie, 'abc123defghij')
assertNotIncludes('hides __Secure-1PSIDTS value', maskedCookie, 'xyz789qrstuv')

assert('empty cookie string', maskCookieString(''), '')
assert('non-string passthrough', maskCookieString(null), null)

// single cookie
const sc = maskCookieString('_U=mysecretvalue')
assertIncludes('single cookie preserves name', sc, '_U=')
assertNotIncludes('single cookie hides value', sc, 'mysecretvalue')

// ========================
// maskTextPreview
// ========================
console.log('\n--- maskTextPreview ---')

const shortText = 'Hello world'
assert('short text unchanged', maskTextPreview(shortText), shortText)
assert('empty string', maskTextPreview(''), '')
assert('non-string passthrough', maskTextPreview(42), 42)

const longText = 'Explain quantum computing in simple terms for a beginner who has no prior knowledge of physics or math'
const maskedText = maskTextPreview(longText)
assertIncludes('preview has first 60 chars', maskedText, longText.slice(0, 60))
assertIncludes('preview has [+N chars]', maskedText, '[+')
assertNotIncludes('preview hides tail', maskedText, longText.slice(80))

assert('custom maxLength', maskTextPreview('abcdefgh', 5), 'abcde... [+3 chars]')

// ========================
// maskStringSecrets
// ========================
console.log('\n--- maskStringSecrets ---')

const bearerStr = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.testtoken.signature'
const maskedBearer = maskStringSecrets(bearerStr)
assertIncludes('Bearer keyword preserved', maskedBearer, 'Bearer ')
assertNotIncludes('Bearer token hidden', maskedBearer, 'testtoken')

const psidStr = '__Secure-1PSID=abc123defghijklmnop; path=/'
const maskedPsid = maskStringSecrets(psidStr)
assertIncludes('__Secure-1PSID name preserved', maskedPsid, '__Secure-1PSID=')
assertNotIncludes('__Secure-1PSID value hidden', maskedPsid, 'abc123defghijklmnop')

assert('normal string untouched', maskStringSecrets('hello world'), 'hello world')
assert('null passthrough', maskStringSecrets(null), null)

// ========================
// maskSensitiveData
// ========================
console.log('\n--- maskSensitiveData ---')

// Authorization header
const authData = { Authorization: 'Bearer supersecrettoken12345' }
const maskedAuth = maskSensitiveData(authData)
assertIncludes('Authorization: Bearer prefix', maskedAuth.Authorization, 'Bearer ')
assertNotIncludes('Authorization: token hidden', maskedAuth.Authorization, 'supersecrettoken12345')

// Cookie string
const cookieData = { cookie: 'sessionKey=supersecretkey; _U=usertoken123' }
const maskedCookieData = maskSensitiveData(cookieData)
assertIncludes('cookie name preserved', maskedCookieData.cookie, 'sessionKey=')
assertNotIncludes('cookie value hidden', maskedCookieData.cookie, 'supersecretkey')

// Array of chrome cookies
const chromeCookies = [
  { name: '__Secure-1PSID', value: 'supersecretpsid123456789', domain: '.google.com', path: '/' },
  { name: 'SID', value: 'sidtoken9876543210', domain: '.google.com', path: '/' },
]
const maskedCookies = maskSensitiveData(chromeCookies)
assert('cookie name preserved', maskedCookies[0].name, '__Secure-1PSID')
assertNotIncludes('cookie value masked', maskedCookies[0].value, 'supersecretpsid123456789')
assertNotIncludes('SID value masked', maskedCookies[1].value, 'sidtoken9876543210')

// Single chrome cookie object
const singleCookie = { name: 'sessionKey', value: 'sk-ant-sidclaudevalue', domain: 'claude.ai', path: '/' }
const maskedSingle = maskSensitiveData(singleCookie)
assert('single cookie name unchanged', maskedSingle.name, 'sessionKey')
assertNotIncludes('single cookie value hidden', maskedSingle.value, 'sk-ant-sidclaudevalue')

// Prompt key
const promptData = { prompt: 'Explain quantum computing in simple terms for a beginner who has absolutely no knowledge of science or math' }
const maskedPrompt = maskSensitiveData(promptData)
assertIncludes('prompt preview included', maskedPrompt.prompt, 'Explain quantum')
assertIncludes('prompt has truncation marker', maskedPrompt.prompt, '[+')
assertNotIncludes('prompt tail hidden', maskedPrompt.prompt, 'absolutely no knowledge of science or math')

// Response key
const responseData = { answer: 'Quantum computing leverages principles of quantum mechanics. It uses qubits which can represent 0 and 1 simultaneously via superposition.' }
const maskedResponse = maskSensitiveData(responseData)
assertIncludes('answer preview included', maskedResponse.answer, 'Quantum computing')
assertIncludes('answer has truncation marker', maskedResponse.answer, '[+')

// ChatGPT messages array
const msgData = {
  messages: [{
    id: 'uuid-1',
    author: { role: 'user' },
    content: {
      content_type: 'text',
      parts: ['What is the meaning of life, the universe, and everything according to Douglas Adams?']
    }
  }]
}
const maskedMsg = maskSensitiveData(msgData)
const part = maskedMsg.messages[0].content.parts[0]
assertIncludes('message part preview', part, 'What is the meaning of life')
assertIncludes('message part truncated', part, '[+')

// Nested objects
const nested = {
  url: 'https://example.com/api',
  headers: {
    Authorization: 'Bearer tokenxyz123456789abc',
    Cookie: 'session=sval12345',
    'Content-Type': 'application/json',
  }
}
const maskedNested = maskSensitiveData(nested)
assert('url preserved', maskedNested.url, 'https://example.com/api')
assertIncludes('nested Authorization Bearer prefix', maskedNested.headers.Authorization, 'Bearer ')
assertNotIncludes('nested Authorization token hidden', maskedNested.headers.Authorization, 'tokenxyz123456789abc')
assertNotIncludes('nested Cookie value hidden', maskedNested.headers.Cookie, 'sval12345')
assert('Content-Type untouched', maskedNested.headers['Content-Type'], 'application/json')

// maskSensitive=false bypass
const rawData = { Authorization: 'Bearer raw-secret-token-12345' }
const notMasked = maskSensitiveData(rawData, { maskSensitive: false })
assert('bypass: raw value preserved', notMasked.Authorization, 'Bearer raw-secret-token-12345')

// Null/undefined
assert('null passes through', maskSensitiveData(null), null)
assert('undefined passes through', maskSensitiveData(undefined), undefined)

// Numbers/booleans
assert('number passthrough', maskSensitiveData(42), 42)
assert('boolean passthrough', maskSensitiveData(true), true)

// JSON string with sensitive content
const jsonStr = JSON.stringify({ Authorization: 'Bearer secrettoken99999' })
const maskedJsonStr = maskSensitiveData(jsonStr)
assertNotIncludes('JSON string: secret hidden', maskedJsonStr, 'secrettoken99999')

// Circular reference
const circular = { a: 1 }
circular.self = circular
const maskedCircular = maskSensitiveData(circular)
assert('circular ref handled', maskedCircular.self, '[Circular]')

// ========================
// createLogger with masking
// ========================
console.log('\n--- createLogger ---')

const log = createLogger('test')
let loggedEntry = null

const onLog = (entry) => { loggedEntry = entry }

log(onLog, 'info', 'NETWORK_REQUEST', 'Fetching token for Bearer eyJsecrettoken12345 user', {
  Authorization: 'Bearer mysecretjwttoken12345',
  cookie: 'sessionKey=verysecretvalue',
  body: { prompt: 'A very long prompt that exceeds sixty characters and should get truncated in the output log' }
})

assert('logger: provider set', loggedEntry.provider, 'test')
assert('logger: level set', loggedEntry.level, 'info')
assertNotIncludes('logger: message Bearer token hidden', loggedEntry.message, 'eyJsecrettoken12345')
assertNotIncludes('logger: Authorization hidden', loggedEntry.data.Authorization, 'mysecretjwttoken12345')
assertIncludes('logger: Authorization Bearer prefix', loggedEntry.data.Authorization, 'Bearer ')
assertNotIncludes('logger: cookie value hidden', loggedEntry.data.cookie, 'verysecretvalue')
assertIncludes('logger: cookie name preserved', loggedEntry.data.cookie, 'sessionKey=')
assertIncludes('logger: prompt truncated', loggedEntry.data.body.prompt, '[+')
assertNotIncludes('logger: prompt tail hidden', loggedEntry.data.body.prompt, 'should get truncated in the output log')

// createLogger with maskSensitive=false via onLog.maskSensitive
const onLogRaw = (entry) => { loggedEntry = entry }
onLogRaw.maskSensitive = false
log(onLogRaw, 'debug', 'RAW', 'Raw log', { Authorization: 'Bearer rawtoken12345678' })
assert('opt-out via onLog.maskSensitive: raw value preserved', loggedEntry.data.Authorization, 'Bearer rawtoken12345678')

// ========================
// Summary
// ========================
console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
} else {
  console.log('All tests passed! ✓')
}
