import { expect, test } from "vitest";
import { sha256, sha256Hex } from "./sha256.js";

test("matches known vectors", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("matches WebCrypto around the block boundaries", async () => {
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(sha256(bytes))).toEqual(Array.from(expected));
  }
});
