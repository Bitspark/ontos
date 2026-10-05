# ontos convergence test — result

**Status:** scored against the sealed prediction
([0001](0001-convergence-test-sealed-prediction.md)) *after* all four panel
responses arrived. Where our sealed prediction was wrong, this document says so
plainly rather than retrofitting it as "what we meant."

**Panel:** four independent proposers, blind to each other and to the sealed
prediction, each given only one answer-free brief from a different intellectual
tradition — logic programming, data interchange, knowledge representation,
programming-languages / type theory. Responses in
[`convergence-panel/responses/`](convergence-panel/responses/).

---

## Verdict: STRONG PASS — the core is *discovered*, safe to freeze

All four converged, from four directions, on the same foundation:

- **One uniform value**, no primitive/structured divide. Three of four wrote the
  identical formalism `μX. Bytes + List(X)`; three explicitly invoked the
  Herbrand universe / free term algebra.
- **Structural identity is the keystone** — every panelist named it first and
  derived it as *forced*: coarser equality smuggles in a consumer's theory; finer
  equality smuggles in representation/object identity.
- **Immutability + finiteness + well-foundedness** all derived as forced
  (well-foundedness was *not* in our sealed list — see surprises).
- **Interpretation-agnostic carriage** — an unrecognised structure is still a
  well-formed value; meaning lives above.
- **Exclusions** — unanimous, and exactly our sealed list: no truth/variables, no
  authority/signing, no hashes/addressing, no time, no schema; encoding ≠ meaning.
- **Canonical encoding kept *beside*, not *in*, the model** — all four, unprompted,
  said standardise one canonical codec as a separate, subordinate, versioned spec.

By the committed rule (≥4/5 core, identity + uniformity mandatory, splitting only
on A/B/C) this is a decisive strong pass. The convergence of four independent
traditions is the evidence we wanted before freezing.

## Where our sealed prediction was WRONG (recorded, not retrofitted)

1. **Exactness — prediction #3 was half-wrong.** We sealed "integers are exact and
   unbounded; no floating point," framing exactness as *keep exact ints in, keep
   floats out*. **All four panelists keep NO numbers in the foundation at all,
   not even integers.** Their argument is stronger and is our *own* filter turned
   on us: a foundational `Int` forces commitments on encoding, sign, leading
   zeros, bounds, `1` vs `01` — so integers fail the **agnostic** test, exactly as
   floats do. Numbers (all of them) are a consumer layer of tagged bytes.
   **Decision (user): adopt the panel's stricter position — bytes-only, zero
   intrinsic scalars.**

2. **Divergence axis B was not a fork.** We predicted "small intrinsic scalar set
   vs. bytes-only" as a genuine 50/50 with our lean toward a small intrinsic set.
   **Unanimous: bytes-only.** The fork collapsed and our lean was overturned.

## The divergence axes (A/B/C) — outcome

- **A — child structure (positional vs. named): our lean CONFIRMED, near-forced.**
  All four make the *ordered product* the primitive with order part of identity.
  Three pick `Atom + Tuple` outright; the interchange lens adds `Map` (see the
  surviving fork) but still treats ordered sequence as primitive.
- **B — leaf inventory: COLLAPSED to bytes-only** (see wrong-prediction #2).
- **C — labels (part of identity? values or tokens?): unanimously resolved —
  no privileged label.** All four explicitly *rejected* `Node(label, children)`
  in favour of an unlabelled tuple whose first child is an ordinary atom by
  convention. A question we'd left open came back forced.

## The ONE genuine surviving fork — `Map` as a primitive?

The only real disagreement, and it is principled:

- **Tuples only (LP, KR, type-theory — 3 of 4):** `Atom + Tuple`, nothing else.
  A `Map` imposes *quotient* equality (key-uniqueness, order-irrelevance) → fails
  the agnostic test → lives above. Backed by the asymmetry principle below.
- **Include `Map` (data-interchange — 1 of 4):** unordered association is a
  *distinct structural fact*; forcing it into sorted tuples either makes arbitrary
  order part of identity or pushes canonicalisation onto every consumer —
  recreating the very seam ontos exists to remove. Notably this dissent comes from
  the lens whose entire tradition is cross-system identity.

**Decision (user): tuples only.** The foundation is `Atom + Tuple`. Maps, sets,
records, graphs are conventions above. We accept the interchange lens's cost
(consumers needing unordered association must agree a canonical map encoding) in
exchange for maximal austerity and the asymmetry guarantee.

## Unanticipated convergences (findings not in the sealed file)

- **Well-foundedness / acyclicity is forced** — cycles would force
  bisimulation/reference identity, which is not agnostic. Add to the core.
- **n-ary tuple beats binary pair + unit** — all four considered cons-pairs and
  rejected them: associativity (`(a,(b,c))` vs `((a,b),c)`) would otherwise leak
  into identity. Sub-question settled: arity is primitive/structural.
- **The asymmetry principle (KR's phrasing):** the foundation must use the
  *finest* consumer-agnostic equality, because upper layers can always **quotient**
  (collapse distinctions) but can never **recover** a distinction the foundation
  erased. "Distinguish too much; never too little." This is a deeper justification
  for structural identity than we had, and it is what decides the Map fork.
- **No reduction relation / values are already normal forms** — there are no
  equations in the foundation; any domain that wants `2/4 = 1/2` must define a
  *canonical embedding* and normalise before producing the foundational value.

## The frozen core (decisions applied)

```text
Bytes = finite octet strings

Value = Atom(Bytes)
      | Tuple(Value*)        // finite, ordered; arity is part of identity
```

- Identity: structural. `Atom(b)=Atom(c) ⇔ b=c`; `Tuple(xs)=Tuple(ys) ⇔ same
  length and elementwise equal`; `Atom ≠ Tuple` always (incl. `Atom("")` ≠
  `Tuple()`).
- finite · immutable · well-founded (acyclic) · closed · uninterpreted ·
  no hidden/object identity · no quotient equality · no intrinsic scalars ·
  no variables · no schema.
- Canonical encoding: a separate, subordinate, **versioned** spec — not part of
  the value semantics. (Three layers kept distinct: *model* / *canonical
  encoding* / *in-memory representation*.)

## Consequence for logos (important)

ontos now holds **only the carrier** (`Atom + Tuple`), not a logic term. The logic
`Term` — variables, the functor/args reading, any numeric theory — is therefore a
**logos-level interpretation layered over ontos values by convention** (e.g.
`Tuple(Atom("var"), Atom("X"))`, integers as a tagged convention), exactly as all
four panelists demonstrated. This supersedes the earlier sketch in which "ontos
holds the Term." Carrier in ontos; term over the carrier in logos.
