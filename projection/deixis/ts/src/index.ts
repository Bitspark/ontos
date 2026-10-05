/*
 * ontos-over-deixis-v1 — the projection between ontos values and Node[Option[Bytes]],
 * on the deixis-pos-v1 position spelling. See ../../PROJECTION.md (normative).
 *
 *   P(Atom(b))            = Node(Some(b), {})                            total
 *   P(Tuple(v₀ … vₙ₋₁))   = Node(None, { κ(i) ↦ P(vᵢ) })                 total
 *   R(Node(Some(b), {}))  = Atom(b)                                      partial:
 *   R(Node(None, m))      = Tuple over κ(0) … κ(n−1), exactly            exact or refusal
 *
 * Deixis v0.2.0 gives every node an own value independently of its children
 * (Node[T] = T × FinMap[Bytes, Node[T]]), so there is no leaf/struct sum to switch on.
 * `Option` is THIS BRIDGE'S chosen payload domain, not a feature of the deixis core — the
 * core carries T opaquely and never interprets it. The two ontos constructors therefore
 * land on two disjoint node shapes, a present value with no children and an absent value
 * with the dense positional children, and the shapes that are NEITHER are exactly what R
 * refuses.
 *
 * The recognizer never parses a key: κ is order-preserving, so deixis's canonical entry
 * order is tuple order, and recognition is one pairwise walk comparing each entry key
 * octet-for-octet against the generated κ(i). It never sorts entries into new positions,
 * fills gaps, drops keys, or normalizes an alternate spelling to its index — recognition
 * is exact or it throws, because a repair pass would silently coarsen identity, which no
 * layer may do.
 *
 * This package is additive and defines no equality of its own at L0 — ontos identity
 * stays where it is (`equals` from @bitspark/ontos-core). What it DOES supply is the slot
 * relation deixis requires of a caller: see `nodeEq`. Nothing in ontos/core or
 * ontos-codec-v1 changes because this package exists, and the dependency direction is
 * ontos → deixis, never the reverse.
 *
 * BROWSER-COMPATIBLE BY CONSTRUCTION. This file imports only @bitspark/ontos-core,
 * @bitspark/deixis-core and @bitspark/deixis-pos — all three pure ESM over Uint8Array —
 * and nothing from `node:`; there is no Buffer, no process, no filesystem. The
 * test/browser.test.ts guard pins that for this file AND for the runtime closure.
 *
 * Peer of projection/deixis/rs (Rust) and projection/deixis/go (Go). Written with both
 * in view, so it is NOT an independent reading of PROJECTION.md — see the note at the
 * bottom of this file.
 */

import { Node, some, type Option } from "@bitspark/deixis-core";
import { key } from "@bitspark/deixis-pos";
import { atom, tuple, bytesEqual, toHex, type Value } from "@bitspark/ontos-core";

/** The name of the profile this package implements. */
export const PROFILE = "ontos-over-deixis-v1";

/**
 * The position spelling the profile is defined over. It is the value the vector file
 * carries, and a conforming face is conforming to exactly this spelling — the tests pin
 * it against @bitspark/deixis-pos's own `PROFILE`.
 */
export const POSITION_SPELLING = "deixis-pos-v1";

/**
 * The bridge's slot: an optional byte string. `Some(b)` reads as an atom's bytes, `None`
 * (spelled `undefined` by deixis) as "no atom here, a tuple's positions instead".
 *
 * Deixis requires a value at every node and says nothing about what it means. This choice
 * is the profile's, made here and nowhere else.
 */
export type Payload = Option<Uint8Array>;

/** The projection's codomain, `Node[Option[Bytes]]`. */
export type BytesNode = Node<Payload>;

/**
 * Equality of the WHOLE payload: `None` differs from every `Some`, and two `Some`s
 * compare by exact bytes, length included.
 */
export function payloadEq(a: Payload, b: Payload): boolean {
  if (a === undefined || b === undefined) return a === b;
  return bytesEqual(a.value, b.value);
}

/**
 * The deixis identity `=D` at this bridge's slot: deixis's lifted relation over
 * `payloadEq`.
 *
 * Deixis deliberately provides no native equality for a node — it lifts one from the slot
 * and declines to choose the slot's relation on a caller's behalf — so the relation is
 * supplied here, explicitly.
 */
export function nodeEq(a: BytesNode, b: BytesNode): boolean {
  return a.equalBy(b, payloadEq);
}

/** A node with a payload and no children; composing zero children cannot collide. */
function childless(own: Payload): BytesNode {
  return Node.compose<Payload>(own, []);
}

/**
 * `P : Ontos → Node[Option[Bytes]]` — TOTAL. Every ontos value has a projection, so this
 * function cannot fail on an L0 value:
 *
 *   P(Atom(b))          = Node(Some(b), {})
 *   P(Tuple(v₀ … vₙ₋₁)) = Node(None, { κ(i) ↦ P(vᵢ) | 0 ≤ i < n })
 */
export function project(value: Value): BytesNode {
  switch (value.kind) {
    case "atom":
      // Some(b) AND childless. The childlessness is half the projection: it is what
      // lets R tell an atom from a tuple without a tag.
      return childless(some(value.bytes()));
    case "tuple": {
      // Law 6: the empty TUPLE is Node(None, {}) and the empty ATOM is Node(Some(""), {}).
      // Both are childless, so the whole distinction rests on the payload — which is
      // exactly what a lax bridge would merge.
      const entries: (readonly [Uint8Array, BytesNode])[] = [];
      const items = value.items();
      for (let i = 0; i < items.length; i += 1) {
        entries.push([key(BigInt(i)), project(items[i]!)]);
      }
      // κ is injective (deixis-pos-v1), so 0…n−1 yield n distinct keys and deixis's
      // DuplicateKeyError is unreachable here — P stays total in its signature.
      return Node.compose<Payload>(undefined, entries);
    }
    default: {
      // L0 is closed: Value = Atom | Tuple. A third case would be a new floor, not a
      // new projection; the `never` makes the compiler say so.
      const impossible: never = value;
      throw new TypeError(`${PROFILE}: not an L0 value: ${String(impossible)}`);
    }
  }
}

/** The refusal classes. Normative: two conforming faces agree on which one applies. */
export type UnrecognizedKind = "key_mismatch" | "value_with_children";

/**
 * Why a node is not an ontos value.
 *
 * `Node[Option[Bytes]]` admits shapes the projection never produces, and they do not all
 * fail for the same reason — so they do not all get the same explanation. A malformed key
 * domain is a statement about WHICH positions a tuple carries; a payload beside children
 * is a statement about WHAT KIND of node it is at all. Collapsing the second into the
 * first would name a key as the culprit when no key is wrong.
 *
 * Do not branch on `message`. It is informative, not normative (PROJECTION.md §Vectors):
 * conformance is the refusal and its `kind`, and two conforming faces are free to word
 * the prose differently. Branch on `kind`, or on `instanceof` of a subclass.
 */
export abstract class Unrecognized extends Error {
  override readonly name: string = "Unrecognized";
  /** Which refusal this is. Normative. */
  abstract readonly kind: UnrecognizedKind;
  /** Tuple indices from the root to the node that refused. */
  readonly path: readonly number[];

  protected constructor(path: readonly number[], message: string) {
    super(message);
    this.path = Object.freeze([...path]);
  }
}

/**
 * The first entry, in canonical order, whose key is not the spelling of its position. A
 * shifted or sparse domain, a named key, a non-canonical spelling and a stray entry after
 * a dense prefix all surface here, located by `entry`.
 */
export class KeyMismatch extends Unrecognized {
  override readonly name = "KeyMismatch";
  override readonly kind = "key_mismatch" as const;
  /** The entry position (in canonical order) whose key mismatched. */
  readonly entry: number;
  /** `κ(entry)` — the key that position must carry. */
  readonly expected: Uint8Array;
  /** The key bytes actually present. */
  readonly found: Uint8Array;

  constructor(path: readonly number[], entry: number, expected: Uint8Array, found: Uint8Array) {
    const where = path.length === 0 ? "$" : `$.${path.join(".")}`;
    super(
      path,
      `${where}: entry ${entry} carries key ${toHex(found)}, not κ(${entry}) = ${toHex(expected)} — ` +
        `recognition under ${PROFILE} is exact, and dom m must be exactly {κ(0) … κ(n−1)}`,
    );
    this.entry = entry;
    this.expected = expected;
    this.found = found;
  }
}

/**
 * The node carries an own value AND children. `P` emits a payload only at a childless
 * node, so this is outside its image however well-formed the keys are — and the keys are
 * not consulted, because the shape is already wrong.
 */
export class ValueWithChildren extends Unrecognized {
  override readonly name = "ValueWithChildren";
  override readonly kind = "value_with_children" as const;
  /** How many children the node carries. Any number but zero refuses. */
  readonly children: number;

  constructor(path: readonly number[], children: number) {
    const where = path.length === 0 ? "$" : `$.${path.join(".")}`;
    super(
      path,
      `${where}: the node carries an own value and ${children} child(ren); under ${PROFILE} ` +
        `a payload belongs only to a CHILDLESS node, so no key is at fault here`,
    );
    this.children = children;
  }
}

/**
 * `R : Node[Option[Bytes]] ⇀ Ontos` — PARTIAL. Succeeds exactly on the image of `project`
 * (law 2), and throws an `Unrecognized` subclass on everything else:
 *
 *   R(Node(Some(b), {})) = Atom(b)
 *   R(Node(None, m))     = Tuple(R(m(κ(0))), …, R(m(κ(n−1))))
 *                          defined only when dom m = { κ(0), …, κ(n−1) } and every child recognizes.
 */
export function recognize(node: BytesNode): Value {
  return recognizeAt(node, []);
}

function recognizeAt(node: BytesNode, path: number[]): Value {
  const own = node.own();
  const entries = node.entries();

  if (own !== undefined) {
    // A present payload is an atom — but ONLY if the node is childless. A node carrying
    // both is well-formed deixis and outside the image of P. That is a question about
    // the node's SHAPE, so it is answered before any key is read: the keys may be
    // flawless κ and the node is still not an ontos value.
    if (entries.length > 0) {
      throw new ValueWithChildren(path, entries.length);
    }
    return atom(own.value);
  }

  // An absent payload is a tuple. Because κ is order-preserving, deixis's canonical entry
  // order IS tuple order. So the recognizer walks the entries ONCE, comparing each key
  // against the GENERATED κ(i) — it never parses a key and needs no κ decoder. That is
  // also what makes the refusals exact: a gap (dom = {κ(0), κ(2)}) shows up as entry 1
  // carrying κ(2); a named key, an empty key, a straggler after a dense prefix, and a key
  // that would DECODE to i but is not octet-equal to κ(i) are all caught by the same
  // comparison. n = 0 is the empty tuple and is in the image.
  const items: Value[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const [found, child] = entries[i]!;
    const expected = key(BigInt(i));
    if (!bytesEqual(found, expected)) {
      throw new KeyMismatch(path, i, expected, found);
    }
    path.push(i);
    items.push(recognizeAt(child, path));
    path.pop();
  }
  return tuple(items);
}

/*
 * INDEPENDENCE NOTE, recorded because the profile's maturity claim depends on it.
 *
 * This face was written by ontos, with projection/deixis/rs and projection/deixis/go
 * open beside PROJECTION.md. It is therefore independent of neither face's code nor of
 * the organisation that wrote them, and per ontos-internal#255 it changes NOTHING about the
 * profile's maturity: `ontos-over-deixis-v1` stays UNWITNESSED, permanently. A third
 * ontos-authored face is a third consumer of the same reading, not a witness to it.
 *
 * The v0.2.0 migration does not change that in either direction: all three faces were
 * carried to the mandatory-value model together, by one author with all three open, so
 * it is not a fresh independent reading — and it does not retract the Go face's original
 * one either, which remains a fact about how that face was FIRST written.
 */
