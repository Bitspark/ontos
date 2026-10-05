/*
 * Pins the `decimal` embedding (ontos-data.md §5.9): encode/read round-trip with
 * producer-side normalization (trailing base-10 zeros stripped into the exponent; zero
 * is decimal(int 0, int 0)), and the reject set — including the RECURSION case (a
 * non-canonical `int` child makes the whole decimal not well-formed), the scalar
 * discipline that distinguishes `decimal` from the containers list/map/set.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encodeInt, encodeDecimal, readDecimal, recognizeDecimal, DataError } from "../src/index.ts";

const LABEL_DECIMAL = new TextEncoder().encode("decimal");
const LABEL_INT = new TextEncoder().encode("int");

const dec = (m: Value, e: Value): Value => tuple([atom(LABEL_DECIMAL), m, e]);

test("decimal encode/read round-trips and normalizes", () => {
  const cases: { m: bigint; e: bigint; wantM: bigint; wantE: bigint }[] = [
    { m: 0n, e: 0n, wantM: 0n, wantE: 0n },
    { m: 1n, e: 0n, wantM: 1n, wantE: 0n },
    { m: 314n, e: -2n, wantM: 314n, wantE: -2n },
    { m: -5n, e: -1n, wantM: -5n, wantE: -1n },
    { m: 100n, e: 0n, wantM: 1n, wantE: 2n }, // trailing zeros stripped into the exponent
    { m: 10n, e: 1n, wantM: 1n, wantE: 2n }, // same value, different surface spelling
    { m: 0n, e: 5n, wantM: 0n, wantE: 0n }, // zero normalizes its exponent to 0
    { m: -120n, e: 3n, wantM: -12n, wantE: 4n },
  ];
  for (const c of cases) {
    const v = encodeDecimal(c.m, c.e);
    const got = readDecimal(v);
    assert.equal(got.mantissa, c.wantM, `read mantissa (${c.m}e${c.e})`);
    assert.equal(got.exponent, c.wantE, `read exponent (${c.m}e${c.e})`);
    // Encoding the normalized pair is idempotent (canonical form is a fixpoint).
    assert.ok(equals(encodeDecimal(c.wantM, c.wantE), v), `canonical fixpoint (${c.m}e${c.e})`);
    recognizeDecimal(v); // must not throw
  }
});

test("decimal rejects non-canonical forms", () => {
  const noncanonical: { name: string; v: Value }[] = [
    { name: "trailing_zero_mantissa", v: dec(encodeInt(10n), encodeInt(0n)) },
    { name: "zero_nonzero_exponent", v: dec(encodeInt(0n), encodeInt(5n)) },
    // non-canonical int mantissa (leading-zero magnitude) — the recursion case.
    { name: "noncanonical_int_mantissa", v: dec(tuple([atom(LABEL_INT), atom(Uint8Array.of(0x00, 0x00, 0x01))]), encodeInt(0n)) },
    { name: "mantissa_not_int", v: dec(atom(Uint8Array.of(0x01)), encodeInt(0n)) },
    { name: "wrong_arity", v: tuple([atom(LABEL_DECIMAL), encodeInt(1n)]) },
    { name: "bare_atom", v: atom(LABEL_DECIMAL) },
    { name: "cross_kind_int", v: encodeInt(1n) },
  ];
  for (const { name, v } of noncanonical) {
    assert.throws(() => recognizeDecimal(v), DataError, `recognizeDecimal must reject ${name}`);
    assert.throws(() => readDecimal(v), DataError, `readDecimal must reject ${name}`);
  }
});
