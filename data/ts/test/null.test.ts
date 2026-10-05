/*
 * Pins the `null` embedding (ontos-data.md §5.10): the single canonical spelling of
 * present-but-no-value, `null()` = Tuple(Atom("null")) — a nullary compound (arity
 * exactly 1, just the label, no payload). It is the only inhabitant. The recognizer
 * accepts exactly that shape and REJECTS any payload (arity > 1, guardrail 1: exactly
 * one no-value, forever), a near-miss label, the bare empty tuple, a bare atom, and a
 * value of another kind (cross-kind disjointness). Mirrors the empty-container kinds
 * (list/set) with a new label; codec-independent, frozen on structure alone.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import {
  encodeNull,
  recognizeNull,
  readNull,
  encodeList,
  encodeBool,
  readList,
  readSet,
  readMap,
  readBool,
  DataError,
} from "../src/index.ts";

const LABEL_NULL = new TextEncoder().encode("null");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

test("null is the unique nullary compound and round-trips to itself", () => {
  const v = encodeNull();
  // Exact canonical structure: Tuple(Atom("null")), arity exactly 1.
  assert.ok(equals(v, tuple([atom(LABEL_NULL)])), "encodeNull() canonical shape");
  // Frozen byte form: 01 01 00 04 6e 75 6c 6c (spec §5.10).
  assert.equal(bytesToHex(encode(v)), "010100046e756c6c", "null frozen byte form");
  // recognize/read both accept; re-encoding is a fixpoint (no value to vary).
  recognizeNull(v);
  readNull(v);
  assert.ok(equals(encodeNull(), v), "encodeNull is a fixpoint");
});

test("null rejects payload, wrong label, empty tuple, bare atom, and cross-kind", () => {
  const cases: { name: string; v: Value }[] = [
    // arity 2: a "null" with a payload child — present-but-no-value forbids payload.
    { name: "null_with_payload", v: tuple([atom(LABEL_NULL), atom(Uint8Array.of(0x61))]) },
    // arity 3: more payload, still rejected.
    {
      name: "null_with_two_payloads",
      v: tuple([atom(LABEL_NULL), atom(Uint8Array.of(0x61)), atom(Uint8Array.of(0x62))]),
    },
    // arity 0: the bare empty tuple is not the null (the null is the arity-1 form).
    { name: "empty_tuple", v: tuple([]) },
    // a bare atom (even the bytes of "null") is not a null.
    { name: "bare_atom", v: atom(LABEL_NULL) },
    // near-miss label.
    { name: "near_miss_label", v: tuple([atom(new TextEncoder().encode("nul"))]) },
    // cross-kind: a well-formed empty list is not a null.
    { name: "cross_kind_list", v: encodeList([]) },
    // cross-kind: a well-formed bool is not a null.
    { name: "cross_kind_bool", v: encodeBool(false) },
  ];
  for (const { name, v } of cases) {
    assert.throws(() => recognizeNull(v), DataError, `recognizeNull must reject ${name}`);
    assert.throws(() => readNull(v), DataError, `readNull must reject ${name}`);
  }
});

test("the single null value is recognized only as null", () => {
  const v = encodeNull();
  assert.throws(() => readList(v), DataError, "null is not a list");
  assert.throws(() => readSet(v), DataError, "null is not a set");
  assert.throws(() => readMap(v), DataError, "null is not a map");
  assert.throws(() => readBool(v), DataError, "null is not a bool");
});
