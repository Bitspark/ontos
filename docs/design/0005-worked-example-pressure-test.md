# 0005 — Worked-example pressure test (arche fact + logos clause through L0/L1/L2)

**Status:** findings, not new decisions. Stress-tests the frozen core
([ontos-core.md](../spec/ontos-core.md)) and the layering
([0003](0003-layered-architecture.md)) by pushing two *real* consumer inputs all
the way down to L0, independently, and measuring where independent encoders
disagree. Divergence = under-specification. Confirms the floor; localizes the
remaining open work to a small, named set of L2 embeddings.

## Method

The test: take two real inputs and have **five independent encoders express each
as a concrete L0 value**, each blind to the others, each given only the
architecture (L0/L1/L2 rules) — not each other's answers. Where blind encoders
produce **structurally non-equal** L0 trees for the same intended thing, the
architecture failed to force one answer: that is exactly a future "two honest
systems disagree on identity/hash" break, found on paper. The five encoders were
deliberately diverse traditions (literalist, Prolog/Herbrand, data-interchange,
austerity-minimalist, arche-native).

The inputs (verified shapes from source, not invented):

- **A real arche fact** (`arche-core` `fact.ts`): `{ spacePath: string[],
  asserter: bytes[32], predicate: string, body: Term[], signature: bytes[64] }`
  with `body = [bytes(grantee), str("assert"), str("member"), int(-1)]` — the
  negative int a deliberate stress case for the bytes-only floor.
- **A real logos Horn clause:** `path(X, Z) :- edge(X, Y), point(Y, Z, 42).` —
  exercising variables, a clause, a body conjunction, and an int.

> **Provenance caveat.** The exercise was run as a multi-agent workflow. Some of
> its internal agents fabricated repo citations (a non-existent "fact = parent(tom,bob)"
> example, a non-existent clause-as-tuple example). Those specifics are **discarded
> here**; this document keeps only the encoder outputs (the actual divergences) and
> claims re-verified against real files ([ontos-core.md](../spec/ontos-core.md),
> logos-contract.md, and
> logos 0001-agnostic-shared-contract.md).

## Verdict

**The floor survives; the floor is not yet a contract.** L0 held under five blind
encoders with **zero violations** — nobody invented a sort, a scalar, a variable
primitive, or a new equality; the integer (the single hardest temptation) went
*inside* an `Atom` every time. But above the floor, the *same* fact and clause
produced structurally non-equal trees, because the embeddings L2 *promises* ("each
known label has one canonical embedding") were not yet *written*, so five honest
readers filled the vacuum five ways. Every break is a **missing registry entry,
not a flaw in the floor.**

## What the architecture successfully forced (the agreements)

These convergences happened with no communication between encoders — evidence the
constraints are real, not vacuous:

- **L0 sort discipline.** Only `Atom(bytes)` / `Tuple`; no new sort; the i64 went
  into an atom, not a number sort. "No intrinsic scalars" survived its hardest test.
- **The `ontos/compound` (L1) reading is natural.** All five used
  `Tuple(label, child*)` with the label a **bare atom**, applied uniformly; functor
  / predicate names were never wrapped as text.
- **Arity-by-position and order-by-position** were unanimous (path/2, edge/2,
  point/3 carry arity as tuple length; conjunction and list order carried by child
  order; nobody used a set). The L0 "arity and order are identity" rule projects
  cleanly into logos's functor reading.
- **Variable identity by name** was unanimous (repeated `X`/`Y`/`Z` are
  byte-identical subtrees → intra-clause sharing falls out of L0 structural
  equality). *Caveat:* all five reified the variable as `Tuple(Atom("var"), name)`
  — which `logos-contract.md` §1 explicitly forbids as a *live* term (see below).
- **The codec axis stayed orthogonal:** no encoder smuggled framing/length-prefix
  into the value trees.

The throughline: **wherever the floor's identity rules touch a decision, encoders
converged; wherever a label needed a canonical embedding L2 hadn't written, they
diverged.** That is the design working *and* the precise boundary where it stops.

## The divergences, sorted into three buckets

Sixteen divergence points were found. They sort cleanly by *who owns the fix*.

### Bucket 1 — Dissolved by `logos-contract.md` (not ontos's problem, and already decided)

The clause input produced ~half the divergences (clause root label `clause` vs
`:-`; conjunction wrapper `and`/`list`/bare; empty-body three ways;
`Tuple(var,…)` shapes). **Most of these were a category error in the test
itself.** Per logos-contract.md:

- A **Clause is a host struct** `{ head, body: Vec<Atom> }`, *not* an ontos value;
  the conjunction is "just the body vector; empty body = the n=0 case." There is no
  tuple to label → the clause-label / conjunction / empty-body divergences **do not
  arise**.
- A **`Var` is a genuine term constructor, explicitly NOT `Tuple(Atom("var"), …)`**
  — encoding it that way "would force logos to reserve the label `var`, colliding
  with consumer data — the leak the model refuses." All five blind encoders did the
  forbidden thing; the contract's non-obvious answer is the right one. A clause
  becomes an ontos value only via the single `quote` operation (one canonical
  reification, not five opinions).

*Finding:* this is a strong vindication of the contract — it pre-decided exactly
where naïve encoders (even five expert ones) diverge. It is also a **discoverability
problem**: the encoders contradicted a spec they couldn't see. (See "Edits" below.)

### Bucket 2 — arche's storage layer, not ontos (real, but correctly out of scope)

The fact produced **two skeletons**: positional `Tuple(fact, …)` (four encoders)
vs. a keyed `map` with materialized field-name atoms (interchange). Different root,
different arity, different children → non-equal → different hash → the fact's own
**signature breaks** across the two.

This is real, but it is **arche's** concern: "how a fact is laid out for signing"
is arche's `DataNode`-on-ontos storage codec, not ontos. ontos-core §7 and
0003 already place facts/attestation in the consumer layer. The *generic* lesson
that ontos owes (record-vs-map) is captured as a principle below; the *fact shape*
is arche's to pin.

### Bucket 3 — Real, still-open, and genuinely ontos's (L2 / `ontos/data`)

These are the ground-value arguments that legitimately travel L0→L2. They are the
actual remaining work, and they are exactly what `ontos/data` exists to settle:

- **R1 — integer (critical, widest blast radius).** `-1` was emitted three
  pairwise-non-equal ways: `Atom(FF)`, `Atom(FFFFFFFFFFFFFFFF)`, and a
  `Tuple(int, "-", 01)` sign-magnitude triple. The single most-used scalar gets
  multiple identities. *Direction:* one canonical form — minimal-length big-endian
  two's-complement in a single atom, **zero = empty atom**, no redundant
  leading `00`/`FF`. Reject fixed-width and sign-magnitude. (The integer *domain*
  is also flagged open in `logos-contract.md` §9 and 0004.)
- **R3 — text and bytes tagging (critical, most insidious).** `grant` was bare
  `Atom(…)` for one encoder, `Tuple(str, …)` for four; same split for spacePath
  segments and for the top-level asserter/signature. Because **`Atom ≠ Tuple`
  always**, these are different *sorts*, not spellings — no read-time coercion can
  reconcile them, and it breaks the signed bytes directly. *Direction:* always
  self-tagged and **context-independent** (`Tuple(Atom("str"), Atom(utf8))` /
  `Tuple(Atom("bytes"), Atom(octets))`), including inside known-homogeneous lists.
- **R4 — list/sequence shape (critical, self-poisoning).** Lists were
  `Tuple(list, elem*)` (four) vs. bare `Tuple(elem*)` (one). The bare form is
  *L1-indistinguishable from a compound* `x(y)` — so it isn't even self-describing.
  *Direction:* register `list` as `Tuple(Atom("list"), elem*)`; forbid the bare
  form precisely because it collides with the compound reading.

## The one principle these three share

> **Canonical form is a property of the value, never of its position.**

R1, R3, and R4 are all the same defect: an encoder let *context* ("this slot is
known to be text / a list") decide the shape, dropping a tag or a label. But L0
identity is purely structural and context-free, so any position-dependent canonical
form silently forks identity across sites. This single rule belongs at the top of
the `ontos/data` spec; it kills R3 outright, half of R1 (no per-site width), and
makes upward recognition context-free.

## One genuinely new gap (not in 0003): the L2 label namespace

A user functor literally named `int` / `list` / `map` encodes to the *same* L0
shape as the L2 kind embedding. At **L0 this is not an identity break** (bytes are
identical — ontos-core §7 is explicit: such a value "is, at L0, only a tuple whose
first child is an atom"), so it is not a floor problem. But **upward recognition
forks**: one consumer recognizes the reserved kind and may normalize/reject; another
treats it as opaque user data. 0003's governance covers "L2 must be ignorable" but
not "L2 reserved labels must be provably disjoint from user functors." *Direction
(for the L2 spec):* the registry — the only layer introducing reserved vocabulary —
carves a reserved sub-namespace (e.g. a label byte-prefix) so "is this kind K?" is
decidable independent of any user's chosen names.

## Edits this motivates (concept-level; no new floor decisions)

1. **Write `ontos/data` (L2) as actual embeddings, not a promise** — at minimum
   `int`, `str`, `bytes`, `list`: the exact L0 tree, the producer normalization,
   and the explicit non-canonical spellings, per label. This is the single
   highest-value next artifact; it closes every Bucket-3 break.
2. **Put "canonical form is a property of the value, not its position" at the top
   of that spec.**
3. **Add the L2 label-namespace rule** (reserved sub-namespace, disjoint from user
   functors) to the L2 spec / 0003 governance.
4. **Make `logos-contract.md` discoverable/binding** for the clause/var vocabulary
   — Bucket 1 shows even expert encoders contradict it when they can't see it. (The
   `Var`-is-not-`Tuple(var,…)` rule is the highest-value thing to surface loudly.)
5. **Record the record-vs-map principle** (closed fixed schema → positional
   compound, field names in the registry not the value; open key set → `map`) so
   arche's fact-shape decision (Bucket 2) has a generic rule to follow — noting
   `map` itself is still gated on `ontos/codec` (0003).

## Relation to the logos ADRs and the issue graph (added after this test)

This test pre-dates several things that have since landed; it is consistent with
all of them, and they sharpen its conclusion:

- **logos ADR 0001
  ratifies the account grammar as invariant** — and *only* that: the `Rule |
  Theory | Leaf` closed-positive DAG + verdict taxonomy is fixed (status:
  **accepted**), forced by arche's "check, never search." That is *exactly* the
  positive-Horn account this test pushed through L0/L1/L2, so the test's Bucket-1
  conclusion is now backed by a decision, not just by `logos-contract.md`: the
  clause/variable half is settled at the logos layer and is not ontos's to fix. The
  architecture-level "freeze-before-decide" gate (logos) is **closed** — building
  vectors on the account is unblocked.
- **The overall architecture is NOT yet decided.** The 0001⊕0002 hybrid (closed
  positive core + conformance-pinned Theory/Leaf/Context seams + rings) is a
  *recommendation* — logos ADR 0002,
  status **proposed**, explicitly pending validation against a genuine non-arche
  consumer. Only the account invariant (ADR 0001) is hard-decided; engine search
  strategy, ring structure, and storage remain open. Nothing in this test depends on
  the architecture choice — it tested the account + the value layers, both stable
  regardless of which architecture wins.
- **The remaining Bucket-3 work is entirely ontos-side and below the account.** The
  ADR freezes the codec *in ontos* and puts it on the parity surface; ontos-internal#4 establishes the codec is a
  *soundness dependency* (arche signs over it; logos hashes leaves/clauses through
  it). **Sequencing correction:** the L2 embedding table is therefore **downstream
  of `ontos/codec`**, not the immediate next step — the canonical bytes the table's
  normalization rests on are fixed by the codec. The right order is **codec →
  L2 table** (and `map` is codec-gated regardless, per 0003).

Bucket 3 also maps onto open ontos issues: R1 ↔ the integer domain in ontos-internal#4 and
`logos-contract.md` §9; the L2-label-namespace gap is the recognition-disjointness
concern; the record-vs-map principle is the generic rule under arche's fact-shape
(Bucket 2).

## Bottom line

The pressure test confirms the **frozen floor is sound and teachable**, confirms
the **logos contract dissolves the clause/variable half** (now ratified by logos
ADR 0001), and localizes the remaining ontos work to the **`ontos/data`
canonical-embedding table for `int` / `str` / `bytes` / `list`**, governed by the
value-not-position rule and a reserved label namespace. The corrected sequencing is
**`ontos/codec` first, then that L2 table** (ontos-internal#4): the codec is the
security-critical artifact every embedding's canonical bytes depend on.
