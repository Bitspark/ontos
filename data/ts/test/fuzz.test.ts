/*
 * Property / fuzz tests for the ontos-data (L2) recognizers. They consume
 * already-decoded L0 Value trees that may be adversarial (a peer can hand a consumer
 * any well-formed L0 value), so the headline invariant is that recognition NEVER
 * throws anything but a typed DataError. Dependency-free per the repo ethos — no
 * fast-check / proptest; randomness comes from the same hand-rolled deterministic
 * PRNG the codec fuzz uses, so every run is reproducible and CI never flakes.
 *
 * Five properties (the L2 analogue of the codec's P1/P2/P3):
 *   D1  recognition NEVER throws a non-DataError — every read<Kind>/recognizeInt
 *       returns its datum or throws DataError. Any other throw (RangeError,
 *       TypeError, unwrap-style failure) fails the test.
 *   D2  READ IS CANONICAL — recognition accepts only the canonical form, so if
 *       read<Kind>(v) returns, encode<Kind>(read<Kind>(v)) reproduces v exactly.
 *   D3  ROUND-TRIP on produced data — read<Kind>(encode<Kind>(datum)) === datum.
 *   D4  RECOGNIZE/READ AGREEMENT (ontos-internal#67/#77) — recognizeInt(v) succeeds iff
 *       readInt(v) succeeds. (TS's bigint binding is unbounded, so there is no
 *       resource-limit case; the distinction is load-bearing for Rust's i128.)
 *   D5  AT MOST ONE KIND — the eight labels are disjoint, so a value is a well-formed
 *       embedding of at most one kind.
 *
 * Auto-discovered by the ts CI glob (data/ts/test/*.test.ts). rs/ts stop at these
 * fixed-iteration property tests; Go adds a coverage-guided native FuzzData on top
 * (see .github/workflows/fuzz.yml), exactly as the codec layer is structured.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encode as codecEncode, decode } from "@bitspark/ontos-codec";
import {
  DataError,
  encodeInt,
  readInt,
  recognizeInt,
  encodeText,
  readText,
  encodeBool,
  readBool,
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

// --- deterministic PRNG: xorshift64* over a u64 in BigInt (matches codec fuzz) ----

class Rng {
  #state: bigint;
  static readonly #MASK = (1n << 64n) - 1n;

  constructor(seed: bigint) {
    this.#state = (seed ^ 0x9e3779b97f4a7c15n) & Rng.#MASK || 0x9e3779b97f4a7c15n;
  }

  #nextU64(): bigint {
    let x = this.#state;
    x ^= (x >> 12n) & Rng.#MASK;
    x ^= (x << 25n) & Rng.#MASK;
    x ^= (x >> 27n) & Rng.#MASK;
    this.#state = x & Rng.#MASK;
    return (this.#state * 0x2545f4914f6cdd1dn) & Rng.#MASK;
  }

  nextU32(): number {
    return Number(this.#nextU64() >> 32n);
  }

  /** Integer in [0, n). n must be a positive safe integer. */
  range(n: number): number {
    return this.nextU32() % n;
  }

  byte(): number {
    return this.nextU32() & 0xff;
  }

  bool(): boolean {
    return (this.nextU32() & 1) === 1;
  }
}

// --- generators (embedding-biased) --------------------------------------------

const utf8 = new TextEncoder();
const LABELS = ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"] as const;

function randomLabel(rng: Rng): Uint8Array {
  // 75% a real registered label, 25% a random short atom (mislabeled/bare compound).
  if (rng.range(4) !== 0) {
    return utf8.encode(LABELS[rng.range(LABELS.length)]!);
  }
  const len = rng.range(5);
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = rng.byte();
  return b;
}

function randomAtomBytes(rng: Rng): Uint8Array {
  const len = rng.range(10);
  const small = rng.bool();
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = small ? rng.byte() & 0x03 : rng.byte();
  return b;
}

// An embedding-biased Value: tuples are frequently label-headed and their tails mix
// plain values with arity-2 entry tuples, so read<Map>'s entry/sort/dup paths and
// readInt's sign/magnitude paths are actually reached.
function randomValue(rng: Rng, depth: number): Value {
  if (depth <= 0 || rng.range(5) < 2) {
    return atom(randomAtomBytes(rng));
  }
  const labeled = rng.range(4) !== 0; // 75% labeled compounds
  const arity = rng.range(5); // 0..4 tail children
  const items: Value[] = [];
  if (labeled) items.push(atom(randomLabel(rng)));
  for (let i = 0; i < arity; i += 1) {
    if (rng.bool()) {
      items.push(tuple([randomValue(rng, depth - 1), randomValue(rng, depth - 1)]));
    } else {
      items.push(randomValue(rng, depth - 1));
    }
  }
  return items.length === 0 ? tuple() : tuple(items);
}

const ALPHABET = ["a", "Z", "0", " ", "_", "\n", "é", "ß", "日", "😀"];

function randomString(rng: Rng): string {
  const len = rng.range(12);
  let s = "";
  for (let i = 0; i < len; i += 1) s += ALPHABET[rng.range(ALPHABET.length)];
  return s;
}

// A signed bigint with a 0..19-byte magnitude — deliberately spanning beyond i128 so
// the unbounded TS binding's wide path is exercised (values Rust's i128 resource-limits).
function randomBigInt(rng: Rng): bigint {
  const n = rng.range(20);
  let mag = 0n;
  for (let i = 0; i < n; i += 1) mag = (mag << 8n) | BigInt(rng.byte());
  return rng.bool() && mag !== 0n ? -mag : mag;
}

// n pairwise-distinct single-byte atoms, so encodeMap/encodeSet never hit a duplicate.
function distinctAtoms(n: number): Value[] {
  return Array.from({ length: n }, (_unused, i) => atom(Uint8Array.of(i)));
}

// A guaranteed-canonical embedding of a random kind (keeps D2/D4 non-vacuous).
function validEmbedding(rng: Rng): Value {
  switch (rng.range(8)) {
    case 0:
      return encodeInt(randomBigInt(rng));
    case 1:
      return encodeText(randomString(rng));
    case 2:
      return encodeBool(rng.bool());
    case 3: {
      const arity = rng.range(5);
      const elems = Array.from({ length: arity }, () => randomValue(rng, 2));
      return encodeList(elems);
    }
    case 4: {
      const arity = rng.range(5);
      const keys = distinctAtoms(arity);
      const entries = keys.map((k) => [k, randomValue(rng, 2)] as [Value, Value]);
      return encodeMap(entries);
    }
    case 5:
      return encodeSet(distinctAtoms(rng.range(5)));
    case 6:
      // decimal: random (possibly > i128) mantissa, small exponent. TS's unbounded
      // bigint materializes a wide mantissa — the path Rust resource-limits (§5.9).
      return encodeDecimal(randomBigInt(rng), BigInt(rng.range(41) - 20));
    default:
      // null: the single inhabitant Tuple(Atom("null")) (§5.10).
      return encodeNull();
  }
}

// --- shared checker: D1, D2, D4, D5 -------------------------------------------

// Run `fn`; on throw, assert it is a DataError (D1) and report a miss.
function attempt<T>(fn: () => T, label: string, vDesc: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    assert.ok(
      e instanceof DataError,
      `D1: ${label} threw a non-DataError on ${vDesc}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
    return { ok: false };
  }
}

function checkRecognizers(v: Value): number {
  const vDesc = v.toString();
  let matched = 0;

  // int — D2 and D4 (TS unbounded: recognizeInt succeeds iff readInt succeeds).
  const ri = attempt(() => readInt(v), "readInt", vDesc);
  if (ri.ok) {
    assert.ok(equals(encodeInt(ri.value), v), `D2: encodeInt(readInt(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  const rec = attempt(() => recognizeInt(v), "recognizeInt", vDesc);
  assert.equal(rec.ok, ri.ok, `D4: recognizeInt disagrees with readInt for ${vDesc}`);

  const rt = attempt(() => readText(v), "readText", vDesc);
  if (rt.ok) {
    assert.ok(equals(encodeText(rt.value), v), `D2: encodeText(readText(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  const rb = attempt(() => readBool(v), "readBool", vDesc);
  if (rb.ok) {
    assert.ok(equals(encodeBool(rb.value), v), `D2: encodeBool(readBool(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  const rl = attempt(() => readList(v), "readList", vDesc);
  if (rl.ok) {
    assert.ok(equals(encodeList(rl.value), v), `D2: encodeList(readList(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  // map/set: read only succeeds on strictly-ascending, dup-free children, so
  // re-encoding cannot hit the duplicate precondition (a throw here is a real defect).
  const rm = attempt(() => readMap(v), "readMap", vDesc);
  if (rm.ok) {
    assert.ok(equals(encodeMap(rm.value), v), `D2: encodeMap(readMap(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  const rs = attempt(() => readSet(v), "readSet", vDesc);
  if (rs.ok) {
    assert.ok(equals(encodeSet(rs.value), v), `D2: encodeSet(readSet(v)) !== v for ${vDesc}`);
    matched += 1;
  }
  // decimal — D2 and D4 (TS unbounded: recognizeDecimal succeeds iff readDecimal does).
  const rd = attempt(() => readDecimal(v), "readDecimal", vDesc);
  if (rd.ok) {
    assert.ok(
      equals(encodeDecimal(rd.value.mantissa, rd.value.exponent), v),
      `D2: encodeDecimal(readDecimal(v)) !== v for ${vDesc}`,
    );
    matched += 1;
  }
  const recDec = attempt(() => recognizeDecimal(v), "recognizeDecimal", vDesc);
  assert.equal(recDec.ok, rd.ok, `D4: recognizeDecimal disagrees with readDecimal for ${vDesc}`);
  // null — D2 (encodeNull() === v) and D4 (recognize iff read). null carries no payload,
  // so recognize and read coincide; a recognized null re-encodes to the single inhabitant.
  const rn = attempt(() => readNull(v), "readNull", vDesc);
  if (rn.ok) {
    assert.ok(equals(encodeNull(), v), `D2: encodeNull() !== v for ${vDesc}`);
    matched += 1;
  }
  const recNull = attempt(() => recognizeNull(v), "recognizeNull", vDesc);
  assert.equal(recNull.ok, rn.ok, `D4: recognizeNull disagrees with readNull for ${vDesc}`);

  assert.ok(matched <= 1, `D5: value recognized as ${matched} kinds (labels must be disjoint): ${vDesc}`);
  return matched;
}

// =============================================================================

test("D1/D2/D4/D5: recognizers never throw non-DataError + reads are canonical", () => {
  const rng = new Rng(0xda7af0225eed0001n);
  const ITERATIONS = 20_000;
  let recognized = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    // Alternate a guaranteed-canonical embedding (keeps D2/D4 non-vacuous) with an
    // arbitrary embedding-biased tree (breadth — mostly not-recognized).
    const v = i % 2 === 0 ? validEmbedding(rng) : randomValue(rng, 4);
    recognized += checkRecognizers(v);
  }

  assert.ok(recognized > 0, "expected some values recognized (D2/D4 would be vacuous)");
  console.log(`D1/D2/D4/D5: ${ITERATIONS} values, ${recognized} recognized`);
});

test("D1: recognizers total on values decoded from arbitrary bytes", () => {
  const rng = new Rng(0xda7af0225eed0002n);
  const ITERATIONS = 20_000;
  const MAX_LEN = 48;
  let decoded = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    let bytes: Uint8Array;
    if (i % 2 === 0) {
      // Encoded random value — always decodes, guaranteeing the sweep runs.
      bytes = codecEncode(randomValue(rng, 4));
    } else {
      // Small-alphabet bytes — decode often enough to exercise the recognizers.
      const len = rng.range(MAX_LEN + 1);
      bytes = new Uint8Array(len);
      for (let j = 0; j < len; j += 1) bytes[j] = rng.byte() & 0x07;
    }
    let v: Value;
    try {
      v = decode(bytes);
    } catch {
      continue; // decode failure is the codec's own concern (codec fuzz covers it)
    }
    decoded += 1;
    checkRecognizers(v);
  }
  assert.ok(decoded > 0, "expected some buffers to decode (recognizer sweep was vacuous)");
  console.log(`D1: swept recognizers over ${decoded} decoded values`);
});

test("D3: produced data round-trips for every kind", () => {
  const rng = new Rng(0xda7af0225eed0003n);
  const ITERATIONS = 8_000;

  for (let i = 0; i < ITERATIONS; i += 1) {
    // int (including >i128 magnitudes — TS materializes them)
    const n = randomBigInt(rng);
    assert.equal(readInt(encodeInt(n)), n, "D3 int");

    // utf8-text
    const s = randomString(rng);
    assert.equal(readText(encodeText(s)), s, "D3 text");

    // bool
    const b = rng.bool();
    assert.equal(readBool(encodeBool(b)), b, "D3 bool");

    // list
    const elems = Array.from({ length: rng.range(5) }, () => randomValue(rng, 2));
    const lv = encodeList(elems);
    assert.equal(readList(lv).length, elems.length, "D3 list arity");
    assert.ok(equals(encodeList(readList(lv)), lv), "D3 list re-encode");

    // map (distinct keys; compare via the canonical value)
    const keys = distinctAtoms(rng.range(5));
    const entries = keys.map((k) => [k, randomValue(rng, 2)] as [Value, Value]);
    const mv = encodeMap(entries);
    assert.ok(equals(encodeMap(readMap(mv)), mv), "D3 map");

    // set (distinct elements)
    const sv = encodeSet(distinctAtoms(rng.range(5)));
    assert.ok(equals(encodeSet(readSet(sv)), sv), "D3 set");

    // decimal (read returns the producer-normalized pair; compare via the canonical value)
    const dv = encodeDecimal(randomBigInt(rng), BigInt(rng.range(41) - 20));
    const rd = readDecimal(dv);
    assert.ok(equals(encodeDecimal(rd.mantissa, rd.exponent), dv), "D3 decimal");

    // null (the single inhabitant round-trips to itself)
    const nv = encodeNull();
    readNull(nv);
    assert.ok(equals(encodeNull(), nv), "D3 null");
  }
  console.log(`D3: ${ITERATIONS} round-trip iterations across all eight kinds`);
});
