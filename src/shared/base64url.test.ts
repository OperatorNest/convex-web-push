import { expect, test } from "vitest";
import { base64urlDecode, base64urlEncode, bytesEqual, utf8ByteLength } from "./base64url.js";

test("encodes without padding using the url alphabet", () => {
  expect(base64urlEncode(new Uint8Array([251, 255, 254]))).toBe("-__-");
  expect(base64urlEncode(new Uint8Array([1]))).toBe("AQ");
  expect(base64urlEncode(new Uint8Array())).toBe("");
});

test("round-trips every length", () => {
  for (let n = 0; n < 70; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    expect(bytesEqual(base64urlDecode(base64urlEncode(bytes)), bytes)).toBe(true);
  }
});

test("accepts padded and standard-alphabet input", () => {
  expect(Array.from(base64urlDecode("AQ=="))).toEqual([1]);
  expect(Array.from(base64urlDecode("+/8="))).toEqual([251, 255]);
});

test("rejects invalid input", () => {
  expect(() => base64urlDecode("a")).toThrow();
  expect(() => base64urlDecode("ab$d")).toThrow();
});

test("counts utf-8 bytes", () => {
  expect(utf8ByteLength("é")).toBe(2);
  expect(utf8ByteLength("a")).toBe(1);
});

test("bytesEqual compares content and length", () => {
  expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
});
