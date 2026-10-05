# Design brief — foundational value model for a shared substrate

> You are being consulted as an independent expert. Work the problem from first
> principles and produce *your own* proposal. There is no expected answer to
> match; a confident, well-argued, opinionated proposal is what's wanted. Do not
> hedge toward what you think the asker wants — they specifically want your
> independent reasoning.

## The lens you are asked to bring

Adopt the perspective of a **programming-languages and type-theory designer** —
someone fluent in algebraic data types, value semantics, the theory of equality
(structural vs. nominal, intensional vs. extensional), normal forms, and what it
takes for a data model to be total, closed, and well-founded. Bring that
tradition's hard-won instincts about minimal generating sets of constructors, the
cost of every primitive you commit to, and how equality and canonical form
interact.

You are not designing a type system or a language here — only the **set of values
themselves**, prior to any typing discipline imposed on them (see the task). But
your expertise in the algebra of values and the semantics of equality is exactly
why you're being asked.

---

## Shared brief — the thing to design

There is a family of systems that all manipulate **the same data** but do
fundamentally different things with it:

- a **reasoning system** that works out what follows from rules and facts;
- an **authority / attestation substrate** that records who asserted what and
  whether it counts, and chains trust;
- a **storage and transport layer** that persists data, addresses it, and moves
  it between machines;
- assorted **tools** that render, diff, and transform it.

These systems are separate, owned by different teams, and evolve independently. But
they constantly hand data to one another. Today each has its own notion of "a
value," so every boundary between them is a translation — and the translations
drift, disagree, and leak.

We want to define **one shared foundational model of a value** that all of them
build on, so that crossing a boundary is an *identity* (the thing on this side
simply *is* the thing on that side) rather than a conversion. Call this foundation
**the value model**. It is owned by no consumer; it is prior to all of them.

This model is meant to be **frozen for the very long term** — changing it later is
ruinously expensive because everything is built on it. So the entire design
challenge is restraint: include exactly what *must* be shared, and refuse
everything else.

### The inclusion filter (the heart of the task)

A thing belongs in the foundational value model only if it passes **both** tests:

1. **Necessary** — interoperation is impossible unless all consumers agree on it.
   If each consumer could decide it privately and never need to agree, it is not
   foundational.
2. **Agnostic** — it is true of *a value as such*, independent of what any consumer
   does with it. The operative question: *would the reasoning system, the storage
   layer, and the authority substrate ever want this differently?* If yes, it
   belongs to those consumers, not to the foundation.

Anything that fails either test must be pushed *up* into the specific consumer that
needs it — never down into the shared foundation. A concrete example of the
discipline: a particular cryptographic signature scheme is *certain* to be needed
by the authority substrate, yet it plainly does not belong in a shared value model,
because it fails the agnostic test. Certainty is not the criterion; necessary-and-
agnostic is.

### What you can rely on about the consumers

You may assume the consumers above exist and are real, but you must **not** bake any
one consumer's needs into the foundation. The foundation should make each of them
*possible to build on top* without itself knowing anything about reasoning,
authority, storage, time, or schema. Assume new consumers, not yet imagined, will
also be built on it.

---

## Your task

Produce a proposal for the foundational value model. Specifically:

1. **State the core semantics** — what *is* a value, in this model? Define it as
   precisely as you can. What are its building blocks, and how do they compose?

2. **Decide identity** — when are two values *the same value*? This question tends
   to be load-bearing for every consumer; treat it with care and say why your
   answer is forced rather than chosen.

3. **Justify every inclusion against the filter** — for each element you put in the
   model, show it passes *both* the necessary and the agnostic test. This is the
   most important part: a short, ruthless justification per element.

4. **Name what you deliberately excluded, and why** — the things you considered and
   pushed up to consumers. Be explicit about the boundary.

5. **Flag genuine forks** — wherever you had to make a choice that you believe is
   *not* forced by the constraints (where a reasonable designer could decide
   otherwise), call it out explicitly as an open decision, and give your lean and
   your reason. Distinguish these sharply from the parts you believe are *forced*.

6. **Stress-test for longevity** — argue how your model avoids needing to change
   when a genuinely new *kind* of data, unforeseen today, must be represented
   later. If your model would need to grow to accommodate it, say so; that's a
   weakness worth surfacing.

Length and format are yours to choose. Prioritise clear reasoning over breadth.
Where your tradition's instinct pulls toward including something (a rich set of
primitive types, a typing discipline, a particular equality), interrogate it
against the filter out loud — the interaction between your chosen primitives,
equality, and canonical form is likely to matter, and that reasoning is as valuable
as the conclusion.
