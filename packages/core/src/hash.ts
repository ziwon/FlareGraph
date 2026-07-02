// WebCrypto-based hashing: works in Cloudflare Workers and Node >= 20.
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function shortHash(input: string, length = 12): Promise<string> {
  return (await sha256Hex(input)).slice(0, length);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Stable page id derived from the vault-relative path. */
export async function pageIdForPath(path: string): Promise<string> {
  return `page_${await shortHash(`page:${path}`, 16)}`;
}
