/*
 * Tuple#toString walks with an explicit stack, never one native frame per nesting level, so
 * a value renders whatever its depth. The codec's default decoder accepts 1024 levels, and a
 * caller that logs a decoded value must not crash; codec/ts's depth test covers the decoded
 * path. The output is the recursive form's, byte for byte.
 *
 * NEGATIVE WITNESS: the recursive form threw RangeError from about 5,000 levels on Node 24,
 * so the 100,000-level cases below failed.
 *
 * Auto-discovered by the ts CI glob (core/ts/test/*.test.ts). Run directly:
 *   node --test core/ts/test/rendering.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, Atom, Tuple, type Value } from "../src/index.ts";

// depth one-element tuples around Atom(0x61), built without recursion.
function nested(depth: number): Value {
  let v: Value = atom([0x61]);
  for (let i = 0; i < depth; i += 1) v = tuple([v]);
  return v;
}

function nestedText(depth: number): string {
  return "Tuple(".repeat(depth) + "Atom(0x61)" + ")".repeat(depth);
}

// toString as it was before it walked with an explicit stack: the oracle for byte identity.
function recursiveString(value: Value): string {
  if (value instanceof Tuple) {
    return `Tuple(${value.items().map((item) => recursiveString(item)).join(", ")})`;
  }
  return value.toString();
}

test("the cross-core diagnostic form", () => {
  assert.equal(tuple().toString(), "Tuple()");
  assert.equal(
    tuple([atom([0x6d, 0x61, 0x70]), atom([0x61])]).toString(),
    "Tuple(Atom(0x6d6170), Atom(0x61))",
  );
  assert.equal(
    tuple([atom([0x70]), tuple([atom([0x71])])]).toString(),
    "Tuple(Atom(0x70), Tuple(Atom(0x71)))",
  );
});

test("a value at the default decode depth and one 100,000 deep render, by every string conversion", () => {
  for (const depth of [1024, 100_000]) {
    const v = nested(depth);
    const want = nestedText(depth);
    assert.equal(v.toString(), want, `toString at ${depth}`);
    assert.equal(String(v), want, `String() at ${depth}`);
    assert.equal(`${v}`, want, `template at ${depth}`);
  }
});

test("a deep child among siblings keeps its separators and closers", () => {
  const v = tuple([atom([0x01]), nested(10_000), tuple(), atom([0x02])]);
  assert.equal(v.toString(), `Tuple(Atom(0x01), ${nestedText(10_000)}, Tuple(), Atom(0x02))`);
});

test("the output is the recursive form's on generated values", () => {
  // A deterministic linear congruential generator: a property sweep, not fuzzing.
  let state = 0x64;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % bound;
  };
  const gen = (depth: number): Value => {
    if (depth >= 6 || next(10) < 4) {
      return atom(Array.from({ length: next(4) }, () => next(256)));
    }
    return tuple(Array.from({ length: next(5) }, () => gen(depth + 1)));
  };
  for (let trial = 0; trial < 500; trial += 1) {
    const v = gen(0);
    assert.equal(v.toString(), recursiveString(v), `trial ${trial}`);
  }
});

test("a child whose toString is overridden still renders through it", () => {
  // The recursive form called toString on every child, so a subclass's own rendering showed
  // inside its parent. The walk keeps that, and writes what the override returns as join did.
  class Point extends Tuple {
    override toString(): string {
      return "Point";
    }
  }
  class Label extends Atom {
    override toString(): string {
      return "Label";
    }
  }
  class Blank extends Atom {
    override toString(): string {
      return undefined as unknown as string;
    }
  }
  const v = tuple([new Point([atom([0x01])]), tuple([new Label([0x02])]), atom([0x03])]);
  assert.equal(v.toString(), "Tuple(Point, Tuple(Label), Atom(0x03))");
  assert.equal(tuple([new Blank([0x04]), atom([0x05])]).toString(), "Tuple(, Atom(0x05))");

  // A subclass that keeps Tuple's toString is walked like a Tuple.
  class Plain extends Tuple {}
  assert.equal(tuple([new Plain([atom([0x06])])]).toString(), "Tuple(Tuple(Atom(0x06)))");
});
