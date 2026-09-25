/**
 * Diagnostic log entry emitted by provider modules.
 */
export interface LogEntry {
  timestamp: string;
  provider: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: any;
}

/**
 * Options passed to `sendPrompt`.
 */
export interface PromptOptions {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  onLog?: (entry: LogEntry) => void;
}

export type ProviderName = 'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'copilot' | 'deepseek';

/**
 * Options passed to `checkSession` or `checkAuth`.
 */
export interface CheckSessionOptions {
  mode?: 'cookie' | 'network';
  providers?: Array<ProviderName | string>;
  signal?: AbortSignal;
  onLog?: (entry: LogEntry) => void;
}

/**
 * Static metadata describing a provider.
 */
export interface ProviderMetadata {
  id: string;
  displayName: string;
  shortName: string;
  loginUrl: string;
  challengeUrl: string;
  homeUrl: string;
}

/**
 * Result of checking authentication for a provider.
 */
export interface ProviderAuthResult {
  authenticated: boolean;
  loginUrl: string;
  challengeUrl?: string;
  reason?: string;
  metadata?: ProviderMetadata;
}

/**
 * HTTP error thrown during prompt execution or auth verification.
 */
export interface HttpError extends Error {
  status: number | null;
  code: 'AUTH_REQUIRED' | 'CLOUDFLARE_CHALLENGE' | 'RATE_LIMITED' | 'HTTP_ERROR' | string;
  provider?: string;
  actionUrl?: string;
}

/**
 * Provider module interface.
 */
export interface ProviderModule {
  metadata: ProviderMetadata;
  sendPrompt(prompt: string, options?: PromptOptions & Record<string, any>): Promise<string>;
  checkAuth(options?: {
    mode?: 'cookie' | 'network';
    signal?: AbortSignal;
    onLog?: (entry: LogEntry) => void;
    token?: string;
  }): Promise<ProviderAuthResult>;
}

export const chatgpt: ProviderModule;
export const claude: ProviderModule;
export const gemini: ProviderModule;
export const kimi: ProviderModule;
export const copilot: ProviderModule;
export const deepseek: ProviderModule;

export const providers: {
  chatgpt: ProviderModule;
  claude: ProviderModule;
  gemini: ProviderModule;
  kimi: ProviderModule;
  copilot: ProviderModule;
  deepseek: ProviderModule;
  [key: string]: ProviderModule;
};

/**
 * Get a provider module by string identifier.
 */
export function getProvider(name: ProviderName | string): ProviderModule;

/**
 * Returns static metadata for a given provider name without needing cookies or network calls.
 */
export function getProviderMetadata(name: string): ProviderMetadata | null;

/**
 * Returns static metadata for all registered providers.
 */
export function getAllProvidersMetadata(): Record<string, ProviderMetadata>;

/**
 * Create an Error decorated with status, code, provider metadata, and actionUrl.
 */
export function createHttpError(
  message: string,
  status?: number | null,
  provider?: string,
  code?: string,
  actionUrl?: string | null
): HttpError;

/**
 * Check session status across providers.
 */
export function checkSession(options?: CheckSessionOptions): Promise<{
  available: string[];
  providers: Record<string, ProviderAuthResult>;
}>;

/**
 * Unified prompt dispatcher across providers.
 */
export function sendPrompt(
  providerName: ProviderName | string,
  prompt: string,
  options?: PromptOptions & Record<string, any>
): Promise<string>;

/**
 * Array of declarativeNetRequest rule definitions for Origin/Referer spoofing.
 */
export const NET_RULES: Array<any>;

/**
 * Automatically registers or refreshes dynamic declarativeNetRequest rules in Chrome MV3.
 */
export function setupDynamicRules(): Promise<boolean>;

/**
 * Ensures dynamic rules are installed once in the current background session.
 */
export function ensureDynamicRules(): Promise<void>;

/**
 * Opt-out: disable automatic dynamic rule registration if the host extension
 * prefers to manage DNR rules exclusively through its own static rulesets.
 */
export function disableDynamicRules(): void;

