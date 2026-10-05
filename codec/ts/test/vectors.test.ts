/*
 * Replays the shared conformance vectors (../../../vectors/{identity,codec}.json)
 * against the TS implementation. The {atom:hex}|{tuple:[...]} JSON is the vector
 * authoring notation, NOT ontos's canonical encoding.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { decode, encode, encodeUvarint, DecodeError } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

function readVectors(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function valueFromJson(j: any): Value {
  if (typeof j.atom === "string") return atom(hexToBytes(j.atom));
  if (Array.isArray(j.tuple)) return tuple(j.tuple.map(valueFromJson));
  throw new Error(`value must be {atom} or {tuple}: ${JSON.stringify(j)}`);
}

test("identity vectors", () => {
  const doc = readVectors("identity.json");
  assert.ok(doc.cases.length > 0, "no identity cases");
  for (const c of doc.cases) {
    const left = valueFromJson(c.left);
    const right = valueFromJson(c.right);
    assert.equal(equals(left, right), c.equal, `identity case ${c.name}`);
  }
});

test("codec uvarint vectors", () => {
  const doc = readVectors("codec.json");
  for (const c of doc.uvarint) {
    assert.equal(bytesToHex(encodeUvarint(c.n)), c.hex, `uvarint(${c.n})`);
  }
});

test("codec encode + roundtrip vectors", () => {
  const doc = readVectors("codec.json");
  for (const c of doc.encode) {
    const value = valueFromJson(c.value);
    assert.equal(bytesToHex(encode(value)), c.hex, `encode ${c.name}`);
    assert.equal(equals(decode(hexToBytes(c.hex)), value), true, `roundtrip ${c.name}`);
  }
});

test("data embedding vectors", () => {
  // ontos/data (L2) embeddings pinned as full ontos-codec-v1 encodings —
  // same encode+roundtrip contract as codec.json's encode cases.
  const doc = readVectors("data.json");
  assert.ok(doc.encode.length > 0, "no data cases");
  for (const c of doc.encode) {
    const value = valueFromJson(c.value);
    assert.equal(bytesToHex(encode(value)), c.hex, `data encode ${c.name}`);
    assert.equal(equals(decode(hexToBytes(c.hex)), value), true, `data roundtrip ${c.name}`);
  }
});

test("codec reject vectors", () => {
  const doc = readVectors("codec.json");
  for (const c of doc.reject) {
    try {
      const v = decode(hexToBytes(c.hex));
      assert.fail(`reject case ${c.name} unexpectedly decoded to ${v.toString()}`);
    } catch (e) {
      assert.ok(e instanceof DecodeError, `reject case ${c.name}: expected DecodeError, got ${e}`);
      assert.equal(e.code, c.code, `reject case ${c.name}`);
    }
  }
});

// --- TS-only uvarint u64-domain boundary tests --------------------------------
// Implementation-local (NOT pinned in the shared vectors): the limit_exceeded
// boundary is Number.MAX_SAFE_INTEGER, specific to this core's native number
// width. See ontos-codec.md §3.1 / §4. Each uvarint is placed behind a 0x00
// (Atom) length prefix and run through the public decode() path.
function decodeCode(uvarintHex: string): string {
  try {
    decode(hexToBytes("00" + uvarintHex));
    return "OK";
  } catch (e) {
    assert.ok(e instanceof DecodeError, `expected DecodeError, got ${e}`);
    return e.code;
  }
}

test("uvarint at MAX_SAFE_INTEGER + 1 (2^53) is limit_exceeded, not uvarint_overflow", () => {
  // 2^53 = 9007199254740992, canonical uvarint 80 80 80 80 80 80 80 80 10 (9 bytes).
  // A valid u64 but above Number.MAX_SAFE_INTEGER -> resource-limit class.
  assert.equal(decodeCode("808080808080808010"), "limit_exceeded");
});

test("uvarint at u64 max (2^64 - 1) is limit_exceeded, not uvarint_overflow", () => {
  // 2^64 - 1, canonical 10-byte ff ff ff ff ff ff ff ff ff 01. Still a valid u64.
  assert.equal(decodeCode("ffffffffffffffffff01"), "limit_exceeded");
});

test("uvarint at 2^64 is uvarint_overflow", () => {
  // 2^64 is outside the u64 domain; minimal LEB128 needs an 11th byte (80*10 02).
  assert.equal(decodeCode("8080808080808080808002"), "uvarint_overflow");
});

test("uvarint with a 10th byte exceeding the u64 ceiling is uvarint_overflow", () => {
  // ff*9 03: the terminating byte pushes the value past 2^64 within 10 bytes.
  assert.equal(decodeCode("ffffffffffffffffff03"), "uvarint_overflow");
});

test("uvarint at exactly MAX_SAFE_INTEGER materializes (no limit_exceeded / overflow)", () => {
  // 2^53 - 1, canonical ff ff ff ff ff ff ff 0f (7 bytes): accepted as a length,
  // then decode reports unexpected_eof on the absent atom body -> proves the
  // uvarint itself was materialized, not rejected.
  assert.equal(decodeCode("ffffffffffffff0f"), "unexpected_eof");
});

test("uvarint preserves unexpected_eof and non_canonical_uvarint", () => {
  assert.equal(decodeCode("80"), "unexpected_eof");
  assert.equal(decodeCode("8000"), "non_canonical_uvarint");
});
