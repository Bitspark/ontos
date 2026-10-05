# ontos/core (L0) — normative specification

**Layer:** L0 (`ontos/core`). **Status:** normative; this is the frozen floor.
**Conformance:** an implementation conforms to `ontos/core` iff it realizes the
value set, the structural identity relation, and the well-formedness rules below,
and passes the L0 conformance vectors.

This document defines **what a value is** and **when two values are the same**. It
defines nothing else. Byte encoding is `ontos/codec` (separate, versioned). The
labeled-compound reading is `ontos/compound` (L1). Recognized data embeddings
(int, text, …) are `ontos/data` (L2). None of those are required to conform to
L0, and L0 never depends on them. See
[design/0003-layered-architecture.md](../design/0003-layered-architecture.md).

The keywords MUST, MUST NOT, SHOULD, and MAY are used in the IETF sense.

---

## 1. The value set

There is exactly one kind of thing: a **value**. The set of values `V` is the
**least** set satisfying the two constructors:

```text
Atom(b)              ∈ V    for every finite byte string b
Tuple(v₀, …, vₙ₋₁)   ∈ V    for every finite n ≥ 0 and all vᵢ ∈ V
```

Equivalently, `V` is the initial algebra `μX. Bytes + List(X)`, where `Bytes` is
the set of all finite sequences of octets.

- **`Atom(b)`** — a leaf carrying a finite, **uninterpreted** byte string. The
  bytes are not text, not a number, not a hash, not a key. L0 commits only to
  *which exact octets are present*.
- **`Tuple(v₀, …, vₙ₋₁)`** — a finite, **ordered** sequence of `n` child values.
  `n` is the **arity**. Order and arity are part of the value. There is no
  implicit flattening, sorting, or de-duplication.

`V` is closed: every child of a tuple is itself a value, recursively. These are
the only two constructors. There is no third kind of value — no nil, no variable,
no number, no string, no map, no reference, no label slot. (Those are all either
higher-layer *readings* of these two constructors, or they belong to a consumer.
See §7.)

### 1.1 Examples (illustrative; notation only)

```text
Atom("")                       the empty-bytes atom
Atom(0x61)                     a one-byte atom
Tuple()                        the empty tuple (arity 0)
Tuple(Atom(0x61))              arity-1 tuple
Tuple(Atom(0x61), Atom(0x62))  arity-2 tuple
Tuple(Atom(0x70), Tuple(Atom(0x71), Atom(0x72)))   nested
```

Brackets, quotes, and hex are notation for this document. They are not part of the
model; the model is the abstract tree, not any spelling of it. (A reader who
chooses to see `Tuple(Atom("parent"), Atom("alice"), Atom("bob"))` as
`parent(alice, bob)` is applying the `ontos/compound` reading — L1, not L0.)

## 2. Intrinsic properties

Every value MUST satisfy all of the following. These are part of *valuehood*, not
of any interpretation.

- **Finite.** A value is a finite structure: finitely many tuples, each of finite
  arity, with atoms of finite byte length. There are no infinite or lazy values.
- **Well-founded (acyclic).** The child relation is well-founded: a value is a
  finite tree, not a graph. No value contains itself, directly or transitively.
  (Sharing — representing equal subtrees once — is an implementation matter, §6;
  it is unobservable and never makes a value cyclic.)
- **Immutable.** A value does not change. "Modifying" a value produces a different
  value. Identity (§3) is therefore stable across copying, transport,
  serialization, deserialization, caching, and re-materialization.
- **Closed / context-free.** A value carries no ambient context: no address, no
  owner, no creation time, no validity, no provenance, no environment. A value is
  fully determined by its own structure (§1) and nothing else.
- **Complete (ground).** Every value is whole. There is no "hole," placeholder, or
  unknown within a value. (The *variable* — the unknown — is precisely what L0
  excludes; it is reasoning's addition, and it lives in logos. See §7 and
  [0003](../design/0003-layered-architecture.md).)

## 3. Identity — when two values are the same

Identity is **structural**. It is the keystone invariant of the entire model;
every higher layer and every consumer inherits it unchanged and MUST NOT redefine
it.

Two values are equal iff one of the following holds:

```text
Atom(b) = Atom(c)
    iff  b and c are the same finite byte string (octet-for-octet).

Tuple(x₀, …, xₘ₋₁) = Tuple(y₀, …, yₙ₋₁)
    iff  m = n  and  xᵢ = yᵢ for every i (recursively, by this same relation).

Atom(_) ≠ Tuple(_)
    always — the two constructors are disjoint.
```

No other values are equal. In particular:

- **`Atom("")` ≠ `Tuple()`.** Empty bytes and the empty tuple are different
  values. (Neither is "null.")
- Equality is **not** coarser than structural: L0 does **not** decide that
  `Atom(0x01)` and `Atom(0x0001)` are equal, that `Tuple(a, b)` equals
  `Tuple(b, a)`, that two differently-encoded texts are equal, or any other
  semantic equation. Any such equation would import a consumer's theory (numbers,
  sets, text normalization) and is therefore excluded. (Domains wanting such
  equations define a **canonical embedding** and normalize at the producer — L2,
  §7 — never an L0 equality.)
- Equality is **not** finer than structural: two values with identical structure
  are the same value regardless of memory address, allocation history, sharing,
  encoding, storage location, or who produced them. There is **no object identity**
  and **no hidden identity bit**.

### 3.1 The asymmetry principle (rationale, normative in effect)

L0 uses the **finest consumer-agnostic equality** that exists: structural
equality. This is forced, not chosen. A coarser equality smuggles in some
consumer's semantics; a finer one smuggles in representation or object identity.
And the asymmetry is decisive: a higher layer can always **collapse** distinctions
the floor preserved (by normalizing or quotienting *in that layer*), but it can
**never recover** a distinction the floor erased. Therefore the floor MUST
distinguish maximally and quotient never.

A direct corollary: **values are already in normal form.** L0 defines no reduction
or rewrite relation. There is nothing to simplify; a value just *is* its structure.

## 4. Well-formedness

Every term generated by the §1 grammar is a well-formed value. There are **no**
L0-level validity predicates beyond the grammar itself — no "the first child must
be an atom," "these bytes must be valid UTF-8," "this tuple must have even arity,"
"this label is reserved." Such conditions are L1/L2 *recognition* (§7) or consumer
schema, never L0 well-formedness.

Consequences:

- An implementation decoding or constructing a value MUST accept any finite,
  acyclic `Atom`/`Tuple` structure as a valid value.
- An implementation MUST NOT reject a value, or alter its identity, on the basis
  of any interpretation of its atoms or its shape.

## 5. Resource bounds (operational, not semantic)

The abstract model permits atoms of any finite length and tuples of any finite
arity and depth. Real implementations have limits (memory, transport, stack).

- Limits are **operational policy**, not part of valuehood. A value rejected by a
  small implementation for exceeding a limit is still a value; another
  implementation MAY accept it.
- An implementation MAY impose and document limits (max atom length, max arity,
  max depth, max total size) and MUST fail safely (reject, do not truncate or
  silently alter) when a value exceeds them.
- Limits MUST NOT be presented as L0 semantics, and two conforming implementations
  with different limits do not thereby disagree about *which structures are
  values*.

## 6. Representation freedom (non-normative guidance)

The value is the abstract finite tree. How an implementation stores it in memory
is unconstrained, provided observable identity (§3) is preserved:

- Equal subtrees MAY be shared (hash-consed) or duplicated — unobservable.
- Atoms MAY be interned; small atoms or recognized `ontos/data` values (§7) MAY be
  stored unboxed. These are efficiency choices, not new sorts and not new
  identity.
- A value MAY be held as a DAG internally; it still denotes the finite tree. `μ`
  (cyclic) representations are forbidden because cycles would denote a non-value
  (§2).

## 7. What L0 deliberately excludes (and where each lives)

Each of the following is excluded from L0 because it fails the *agnostic* half of
the inclusion filter — a reasoning engine, a store, and an authority substrate
would not all want it the same way — and therefore belongs to a higher ontos
profile or to a specific consumer. (Inclusion rationale and governance:
[0003](../design/0003-layered-architecture.md).)

| Excluded from L0 | Lives in |
| --- | --- |
| Byte encoding / canonical bytes / hashing | `ontos/codec` (side axis) |
| The labeled-compound reading (`label(args…)`) | `ontos/compound` (L1) |
| Integers, text, bool (canonical embeddings) | `ontos/data` (L2) |
| Maps / sets / records | `ontos/data` (L2; `map` reserved, defined after codec) — or a consumer |
| Numeric equality, arithmetic, ordering, total order over values | logos / math / domain layer |
| Variables (the unknown), unification, rules, proof, truth | logos |
| Schema, types, validation, required fields | a schema layer above ontos |
| Facts, claims, signers, attestation, trust, time | arche / an authority layer |
| References, links, addresses, content-addressing, Merkle edges | a storage layer |

A value whose label or shape *happens to look like* one of these (e.g.
`Tuple(Atom("int"), …)`) is, at L0, **only** a tuple whose first child is an atom.
Meaning is conferred by a recognizing layer, never by L0.

## 8. Conformance vectors

L0 conformance is pinned by a shared vector set, published at
[vectors/identity.json](../../vectors/identity.json) (with the format described in
[vectors/README.md](../../vectors/README.md)). It covers:

- **Identity — equal:** structurally identical values compare equal regardless of
  construction path or sharing (§3, §6).
- **Identity — distinct:** `Atom("") ≠ Tuple()`; arity differences; order
  differences (`Tuple(a,b) ≠ Tuple(b,a)`); multiplicity; nesting differences
  (`Tuple(a) ≠ a`, `Tuple(Tuple(a,b)) ≠ Tuple(a,b)`); atom byte differences
  including length (`Atom(0x01) ≠ Atom(0x0001)`); `Tuple(Atom("")) ≠
  Tuple(Tuple())`.
- **Atom/Tuple disjointness** across empties and non-empties.

A conforming L0 implementation MUST agree with the vectors on every equal/distinct
judgment. The vectors are expressed against the abstract value set (an authoring
notation, **not** ontos's canonical bytes); the byte-level vector form lives in
[vectors/codec.json](../../vectors/codec.json) with `ontos/codec`. As of this
writing the vectors are replayed green by the `go`, `rs`, and `ts` implementations
under [core/](../../core/) and [codec/](../../codec/).

---

> **Frozen-floor note.** This layer is intended never to change. New capability is
> added *above* L0 (new `ontos/data` embeddings, new consumer layers), never *to*
> L0. If a future need seems to require changing L0, the default answer is that it
> is a higher-layer concern — re-derive it against the inclusion filter before
> touching the floor.
