import type { PaginationOptions } from "convex/server";
import { jsonToConvex, type Value } from "convex/values";
import { utf8ByteLength } from "./base64url.js";
import { webPushError } from "./errors.js";

export function boundedString(value: string, max: number): void {
  if (
    !value.isWellFormed() ||
    value.length === 0 ||
    value.length > max ||
    utf8ByteLength(value) > max
  )
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
}

export function validateHosts(hosts: readonly string[] | undefined): void {
  if (hosts === undefined) return;
  if (hosts.length > 16) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  for (const host of hosts) {
    boundedString(host, 253);
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
