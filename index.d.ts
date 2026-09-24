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

/**
 * Options passed to `checkSession` or `checkAuth`.
 */
export interface CheckSessionOptions {
  mode?: 'cookie' | 'network';
  providers?: Array<'chatgpt' | 'claude' | 'gemini'>;
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
  sendPrompt(prompt: string, options?: PromptOptions): Promise<string>;
  checkAuth(options?: {
    mode?: 'cookie' | 'network';
    signal?: AbortSignal;
    onLog?: (entry: LogEntry) => void;
  }): Promise<ProviderAuthResult>;
}

export const chatgpt: ProviderModule;
export const claude: ProviderModule;
export const gemini: ProviderModule;

export const providers: {
  chatgpt: ProviderModule;
  claude: ProviderModule;
  gemini: ProviderModule;
  [key: string]: ProviderModule;
};

/**
 * Get a provider module by string identifier.
 */
export function getProvider(name: 'chatgpt' | 'claude' | 'gemini' | string): ProviderModule;

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
  providerName: 'chatgpt' | 'claude' | 'gemini' | string,
  prompt: string,
  options?: PromptOptions
): Promise<string>;
