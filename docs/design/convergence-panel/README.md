# ontos convergence panel

A test of whether ontos's foundational semantics are **discovered** (forced by
their constraints) or merely **invented** (chosen by taste). A foundation we
intend to freeze should be the former.

## The experiment

We hand each of four briefs — independently, with no shared context — to a fresh,
capable model. Each brief frames a different **intellectual tradition** (a lens),
but all four carry the *same* underlying brief: ontos's role, the
necessary-and-agnostic inclusion filter, the consumers that build on top, and the
task. None of the briefs states the answer we expect, and none reveals the others.

- If the four converge on the same core from four different directions, that is
  strong evidence the core is *inherent* — safe to freeze.
- Wherever they diverge, that pinpoints a place ontos is genuinely
  *underdetermined* — a decision we own, not a truth we record.

## Integrity rules

1. **Pre-registration.** Our expected answer is sealed in
   [`../0001-convergence-test-sealed-prediction.md`](../0001-convergence-test-sealed-prediction.md),
   written *before* any proposal is run. Convergence is scored against that file,
   not against hindsight.
2. **Blindness.** Give each brief to a *separate* model session. Do not show a
   model the other briefs, the other proposals, the sealed prediction, or these
   READMEs. Each proposal must be produced cold.
3. **Lens, not answer.** The briefs differ only in the persona/lens. The persona
   supplies *expertise and instinct*, never conclusions — so each tradition's
   natural temptations (and whether the filter correctly resists them) are part of
   the signal.

## The four lenses

| Brief | Tradition | Natural instinct it tests |
|---|---|---|
| [`brief-logic-programming.md`](brief-logic-programming.md) | Logic programming / automated reasoning | structured symbolic terms; the pull to include variables/unification |
| [`brief-data-interchange.md`](brief-data-interchange.md) | Data interchange / serialization | canonical representation & interop across heterogeneous systems |
| [`brief-knowledge-representation.md`](brief-knowledge-representation.md) | Knowledge representation / ontology | categories of being; the pull to bake in classes/schema |
| [`brief-type-theory.md`](brief-type-theory.md) | Programming languages / type theory | value semantics, equality, algebraic structure |

## After collecting the proposals

Score each against the sealed prediction's committed rule:

- **Strong pass** — independently hits ≥4 of the 5 core points (uniformity +
  identity mandatory) and splits only along axes A/B/C.
- **Weak pass** — core mostly hit, but a consumer-specific concern (storage,
  authority, reasoning) leaked into the foundation.
- **Fail / learn** — divergence on a *core* point: that point is not actually
  forced, and we must justify it as a choice.

The most valuable result is a **surprise not in the sealed file** — a core point we
missed, or a divergence axis we didn't anticipate. Record it as a surprise; do not
retrofit it as "what we meant."
