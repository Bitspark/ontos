# Measuring a value's canonical encoding without expanding it

**Status: decided, 10 November 2026, by the ontos coordinator under the owner's standing
delegation of design decisions.** This answers [ontos issue 35](https://github.com/Bitspark/ontos/issues/35),
which brings the request from bittype research 0015
([bittype issue 203](https://github.com/Bitspark/bittype/issues/203), advice §4, row 33). The
implementation lands with the specification text and the vectors in one change.

## 1. The request

Bindings for horos-declared service contracts must bound the **expanded** canonical size of a
value. ontos lets an implementation hold a value as a DAG
([ontos-core §6](../spec/ontos-core.md)), while the canonical encoding and equality still
process the finite tree that DAG denotes. A chain of `k` distinct nodes

```text
x0 = Atom(0x00)
xk = Tuple(x(k-1), x(k-1))
```

encodes to `5·2^k − 2` bytes. A distinct-node bound and a depth bound do not limit that, and
keeping the DAG during conversion only postpones the expansion to encoding. Research 0015
assigns the canonical encoded-size calculation to ontos, as the owner of the encoding.

## 2. Decisions

1. **`ontos/codec` owns it.** The encoded length is a property of the encoding (§2 of
   [ontos-codec](../spec/ontos-codec.md)). The two other measures belong to the core value,
   but a caller needs all three at once, and one walk computes them together, so one codec
   function provides all three. This is additive API. The `ontos-codec-v1` bytes, the decoder,
   the existing vectors and the core APIs do not change.

2. **One function, `measure`, with three measures**, each defined on the expanded tree:

   | measure | definition |
   | --- | --- |
   | `encoded_bytes` | the length of the value's canonical encoding: `1 + len(uvarint(len(b))) + len(b)` for `Atom(b)`, and `1 + len(uvarint(n)) + Σ encoded_bytes(vi)` for `Tuple(v0 … v(n-1))` |
   | `occurrences` | the number of values in the expanded tree, the root included: `1` for an atom, `1 + Σ occurrences(vi)` for a tuple |
   | `height` | how deep the value is nested, as codec §4.1 defines it (the root at depth 0): `0` for an atom and for the empty tuple, `1 + max height(vi)` for a non-empty tuple |

   `height` uses the decoder's own depth definition on purpose: a value whose `height` is
   `H` passes the decoder's depth bound exactly when that bound is at least `H`, so a caller
   can bound a value's measures with the same numbers it decodes with.

3. **The caller states every bound.** `measure` takes a bound for each of the three measures,
   and none has a default. A measure that stays within its bound is reported exactly. A
   measure that exceeds it saturates. The arithmetic never overflows and never wraps. The
   result is then **over limit**, naming every measure that exceeded its bound.
   - Each measure saturates independently, and the walk always finishes, so the set of
     exceeded measures is a function of the value and the bounds alone. Unlike the decoder's
     limit kinds (codec §4.2), it does not depend on traversal order or on the host, and the
     vectors pin it.
   - The work is linear in the distinct in-memory nodes plus their child edges, whatever
     the bounds. Because the value is already in memory, that work is bounded by memory the
     caller already holds.
   - A bound is a non-negative integer that every face can represent exactly: at most
     `2^53 − 1` in TypeScript, `2^64 − 1` in Go and Rust, and any non-negative `int` in
     Python. Vectors use bounds at most `2^53 − 1`.

4. **Each distinct subtree is visited once.** The walk memoizes on the **identity of the
   in-memory node**, not on structural equality. A node reached again through another
   parent contributes its memoized measures once for each incoming edge. Heights are
   recorded bottom-up per subtree, so a memo hit reached on a deeper path cannot bypass the
   height bound. A memo hit only skips the subtree's interior, and the height of the
   enclosing path is still computed from it. Structurally equal subtrees built separately
   are measured correctly, just not shared. No face hash-conses, and none needs to.
   - TypeScript and Python memoize on the tuple object.
   - Go memoizes on the identity of the tuple's child storage. A `core.Tuple` is a struct
     around a slice, and every copy of it shares that slice's backing array. The face
     chooses a std-only mechanism and documents it.
   - Rust: `core::Value` owns its children, so a Rust value cannot share a subtree. Its
     `measure` is a plain walk with the same saturation and the same results.

5. **Stack-safe.** Like core's `Clone`, `Eq` and `Hash` and the codec's `encode`, `measure`
   walks iteratively with an explicit stack, so a value of any height can be measured,
   including one past the height bound.

6. **Four faces, not two.** The issue asks for Go and TypeScript. CONTRIBUTING requires a
   codec behavior in every language that carries `codec/`, so Go, Rust, TypeScript and
   Python all implement it, to one vector file. Names follow each language's idiom:
   `codec.Measure` in Go, `ontos_codec::measure` in Rust, `measure` in the TypeScript and
   Python codecs. Each face pins the three measure identifiers, `encoded_bytes`,
   `occurrences` and `height`, in its over-limit outcome. Those identifiers are append-only,
   as the limit kinds of codec §4.2 are.

7. **Vectors with real sharing.** `vectors/codec-measure.json` is hand-authored from this
   record and the codec equations (Class A). Its own notation writes a value as a node
   table, so each face builds the value with genuine sharing, one in-memory node per table
   entry:

   ```text
   { "nodes": [ { "atom": "<hex>" } | { "tuple": [ <earlier node index>, … ] }, … ], "root": <index> }
   ```

   A tuple may reference only earlier entries, so the table is acyclic by construction, and
   the same index may appear more than once. Each case gives the bounds and either the three
   exact measures or the sorted list of exceeded measures. The cases cover:
   - atoms whose length crosses a uvarint width;
   - the empty tuple;
   - the doubling chain at small `k`, exact;
   - the doubling chain at `k = 64`, where `encoded_bytes` exceeds `2^64` and saturates;
   - one measure over its bound while the others stay exact;
   - all three measures over their bounds;
   - a bound exactly equal to a measure, which is within.

   A face whose values cannot share (Rust) replays only the cases whose expanded
   `occurrences` stay small. The vector file marks those with a flag rather than leaving
   each face to guess.

8. **Out of scope:** a command-line `measure` command and its differential-harness lane,
   bounds on atom length and tuple arity, and any change to decoding. Each can follow once
   a consumer names a need.

## 3. Why not elsewhere

- **In each binding family:** every family would re-derive the uvarint widths, and an
  off-by-one in one of them would let a value past its bound. The encoding's owner states
  the equation once.
- **In horos or bittype:** both would then depend on ontos's byte layout without owning it.
  Codec §7 freezes that layout precisely so that consumers don't re-implement it.
- **As a sharing encoding** ([ontos issue 12](https://github.com/Bitspark/ontos/issues/12)):
  that encoding is a different byte form and stays deferred. `measure` reports the canonical
  `ontos-codec-v1` length, which is what consumers sign and hash.
