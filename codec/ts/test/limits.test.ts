/*
 * Operational limit reporting (ontos-codec.md §4.2, ontos-internal#352): every decoder-produced
 * limit_exceeded names the bound that stopped it in `limitKind`. Replays
 * vectors/codec-limits.json and pins TS's native-width ceiling (2^53 - 1).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decode, DecodeError, DecodeLimitKind, type DecodeOptions } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

function readVectors(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The DecodeError that decoding `bytes` under `options` throws. */
function decodeError(bytes: Uint8Array, options: DecodeOptions = {}): DecodeError {
  try {
    decode(bytes, options);
  } catch (err) {
    assert.ok(err instanceof DecodeError, `not a DecodeError: ${String(err)}`);
    return err;
  }
  assert.fail("expected decode to throw");
}

/** An atom tag followed by a declared byte length and no bytes. */
function atomOfLength(length: bigint): Uint8Array {
  const out = [0x00];
  let n = length;
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    out.push(byte);
  } while (n !== 0n);
  return Uint8Array.from(out);
}

test("codec-limits.json: every case accepts or names its bound", () => {
  const doc = readVectors("codec-limits.json");
  assert.ok(doc.cases.length > 0);
  for (const c of doc.cases) {
    for (const key of Object.keys(c.limits)) {
      assert.ok(["maxDepth", "maxAtomBytes", "maxTupleArity"].includes(key), `${c.name}: unknown limit ${key}`);
    }
    const bytes = hexToBytes(c.hex);
    if (c.expect === "accept") {
      assert.doesNotThrow(() => decode(bytes, c.limits), `${c.name}: expected accept`);
      continue;
    }
    const err = decodeError(bytes, c.limits);
    assert.deepEqual([err.code, err.limitKind], [c.expect.code, c.expect.limitKind], c.name);
  }
});

test("byte-contract rejects carry no limit kind, not even an undefined property", () => {
  for (const c of readVectors("codec.json").reject) {
    const err = decodeError(hexToBytes(c.hex));
    assert.equal(err.limitKind, undefined, c.name);
    assert.ok(!Object.hasOwn(err, "limitKind"), `${c.name}: limitKind present as an own property`);
  }
});

test("native width: a length past Number.MAX_SAFE_INTEGER is native_width; the ceiling itself is truncation", () => {
  const past = decodeError(atomOfLength(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
  assert.deepEqual([past.code, past.limitKind], ["limit_exceeded", DecodeLimitKind.NativeWidth]);
  const at = decodeError(atomOfLength(BigInt(Number.MAX_SAFE_INTEGER)));
  assert.deepEqual([at.code, at.limitKind], ["unexpected_eof", undefined]);
});

test("the worked collision of §4.2: with an atom bound of 10, a 2^60-byte atom is native_width in TS", () => {
  // go, rs (64-bit) and py report atom_bytes for the same input and options: TS's width
  // check runs inside the uvarint read, before the atom bound is compared.
  const err = decodeError(atomOfLength(1n << 60n), { maxAtomBytes: 10 });
  assert.deepEqual([err.code, err.limitKind], ["limit_exceeded", DecodeLimitKind.NativeWidth]);
});

test("compatibility: the two-argument constructor, instanceof, and the parent code are unchanged", () => {
  const built = new DecodeError("limit_exceeded", "from a caller");
  assert.ok(built instanceof DecodeError && built instanceof Error);
  assert.equal(built.code, "limit_exceeded");
  assert.equal(built.message, "from a caller");
  assert.equal(built.limitKind, undefined);

  const err = decodeError(hexToBytes("01010000"), { maxDepth: 0 });
  assert.equal(err.code, "limit_exceeded");
  assert.equal(err.message, "maximum decode depth exceeded: 0");
  assert.equal(err.limitKind, "decode_depth");
});

test("an unrecognized kind is still a limit_exceeded DecodeError", () => {
  const later = new DecodeError("limit_exceeded", "from a later version", "from_a_later_version");
  assert.equal(later.code, "limit_exceeded");
  const known: readonly string[] = Object.values(DecodeLimitKind);
  assert.ok(!known.includes(later.limitKind ?? ""), "a later kind is not one of today's");
});
