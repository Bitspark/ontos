# ontos/compound (L1) — the labeled-compound reading

**Layer:** L1 (`ontos/compound`). **Status:** **frozen** (the reading is fixed;
it adds no values and no identity). A *reading* of `ontos/core` (L0) values, not a
new value kind. See [design/0003](../design/0003-layered-architecture.md) for the
layering rationale.

`ontos/compound` is the single, minimal convention that lets an L0 `Tuple` be read
as a **labeled compound** — `label(child*)`. It is the reading
[`ontos/data`](ontos-data.md) (L2) builds its embeddings on, and the reading
logos's logic terms use (`functor(args)` ≅ the compound below). It introduces
**one** idea: *the first child of a tuple may be read as a label.* Nothing more.

The keywords MUST, MUST NOT, SHOULD, MAY are used in the IETF sense.

> **Decision (2026-06-03) — L1 `compound` is intentionally spec-only; there is no
> `compound/` code module.** Unlike `ontos/core` (L0) and `ontos/data` (L2), which
> ship `core/{go,rs,ts}` and `data/{go,rs,ts}`, `ontos/compound` ships only this
> spec. *Rationale:* L1 adds **no values and no identity** — it is a *reading* of L0
> values (the "first child may be a label" lens, §1/§3), not a new value kind. A
> conformant `is_compound` / `label` / `args` is a total function of an L0 `Value`
> (§7), and it is exercised **transitively** by every `ontos/data` embedding (each
> is a recognized compound) and by logos's logic terms. A dedicated module would add
> surface — a third package per language, its own version, its own publish — without
> adding any behavior the layers above do not already exercise. Per the project's
> austerity, that surface is **not** built. A module would be warranted only if a
> concrete consumer needed a standalone `is_compound`/`label`/`args` API *without*
> depending on `ontos/data` (none does today); until then, the spec is the whole of
> L1.

---

## 1. The reading

A `ontos/core` value is a **recognized compound** iff it is a `Tuple` whose **first
child is an `Atom`**:

```text
compound  ⇔  Tuple(Atom(label), child₀, …, childₙ₋₁)   with n ≥ 0
```

- **`label`** = the bytes of that first `Atom`. The remaining children
  `child₀…childₙ₋₁` are the **arguments**, in order.
- A compound with **zero arguments** (`Tuple(Atom(label))`) is a well-formed
  *nullary* compound — the L1 reading of `label()`.
- `functor(arg₀, …)` ≅ `Tuple(Atom(functor), arg₀, …)`. This equivalence is the
  whole of L1.

L1 assigns significance to the **label slot** (that child₀ is "the label") but
assigns **no meaning to any particular label**. `int`, `parent`, `pair` are all
just atoms; what they *mean* is L2 (`ontos/data`) or a consumer.

## 2. What is NOT a recognized compound

These are all perfectly valid L0 values; they are simply not *read* as compounds:

- **`Atom(b)`** — an atom is not a tuple.
- **`Tuple()`** — the empty tuple has no first child, so no label.
- **`Tuple(Tuple(…), …)`** — first child is a tuple, not an atom: no label slot.

A consumer that does not recognize a value as a compound treats it as an ordinary
L0 value, unchanged. (An argument *may itself* be a compound — the reading is
recursive on the children that happen to be compounds — but the reading never
*requires* an argument to be one.)

## 3. Identity is L0's, unchanged

L1 defines **no equality** and **no canonical form** of its own. Two compounds are
the same value iff they are the same L0 value (structural identity —
[ontos-core §3](ontos-core.md)). Reading a tuple as `label(args)` changes nothing
about its identity or its bytes; it is a *lens*, never a transform. In particular
the label is an ordinary first child — `Tuple(Atom("p"), x)` is one specific L0
value, and "relabeling" means building a different value, not mutating this one.

## 4. Recognition is partial and opt-in

A consumer recognizes the labels it cares about and ignores the rest; recognition
is a partial function from L0 values to "compound or not." There is **no global
registry of labels at L1** — that is L2's job (`ontos/data` registers *meaningful*
labels like `int`). L1 only says *how* a label is carried, not *which* labels
exist.

## 5. Relationship to the neighboring layers

- **Below — `ontos/core` (L0):** a compound *is* a `Tuple(Atom, …)`. L0 sees only
  a tuple whose first child is an atom; it knows nothing of "labels."
- **Beside — `ontos/codec`:** a compound encodes exactly as its underlying L0
  value (`0x01 ‖ uvarint(arity) ‖ children`); L1 adds no bytes.
- **Above — `ontos/data` (L2):** an embedding is a *recognized compound with a
  registered label* and a fixed payload shape (e.g. `int(Atom(bytes))`). Every L2
  value is an L1 compound is an L0 value.

## 6. What `ontos/compound` is not

- **Not a value kind.** It adds nothing to `Value = Atom | Tuple`.
- **Not a type system or schema.** It does not constrain arity, argument shapes,
  or which labels are legal. A consumer/L2 does that.
- **Not new equality or canonical form.** Always L0 structural identity (§3).
- **Not a label registry.** Naming meaningful labels is L2.

## 7. Conformance

An implementation conforms to `ontos/compound` iff `is_compound(v)` is true exactly
when `v` is a `Tuple` with a non-zero arity whose first child is an `Atom`, and its
`label`/`args` accessors return that first atom's bytes and the remaining children
in order — with the underlying value and its identity unchanged. (No separate
vector file is required: L1 is a total function of the L0 value, exercised
transitively by every `ontos/data` vector in [`vectors/data.json`](../../vectors/data.json),
each of which is a recognized compound.)
