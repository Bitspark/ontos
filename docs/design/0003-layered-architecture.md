# ontos — layered architecture

**Status:** decided. Builds directly on the convergence result
([0002](0002-convergence-test-result.md)) and its frozen core. Records the
layering that lets ontos host useful shared conventions *without* weakening the
floor the panel converged on.

> **Forward-note (2026-06-01) — `map`/`set` have since shipped.** This ADR is a
> dated, point-in-time record; its body below describing `map` as *reserved /
> deferred* (the "Sequencing — codec before map" discussion and the L2 list) was
> accurate when written. `ontos/codec` was subsequently frozen as `ontos-codec-v1`,
> and `map` (§5.7) **and** `set` (§5.8) were defined and **frozen 2026-06-01**. For
> the shipped state see [`docs/spec/ontos-data.md`](../spec/ontos-data.md). Per the
> repo's convention, ADRs are historical decisions, not living docs — the original
> text below is preserved unchanged; read it as "as of the decision," with this note
> as the only pointer to the current state.

## The governing rule

> **Every higher ontos layer is a *conservative extension*: it adds vocabulary
> and *readings*, projects totally back down to the floor, and must never add a
> new value and never change identity.**

A "layer" that cannot be expressed as floor values is not a layer — it is a fork,
and it breaks the interpretation-agnostic carriage the whole model rests on.

## Direction discipline (the precise shape)

```text
Downward projection: TOTAL.
    Every L1 / L2 value IS an L0 value. No exceptions.

Upward recognition: PARTIAL, single-valued, deterministic.
    Only some L0 values are recognized by a higher layer; recognition is a
    partial function L0 ⇀ L_n. A given L0 value is recognized as at most one
    thing under a given profile.

Identity: INHERITED FROM L0, ALWAYS.
    Recognition never changes equality. Two values are the same iff they are the
    same L0 value. No higher layer may define its own equality.
```

The inverse of "downward is total" must **not** hold: not every L0 value is an L1
compound; not every L1 compound is an L2 integer; not every tuple whose first atom
looks like a label is meaningful to a given convention. Recognition is allowed to
say "I don't recognize this" — and the value is still a perfectly good L0 value.

## Identity lives at the floor, forever

This is the single anti-rot invariant. Structural identity is defined **only at
L0**; every higher layer inherits it unchanged. Higher layers may define a
**canonical form** (a producer-side normalization) but **never their own
equality** (a quotient). The asymmetry principle decides this: upper layers can
always collapse distinctions, but can never recover a distinction the floor
erased — so the floor must distinguish maximally and quotient never.

## The layers (conformance profiles, not one expanding ontology)

### L0 — `ontos/core`  *(necessary AND agnostic)*

```text
Value = Atom(Bytes) | Tuple(Value*)
```

Structural identity. Finite, immutable, well-founded (acyclic), closed,
uninterpreted. No intrinsic scalars, no variables, no schema, no privileged
label. This is the panel result, pinned by conformance vectors across languages.
*Agreement is a theorem here.*

### `ontos/codec` — canonical byte encoding *(side axis, not a higher layer)*

A versioned, subordinate spec: how to turn **any** L0 value into canonical bytes
(for hashing, transport, content-addressing by consumers). It is `L0 → bytes`. It
is **not** semantic and **not** a higher layer of the value model — it sits on an
orthogonal axis. Distinct from `ontos/data` (see below): codec is *how values
become bytes*; data is *which L0 values mean something*.

### L1 — `ontos/compound`  *(agnostic convention; the labeled-compound reading)*

A recognized compound is `Tuple(label, child*)`, where `label` is an ordinary
`Atom`. This is a **naming convention over L0** — not a type system, not schema,
and **not yet a logic term**. The label is an ordinary value made special only by
this reading; L0 still sees "a tuple whose first child is an atom." logos may read
the same shape as `functor(args…)`, but ontos does not require that reading, and
ontos assigns **no meaning** to any particular label.

(Naming note: deliberately *not* `ontos/term` or `ontos/type` — "term" pulls logos
back into ontos; "type" pulls schema/validation back in. ontos is neither.)

### L2 — `ontos/data`  *(agnostic registered embeddings)*

A registry of **known labels** with canonical embeddings into L0:

- **v1: exact integer, utf-8 text, bool** — each self-contained (specifiable with
  no dependency on anything outside L0);
- **`map`: reserved, deferred (see "sequencing" below)** — the label is reserved
  now so no consumer squats it, but its normalization depends on `ontos/codec`;
- **normalization rules for producers** (canonicalize before emitting);
- **suggested unboxed representations for implementations** (e.g. a Rust enum may
  store a recognized `int` unboxed) — an efficiency hint, *not* a foundational
  sort;
- **no new equality.**

**Sequencing — codec before map.** `int`/`utf8-text`/`bool` are self-contained
and ship in `ontos/data` v1. A canonical `map`, by contrast, must **sort its
entries by key**, and keys are arbitrary L0 values — so map-normalization needs a
**total order over all ontos values**, which the panel deliberately kept *out* of
L0. The clean resolution is "canonical map order = `ontos/codec` byte order," but
that means **`map` cannot be finalized until `ontos/codec` is fixed.** So `map` is
*reserved now, defined after codec* — honoring the data-interchange dissent (no
consumer invents a rival `map`) without forcing premature codec decisions or
smuggling a total order into the floor.

Non-canonical surface forms are **not** "equal L2 values" — they are simply **not
well-formed L2 values of that kind**, while remaining valid L0 values:

```text
Tuple(Atom("int"), 0x01)     → canonical L2 int (the integer 1)
Tuple(Atom("int"), 0x0001)   → a valid L0 value, NOT a well-formed L2 int
normalize(...)               → producer-side operation, NOT an equality claim
```

So a reader never declares `int(0x0001) = int(0x01)`. Producers normalize before
emitting; what is stored and exchanged is already canonical; a reader encountering
a non-canonical spelling treats it as an unrecognized compound, not as a quotient-
equal integer. This is the convergence result's "no reduction relation / values
are already normal forms," applied: domains wanting equations like `2/4 = 1/2`
define a canonical embedding and normalize at the producer.

## Governance (prevents `ontos/data` from becoming the new floor by social pressure)

```text
L0 conformance must NEVER require L1 or L2.
L1 conformance must NEVER require L2.
L2 labels MUST be ignorable by L0/L1 consumers (carry, compare, round-trip
    unchanged without recognizing them).
Each profile is independently versioned and independently adoptable.
```

## Membership test (the same filter, dialled per layer)

```text
L0:
    necessary AND agnostic.

Higher ontos profiles (compound, data):
    not necessary, but agnostic + lossless + ignorable + identity-preserving.
    Qualifies only if: every recognizer reads it the same way, AND non-recognizers
    can safely carry / compare / round-trip it unchanged.
    (NOT "every consumer would want it" — most consumers won't care about int or
    utf-8, and that's fine.)

Consumer layers (NOT ontos):
    any convention whose meaning depends on a particular engine, authority model,
    reasoning semantics, validation regime, or domain theory.
```

Worked classification:

```text
exact-int canonical embedding      → ontos/data (OK)
utf-8 text canonical embedding     → ontos/data (OK)
decimal-as-representation          → ontos/data (OK, representation not arithmetic)
map embedding                      → ontos/data (OK as convention; NOT an L0 primitive)
variable                           → logos (only reasoning wants it)
unification variable               → logos
numeric equality / arithmetic / ordering → logos / math / domain layer (NOT ontos identity)
fact, claim, signer, timestamp     → arche / authority layer
schema, record validation, required fields → schema layer above ontos
```

## Two consequences worth stating explicitly

**1. logos's `Term` = `ontos Value ⊎ Variable`** (precise form). A logos term is
"an ontos value, possibly with holes": its atoms come from L0, its compounds from
`ontos/compound`, its numbers/text from `ontos/data`, and the **variable** is the
one genuine addition — the thing only reasoning needs. Substitute every hole away
and a logos term is *literally* an ontos value (identity, not conversion):

```text
ground logos Term  ≡  ontos Value
```

(So the looser phrasing "`ontos/compound` + variables" undercounts — logos terms
also include bare atoms and `ontos/data` numbers. The relation is subset/superset,
not a single layer plus one sort.)

**The variable is a genuine new sort *in logos*, NOT an ontos value under a
reserved label.** A live variable is precisely the thing that is *not* ground or
complete — and ontos values are by definition ground and complete, which is *why*
the variable lives in logos and not ontos. Encoding a variable as
`Tuple(Atom("var"), …)` at the ontos level would force logos to **reserve the
label `"var"`**, colliding with any consumer that has legitimate data about
something named `var` — exactly the leak the model refuses.

**Reification is the exception, and it's clean.** When a term-with-holes must be
shipped as *ground data* (e.g. arche storing a *rule* as a fact), the variable is
**quoted** into an ontos value — `Tuple(Atom("var"), name)` — which is a being,
distinct from the live variable. So: *live* variable = genuine logos sort; *reified*
variable = ontos value under convention. (This is exactly arche-core's existing
`quote`/`vvar` pattern.) The "functor *is* the type" idea survives as a *reading*
in `ontos/compound`; it is not a type system, and a logic term's numeric theory
stays in logos.

**2. The one surviving panel fork (`Map`) is resolved by layering.** L0 excludes
`Map` (panel majority: it imposes quotient equality → fails agnostic at the floor).
But the data-interchange dissent — "consumers need a standard unordered
association or they'll each invent one" — is satisfied at **L2**: a standard `map`
embedding (`Tuple(Atom("map"), Tuple(k,v), …)` with sorted-unique-key
normalization) can live in `ontos/data`, recognized by those who want it,
ignorable by those who don't, with **identity still inherited from L0** (so two
maps with the same entries in different orders are the *same value* only if the
producer normalized — never by an L2 equality rule). L0 stays austere; the
convention is available; no quotient is introduced. The fork dissolves.

## Notes for migration & vocabulary

- **ontos drops `Nil`.** plexis `Pure` has three sorts — `Nil | Bytes | Compound`
  — but the converged L0 is two — `Atom(Bytes) | Tuple`. There is **no `Nil`**:
  the panel showed `Tuple()` (the empty tuple) or a conventional atom serves every
  role `Nil` did. Consequence for migration: the plexis→ontos port must map
  `Pure::Nil` onto a chosen convention (likely `Tuple()`), and decide it once.
  (arche `DataNode` has no nil, so only plexis is affected.) `Atom("")` and
  `Tuple()` remain distinct values — neither is "null"; higher layers assign such
  meanings.
- **Vocabulary: "the unknown" = "variable".** The logos README calls it "the
  unknown"; this doc calls it "variable." Same concept. Prefer **"variable (the
  unknown)"** in technical text — the ontological phrasing fits the being/account
  framing, the precise term keeps it unambiguous against logic-programming usage.

## Final architecture

```text
ontos/core      L0   Value = Atom(Bytes) | Tuple(Value*); structural identity; no interpretation
ontos/codec      –   canonical byte encoding of any L0 value; versioned, subordinate, NOT semantic
ontos/compound  L1   reading of Tuple(Atom(label), args…); labels are ordinary atoms; shape only, no validation
ontos/data      L2   registered canonical embeddings (int, utf8-text, …); producer normalization;
                     impl unboxing hints; NO new equality
```

ontos stays agnostic because higher layers are not extensions of *identity*; they
are disciplined *readings* of already-existing values.
