import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, type Value } from "@bitspark/ontos-core";
import { decode, DecodeError, encode, encodeTupleHeader, encodeUvarint } from "../src/index.ts";

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function failure(action: () => unknown): Error {
  try { action(); } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected rejection");
}

test("tuple headers have the frozen tag and shortest arity bytes at integer boundaries", () => {
  // Derived from the codec specification, including arities that cannot be
  // allocated as a JS array. The helper allocates only the header.
  const cases: readonly (readonly [number, readonly number[]])[] = [
    [0, [1, 0]],
    [1, [1, 1]],
    [127, [1, 127]],
    [128, [1, 128, 1]],
    [16383, [1, 255, 127]],
    [16384, [1, 128, 128, 1]],
    [2 ** 32 - 1, [1, 255, 255, 255, 255, 15]],
    [2 ** 32, [1, 128, 128, 128, 128, 16]],
    [Number.MAX_SAFE_INTEGER, [1, 255, 255, 255, 255, 255, 255, 255, 15]],
  ];
  for (const [arity, expected] of cases) {
    const header = encodeTupleHeader(arity);
    assert.deepEqual(header, Uint8Array.from(expected), `arity ${arity}`);
    assert.deepEqual(header.subarray(1), encodeUvarint(arity));
    assert.equal(header.buffer.byteLength, header.length);
  }
  assert.deepEqual(encodeTupleHeader(-0), encodeTupleHeader(0));
});

test("tuple header rejects exactly the invalid numeric inputs rejected by encodeUvarint", () => {
  for (const arity of [-1, -0.5, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, -Infinity]) {
    const expected = failure(() => encodeUvarint(arity));
    const actual = failure(() => encodeTupleHeader(arity));
    assert.ok(actual instanceof RangeError);
    assert.equal(actual.constructor, expected.constructor);
    assert.equal(actual.message, expected.message);
  }
});

test("tuple header plus independently encoded children equals the whole encoder", () => {
  for (const arity of [0, 1, 2, 127, 128, 16383, 16384]) {
    const children: Value[] = Array.from({ length: arity }, (_, i) => i % 2 === 0
      ? atom(Uint8Array.of(i & 255))
      : tuple([atom(Uint8Array.of(0, 255)), tuple([])]));
    const assembled = concatenate([encodeTupleHeader(arity), ...children.map(encode)]);
    const whole = encode(tuple(children));
    assert.deepEqual(assembled, whole, `arity ${arity}`);
    assert.deepEqual(encode(decode(assembled)), whole);
  }
});

test("tuple header results are independent and assembled values keep ordinary decoder boundaries", () => {
  const header = encodeTupleHeader(2);
  const unchanged = encodeTupleHeader(2);
  assert.notEqual(header.buffer, unchanged.buffer);
  header.fill(255);
  assert.deepEqual(encodeTupleHeader(2), unchanged);

  const child = tuple([atom(Uint8Array.of(1, 2, 3))]);
  const bytes = concatenate([encodeTupleHeader(1), encode(child)]);
  assert.deepEqual(bytes, encode(tuple([child])));
  for (const [options, kind] of [
    [{ maxDepth: 1 }, "decode_depth"],
    [{ maxTupleArity: 0 }, "tuple_arity"],
    [{ maxAtomBytes: 2 }, "atom_bytes"],
  ] as const) {
    assert.throws(() => decode(bytes, options), (error: unknown) =>
      error instanceof DecodeError && error.code === "limit_exceeded" && error.limitKind === kind);
  }
  assert.throws(() => decode(encodeTupleHeader(1)), (error: unknown) =>
    error instanceof DecodeError && error.code === "unexpected_eof");
  assert.throws(() => decode(concatenate([encodeTupleHeader(0), encode(child)])), (error: unknown) =>
    error instanceof DecodeError && error.code === "trailing_bytes");
});
