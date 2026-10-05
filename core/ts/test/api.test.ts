/*
 * Public Value API surface tests for @bitspark/ontos-core (ontos-internal#55).
 *
 * These cover the COMMON core API that every core (Go, Rust, TS) must provide —
 * construct, bytes/items, length, indexed `at`, equality, string — plus the
 * TS-idiomatic extras (`kind` discriminant, toJSON, toHex) that are documented as
 * intentional per-language additions. They assert the library contract only; byte
 * parity and the codec mapping are exercised by the codec/data vector suites.
 *
 * Auto-discovered by the ts CI glob (core/ts/test/*.test.ts). Run directly:
 *   node --test core/ts/test/api.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, isValue, toHex, Atom, Tuple, type Value } from "../src/index.ts";

// --- common API: construct + bytes/items + length ----------------------------

test("atom exposes bytes (defensive copy) and length", () => {
  const a = atom([1, 2, 3]);
  assert.equal(a.length, 3);
  const bytes = a.bytes();
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  // Mutating the returned bytes must not mutate the atom.
  bytes[0] = 0xff;
  assert.deepEqual(Array.from(a.bytes()), [1, 2, 3]);
});

test("empty atom has length 0", () => {
  assert.equal(atom().length, 0);
  assert.equal(atom([]).length, 0);
});

test("tuple exposes items and length", () => {
  const first = atom([0x61]);
  const second = atom([0x62]);
  const t = tuple([first, second]);
  assert.equal(t.length, 2);
  assert.equal(t.items().length, 2);
  assert.ok(equals(t.items()[0]!, first));
  assert.ok(equals(t.items()[1]!, second));
});

// --- common API: indexed access (parallels Go Tuple.At / Rust Tuple::at) ------

test("Tuple.at returns children in order", () => {
  const first = atom([0x61]);
  const second = atom([0x62]);
  const t = tuple([first, second]);
  assert.ok(equals(t.at(0)!, first));
  assert.ok(equals(t.at(1)!, second));
  // at() agrees with the items() array at the same index.
  assert.strictEqual(t.at(0), t.items()[0]);
});

test("Tuple.at out of range is undefined", () => {
  const t = tuple([atom([0x61])]);
  assert.equal(t.at(1), undefined);
  assert.equal(t.at(-1), undefined);
  const empty = tuple();
  assert.equal(empty.length, 0);
  assert.equal(empty.at(0), undefined);
});

// --- common API: structural equality + diagnostic string ---------------------

test("equality is structural and disjoint across kinds", () => {
  assert.ok(equals(atom([1, 2, 3]), atom([1, 2, 3])));
  assert.ok(!equals(atom([1, 2, 3]), atom([1, 2, 4])));
  // Empty atom and empty tuple are distinct values.
  assert.ok(!equals(atom([]), tuple([])));
  const nested = tuple([tuple([atom([0x61]), atom([0x62])])]);
  const flat = tuple([atom([0x61]), atom([0x62])]);
  assert.ok(!equals(nested, flat));
});

test("toString is a diagnostic (not canonical) form", () => {
  assert.equal(atom([0x61, 0x62]).toString(), "Atom(0x6162)");
  assert.equal(tuple([atom([0x61]), atom([0x62])]).toString(), "Tuple(Atom(0x61), Atom(0x62))");
});

// --- TS-idiomatic intentional extras: kind discriminant ----------------------

test("kind discriminant narrows Value exhaustively", () => {
  const values: Value[] = [atom([0x61]), tuple([atom([0x62])])];
  let atoms = 0;
  let tuples = 0;
  for (const v of values) {
    switch (v.kind) {
      case "atom":
        atoms += 1;
        assert.ok(v instanceof Atom);
        break;
      case "tuple":
        tuples += 1;
        assert.ok(v instanceof Tuple);
        break;
    }
  }
  assert.equal(atoms, 1);
  assert.equal(tuples, 1);
});

// --- TS-idiomatic intentional extras: toJSON / toHex --------------------------

test("toJSON exposes a stable structured shape", () => {
  assert.deepEqual(atom([0xde, 0xad]).toJSON(), { atom: "dead" });
  const t = tuple([atom([0x61])]);
  const json = t.toJSON();
  assert.equal(json.tuple.length, 1);
  assert.ok(equals(json.tuple[0]!, atom([0x61])));
  // JSON.stringify drives toJSON recursively.
  assert.equal(JSON.stringify(atom([0x00, 0xff])), '{"atom":"00ff"}');
});

test("toHex renders lowercase, zero-padded bytes", () => {
  assert.equal(toHex(new Uint8Array([0x00, 0x0f, 0xff])), "000fff");
  assert.equal(toHex(new Uint8Array()), "");
});

// --- isValue guard ------------------------------------------------------------

test("isValue recognizes only ontos values", () => {
  assert.ok(isValue(atom([0x61])));
  assert.ok(isValue(tuple([])));
  assert.ok(!isValue({ kind: "atom" }));
  assert.ok(!isValue(null));
  assert.ok(!isValue("atom"));
});
