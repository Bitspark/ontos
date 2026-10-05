/*
 * Laws 1–7 of ontos-over-deixis-v1 over GENERATED values and DELIBERATELY MALFORMED
 * positional structures — the property-shaped half of this face's evidence.
 *
 * The vector corpus (vectors.test.ts) is seventeen hand-authored cases. This file walks
 * the same laws over a few hundred values it builds itself — arbitrary byte leaves,
 * arities across κ's one-byte magnitude boundary at 256, deep nesting — and then takes
 * each projected node apart in every way R must refuse: a gap, a shift, a named
 * straggler after a dense prefix, a non-canonical spelling of a valid index, an empty
 * key. Dependency-free per the repo ethos (no fast-check): randomness comes from a small
 * deterministic PRNG seeded from a constant, so every run is reproducible.
 *
 * Passing a finite corpus — this one included — is evidence for these cases, not a
 * proof of the universal laws. It is stated here so the file is not read as one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Node, some } from "@bitspark/deixis-core";
import { isKey, key } from "@bitspark/deixis-pos";
import { atom, tuple, equals, bytesEqual, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";

import {
  type BytesNode,
  type Payload,
  KeyMismatch,
  Unrecognized,
  ValueWithChildren,
  nodeEq,
  project,
  recognize,
} from "../src/index.ts";

// The two node SHAPES P emits, named once. In the mandatory-value model a node is
// (own, children) and there is no constructor to choose between, so the profile's
// two cases have to be spelled out by the caller — which is the point: the shapes
// are the bridge's, not deixis's.
const tupleNode = (children: Iterable<readonly [Uint8Array, BytesNode]>): BytesNode =>
  Node.compose<Payload>(undefined, children);
const atomNode = (bytes: Uint8Array): BytesNode => Node.compose<Payload>(some(bytes), []);

// --- deterministic PRNG (xorshift64*, as codec/ts/test/fuzz.test.ts) -----------------

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

  /** Uniform integer in [0, n). */
  below(n: number): number {
    return Number((this.#nextU64() >> 32n) % BigInt(n));
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) out[i] = this.below(256);
    return out;
  }
}

// --- generators ------------------------------------------------------------------------

/** An arbitrary byte leaf: empty a fifth of the time, otherwise up to 64 random octets. */
function genAtom(rng: Rng): Value {
  return atom(rng.below(5) === 0 ? new Uint8Array() : rng.bytes(rng.below(65)));
}

/** A random value tree, bounded in depth and arity so the suite stays quick. */
function genValue(rng: Rng, depth = 0): Value {
  if (depth >= 4 || rng.below(3) === 0) return genAtom(rng);
  const arity = rng.below(6);
  const items: Value[] = [];
  for (let i = 0; i < arity; i += 1) items.push(genValue(rng, depth + 1));
  return tuple(items);
}

/** A tuple of exactly `arity` atoms — used to cross κ's magnitude boundary at 256. */
function flat(arity: number): Value {
  const items: Value[] = [];
  for (let i = 0; i < arity; i += 1) items.push(atom(new Uint8Array([i >> 8, i & 0xff])));
  return tuple(items);
}

function refusal(node: BytesNode): Unrecognized | undefined {
  try {
    recognize(node);
    return undefined;
  } catch (e) {
    if (e instanceof Unrecognized) return e;
    throw e;
  }
}

/** Every struct in the node, addressed by its ontos index path from the root. */
function structs(node: BytesNode, path: number[] = []): { path: number[]; node: BytesNode }[] {
  if (node.own() !== undefined) return [];
  const out = [{ path: [...path], node }];
  node.entries().forEach(([, child], i) => {
    out.push(...structs(child, [...path, i]));
  });
  return out;
}

/** Rebuild `root` with the struct at `path` replaced by `replacement`. */
function replaceAt(root: BytesNode, path: readonly number[], replacement: BytesNode): BytesNode {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path as [number, ...number[]];
  const entries = root.entries();
  const [k, child] = entries[head]!;
  entries[head] = [k, replaceAt(child, rest, replacement)];
  return tupleNode(entries);
}

/**
 * κ(i) spelled non-canonically: one more ff, and a leading 00 on the magnitude. A lax
 * reader that trusted the ff-run as the magnitude length would decode it to i; it is not
 * octet-equal to κ(i), and deixis-pos's own `isKey` rejects it.
 */
function laxSpelling(i: number): Uint8Array {
  const canonical = key(BigInt(i));
  const run = canonical.indexOf(0x00);
  const mag = canonical.subarray(run + 1);
  const out = new Uint8Array(canonical.length + 2);
  out.fill(0xff, 0, run + 1);
  out[run + 1] = 0x00;
  out[run + 2] = 0x00;
  out.set(mag, run + 3);
  assert.ok(!isKey(out), "the lax spelling must NOT be a canonical key");
  assert.ok(!bytesEqual(out, canonical));
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const SEED = 0x6f6e746f73n; // "ontos"
const CASES = 300;

// --- the laws over generated values -------------------------------------------------------

test("law 1 — R(P(v)) =O v over generated values", () => {
  const rng = new Rng(SEED);
  for (let n = 0; n < CASES; n += 1) {
    const v = genValue(rng);
    assert.ok(equals(recognize(project(v)), v), `law 1 failed on ${v.toString()}`);
  }
});

test("law 3 — P(R(d)) =D d for every d in the image of P", () => {
  const rng = new Rng(SEED + 1n);
  for (let n = 0; n < CASES; n += 1) {
    const d = project(genValue(rng));
    assert.ok(nodeEq(project(recognize(d)), d));
  }
});

test("law 4 — P(v) =D P(w) iff v =O w, over generated pairs and structural copies", () => {
  const rng = new Rng(SEED + 2n);
  let sawEqual = 0;
  let sawDistinct = 0;
  for (let n = 0; n < CASES; n += 1) {
    const v = genValue(rng);
    const w = rng.below(2) === 0 ? genValue(rng) : recognize(project(v)); // a structural copy half the time
    const o = equals(v, w);
    if (o) sawEqual += 1;
    else sawDistinct += 1;
    assert.equal(nodeEq(project(v), project(w)), o, `law 4 failed on ${v.toString()} vs ${w.toString()}`);
  }
  assert.ok(sawEqual > 0 && sawDistinct > 0, "both directions of the iff must be exercised");
});

test("law 5 — d =D e implies the same recognizer outcome (entry order is not part of a node)", () => {
  const rng = new Rng(SEED + 3n);
  for (let n = 0; n < CASES; n += 1) {
    const d = project(genValue(rng));
    // Same entries, authored in reverse: =D by construction, so R must agree.
    const e = reversed(d);
    assert.ok(nodeEq(d, e));
    const a = refusal(d);
    const b = refusal(e);
    assert.equal(a === undefined, b === undefined);
    if (a === undefined) assert.ok(equals(recognize(d), recognize(e)));
  }
});

function reversed(node: BytesNode): BytesNode {
  if (node.own() !== undefined) return node;
  return tupleNode(node.entries().reverse().map(([k, c]) => [k, reversed(c)] as const));
}

test("law 6 — Node(Some(\"\"), {}) ≠D Node(None, {}), and neither payload nor arity leaks across", () => {
  // BOTH are childless in this model, so the distinction rests on the payload alone.
  assert.equal(project(atom()).length, 0);
  assert.equal(project(tuple()).length, 0);
  assert.notEqual(project(atom()).own(), undefined);
  assert.equal(project(tuple()).own(), undefined);
  assert.ok(!nodeEq(project(atom()), project(tuple())));
  assert.equal(recognize(project(atom())).kind, "atom");
  assert.equal(recognize(project(tuple())).kind, "tuple");
  // The singleton of the empty atom is a third thing, distinct from both.
  const singleton = project(tuple([atom()]));
  assert.ok(!nodeEq(singleton, project(atom())));
  assert.ok(!nodeEq(singleton, project(tuple())));
});

test("law 7 — index paths and κ key paths reach the same subvalue, or both miss", () => {
  const rng = new Rng(SEED + 4n);
  let resolved = 0;
  let missed = 0;
  for (let n = 0; n < CASES; n += 1) {
    const v = genValue(rng);
    const d = project(v);
    // A random path of depth 0..3 over indices 0..6 — past the arity often enough to
    // exercise the non-resolving direction of the iff.
    const path: number[] = [];
    for (let k = rng.below(4); k > 0; k -= 1) path.push(rng.below(7));

    let byIndex: Value | undefined = v;
    for (const i of path) byIndex = byIndex?.kind === "tuple" ? byIndex.at(i) : undefined;
    const byKeys = d.at(path.map((i) => key(BigInt(i))));

    assert.equal(byIndex !== undefined, byKeys !== undefined, `law 7 reachability disagrees at ${path.join(".")}`);
    if (byIndex !== undefined) {
      resolved += 1;
      assert.ok(nodeEq(byKeys!, project(byIndex)), `law 7 reached the wrong node at ${path.join(".")}`);
    } else {
      missed += 1;
    }
  }
  assert.ok(resolved > 0 && missed > 0, "both directions of the iff must be exercised");
});

// --- κ's magnitude boundary and byte composition -----------------------------------------

test("round trip across the κ length boundary (arity 300 crosses position 256)", () => {
  const value = flat(300);
  const node = project(value);
  const keys = node.keys();
  assert.equal(keys.length, 300);
  assert.equal(hex(keys[255]!), "00ff", "κ(255) = 00ff");
  assert.equal(hex(keys[256]!), "ff000100", "κ(256) = ff000100");
  assert.ok(equals(recognize(node), value));
  // toOntosBytes(P(v)) = encodeOntosV1(v) here too — the profile's one byte-level claim.
  assert.ok(bytesEqual(encode(recognize(node)), encode(value)));
});

test("toOntosBytes(P(v)) = encodeOntosV1(v) over generated values", () => {
  const rng = new Rng(SEED + 5n);
  for (let n = 0; n < CASES; n += 1) {
    const v = genValue(rng);
    assert.ok(bytesEqual(encode(recognize(project(v))), encode(v)));
  }
});

// --- law 2, the refusal half: malformed positional structures -------------------------------
//
// R succeeds iff d is in the image of P. Every mutation below leaves the image, so R must
// refuse it — and must refuse it with the TYPED refusal, located at the struct that was
// mutated. None of these may be "repaired": a gap filled, a shift re-based, a straggler
// dropped, a spelling normalized.

/** A generated struct with at least `min` entries, plus the value it came from. */
function genStructAtLeast(rng: Rng, min: number): { value: Value; node: BytesNode; path: number[] } {
  for (;;) {
    const value = genValue(rng);
    const candidates = structs(project(value)).filter(({ node }) => node.length >= min);
    if (candidates.length === 0) continue;
    const pick = candidates[rng.below(candidates.length)]!;
    return { value, node: project(value), path: pick.path };
  }
}

function expectRefusalAt(mutated: BytesNode, path: readonly number[], what: string): KeyMismatch {
  const err = refusal(mutated);
  assert.ok(err instanceof Unrecognized, `${what}: R accepted a node outside the image of P`);
  // Every mutation below is a DOMAIN mutation, so the refusal must be the key one. If a
  // face reported these as a shape problem it would be describing the wrong defect.
  assert.ok(err instanceof KeyMismatch, `${what}: expected a key mismatch, got ${err.kind}`);
  assert.deepEqual([...err.path], [...path], `${what}: refusal located at the wrong struct`);
  assert.ok(bytesEqual(err.expected, key(BigInt(err.entry))), `${what}: expected must be κ(entry)`);
  assert.ok(!bytesEqual(err.found, err.expected), `${what}: a refusal must report a real mismatch`);
  return err;
}

test("refusal — a gap is never filled", () => {
  const rng = new Rng(SEED + 6n);
  for (let n = 0; n < 100; n += 1) {
    const { node, path } = genStructAtLeast(rng, 2);
    const target = node.at(path.map((i) => key(BigInt(i))))!;
    const entries = target.entries();
    const drop = rng.below(entries.length - 1); // never the last: dropping it is a valid shorter tuple
    entries.splice(drop, 1);
    const err = expectRefusalAt(replaceAt(node, path, tupleNode(entries)), path, "gap");
    assert.equal(err.entry, drop, "the first mismatch is exactly where the gap opened");
  }
});

test("refusal — a shifted domain is never re-based", () => {
  const rng = new Rng(SEED + 7n);
  for (let n = 0; n < 100; n += 1) {
    const { node, path } = genStructAtLeast(rng, 1);
    const target = node.at(path.map((i) => key(BigInt(i))))!;
    const shift = 1 + rng.below(3);
    const shifted = target.entries().map(([, c], i) => [key(BigInt(i + shift)), c] as const);
    const err = expectRefusalAt(replaceAt(node, path, tupleNode(shifted)), path, "shift");
    assert.equal(err.entry, 0, "a shift is caught at entry 0");
  }
});

test("refusal — a named straggler after a dense prefix is never dropped", () => {
  const rng = new Rng(SEED + 8n);
  for (let n = 0; n < 100; n += 1) {
    const { node, path } = genStructAtLeast(rng, 0);
    const target = node.at(path.map((i) => key(BigInt(i))))!;
    const entries = target.entries();
    // A key that sorts after every κ (0x61… > 0x00…, 0xff… κ's start with ff-runs but a
    // bare 0x61 prefix sorts between): "a"-prefixed, arbitrary length.
    const named = new Uint8Array([0x61, ...rng.bytes(rng.below(4))]);
    assert.ok(!isKey(named));
    entries.push([named, atomNode(rng.bytes(3))]);
    const err = expectRefusalAt(replaceAt(node, path, tupleNode(entries)), path, "straggler");
    // Dense prefix intact, so the mismatch is the straggler's own position.
    assert.equal(err.entry, target.length);
  }
});

test("refusal — a non-canonical spelling of a valid index is never normalized", () => {
  const rng = new Rng(SEED + 9n);
  for (let n = 0; n < 100; n += 1) {
    const { node, path } = genStructAtLeast(rng, 1);
    const target = node.at(path.map((i) => key(BigInt(i))))!;
    const entries = target.entries();
    const i = rng.below(entries.length);
    entries[i] = [laxSpelling(i), entries[i]![1]];
    expectRefusalAt(replaceAt(node, path, tupleNode(entries)), path, "lax spelling");
  }
});

test("refusal — the empty key spells no position", () => {
  const empty = tupleNode([[new Uint8Array(), atomNode(new Uint8Array())]]);
  const err = expectRefusalAt(empty, [], "empty key");
  assert.equal(err.entry, 0);
  assert.equal(err.found.length, 0);
});

test("refusal — is recursive and located: an inner mismatch names the inner path", () => {
  // Outer dense, inner shifted: the error points inside, in tuple indices (mirrors the
  // rs unit test and the corpus's child_unrecognized case, at depth 2).
  const inner = tupleNode([[key(1n), atomNode(new Uint8Array())]]);
  const mid = tupleNode([
    [key(0n), atomNode(new Uint8Array([0x01]))],
    [key(1n), inner],
  ]);
  const root = tupleNode([[key(0n), mid]]);
  const err = expectRefusalAt(root, [0, 1], "nested shift");
  assert.equal(err.entry, 0);
  assert.ok(bytesEqual(err.found, key(1n)));
  assert.ok(bytesEqual(err.expected, key(0n)));
  assert.match(err.message, /^\$\.0\.1: /);
});

test("refusal — Unrecognized is a typed Error hierarchy, and R throws nothing else", () => {
  const mismatch = refusal(tupleNode([[key(3n), atomNode(new Uint8Array())]]));
  assert.ok(mismatch instanceof Unrecognized);
  assert.ok(mismatch instanceof KeyMismatch);
  assert.ok(mismatch instanceof Error);
  assert.equal(mismatch.name, "KeyMismatch");
  assert.equal(mismatch.kind, "key_mismatch");
  assert.ok(Object.isFrozen(mismatch.path));

  // The second refusal class is a SIBLING, not a flavour of the first: a shape problem
  // must not arrive wearing a key problem's type, or a consumer narrowing on KeyMismatch
  // would read `expected`/`found` that describe nothing.
  const shape = refusal(
    Node.compose<Payload>(some(new Uint8Array([0x61])), [[key(0n), atomNode(new Uint8Array())]]),
  );
  assert.ok(shape instanceof Unrecognized);
  assert.ok(shape instanceof ValueWithChildren);
  assert.ok(!(shape instanceof KeyMismatch), "a shape refusal must not be a KeyMismatch");
  assert.equal(shape.name, "ValueWithChildren");
  assert.equal(shape.kind, "value_with_children");
  assert.equal(shape.children, 1);
  assert.ok(Object.isFrozen(shape.path));
});

// The shape the v0.1.0 leaf/struct sum could not express, over generated trees: give any
// node in the image of P a payload beside its children and R must refuse it for its
// SHAPE — never for a key, because every key in these trees is a flawless κ.
test("refusal — a payload beside children is refused, and never blamed on a key", () => {
  const rng = new Rng(SEED + 11n);
  for (let n = 0; n < 100; n += 1) {
    const { node, path } = genStructAtLeast(rng, 1);
    const target = node.at(path.map((i) => key(BigInt(i))))!;
    // Same children, now with a payload: the domain is untouched and still dense.
    const poisoned = Node.compose<Payload>(some(rng.bytes(2)), target.entries());
    const err = refusal(replaceAt(node, path, poisoned));

    assert.ok(err instanceof ValueWithChildren, `a payload beside children must refuse as a shape: got ${err?.kind}`);
    assert.deepEqual([...err.path], [...path], "the refusal is located at the poisoned node");
    assert.equal(err.children, target.length, "it reports how many children the node carried");
  }
});

// …and the childless half of the same shape rule: stripping the children off a TUPLE node
// leaves Node(None, {}), which is the empty tuple and is perfectly recognizable. The rule
// is about a PAYLOAD beside children, not about children being present at all.
test("a tuple node emptied of children is the empty tuple, not a refusal", () => {
  const rng = new Rng(SEED + 12n);
  for (let n = 0; n < 50; n += 1) {
    const { node, path } = genStructAtLeast(rng, 1);
    const emptied = replaceAt(node, path, tupleNode([]));
    const value = recognize(emptied);
    assert.ok(value !== undefined, "R must accept a tuple node with no children");
  }
});
