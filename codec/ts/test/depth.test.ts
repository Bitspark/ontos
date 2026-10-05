/*
 * ontos-internal#343: encode and decode walk with an explicit stack, never the JS call stack, so the depth of a
 * value they handle is not a property of the V8 tier or the runner (logos measured a recursive
 * walker's throw depth moving by ~570 levels between the unoptimized and optimized tiers). The byte
 * mapping is frozen (ontos-codec-v1): this changes how the walk is done, never what it writes.
 *
 * NEGATIVE WITNESS: the recursive encode throws RangeError on the 100,000-level value below.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, Tuple, type Value } from "@bitspark/ontos-core";
import { decode, encode, DecodeError } from "../src/index.ts";

const DEEP = 100_000;

// DEEP one-element tuples around the atom "a".
function nested(depth: number): Value {
  let v: Value = atom(Uint8Array.of(0x61));
  for (let i = 0; i < depth; i += 1) v = tuple([v]);
  return v;
}

// The frozen byte form, computed by hand: each tuple level is TAG_TUPLE (0x01) and arity 1 (0x01);
// the atom is TAG_ATOM (0x00), length 1 (0x01), then 0x61.
function expectedBytes(depth: number): Uint8Array {
  const out = new Uint8Array(2 * depth + 3);
  for (let i = 0; i < depth; i += 1) {
    out[2 * i] = 0x01;
    out[2 * i + 1] = 0x01;
  }
  out.set([0x00, 0x01, 0x61], 2 * depth);
  return out;
}

test("ontos-internal#343: encode writes a 100,000-level value, byte for byte, with no call stack per level", () => {
  const bytes = encode(nested(DEEP));
  assert.deepEqual(bytes, expectedBytes(DEEP));
});

test("ontos-internal#343: decode reads a 100,000-level value back when maxDepth allows it", () => {
  const v = decode(expectedBytes(DEEP), { maxDepth: DEEP + 1 });
  let cur: Value = v;
  let levels = 0;
  while (cur instanceof Tuple) {
    assert.equal(cur.length, 1);
    cur = cur.items()[0]!;
    levels += 1;
  }
  assert.equal(levels, DEEP);
  assert.deepEqual(encode(v), expectedBytes(DEEP), "decode is encode's inverse on the deep value");
});

test("ontos-internal#343: the default limit still refuses a deep value by name, never with a RangeError", () => {
  assert.throws(
    () => decode(expectedBytes(DEEP)),
    (e: unknown) => e instanceof DecodeError && e.code === "limit_exceeded",
  );
});
