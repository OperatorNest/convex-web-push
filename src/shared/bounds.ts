import type { PaginationOptions } from "convex/server";
import { jsonToConvex } from "convex/values";
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

export function truncateText(value: string, max: number): string {
  const text = value.toWellFormed();
  const end = Math.min(text.length, max);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export function boundedPage(options: PaginationOptions): PaginationOptions {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > 100)
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  for (const cursor of [options.cursor, options.endCursor]) {
    if (cursor === null || cursor === undefined) continue;
    boundedString(cursor, 4096);
    try {
      const values = jsonToConvex(JSON.parse(cursor));
      if (
        !Array.isArray(values) ||
        (values.length !== 0 &&
          (values.length !== 4 ||
            typeof values[0] !== "string" ||
            !values[0].isWellFormed() ||
            typeof values[1] !== "number" ||
            !Number.isFinite(values[1]) ||
            typeof values[2] !== "number" ||
            !Number.isFinite(values[2]) ||
            typeof values[3] !== "string" ||
            !values[3].isWellFormed()))
      )
        throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    } catch {
      throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    }
  }
  // With endCursor, convex-helpers ignores numItems; the server row budget still applies.
  return {
    numItems: options.numItems,
    cursor: options.cursor,
    endCursor: options.endCursor,
    maximumRowsRead: options.numItems + 1,
    maximumBytesRead: 1024 * 1024,
  };
}
