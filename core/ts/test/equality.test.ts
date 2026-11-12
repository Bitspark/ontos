/*
 * Tuple#equals walks with an explicit stack, never one native frame per nesting level, so
 * values compare whatever their depth. The answer, and the order the children are asked in,
 * are the recursive form's.
 *
 * NEGATIVE WITNESS: the recursive form threw RangeError at 100,000 levels on Node 24, so
 * the 100,000- and 1,000,000-level cases below failed.
 *
 * Auto-discovered by the ts CI glob (core/ts/test/*.test.ts). Run directly:
 *   node --test core/ts/test/equality.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, Atom, Tuple, type Value } from "../src/index.ts";

// depth one-element tuples around leaf, built without recursion.
function nestedOn(leaf: Value, depth: number): Value {
  let v = leaf;
  for (let i = 0; i < depth; i += 1) v = tuple([v]);
  return v;
}

function nested(depth: number): Value {
  return nestedOn(atom([0x61]), depth);
}

// equals as it was before it walked with an explicit stack: the oracle for the relation.
function recursiveEquals(left: Value, right: Value): boolean {
  if (left instanceof Atom) return left.equals(right);
  if (!(right instanceof Tuple) || left.length !== right.length) return false;
  const lefts = left.items();
  const rights = right.items();
  for (let i = 0; i < lefts.length; i += 1) {
    if (!recursiveEquals(lefts[i]!, rights[i]!)) return false;
  }
  return true;
}

for (const depth of [1024, 100_000, 1_000_000]) {
  test(`values ${depth} deep compare, and a difference anywhere is seen`, () => {
    // Each assertion is a whole walk of the value.
    const a = nested(depth);
    assert.equal(equals(a, nested(depth)), true);
    // A difference at the very bottom, in arity, or in depth.
    assert.equal(a.equals(nestedOn(atom([0x62]), depth)), false);
    assert.equal(a.equals(nestedOn(tuple([atom([0x61]), atom()]), depth - 1)), false);
    assert.equal(nested(depth - 1).equals(a), false);
  });
}

test("the relation is the recursive form's on generated pairs", () => {
  // A deterministic linear congruential generator: a property sweep, not fuzzing. A small
  // space, so that many pairs are equal without being one object.
  let state = 0x66;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % bound;
  };
  const gen = (depth: number): Value => {
    if (depth >= 3 || next(10) < 4) return atom(Array.from({ length: next(2) }, () => next(2)));
    return tuple(Array.from({ length: next(3) }, () => gen(depth + 1)));
  };
  const values = Array.from({ length: 80 }, () => gen(0));
  let equalPairs = 0;
  for (const left of values) {
    for (const right of values) {
      const want = recursiveEquals(left, right);
      assert.equal(left.equals(right), want);
      if (want) equalPairs += 1;
    }
  }
  assert.ok(equalPairs > 2 * values.length, "the sweep must meet equal pairs");
});

test("a left child whose equals is overridden is still asked; a right one is not", () => {
  // The recursive form called each left child's own equals, and a right child was only
  // ever an argument. The walk keeps both.
  class Loose extends Tuple {
    override equals(): boolean {
      return true;
    }
  }
  const one = atom([0x01]);
  const two = atom([0x02]);
  assert.equal(tuple([new Loose([one])]).equals(tuple([tuple([two])])), true);
  assert.equal(tuple([tuple([two])]).equals(tuple([new Loose([one])])), false);
  assert.equal(tuple([tuple([one])]).equals(tuple([new Loose([one])])), true);

  // A subclass that keeps Tuple's equals is opened like a Tuple, on either side.
  class Plain extends Tuple {}
  assert.equal(tuple([new Plain([one])]).equals(tuple([tuple([one])])), true);
  assert.equal(tuple([tuple([one])]).equals(tuple([new Plain([two])])), false);
});
