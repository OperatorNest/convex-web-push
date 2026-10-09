/** Unpadded base64url (RFC 4648 section 5), built on `btoa`/`atob` so it runs without Node APIs. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes base64url, tolerating padding and the standard `+/` alphabet. Throws on invalid input. */
export function base64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
  if (!/^[A-Za-z0-9_-]*$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Invalid base64url string");
  }
  const padded = normalized.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function utf8ByteLength(text: string): number {
  return utf8Encode(text).byteLength;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
