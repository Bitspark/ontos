/*
 * ontos-internal#362: encode sizes the output first and writes one buffer, and encodes uvarints without BigInt.
 * FactIDs downstream are hashes of these bytes, so the only acceptable result is the previous
 * encoder's bytes, value for value. That encoder is kept here, verbatim in behaviour, as the
 * oracle: one Uint8Array per tag, per varint (through BigInt) and per atom, then a concat.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Atom, atom, tuple, type Value } from "@bitspark/ontos-core";
import { encode, encodeUvarint } from "../src/index.ts";

function oracleUvarint(n: number): Uint8Array {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

function oracleEncode(value: Value): Uint8Array {
  const pieces: Uint8Array[] = [];
  const stack: Value[] = [value];
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (v instanceof Atom) {
      const b = v.bytes();
      pieces.push(Uint8Array.of(0x00), oracleUvarint(b.length), b);
    } else {
      const items = v.items();
      pieces.push(Uint8Array.of(0x01), oracleUvarint(items.length));
      for (let i = items.length - 1; i >= 0; i -= 1) stack.push(items[i]!);
    }
  }
  let total = 0;
  for (const p of pieces) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A fixed xorshift corpus, so a failure reproduces.
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function randomValue(next: () => number, depth: number): Value {
  if (depth === 0 || next() < 0.45) {
    // Lengths across the 1-, 2- and 3-byte varint ranges, weighted towards small.
    const r = next();
    const len = r < 0.7 ? Math.floor(next() * 8) : r < 0.95 ? 120 + Math.floor(next() * 20) : 16380 + Math.floor(next() * 10);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(next() * 256);
    return atom(bytes);
  }
  const r = next();
  // Wide tuples (an arity crossing the 1/2-byte varint boundary) only one level above the leaves,
  // so a case stays a few hundred values rather than growing as 128^depth.
  const arity = r < 0.8 || depth > 1 ? Math.floor(next() * 5) : 126 + Math.floor(next() * 4);
  const items: Value[] = [];
  for (let i = 0; i < arity; i += 1) items.push(randomValue(next, depth - 1));
  return tuple(items);
}

test("ontos-internal#362: encode is byte-identical to the per-piece encoder over a fixed random corpus", () => {
  const next = rng(0x5eed362);
  for (let i = 0; i < 400; i += 1) {
    const v = randomValue(next, 4);
    assert.deepEqual(encode(v), oracleEncode(v), `case ${i}`);
  }
});

test("ontos-internal#362: the uvarint boundaries are byte-identical", () => {
  const ns = [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0x7fffffff, 0x80000000, 0xffffffff, 2 ** 32, 2 ** 35 - 1, 2 ** 35, 2 ** 49, Number.MAX_SAFE_INTEGER];
  for (const n of ns) assert.deepEqual(encodeUvarint(n), oracleUvarint(n), `uvarint ${n}`);
  // Through encode too: atom lengths on both sides of the 1/2- and 2/3-byte boundaries.
  for (const len of [0, 0x7f, 0x80, 0x3fff, 0x4000]) {
    const v = atom(new Uint8Array(len).fill(0xab));
    assert.deepEqual(encode(v), oracleEncode(v), `atom of ${len} bytes`);
  }
  // A tuple whose arity crosses the 1/2-byte boundary.
  const wide = tuple(Array.from({ length: 0x80 }, (_, i) => atom(Uint8Array.of(i))));
  assert.deepEqual(encode(wide), oracleEncode(wide));
});

test("ontos-internal#362: encodeUvarint still refuses what it refused", () => {
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
    assert.throws(() => encodeUvarint(bad), RangeError, `uvarint ${bad}`);
  }
});

test("ontos-internal#362: encode returns a fresh, exactly sized buffer", () => {
  const v = tuple([atom(Uint8Array.of(1, 2, 3)), tuple([])]);
  const a = encode(v);
  const b = encode(v);
  assert.equal(a.buffer.byteLength, a.length, "no slack in the buffer");
  assert.notEqual(a.buffer, b.buffer, "each call returns its own buffer");
  a[0] = 0xff;
  assert.equal(encode(v)[0], 0x01, "mutating a result does not touch later results");
});
