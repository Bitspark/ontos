# ontos foundational semantics — sealed prediction (pre-registration)

**Status:** sealed before the convergence panel ran. Written so the test
measures convergence against a *committed* prediction, not hindsight.

**Purpose.** We are about to give an independent, answer-free brief to a panel of
proposers from different intellectual traditions and ask each to derive the
foundational semantics ontos should encode. If the design is *discovered* (forced
by its constraints) rather than *invented* (chosen by taste), independent thinkers
should converge on the same core. This file records — in advance — exactly what we
expect them to converge on, and exactly where we expect them to diverge. Wherever
they diverge is, by construction, a place where ontos is genuinely underdetermined:
a real decision we own rather than a truth we record.

The brief given to the panel deliberately withholds everything below. It supplies
only ontos's role, the necessary-and-agnostic inclusion filter, and the roles of
the layers built on top.

---

## Predicted CORE — we expect convergence here

1. **One uniform notion of a value.** No privileged divide between "primitive" and
   "structured." A value is a *named composition* that bottoms out in a small set
   of intrinsic leaves. The simplest scalar and the most elaborate structure are
   the same shape of being.

2. **Identity is structural / by-value, with a canonical form.** Two values are the
   same iff they have the same structure; there is exactly one canonical
   representation of a given value. Proposers should independently name identity as
   the keystone invariant — the thing every consumer (dedup in a store, unification
   in reasoning, hashing in attestation) depends on.

3. **Exactness.** "Looks equal ⇒ is equal." The model commits that equal-appearing
   values are the same value. Consequence: **no floating-point / approximate
   numbers** in the foundation (they break identity); integers are exact and
   unbounded-in-principle.

4. **Interpretation-agnostic carriage.** An unrecognized structure is still a
   perfectly well-formed value. ontos can represent, compare, canonicalize, and
   round-trip a kind of thing whose *meaning* has not been invented yet. Meaning
   lives in the layers above; ontos holds the thing.

5. **Exclusions (each because it fails the "agnostic" half of the filter):**
   - no **truth / variables / inference** (reasoning — logos),
   - no **authority / identity-of-author / signing / attestation** (arche),
   - no **persistence / location / addressing / Merkle edges / content-addressing** (storage),
   - no **time / ordering-in-history / versioning** (storage/substrate),
   - no **schema / validation / interpretation** (consumers),
   - **encoding is not meaning** — the model is the thing, not its bytes.

## Predicted DIVERGENCE axes — we are genuinely unsure here; this is what the test is *for*

- **A. Child structure: positional vs. named.** Are a composition's children an
  *ordered sequence* (`label(arg0, arg1, …)`) or a *keyed map* (`label{k: v}`)?
  Our lean: **positional**, with names/maps expressible on top. Held with moderate
  confidence — strong probe.

- **B. Leaf inventory: a small intrinsic scalar set vs. bytes-only.** Does the
  foundation include a few intrinsic scalar kinds (e.g. a symbol/name, an exact
  integer, raw bytes, perhaps text) — or does it go radically minimal (only raw
  bytes + composition, with all scalars being tagged bytes)? Our lean: **a small
  intrinsic set**, but held loosely; this is a real fork.

- **C. Labels/names: are they part of identity, and are they themselves values or
  a separate sort of token?** Is the label on a composition a first-class value, an
  interned symbol, or just a string — and does it participate in identity the same
  way children do?

## Scoring rule (committed in advance)

- **Strong pass:** panel independently hits ≥4 of the 5 CORE points (identity +
  uniformity are mandatory among them) and splits *only* along A/B/C.
- **Weak pass:** core mostly hit but a proposer leaks a specific (storage/auth/
  reasoning concept) into the foundation — tells us the brief under-warned on
  that boundary.
- **Fail / learn:** divergence on a CORE point. That would mean the point is *not*
  actually forced — i.e. it is a decision we are making, and we must justify it
  rather than assume it.

A surprise that is *not* in this file (a CORE point we missed, or a divergence axis
we didn't anticipate) is the most valuable possible result and must be recorded as
such — not retrofitted as "what we meant."
