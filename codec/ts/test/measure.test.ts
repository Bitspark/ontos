/*
 * measure (ontos-codec.md §10, design record 0008): replays vectors/codec-measure.json with
 * real sharing, and checks what the vectors cannot state: a doubling chain far past k = 64, a
 * value deeper than the JS call stack, and the bounds a caller may pass.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atom, tuple, type Value } from "@bitspark/ontos-core";
import { encode, measure, MeasureError, MeasureKind, type MeasureBounds } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

const MAX = Number.MAX_SAFE_INTEGER;
const UNBOUNDED: MeasureBounds = { maxEncodedBytes: MAX, maxOccurrences: MAX, maxHeight: MAX };

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** One object per table entry, so an index named twice is one shared tuple or atom. */
function build(table: { nodes: ({ atom: string } | { tuple: number[] })[]; root: number }): Value {
  const built: Value[] = [];
  table.nodes.forEach((node, i) => {
    if ("atom" in node) {
      built.push(atom(hexToBytes(node.atom)));
    } else {
      for (const ref of node.tuple) assert.ok(Number.isInteger(ref) && ref >= 0 && ref < i, `node ${i} names ${ref}`);
      built.push(tuple(node.tuple.map((ref) => built[ref]!)));
    }
  });
  return built[table.root]!;
}

/** The identifiers that `measure` throws as exceeded, or fails. */
function exceeded(value: Value, bounds: MeasureBounds): readonly string[] {
  try {
    measure(value, bounds);
  } catch (err) {
    assert.ok(err instanceof MeasureError, `not a MeasureError: ${String(err)}`);
    return err.exceeded;
  }
  assert.fail("expected measure to be over limit");
}

/** x0 = Atom(00), xk = Tuple(x(k-1), x(k-1)), as k + 1 objects. */
function doublingChain(k: number): Value {
  let v: Value = atom(Uint8Array.of(0x00));
  for (let i = 0; i < k; i += 1) v = tuple([v, v]);
  return v;
}

test("codec-measure.json: every case gives its measures or names what it exceeds", () => {
  const doc = JSON.parse(readFileSync(join(vectorsDir, "codec-measure.json"), "utf8"));
  assert.ok(doc.cases.length > 0);
  assert.equal(doc.cases.length, doc.count);
  for (const c of doc.cases) {
    const value = build(c.value);
    const bounds: MeasureBounds = {
      maxEncodedBytes: c.bounds.encoded_bytes,
      maxOccurrences: c.bounds.occurrences,
      maxHeight: c.bounds.height,
    };
    if (c.expect.measures !== undefined) {
      const want = c.expect.measures;
      assert.deepEqual(
        measure(value, bounds),
        { encodedBytes: want.encoded_bytes, occurrences: want.occurrences, height: want.height },
        c.name,
      );
    } else {
      assert.ok(c.expect.exceeded.length > 0, `${c.name}: expects nothing`);
      assert.deepEqual(exceeded(value, bounds), c.expect.exceeded, c.name);
    }
  }
});

// Expected numbers are the closed forms of record 0008: 5·2^k − 2 bytes, 2^(k+1) − 1
// occurrences, height k.
test("the doubling chain at k = 64 saturates at once, and k = 100000 measures as fast as it is long", () => {
  assert.deepEqual(measure(doublingChain(50), UNBOUNDED), {
    encodedBytes: 5 * 2 ** 50 - 2,
    occurrences: 2 ** 51 - 1,
    height: 50,
  });
  assert.deepEqual(exceeded(doublingChain(64), { ...UNBOUNDED, maxHeight: 64 }), ["encoded_bytes", "occurrences"]);
  assert.deepEqual(exceeded(doublingChain(64), { ...UNBOUNDED, maxHeight: 63 }), [
    "encoded_bytes",
    "height",
    "occurrences",
  ]);
  const far = doublingChain(100_000);
  assert.deepEqual(exceeded(far, { ...UNBOUNDED, maxHeight: 100_000 }), ["encoded_bytes", "occurrences"]);
  assert.deepEqual(exceeded(far, { ...UNBOUNDED, maxHeight: 99_999 }), ["encoded_bytes", "height", "occurrences"]);
});

// Each level is a tag and an arity of 1 (2 bytes), around Atom(61) (3 bytes).
test("a value a million deep is measured with no call stack per level", () => {
  const DEEP = 1_000_000;
  let v: Value = atom(Uint8Array.of(0x61));
  for (let i = 0; i < DEEP; i += 1) v = tuple([v]);
  assert.deepEqual(measure(v, UNBOUNDED), { encodedBytes: 2 * DEEP + 3, occurrences: DEEP + 1, height: DEEP });
  assert.deepEqual(exceeded(v, { ...UNBOUNDED, maxHeight: 1024 }), ["height"]);
});

test("structurally equal tuples built apart are measured all the same", () => {
  const a = atom(new TextEncoder().encode("abc"));
  const v = tuple([tuple([a]), tuple([a]), tuple([])]);
  const got = measure(v, UNBOUNDED);
  assert.deepEqual(got, { encodedBytes: 2 + 7 + 7 + 2, occurrences: 1 + 2 + 2 + 1, height: 2 });
  assert.equal(got.encodedBytes, encode(v).length);
});

test("every bound is required, and is a non-negative safe integer", () => {
  const v = tuple([]);
  for (const bad of [-1, 1.5, MAX + 1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    for (const name of ["maxEncodedBytes", "maxOccurrences", "maxHeight"] as const) {
      assert.throws(() => measure(v, { ...UNBOUNDED, [name]: bad } as unknown as MeasureBounds), RangeError);
    }
  }
  assert.deepEqual(measure(v, { maxEncodedBytes: 2, maxOccurrences: 1, maxHeight: 0 }), {
    encodedBytes: 2,
    occurrences: 1,
    height: 0,
  });
});

test("MeasureError names the exceeded measures, frozen, in its message too", () => {
  try {
    measure(atom(), { maxEncodedBytes: 0, maxOccurrences: 0, maxHeight: 0 });
    assert.fail("expected over limit");
  } catch (err) {
    assert.ok(err instanceof MeasureError);
    assert.deepEqual(err.exceeded, [MeasureKind.EncodedBytes, MeasureKind.Occurrences]);
    assert.ok(Object.isFrozen(err.exceeded));
    assert.equal(err.message, "over limit: encoded_bytes, occurrences");
    assert.equal(err.name, "MeasureError");
  }
});
