/*
 * Pins the i128 host-width boundary from the data spec §5.1 ("Implementation
 * bindings & integer width"). TS's `bigint` binding is unbounded, so it
 * MATERIALIZES the exact canonical bytes that Rust's `i128` binding reports as
 * IntOutOfRange: 2^127 (= i128::MAX + 1) and -(2^127 + 1) (= i128::MIN - 1). This
 * is the one place the three cores MATERIALIZE different sets of values (ontos-internal#67) —
 * recognition is identical, only materialization diverges; the bytes are well-formed,
 * so they must read AND round-trip. The payloads are shared verbatim with the Rust
 * and Go boundary tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals } from "@bitspark/ontos-core";
import { encodeInt, readInt } from "../src/index.ts";

const LABEL_INT = new TextEncoder().encode("int");

// Build a raw int value: Tuple(Atom("int"), Atom(sign || big-endian magnitude)).
function intValue(payload: number[]) {
  return tuple([atom(LABEL_INT), atom(Uint8Array.from(payload))]);
}

const TWO_127 = 1n << 127n; // 2^127 = i128::MAX + 1

const cases: { name: string; payload: number[]; want: bigint }[] = [
  // 2^127: sign 0x00, magnitude 0x80 then 15 zero bytes.
  { name: "i128_max_plus_1", payload: [0x00, 0x80, ...Array<number>(15).fill(0x00)], want: TWO_127 },
  // -(2^127 + 1): sign 0x01, magnitude 0x80, 14 zero bytes, then 0x01.
  { name: "i128_min_minus_1", payload: [0x01, 0x80, ...Array<number>(14).fill(0x00), 0x01], want: -(TWO_127 + 1n) },
];

for (const { name, payload, want } of cases) {
  test(`int host-width boundary materializes ${name} (Rust would report IntOutOfRange)`, () => {
    const v = intValue(payload);
    const got = readInt(v);
    assert.equal(got, want);
    // Round-trips to the very same canonical value, so these bytes are genuinely
    // well-formed — not merely tolerated on read.
    assert.ok(equals(encodeInt(got), v), "encodeInt(readInt(v)) !== v");
  });
}
