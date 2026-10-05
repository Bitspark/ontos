/*
 * Replays the shared ontos/data (L2) conformance vectors
 * (../../../vectors/data.json) against the TS embedding implementation, then adds
 * implementation-local recognition (negative) and round-trip (positive) tests.
 *
 * The {atom:hex}|{tuple:[...]} JSON is the vector authoring notation, NOT ontos's
 * canonical encoding. The "FULL byte chain" assertions encode each vector value
 * with @bitspark/ontos-codec (now a RUNTIME dependency — `map` entry order is the
 * codec byte order, ontos-data.md §5.7) and check it equals the pinned hex, proving
 * datum -> Value -> bytes end-to-end. See docs/spec/ontos-data.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Atom, Tuple, atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import {
  DataError,
  LABELS,
  encodeInt,
  readInt,
  recognizeInt,
  encodeBool,
  readBool,
  encodeText,
  readText,
  encodeList,
  readList,
  encodeMap,
  readMap,
  encodeSet,
  readSet,
  encodeDecimal,
  readDecimal,
  recognizeDecimal,
  encodeNull,
  readNull,
  recognizeNull,
} from "../src/index.ts";

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

/** The label string of an embedding value (child0 of a non-empty Tuple). */
function labelOf(v: Value): string {
  if (!(v instanceof Tuple) || v.length < 1) throw new Error(`not a labeled tuple: ${v.toString()}`);
  const child0 = v.at(0);
  if (!(child0 instanceof Atom)) throw new Error(`label child is not an atom: ${v.toString()}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(child0.bytes());
}

test("data embedding vectors — encode, read, round-trip, full byte chain", () => {
  const doc = readVectors("data.json");
  assert.ok(doc.encode.length > 0, "no data cases");
  let processed = 0;

  for (const c of doc.encode) {
    const v = valueFromJson(c.value);
    const label = labelOf(v);

    switch (label) {
      case "int": {
        // datum source: parse case.datum as a base-10 integer.
        const datum = BigInt(c.datum);
        assert.ok(equals(encodeInt(datum), v), `int encode ${c.name}`);
        assert.equal(readInt(v), datum, `int read ${c.name}`);
        assert.ok(equals(encodeInt(readInt(v)), v), `int round-trip ${c.name}`);
        break;
      }
      case "bool": {
        // datum source: case.datum is "true"/"false".
        assert.ok(c.datum === "true" || c.datum === "false", `bool datum ${c.name}`);
        const datum = c.datum === "true";
        assert.ok(equals(encodeBool(datum), v), `bool encode ${c.name}`);
        assert.equal(readBool(v), datum, `bool read ${c.name}`);
        assert.ok(equals(encodeBool(readBool(v)), v), `bool round-trip ${c.name}`);
        break;
      }
      case "utf8-text": {
        // datum source: derive structurally from V (case.datum is display-only).
        const datum = readText(v);
        assert.ok(equals(encodeText(datum), v), `text encode ${c.name}`);
        assert.equal(readText(v), datum, `text read ${c.name}`);
        assert.ok(equals(encodeText(readText(v)), v), `text round-trip ${c.name}`);
        break;
      }
      case "list": {
        // datum source: derive elements structurally from V (case.datum display-only).
        const datum = readList(v);
        assert.ok(equals(encodeList(datum), v), `list encode ${c.name}`);
        const got = readList(v);
        assert.equal(got.length, datum.length, `list read arity ${c.name}`);
        for (let i = 0; i < datum.length; i += 1) {
          assert.ok(equals(got[i]!, datum[i]!), `list element ${i} ${c.name}`);
        }
        assert.ok(equals(encodeList(readList(v)), v), `list round-trip ${c.name}`);
        break;
      }
      case "map": {
        // datum source: derive entries structurally from V — V's children after the
        // label are arity-2 entry tuples (key, value); case.datum is display-only.
        if (!(v instanceof Tuple)) assert.fail(`map case ${c.name} value is not a tuple`);
        const entries: Array<[Value, Value]> = v
          .items()
          .slice(1)
          .map((child) => {
            assert.ok(child instanceof Tuple && child.length === 2, `map entry shape ${c.name}`);
            return [child.at(0)!, child.at(1)!] as [Value, Value];
          });

        // encodeMap must reproduce the canonical value from the (already-sorted) entries...
        assert.ok(equals(encodeMap(entries), v), `map encode ${c.name}`);
        // ...AND from the entries REVERSED — proving encodeMap SORTS, not just preserves order.
        assert.ok(equals(encodeMap([...entries].reverse()), v), `map encode (reversed input) ${c.name}`);

        // readMap returns exactly those (key, value) pairs in order.
        const got = readMap(v);
        assert.equal(got.length, entries.length, `map read arity ${c.name}`);
        for (let i = 0; i < entries.length; i += 1) {
          assert.ok(equals(got[i]![0], entries[i]![0]), `map key ${i} ${c.name}`);
          assert.ok(equals(got[i]![1], entries[i]![1]), `map value ${i} ${c.name}`);
        }
        assert.ok(equals(encodeMap(readMap(v)), v), `map round-trip ${c.name}`);
        break;
      }
      case "set": {
        // datum source: derive elements structurally from V — V's children after the
        // label are the (single-value) elements; case.datum is display-only.
        if (!(v instanceof Tuple)) assert.fail(`set case ${c.name} value is not a tuple`);
        const elements: Value[] = v.items().slice(1);

        // encodeSet must reproduce the canonical value from the (already-sorted) elements...
        assert.ok(equals(encodeSet(elements), v), `set encode ${c.name}`);
        // ...AND from the elements REVERSED — proving encodeSet SORTS, not just preserves order.
        assert.ok(equals(encodeSet([...elements].reverse()), v), `set encode (reversed input) ${c.name}`);

        // readSet returns exactly those elements in order.
        const got = readSet(v);
        assert.equal(got.length, elements.length, `set read arity ${c.name}`);
        for (let i = 0; i < elements.length; i += 1) {
          assert.ok(equals(got[i]!, elements[i]!), `set element ${i} ${c.name}`);
        }
        assert.ok(equals(encodeSet(readSet(v)), v), `set round-trip ${c.name}`);
        break;
      }
      case "decimal": {
        // datum source: derive (mantissa, exponent) structurally from V via readDecimal.
        // This binding's bigint is unbounded, so even the beyond-i128 mantissa
        // (decimal_2pow128_mantissa) materializes and round-trips here — the recognize/read
        // split only diverges in the bounded Rust i128 binding (§5.9).
        const { mantissa, exponent } = readDecimal(v);
        assert.ok(equals(encodeDecimal(mantissa, exponent), v), `decimal round-trip ${c.name}`);
        recognizeDecimal(v); // structural recognition must accept every decimal_* vector
        break;
      }
      case "null": {
        // null is the single inhabitant; there is no datum to derive — encodeNull() must
        // reproduce V exactly, and recognize/read both accept it.
        assert.ok(equals(encodeNull(), v), `null encode ${c.name}`);
        recognizeNull(v);
        readNull(v);
        break;
      }
      default:
        // EXHAUSTIVENESS guard: any future vector with a new label forces an update.
        assert.fail(`unrecognized data label "${label}" in case ${c.name}`);
    }

    // FULL byte chain: datum -> Value -> bytes equals the pinned hex.
    assert.equal(bytesToHex(encode(v)), c.hex, `data full byte chain ${c.name}`);
    processed += 1;
  }

  assert.ok(processed > 0, "processed zero data cases");
});

test("data reject vectors — read<kind> rejects non-canonical and cross-kind forms", () => {
  // The shared `reject` array pins the cross-language RECOGNITION decision: each
  // value is valid at L0 but is NOT a well-formed embedding of its `kind`, so
  // read<kind> must reject it. (The specific DataError code is impl-local.)
  const doc = readVectors("data.json");
  assert.ok(Array.isArray(doc.reject) && doc.reject.length > 0, "no data reject cases");
  const readers: Record<string, (v: Value) => unknown> = {
    "int": readInt,
    "bool": readBool,
    "utf8-text": readText,
    "list": readList,
    "map": readMap,
    "set": readSet,
    "decimal": readDecimal,
    "null": readNull,
  };
  for (const c of doc.reject) {
    const read = readers[c.kind];
    assert.ok(read, `unrecognized reject kind "${c.kind}" in case ${c.name}`);
    expectDataError(() => read(valueFromJson(c.value)), `reject ${c.name}`);
  }
});

// --- recognition (negative) tests — authored, NOT in the vectors --------------

const labelAtom = (s: string): Atom => atom(new TextEncoder().encode(s));

function expectDataError(fn: () => unknown, name: string): DataError {
  try {
    const r = fn();
    assert.fail(`${name}: expected DataError, got ${String(r)}`);
  } catch (e) {
    assert.ok(e instanceof DataError, `${name}: expected DataError, got ${e}`);
    return e;
  }
  throw new Error("unreachable");
}

test("readInt rejects malformed and cross-kind forms", () => {
  // non-tuple
  expectDataError(() => readInt(atom([0x00])), "int non-tuple");
  // wrong arity (3)
  expectDataError(() => readInt(tuple([labelAtom("int"), atom([0x00]), atom([0x00])])), "int wrong arity");
  // label child is not an atom (a tuple sits in the label slot)
  expectDataError(() => readInt(tuple([tuple([]), atom([0x00])])), "int non-atom label");
  // payload child is not an atom (a tuple sits in the payload slot)
  expectDataError(() => readInt(tuple([labelAtom("int"), tuple([])])), "int non-atom payload");
  // wrong label — a well-formed bool value
  expectDataError(() => readInt(encodeBool(true)), "int wrong label (bool)");
  // cross-kind: a list value
  expectDataError(() => readInt(encodeList([atom([0x61])])), "int on list value");
  // empty payload
  expectDataError(() => readInt(tuple([labelAtom("int"), atom([])])), "int empty payload");
  // sign byte 0x02
  expectDataError(() => readInt(tuple([labelAtom("int"), atom([0x02, 0x01])])), "int sign 0x02");
  // negative-zero payload [0x01]
  expectDataError(() => readInt(tuple([labelAtom("int"), atom([0x01])])), "int negative zero");
  // leading-zero magnitude [0x00, 0x00, 0x01]
  expectDataError(() => readInt(tuple([labelAtom("int"), atom([0x00, 0x00, 0x01])])), "int leading-zero magnitude");
});

test("readBool rejects malformed and wrong-label forms", () => {
  // wrong label — an int value
  expectDataError(() => readBool(encodeInt(1n)), "bool wrong label (int)");
  // empty payload
  expectDataError(() => readBool(tuple([labelAtom("bool"), atom([])])), "bool empty payload");
  // payload 0x02
  expectDataError(() => readBool(tuple([labelAtom("bool"), atom([0x02])])), "bool payload 0x02");
  // 2-byte payload
  expectDataError(() => readBool(tuple([labelAtom("bool"), atom([0x00, 0x01])])), "bool 2-byte payload");
});

test("readText rejects wrong label and invalid UTF-8, accepts empty string", () => {
  // wrong label — a bool value
  expectDataError(() => readText(encodeBool(false)), "text wrong label (bool)");
  // invalid UTF-8 payload (0xff)
  const e = expectDataError(() => readText(tuple([labelAtom("utf8-text"), atom([0xff])])), "text invalid utf8");
  assert.equal(e.code, "invalid_utf8");
  // ACCEPTS the empty string
  assert.equal(readText(tuple([labelAtom("utf8-text"), atom([])])), "");
});

test("readList rejects bare/non-tuple/empty-tuple, accepts the empty list", () => {
  // bare tuple (two atoms, no "list" label) is NOT a list
  expectDataError(() => readList(tuple([atom([0x61]), atom([0x62])])), "list bare tuple");
  // non-tuple
  expectDataError(() => readList(atom([0x61])), "list non-tuple");
  // arity-0 empty Tuple (no label child)
  expectDataError(() => readList(tuple([])), "list empty tuple");
  // ACCEPTS the empty list Tuple(Atom("list")) -> []
  const empty = readList(tuple([labelAtom("list")]));
  assert.equal(empty.length, 0);
});

// --- positive round-trips beyond the vectors ----------------------------------

test("int round-trips across the range including a large value", () => {
  const cases: bigint[] = [
    0n,
    1n,
    -1n,
    255n,
    256n,
    -256n,
    65535n,
    // Large value well beyond i64 — int is unbounded (bigint).
    123456789012345678901234567890n,
    -(2n ** 200n),
  ];
  for (const n of cases) {
    const v = encodeInt(n);
    assert.equal(readInt(v), n, `int round-trip ${n}`);
    assert.ok(equals(encodeInt(readInt(v)), v), `int re-encode ${n}`);
  }
  // Spot-check the canonical zero payload: Tuple(Atom("int"), Atom(0x00)).
  assert.ok(equals(encodeInt(0n), tuple([labelAtom("int"), atom([0x00])])), "int zero canonical");
});

test("recognizeInt is structural: accepts > i128 magnitudes, rejects non-canonical forms", () => {
  const intLabel = labelAtom("int");
  // 2^128: sign 0x00, magnitude 0x01 then sixteen 0x00 (17 magnitude bytes).
  const twoPow128 = tuple([intLabel, atom([0x00, 0x01, ...new Array<number>(16).fill(0)])]);
  // Recognized structurally (no throw)...
  assert.doesNotThrow(() => recognizeInt(twoPow128), "recognizeInt accepts 2^128");
  // ...and this unbounded (bigint) binding also materializes it (Rust i128 would not).
  assert.equal(readInt(twoPow128), 2n ** 128n, "readInt materializes 2^128 on the bigint binding");

  // Non-canonical forms are rejected by recognizeInt exactly as by readInt (shared gate).
  const noncanonical: Value[] = [
    atom([0x00]), // not a tuple
    tuple([intLabel, atom([])]), // empty payload
    tuple([intLabel, atom([0x02, 0x01])]), // sign byte 0x02
    tuple([intLabel, atom([0x01])]), // negative zero
    tuple([intLabel, atom([0x00, 0x00, 0x01])]), // leading-zero magnitude
    encodeBool(true), // wrong label
  ];
  for (const v of noncanonical) {
    expectDataError(() => recognizeInt(v), `recognizeInt rejects ${v.toString()}`);
    expectDataError(() => readInt(v), `readInt rejects ${v.toString()}`);
  }
});

test("bool round-trips both values", () => {
  for (const b of [false, true]) {
    const v = encodeBool(b);
    assert.equal(readBool(v), b, `bool round-trip ${b}`);
    assert.ok(equals(encodeBool(readBool(v)), v), `bool re-encode ${b}`);
  }
});

test("text round-trips empty, ASCII, and non-ASCII strings", () => {
  const cases = ["", "hi", "hello, world", "héllo", "日本語", "emoji 😀 mix", "ZWJ‍seq"];
  for (const s of cases) {
    const v = encodeText(s);
    assert.equal(readText(v), s, `text round-trip ${JSON.stringify(s)}`);
    assert.ok(equals(encodeText(readText(v)), v), `text re-encode ${JSON.stringify(s)}`);
  }
});

test("list round-trips empty, heterogeneous, and nested lists", () => {
  // Heterogeneous: a bare atom (bytes), an int embedding, a text embedding.
  const hetero = encodeList([atom([0x61]), encodeInt(1n), encodeText("hi")]);
  const elems = readList(hetero);
  assert.equal(elems.length, 3);
  assert.ok(equals(encodeList(readList(hetero)), hetero), "list hetero re-encode");

  // Nested: a list whose elements are themselves lists.
  const nested = encodeList([encodeList([]), encodeList([atom([0x61])])]);
  const nestedElems = readList(nested);
  assert.equal(nestedElems.length, 2);
  assert.equal(readList(nestedElems[0]!).length, 0, "inner empty list");
  assert.equal(readList(nestedElems[1]!).length, 1, "inner singleton list");
  assert.ok(equals(encodeList(readList(nested)), nested), "list nested re-encode");

  // Empty list.
  const empty = encodeList([]);
  assert.equal(readList(empty).length, 0);
  assert.ok(equals(empty, tuple([labelAtom("list")])), "empty list canonical");

  // Order and multiplicity are identity: [a, a] != [a] and [a, b] != [b, a].
  const a = atom([0x61]);
  const b = atom([0x62]);
  assert.ok(!equals(encodeList([a, a]), encodeList([a])), "multiplicity is identity");
  assert.ok(!equals(encodeList([a, b]), encodeList([b, a])), "order is identity");
});

// --- map: recognition (negative) tests — authored, NOT in the vectors ---------

const mapLabel = (): Atom => labelAtom("map");

test("readMap rejects unsorted, duplicate, bad-arity, flat, and unlabeled forms", () => {
  // unsorted: encode(0x62) > encode(0x61), so 0x61 must come first
  expectDataError(
    () => readMap(tuple([mapLabel(), tuple([atom([0x62]), atom([0x00])]), tuple([atom([0x61]), atom([0x00])])])),
    "map unsorted",
  );
  // duplicate key 0x61 (equal adjacent key encodings)
  expectDataError(
    () => readMap(tuple([mapLabel(), tuple([atom([0x61]), atom([0x00])]), tuple([atom([0x61]), atom([0x01])])])),
    "map duplicate key",
  );
  // entry of arity 3 (want exactly 2)
  expectDataError(
    () => readMap(tuple([mapLabel(), tuple([atom([0x61]), atom([0x00]), atom([0x01])])])),
    "map entry arity 3",
  );
  // entry of arity 1 (want exactly 2)
  expectDataError(() => readMap(tuple([mapLabel(), tuple([atom([0x61])])])), "map entry arity 1");
  // flat: key,value children are not arity-2 entry tuples (a non-tuple child)
  expectDataError(() => readMap(tuple([mapLabel(), atom([0x61]), atom([0x00])])), "map flat interleaved");
  // unlabeled: first child is an entry tuple, not Atom("map")
  expectDataError(() => readMap(tuple([tuple([atom([0x61]), atom([0x00])])])), "map unlabeled");
  // arity-0 empty Tuple (no label child)
  expectDataError(() => readMap(tuple([])), "map empty tuple");
  // non-tuple
  expectDataError(() => readMap(atom([0x6d, 0x61, 0x70])), "map non-tuple");
  // cross-kind: a well-formed list value read as a map
  expectDataError(() => readMap(encodeList([atom([0x61])])), "map on list value");
});

test("encodeMap fails on duplicate keys (producer must resolve before calling)", () => {
  const e = expectDataError(
    () => encodeMap([
      [atom([0x61]), encodeInt(1n)],
      [atom([0x61]), encodeInt(2n)],
    ]),
    "encodeMap duplicate key",
  );
  assert.equal(e.code, "duplicate_key");
  // Duplicate detection is by key ENCODING, not object identity: a non-canonical
  // int and a canonical int with the same encoding would be distinct, but here two
  // structurally-equal keys must collide.
  expectDataError(
    () => encodeMap([
      [encodeInt(1n), encodeBool(true)],
      [encodeInt(1n), encodeBool(false)],
    ]),
    "encodeMap duplicate int key",
  );
});

// --- map: positive round-trips beyond the vectors -----------------------------

test("map round-trips empty, single, and several entries; sorts by codec key bytes", () => {
  // Empty map: Tuple(Atom("map")), arity 1, distinct from the empty list.
  const empty = encodeMap([]);
  assert.equal(readMap(empty).length, 0);
  assert.ok(equals(empty, tuple([mapLabel()])), "empty map canonical");
  assert.ok(!equals(empty, encodeList([])), "empty map != empty list");

  // Single entry.
  const single = encodeMap([[atom([0x6b]), encodeInt(7n)]]);
  const singleEntries = readMap(single);
  assert.equal(singleEntries.length, 1);
  assert.ok(equals(singleEntries[0]![0], atom([0x6b])), "single key");
  assert.ok(equals(singleEntries[0]![1], encodeInt(7n)), "single value");

  // Several heterogeneous keys handed to encodeMap OUT of order; encodeMap sorts
  // them by codec key bytes. Keys: bare atom 0x61, an int, a utf8-text — by codec
  // bytes 0x61 < int(1) < utf8-text("a") (matches map_mixed_keys ordering).
  const unsorted: Array<[Value, Value]> = [
    [encodeText("a"), encodeInt(256n)],
    [encodeInt(1n), encodeBool(false)],
    [atom([0x61]), encodeBool(true)],
  ];
  const m = encodeMap(unsorted);
  const entries = readMap(m);
  assert.equal(entries.length, 3);
  assert.ok(equals(entries[0]![0], atom([0x61])), "sorted key 0 is bare atom");
  assert.ok(equals(entries[1]![0], encodeInt(1n)), "sorted key 1 is int");
  assert.ok(equals(entries[2]![0], encodeText("a")), "sorted key 2 is text");
  assert.ok(equals(encodeMap(readMap(m)), m), "map several re-encode");
  // Reversing the input yields the identical canonical value (encodeMap sorts).
  assert.ok(equals(encodeMap([...unsorted].reverse()), m), "map reversed input -> same value");
});

test("map accepts a nested-map value, a map-as-key, and a non-canonical-int key", () => {
  // Nested map as a VALUE: { 0x6b: {} }.
  const nestedValue = encodeMap([[atom([0x6b]), encodeMap([])]]);
  const nv = readMap(nestedValue);
  assert.equal(nv.length, 1);
  assert.equal(readMap(nv[0]![1]).length, 0, "inner empty map value");
  assert.ok(equals(encodeMap(readMap(nestedValue)), nestedValue), "nested-value re-encode");

  // Map used as a KEY: { {0x61: int 1}: true }.
  const innerMap = encodeMap([[atom([0x61]), encodeInt(1n)]]);
  const mapKey = encodeMap([[innerMap, encodeBool(true)]]);
  const mk = readMap(mapKey);
  assert.equal(mk.length, 1);
  assert.ok(equals(mk[0]![0], innerMap), "map-as-key preserved");
  assert.equal(readMap(mk[0]![0]).length, 1, "inner map-key entries");

  // Non-canonical int as a key — ACCEPTED (no recursion into key canonicality).
  // int(000001) has a leading-zero magnitude (readInt would reject it), but it is a
  // perfectly good map KEY: a valid L0 value with a unique encoding.
  const noncanonicalIntKey = tuple([labelAtom("int"), atom([0x00, 0x00, 0x01])]);
  // Confirm it really is a non-canonical int (readInt rejects it).
  expectDataError(() => readInt(noncanonicalIntKey), "non-canonical int sanity");
  const m = encodeMap([[noncanonicalIntKey, atom([0x00])]]);
  const entries = readMap(m);
  assert.equal(entries.length, 1, "non-canonical int key accepted");
  assert.ok(equals(entries[0]![0], noncanonicalIntKey), "non-canonical int key preserved");
  assert.ok(equals(encodeMap(readMap(m)), m), "non-canonical-key re-encode");
});

// --- set: recognition (negative) tests — authored, NOT in the vectors ---------

const setLabel = (): Atom => labelAtom("set");

test("readSet rejects unsorted, duplicate, unlabeled, bare/empty-tuple, and cross-kind forms", () => {
  // unsorted: encode(0x62) > encode(0x61), so 0x61 must come first
  expectDataError(
    () => readSet(tuple([setLabel(), atom([0x62]), atom([0x61])])),
    "set unsorted",
  );
  // duplicate element 0x61 (equal adjacent encodings)
  expectDataError(
    () => readSet(tuple([setLabel(), atom([0x61]), atom([0x61])])),
    "set duplicate element",
  );
  // unlabeled: first child is an element, not Atom("set")
  expectDataError(() => readSet(tuple([atom([0x61]), atom([0x62])])), "set unlabeled");
  // arity-0 empty Tuple (no label child)
  expectDataError(() => readSet(tuple([])), "set empty tuple");
  // non-tuple: a bare atom (even the bytes of "set")
  expectDataError(() => readSet(atom([0x73, 0x65, 0x74])), "set non-tuple");
  // cross-kind: a well-formed list value read as a set
  expectDataError(() => readSet(encodeList([atom([0x61])])), "set on list value");
});

test("encodeSet fails on duplicate elements (producer must dedup before calling)", () => {
  const e = expectDataError(
    () => encodeSet([atom([0x61]), atom([0x61])]),
    "encodeSet duplicate element",
  );
  assert.equal(e.code, "duplicate_element");
  // Duplicate detection is by element ENCODING: two structurally-equal int elements
  // must collide.
  expectDataError(
    () => encodeSet([encodeInt(1n), encodeInt(1n)]),
    "encodeSet duplicate int element",
  );
});

// --- set: positive round-trips beyond the vectors -----------------------------

test("set round-trips empty, single, and several elements; sorts by codec bytes", () => {
  // Empty set: Tuple(Atom("set")), arity 1, distinct from empty list and empty map.
  const empty = encodeSet([]);
  assert.equal(readSet(empty).length, 0);
  assert.ok(equals(empty, tuple([setLabel()])), "empty set canonical");
  assert.ok(!equals(empty, encodeList([])), "empty set != empty list");
  assert.ok(!equals(empty, encodeMap([])), "empty set != empty map");

  // Single element.
  const single = encodeSet([encodeInt(7n)]);
  const singleElems = readSet(single);
  assert.equal(singleElems.length, 1);
  assert.ok(equals(singleElems[0]!, encodeInt(7n)), "single element");

  // Several heterogeneous elements handed to encodeSet OUT of order; encodeSet sorts
  // them by codec bytes. Elements: bare atom 0x61, an int, a utf8-text — by codec
  // bytes 0x61 < int(1) < utf8-text("a") (matches set_mixed ordering).
  const unsorted: Value[] = [encodeText("a"), encodeInt(1n), atom([0x61])];
  const s = encodeSet(unsorted);
  const elems = readSet(s);
  assert.equal(elems.length, 3);
  assert.ok(equals(elems[0]!, atom([0x61])), "sorted element 0 is bare atom");
  assert.ok(equals(elems[1]!, encodeInt(1n)), "sorted element 1 is int");
  assert.ok(equals(elems[2]!, encodeText("a")), "sorted element 2 is text");
  assert.ok(equals(encodeSet(readSet(s)), s), "set several re-encode");
  // Reversing the input yields the identical canonical value (encodeSet sorts).
  assert.ok(equals(encodeSet([...unsorted].reverse()), s), "set reversed input -> same value");
});

test("set accepts a nested set element and a non-canonical-int element", () => {
  // Nested set-of-sets: { {}, {0x61} } (matches set_nested).
  const nested = encodeSet([encodeSet([]), encodeSet([atom([0x61])])]);
  const ne = readSet(nested);
  assert.equal(ne.length, 2);
  assert.equal(readSet(ne[0]!).length, 0, "inner empty set element");
  assert.equal(readSet(ne[1]!).length, 1, "inner singleton set element");
  assert.ok(equals(encodeSet(readSet(nested)), nested), "nested set re-encode");

  // Non-canonical int as an element — ACCEPTED (no recursion into element canonicality).
  // int(000001) has a leading-zero magnitude (readInt would reject it), but it is a
  // perfectly good set ELEMENT: a valid L0 value with a unique encoding.
  const noncanonicalIntElem = tuple([labelAtom("int"), atom([0x00, 0x00, 0x01])]);
  // Confirm it really is a non-canonical int (readInt rejects it).
  expectDataError(() => readInt(noncanonicalIntElem), "non-canonical int sanity");
  const m = encodeSet([noncanonicalIntElem]);
  const elements = readSet(m);
  assert.equal(elements.length, 1, "non-canonical int element accepted");
  assert.ok(equals(elements[0]!, noncanonicalIntElem), "non-canonical int element preserved");
  assert.ok(equals(encodeSet(readSet(m)), m), "non-canonical-element re-encode");
});

test("LABELS is the registered label set in the actual recognized order", () => {
  // LABELS is the single source of the registered label set and its order (§5).
  assert.deepEqual(
    [...LABELS],
    ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"],
    "LABELS order drifted from the v1 set",
  );

  // recognizes(label, v): the matching recognizer succeeds on v (no throw) — `int`
  // via recognizeInt, the rest via read<Kind>, matching the CLI's per-kind dispatch.
  const recognizes = (label: string, v: Value): boolean => {
    try {
      switch (label) {
        case "int":
          recognizeInt(v);
          break;
        case "utf8-text":
          readText(v);
          break;
        case "bool":
          readBool(v);
          break;
        case "list":
          readList(v);
          break;
        case "map":
          readMap(v);
          break;
        case "set":
          readSet(v);
          break;
        case "decimal":
          recognizeDecimal(v);
          break;
        case "null":
          recognizeNull(v);
          break;
        default:
          throw new Error(`no recognizer for label ${label}`);
      }
      return true;
    } catch (e) {
      if (e instanceof DataError) return false;
      throw e;
    }
  };

  // One canonical embedding per kind, in LABELS order; each must be recognized by
  // exactly its own label's recognizer, so LABELS truly is the recognized order.
  const samples: Value[] = [
    encodeInt(1n),
    encodeText("x"),
    encodeBool(true),
    encodeList([]),
    encodeMap([]),
    encodeSet([]),
    encodeDecimal(1n, 0n),
    encodeNull(),
  ];
  LABELS.forEach((label, i) => {
    assert.ok(
      recognizes(label, samples[i]!),
      `LABELS[${i}] = "${label}": its canonical embedding is not recognized by read<${label}>`,
    );
  });
});
