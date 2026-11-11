/*
 * Operational limit reporting (ontos-codec.md §4.2, ontos-internal#352): every decoder-produced
 * limit_exceeded names the bound that stopped it in `limitKind`. Replays
 * vectors/codec-limits.json and pins TS's native-width ceiling (2^53 - 1).
 *
 * The "limit policy" tests replay the generated corpus vectors/codec-limits.generated.json
 * (Bitspark/ontos#13, docs/design/0009): its agreement-zone differential cases, and its
 * values for the metamorphic relation. ONTOS_LIMIT_POLICY_CORPUS names another corpus from
 * tools/limit-policy/gen.mjs instead, which is how `scripts/check.sh fuzz` replays a fresh seed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Atom, type Value } from "@bitspark/ontos-core";
import { decode, encode, DecodeError, DecodeLimitKind, type DecodeOptions } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

function readVectors(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The DecodeError that decoding `bytes` under `options` throws. */
function decodeError(bytes: Uint8Array, options: DecodeOptions = {}): DecodeError {
  try {
    decode(bytes, options);
  } catch (err) {
    assert.ok(err instanceof DecodeError, `not a DecodeError: ${String(err)}`);
    return err;
  }
  assert.fail("expected decode to throw");
}

/** An atom tag followed by a declared byte length and no bytes. */
function atomOfLength(length: bigint): Uint8Array {
  const out = [0x00];
  let n = length;
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    out.push(byte);
  } while (n !== 0n);
  return Uint8Array.from(out);
}

type Expect = "accept" | { code: string; limitKind: string };

/** A case's limits, refusing a key that names no bound. */
function limitsOf(name: string, limits: Record<string, number>): DecodeOptions {
  for (const key of Object.keys(limits)) {
    assert.ok(["maxDepth", "maxAtomBytes", "maxTupleArity"].includes(key), `${name}: unknown limit ${key}`);
  }
  return limits;
}

/**
 * Decodes `bytes` under `limits` and requires `expect`: acceptance of a value that
 * re-encodes to the same bytes, or a DecodeError with exactly the expected code and kind.
 * Anything else (another error, a missing kind, a different datum) fails. Returns the
 * outcome's label, "accept" or the kind.
 */
function judge(name: string, bytes: Uint8Array, limits: DecodeOptions, expect: Expect): string {
  if (expect === "accept") {
    let value: Value;
    try {
      value = decode(bytes, limits);
    } catch (err) {
      assert.fail(`${name}: expected accept, got ${String(err)}`);
    }
    assert.deepEqual(encode(value), bytes, `${name}: accepted a different datum`);
    return "accept";
  }
  let err: unknown;
  try {
    decode(bytes, limits);
  } catch (caught) {
    err = caught;
  }
  assert.ok(err instanceof DecodeError, `${name}: expected ${expect.limitKind}, got ${err === undefined ? "accept" : String(err)}`);
  assert.deepEqual([err.code, err.limitKind], [expect.code, expect.limitKind], name);
  return expect.limitKind;
}

test("codec-limits.json: every case accepts or names its bound", () => {
  const doc = readVectors("codec-limits.json");
  assert.ok(doc.cases.length > 0);
  for (const c of doc.cases) judge(c.name, hexToBytes(c.hex), limitsOf(c.name, c.limits), c.expect);
});

// ----- the generated limit-policy tests (Bitspark/ontos#13) -----

const BOUNDS = [
  { key: "maxDepth", need: "depth", kind: DecodeLimitKind.DecodeDepth },
  { key: "maxAtomBytes", need: "atom", kind: DecodeLimitKind.AtomBytes },
  { key: "maxTupleArity", need: "arity", kind: DecodeLimitKind.TupleArity },
] as const;

type Needs = { depth: number; atom: number; arity: number };

function readPolicyCorpus(): { path: string; doc: any } {
  const path = process.env.ONTOS_LIMIT_POLICY_CORPUS || join(vectorsDir, "codec-limits.generated.json");
  return { path, doc: JSON.parse(readFileSync(path, "utf8")) };
}

/** A tally with every outcome at zero, so an outcome never seen still shows. */
function tally(): Map<string, number> {
  return new Map([["accept", 0], ...BOUNDS.map((b): [string, number] => [b.kind, 0])]);
}

const show = (t: Map<string, number>) => [...t].map(([k, n]) => `${k} ${n}`).join(", ");

/** What a decoded value needs from each bound, walked with an explicit stack. */
function needsOf(value: Value): Needs {
  const needs = { depth: 0, atom: 0, arity: 0 };
  const stack: [Value, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    needs.depth = Math.max(needs.depth, depth);
    if (v instanceof Atom) {
      needs.atom = Math.max(needs.atom, v.length);
    } else {
      const items = v.items();
      needs.arity = Math.max(needs.arity, items.length);
      for (const item of items) stack.push([item, depth + 1]);
    }
  }
  return needs;
}

test("limit policy: differential, every agreement-zone case produces its one expectation", (t) => {
  const { path, doc } = readPolicyCorpus();
  const cases = doc.differential;
  assert.equal(cases.length, doc.counts.differential, "the corpus's differential count");
  const seen = tally();
  for (const c of cases) {
    const outcome = judge(c.name, hexToBytes(c.hex), limitsOf(c.name, c.limits), c.expect);
    seen.set(outcome, seen.get(outcome)! + 1);
  }
  for (const [outcome, n] of seen) assert.ok(n > 0, `no differential case expects ${outcome}`);
  t.diagnostic(`ts differential: ${cases.length} cases judged (${show(seen)}); ${path} seed ${doc.seed}`);
});

test("limit policy: metamorphic, one bound lowered below an accepted value's need names that bound", (t) => {
  const { path, doc } = readPolicyCorpus();
  const values = doc.metamorphic;
  assert.equal(values.length, doc.counts.metamorphic, "the corpus's metamorphic count");
  const seen = tally();
  for (const v of values) {
    const bytes = hexToBytes(v.hex);
    // The precondition, observed here rather than assumed: the shipped defaults accept it.
    judge(`${v.name} under the defaults`, bytes, {}, "accept");
    seen.set("accept", seen.get("accept")! + 1);
    const needs = needsOf(decode(bytes));
    const tight: DecodeOptions = { maxDepth: needs.depth, maxAtomBytes: needs.atom, maxTupleArity: needs.arity };
    judge(`${v.name} at its needs`, bytes, tight, "accept");
    seen.set("accept", seen.get("accept")! + 1);
    for (const b of BOUNDS) {
      const need = needs[b.need];
      if (need === 0) continue; // nothing to lower below
      for (const lowered of new Set([need - 1, 0])) {
        for (const [label, base] of [["defaults", {}], ["needs", tight]] as const) {
          const limits = { ...base, [b.key]: lowered };
          const expect = { code: "limit_exceeded", limitKind: b.kind };
          judge(`${v.name}: ${b.key}=${lowered} < ${need}, others at ${label}`, bytes, limits, expect);
          seen.set(b.kind, seen.get(b.kind)! + 1);
        }
      }
    }
  }
  for (const [outcome, n] of seen) assert.ok(n > 0, `the metamorphic relation never produced ${outcome}`);
  const decodes = [...seen.values()].reduce((a, n) => a + n, 0);
  t.diagnostic(`ts metamorphic: ${values.length} values, ${decodes} decodes judged (${show(seen)}); ${path} seed ${doc.seed}`);
});

test("byte-contract rejects carry no limit kind, not even an undefined property", () => {
  for (const c of readVectors("codec.json").reject) {
    const err = decodeError(hexToBytes(c.hex));
    assert.equal(err.limitKind, undefined, c.name);
    assert.ok(!Object.hasOwn(err, "limitKind"), `${c.name}: limitKind present as an own property`);
  }
});

test("native width: a length past Number.MAX_SAFE_INTEGER is native_width; the ceiling itself is truncation", () => {
  const past = decodeError(atomOfLength(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
  assert.deepEqual([past.code, past.limitKind], ["limit_exceeded", DecodeLimitKind.NativeWidth]);
  const at = decodeError(atomOfLength(BigInt(Number.MAX_SAFE_INTEGER)));
  assert.deepEqual([at.code, at.limitKind], ["unexpected_eof", undefined]);
});

test("the worked collision of §4.2: with an atom bound of 10, a 2^60-byte atom is native_width in TS", () => {
  // go, rs (64-bit) and py report atom_bytes for the same input and options: TS's width
  // check runs inside the uvarint read, before the atom bound is compared.
  const err = decodeError(atomOfLength(1n << 60n), { maxAtomBytes: 10 });
  assert.deepEqual([err.code, err.limitKind], ["limit_exceeded", DecodeLimitKind.NativeWidth]);
});

test("compatibility: the two-argument constructor, instanceof, and the parent code are unchanged", () => {
  const built = new DecodeError("limit_exceeded", "from a caller");
  assert.ok(built instanceof DecodeError && built instanceof Error);
  assert.equal(built.code, "limit_exceeded");
  assert.equal(built.message, "from a caller");
  assert.equal(built.limitKind, undefined);

  const err = decodeError(hexToBytes("01010000"), { maxDepth: 0 });
  assert.equal(err.code, "limit_exceeded");
  assert.equal(err.message, "maximum decode depth exceeded: 0");
  assert.equal(err.limitKind, "decode_depth");
});

test("an unrecognized kind is still a limit_exceeded DecodeError", () => {
  const later = new DecodeError("limit_exceeded", "from a later version", "from_a_later_version");
  assert.equal(later.code, "limit_exceeded");
  const known: readonly string[] = Object.values(DecodeLimitKind);
  assert.ok(!known.includes(later.limitKind ?? ""), "a later kind is not one of today's");
});
