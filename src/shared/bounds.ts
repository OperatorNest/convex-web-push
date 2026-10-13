import type { PaginationOptions } from "convex/server";
import { jsonToConvex, type Value } from "convex/values";
import { utf8ByteLength } from "./base64url.js";
import { webPushError } from "./errors.js";

/** Throws `WEB_PUSH_INVALID_ARGUMENT` unless `value` is non-empty, well-formed and at most `maxBytes` UTF-8 bytes. */
export function boundedUtf8String(value: string, maxBytes: number): void {
  if (!value.isWellFormed() || value.length === 0 || utf8ByteLength(value) > maxBytes)
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
}

export function validateHosts(hosts: readonly string[] | undefined): void {
  if (hosts === undefined) return;
  if (hosts.length > 16) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  for (const host of hosts) {
    boundedUtf8String(host, 253);
    const wildcard = host.startsWith("*.");
    const labels = (wildcard ? host.slice(2) : host).split(".");
    if (
      (wildcard && labels.length < 2) ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
      throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
}

// shared-block:begin
/** Returns the first `max` UTF-16 code units of `value` as well-formed text without ending inside a surrogate pair. */
export function truncateText(value: string, max: number): string {
  const text = value.toWellFormed();
  const end = Math.min(text.length, max);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Returns `value` when it is non-empty, well-formed and at most `maxLength` UTF-16 code units; otherwise throws `WEB_PUSH_INVALID_ARGUMENT`. */
export function boundedString(value: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength || !value.isWellFormed())
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return value;
}

/** Returns `key` when it is 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`; otherwise throws `WEB_PUSH_INVALID_ARGUMENT`. */
export function validateIdempotencyKey(key: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return key;
}

async function readTextChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  maxBytes: number,
  byteCount: number,
  text: string,
): Promise<string | undefined> {
  const chunk = await reader.read();
  const nextByteCount = byteCount + (chunk.value?.byteLength ?? 0);
  if (nextByteCount > maxBytes) {
    await reader.cancel();
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decoder.decode(chunk.value, { stream: !chunk.done });
  } catch {
    await reader.cancel();
    return undefined;
  }
  if (chunk.done) return text + decoded;
  return readTextChunks(reader, decoder, maxBytes, nextByteCount, text + decoded);
}

/** Reads the body of `message` as UTF-8 text. Returns `undefined`, and stops reading, when `content-length` or the streamed byte count exceeds `maxBytes` or when the bytes are not well-formed UTF-8. A leading byte order mark is kept, so the text re-encodes to the received bytes. A missing body reads as `""`. */
export async function readBoundedText(
  message: Request | Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (Number(message.headers.get("content-length")) > maxBytes) {
    await message.body?.cancel();
    return undefined;
  }
  if (message.body === null) return "";
  return readTextChunks(
    message.body.getReader(),
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    maxBytes,
    0,
    "",
  );
}

/** Throws `WEB_PUSH_INVALID_ARGUMENT` unless `cursor` is well-formed, at most 4096 characters, and a JSON array of at most 16 primitive values whose strings are well-formed. */
export function validateCursor(cursor: string): void {
  const isBoundedText = cursor.length <= 4096 && cursor.isWellFormed();
  if (!isBoundedText) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  let values: Value;
  try {
    values = jsonToConvex(JSON.parse(cursor));
  } catch {
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
  if (
    !Array.isArray(values) ||
    values.length > 16 ||
    !values.every(
      (value) =>
        value === null ||
        (typeof value === "string" && value.isWellFormed()) ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint" ||
        value instanceof ArrayBuffer,
    )
  )
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
}

/** Returns page options with `numItems` 1 to 100, validated `cursor` and `endCursor`, `maximumRowsRead` `numItems + 1` and `maximumBytesRead` 1048576; caller read budgets are ignored. */
export function boundedPage(options: PaginationOptions): PaginationOptions {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > 100)
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  for (const cursor of [options.cursor, options.endCursor])
    if (cursor !== null && cursor !== undefined) validateCursor(cursor);
  return {
    numItems: options.numItems,
    cursor: options.cursor,
    endCursor: options.endCursor,
    maximumRowsRead: options.numItems + 1,
    maximumBytesRead: 1_048_576,
  };
}
// shared-block:end
