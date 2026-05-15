import Groq from 'groq-sdk';

type CompletionParams = Parameters<Groq['chat']['completions']['create']>[0] & { stream?: false };

/** Split one env value into keys (comma, semicolon, or newlines). */
function splitKeyList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[,;\n\r]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Load balancing / failover: multiple Groq keys.
 * - GROQ_API_KEYS — preferred for several keys (comma, semicolon, or line-separated)
 * - GROQ_API_KEY — single key or comma-separated list (backward compatible)
 * Order: GROQ_API_KEYS first, then GROQ_API_KEY; duplicates removed.
 */
function getApiKeys(): string[] {
  const fromKeys = splitKeyList(process.env.GROQ_API_KEYS || '');
  const fromKey = splitKeyList(process.env.GROQ_API_KEY || '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [...fromKeys, ...fromKey]) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

let currentKeyIndex = 0;

export async function groqCompletion(params: CompletionParams): Promise<Groq.Chat.ChatCompletion> {
  const keys = getApiKeys();
  if (keys.length === 0) throw new Error('No GROQ_API_KEY or GROQ_API_KEYS configured');

  // Try each key once before failing
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(currentKeyIndex + attempt) % keys.length];
    try {
      const groq = new Groq({ apiKey: key });
      const result = await groq.chat.completions.create(params);
      // Rotate to next key for load distribution
      currentKeyIndex = (currentKeyIndex + attempt + 1) % keys.length;
      return result;
    } catch (err: any) {
      lastError = err;
      // On rate limit or auth error, try next key
      const isRetryable = err?.status === 429 || err?.status === 401 || err?.status === 503;
      if (!isRetryable) throw err;
      console.warn(`Groq key #${attempt + 1} failed (${err?.status}), trying next key...`);
    }
  }
  throw lastError || new Error('All Groq API keys failed');
}

export function getGroqKeyCount(): number {
  return getApiKeys().length;
}

export function getGroqKeyStatus(): { total: number; configured: boolean } {
  const keys = getApiKeys();
  return { total: keys.length, configured: keys.length > 0 };
}
