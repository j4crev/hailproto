import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";

// Shared HTTP boundaries for the monitor API and its Cloudflare alert receiver.
export async function hash(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export async function authenticated(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  try { decodeBase64Url(secret, 32); } catch { return false; }
  const actual = request.headers.get("Authorization");
  if (!actual || actual.length > 128) return false;
  const [a, b] = await Promise.all([hash(actual), hash(`Bearer ${secret}`)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export async function boundedBody(message: Pick<Request, "body" | "headers">, maximum = 65_536): Promise<Uint8Array | null> {
  const declared = message.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await message.body?.cancel().catch(() => {}); return null;
  }
  if (!message.body) return null;
  const reader = message.body.getReader(), parts: Uint8Array[] = [];
  let length = 0, done = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) { done = true; break; }
      length += next.value.length; if (length > maximum) return null; parts.push(next.value);
    }
  } finally { if (!done) await reader.cancel().catch(() => {}); }
  if (!length) return null;
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
