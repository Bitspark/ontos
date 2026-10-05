/*
 * Property / fuzz tests for ontos-codec-v1 (security-critical: decode() consumes
 * untrusted bytes). Dependency-free per the repo ethos — no fast-check / proptest;
 * randomness comes from a small hand-rolled deterministic PRNG seeded from a
 * constant, so every run is reproducible and CI never flakes.
 *
 * Properties enforced:
 *   P1  decode() NEVER panics on arbitrary input — it either returns a Value or
 *       throws DecodeError. ANY other throw (RangeError, TypeError, index/overflow
 *       blowup, unwrap-style failure) fails the test.
 *   P2  CANONICAL IDEMPOTENCE — the codec accepts only canonical bytes, so if
 *       decode(b) succeeds then encode(decode(b)) must reproduce b exactly.
 *   P3  ROUND-TRIP — for randomly generated Value trees, decode(encode(v)) == v.
 *
 * Auto-discovered by the ts CI glob (codec/ts/test/*.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { decode, encode, DecodeError } from "../src/index.ts";

// --- helpers (match the vectors.test.ts authoring style) ----------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function valueFromJson(j: any): Value {
  if (typeof j.atom === "string") return atom(hexToBytes(j.atom));
  if (Array.isArray(j.tuple)) return tuple(j.tuple.map(valueFromJson));
  throw new Error(`value must be {atom} or {tuple}: ${JSON.stringify(j)}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

function readVectors(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

// --- deterministic PRNG -------------------------------------------------------
// xorshift64* over a u64 kept in BigInt. Seeded from a fixed constant so the
// whole suite is reproducible. nextU32 / range derive bounded ints from it.

class Rng {
  #state: bigint;
  static readonly #MASK = (1n << 64n) - 1n;

  constructor(seed: bigint) {
    // Avoid the all-zero fixed point of xorshift.
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

  /** Uniform-ish 32-bit value as a JS number. */
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
}

// --- random generators --------------------------------------------------------

function randomBytes(rng: Rng, maxLen: number): Uint8Array {
  const len = rng.range(maxLen + 1); // [0, maxLen]
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = rng.byte();
  return out;
}

// Bounded random Value: atoms of random bytes, tuples of small random arity,
// depth-limited so generation always terminates and stays cheap.
function randomValue(rng: Rng, depth: number): Value {
  // Force a leaf at the depth floor; otherwise ~40% tuples to get real nesting.
  const makeTuple = depth > 0 && rng.range(5) < 2;
  if (!makeTuple) {
    return atom(randomBytes(rng, 8));
  }
  const arity = rng.range(5); // [0, 4]
  const items: Value[] = [];
  for (let i = 0; i < arity; i += 1) items.push(randomValue(rng, depth - 1));
  return items.length === 0 ? tuple() : tuple(items);
}

// A single arbitrary buffer for the P1/P2 fuzz, drawn from one of three sources
// so the corpus stresses both decode arms (accept AND reject) hard:
//   - pure random bytes: the real "untrusted garbage" fuzz (almost always rejected)
//   - a freshly encoded valid value: guaranteed-canonical, exercises the P2 arm
//   - a valid encoding with bytes flipped/inserted/dropped: near-miss canonical
//     input that aggressively probes the accept/reject boundary
function arbitraryBuffer(rng: Rng, maxLen: number): Uint8Array {
  const pick = rng.range(3);
  if (pick === 0) {
    return randomBytes(rng, maxLen);
  }
  const valid = encode(randomValue(rng, 4));
  if (pick === 1) {
    return valid;
  }
  // pick === 2: mutate the valid encoding.
  const buf = Array.from(valid);
  const edits = 1 + rng.range(3);
  for (let e = 0; e < edits; e += 1) {
    const op = rng.range(3);
    if (op === 0 && buf.length > 0) {
      buf[rng.range(buf.length)] = rng.byte(); // flip a byte
    } else if (op === 1) {
      buf.splice(rng.range(buf.length + 1), 0, rng.byte()); // insert
    } else if (buf.length > 0) {
      buf.splice(rng.range(buf.length), 1); // drop
    }
  }
  return Uint8Array.from(buf.slice(0, maxLen));
}

// =============================================================================

test("P1/P2: decode never panics + canonical idempotence on arbitrary bytes", () => {
  const rng = new Rng(0xc0dec0ffeen);
  const ITERATIONS = 50_000;
  const MAX_LEN = 64;

  let decoded = 0;
  let rejected = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const bytes = arbitraryBuffer(rng, MAX_LEN);
    const inputHex = bytesToHex(bytes);

    let value: Value | undefined;
    try {
      value = decode(bytes);
    } catch (e) {
      // P1: the ONLY tolerated failure on untrusted input is a typed DecodeError.
      assert.ok(
        e instanceof DecodeError,
        `decode() threw a non-DecodeError on input ${inputHex}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
      rejected += 1;
      continue;
    }

    // P2: a successful decode means the bytes were canonical, so re-encoding the
    // decoded value must reproduce the exact input.
    decoded += 1;
    assert.equal(
      bytesToHex(encode(value)),
      inputHex,
      `canonical idempotence failed: encode(decode(${inputHex})) drifted`,
    );
  }

  // Sanity: the corpus must actually exercise both arms (not all-reject / all-accept),
  // otherwise the properties above would be vacuously satisfied.
  assert.ok(decoded > 0, "expected some random buffers to decode successfully");
  assert.ok(rejected > 0, "expected some random buffers to be rejected");
  // Surfaced in `node --test` output for the reported counts.
  console.log(`P1/P2: ${ITERATIONS} buffers (len 0..${MAX_LEN}) — ${decoded} decoded, ${rejected} rejected`);
});

test("P2: canonical idempotence holds on the conformance encode vectors", () => {
  // Seed P2 with the pinned canonical encodings: decode then re-encode must be
  // an exact byte-for-byte fixpoint. Covers codec.json + data.json embeddings.
  let seeded = 0;
  for (const file of ["codec.json", "data.json"] as const) {
    const doc = readVectors(file);
    for (const c of doc.encode ?? []) {
      const bytes = hexToBytes(c.hex);
      const value = decode(bytes); // canonical by construction; must not throw
      assert.equal(bytesToHex(encode(value)), c.hex, `idempotence on ${file}:${c.name}`);
      seeded += 1;
    }
  }
  assert.ok(seeded > 0, "expected conformance encode vectors to seed P2");
  console.log(`P2(seed): ${seeded} conformance vectors are encode/decode fixpoints`);
});

test("P3: encode/decode round-trips on random valid Value trees", () => {
  const rng = new Rng(0x5eed1dea5n);
  const ITERATIONS = 20_000;
  const MAX_DEPTH = 5;

  let atoms = 0;
  let tuples = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const value = randomValue(rng, MAX_DEPTH);
    if (value.kind === "atom") atoms += 1;
    else tuples += 1;

    const bytes = encode(value);
    let back: Value;
    try {
      back = decode(bytes);
    } catch (e) {
      assert.fail(
        `decode(encode(v)) threw on a valid value (${value.toString()}): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
    }
    assert.ok(equals(back, value), `round-trip mismatch for ${value.toString()}`);
    // encode is deterministic — re-encoding the decoded tree reproduces the bytes.
    assert.equal(bytesToHex(encode(back)), bytesToHex(bytes), `re-encode drift for ${value.toString()}`);
  }

  assert.ok(atoms > 0 && tuples > 0, "expected the corpus to mix atoms and tuples");
  console.log(`P3: ${ITERATIONS} random values (depth<=${MAX_DEPTH}) — ${atoms} atom-rooted, ${tuples} tuple-rooted`);
});
