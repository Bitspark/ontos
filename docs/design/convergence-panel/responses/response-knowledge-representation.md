## Thesis

I would make the foundational value model an **uninterpreted finite term algebra**:

> A value is a closed, immutable, finite structure built only from opaque byte atoms and finite ordered tuples of values.

That is the whole foundation.

No integers. No strings. No booleans. No maps. No sets. No schemas. No truth. No provenance. No references. No hashes. No signatures. No timestamps. No object identity. No classes. No “entity,” “relation,” “fact,” “assertion,” “document,” or “record” as foundational categories.

Those things are all expressible *as* values, but none of them is part of what a value *is*.

The foundation should be a carrier for ontologies, not an ontology of the world.

---

# 1. Core semantics

Let `Bytes` be the set of all finite byte strings.

The set of values `V` is the least set satisfying:

```text
v ::= Atom(b)              where b ∈ Bytes
    | Tuple(v0, …, vn−1)   where n ≥ 0 and each vi ∈ V
```

Equivalently:

```text
V = μX. Bytes + List(X)
```

A value is therefore a finite, well-founded tree whose leaves are byte atoms and whose internal nodes are tuples.

The tuple constructor is n-ary, not binary cons. A tuple has an exact arity. Order matters. Multiplicity matters. Nesting matters. No tuple is implicitly flattened.

So:

```text
Tuple(a, b)        ≠ Tuple(b, a)
Tuple(a, a)        ≠ Tuple(a)
Tuple(a)           ≠ a
Tuple(a, Tuple(b)) ≠ Tuple(a, b)
Tuple()            ≠ Atom(empty-bytes)
```

There are two structural constructors only:

```text
Atom
Tuple
```

They are disjoint. An atom is never a tuple. A tuple is never an atom.

A value has no hidden identity beyond its structure. There are no object IDs, memory addresses, creation events, timestamps, owners, permissions, types, or provenance inside the foundational notion of value.

A byte atom is not “text,” not “a number,” not “a symbol,” not “a URI,” not “an image,” not “encrypted data,” and not “a hash.” It is only a finite sequence of bytes. Any further interpretation belongs to a consumer or to an ontology encoded above the value model.

A tuple is not “a list,” not “a record,” not “a proposition,” not “a function call,” not “an array,” and not “an assertion.” It is only finite ordered composition.

For example, a reasoning system might decide that this value represents a binary predicate application:

```text
Tuple(
  Atom("parent"),
  Atom("alice"),
  Atom("bob")
)
```

But the foundation does not know that. The foundation sees only a three-element tuple whose elements are byte atoms. The fact that the first atom is being used as a predicate symbol is a convention of a logical language built on top.

That distinction is the essence of the proposal.

---

# 2. Identity: when are two values the same value?

Two values are the same value iff they are structurally identical.

Formally:

```text
Atom(b1) = Atom(b2)
    iff b1 and b2 are the same byte string.

Tuple(x0, …, xm−1) = Tuple(y0, …, yn−1)
    iff m = n and, for every i, xi = yi.

Atom(b) ≠ Tuple(...)
    always.
```

There is no other equality.

This is not merely convenient. I think it is forced.

## Why identity cannot be semantic identity

A reasoner may want to treat these as equivalent:

```text
and(p, q)
and(q, p)
```

An authority substrate may need to distinguish them, because Alice asserted the first exact form and Bob asserted the second. A storage system may need to store both. A diff tool may need to show the difference.

So semantic equivalence cannot be foundational. It varies by consumer.

The value model must distinguish expressions that some consumer could reasonably need to distinguish. Higher layers may collapse distinctions; the foundation must not collapse them prematurely.

## Why identity cannot be serialization identity

A value may be serialized in many ways: compact binary, diagnostic text, chunked transport, compressed encoding, streaming envelope, and so on.

If value identity were byte-for-byte serialization identity, then changing a codec would create a different value. That makes transport details ontological, which is exactly the wrong direction.

Serialization is a representation of a value, not the value itself.

A system may define a canonical serialization for hashing or signing. That may be necessary infrastructure, but it is not part of the abstract value semantics.

## Why identity cannot be object identity

Object identity depends on allocation, storage location, process lifetime, pointer address, database row, or content-addressing scheme.

Those are not properties of the value. They are properties of some system holding the value.

If copying a value changed its identity, storage and transport would destroy identity. Therefore object identity is disqualified.

## Why structural identity is forced

The shared foundation must use the **finest consumer-agnostic equality** available.

If two values have the same structure, no consumer-neutral distinction remains.

If two values differ structurally, at least one consumer may need to observe the difference.

So foundational identity must be exactly structural equality.

Consumers may then define their own additional equivalences:

```text
same number
same normalized string
same logical formula
same graph up to node renaming
same set regardless of order
same assertion after canonicalization
same document after formatting
```

But those are not value identity. They are interpretations or quotientings of values.

---

# 3. Inclusion justification

Here is the full inventory of what I would include.

| Included element                                | Necessary?                                                                                                                                                                                                                        | Agnostic?                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Abstract value, distinct from serialization** | Yes. Without this, every transport or storage encoding becomes a different thing, and consumers cannot agree on identity across boundaries.                                                                                       | Yes. Reasoning, authority, storage, and tools all need to talk about the same abstract thing even if they encode it differently.                                                                                                                                      |
| **Finite byte atoms**                           | Yes. The model needs terminal material: names, symbols, opaque payloads, encoded external data, constructor labels, media bytes, identifiers, and all other leaves must bottom out somewhere.                                     | Yes. Bytes carry no intrinsic domain meaning. A byte string can later be interpreted as UTF-8, an integer encoding, a digest, a media file, or a symbol, but the foundation does none of that.                                                                        |
| **Finite tuple composition**                    | Yes. Without shared recursive structure, the only common value would be an opaque blob, and every consumer would privately parse its own structure. That recreates the translation problem.                                       | Yes. Ordered finite containment is structural, not domain-semantic. A reasoner may interpret a tuple as a formula, storage may encode it as a tree, authority may attest to it, and a renderer may display it. None need the foundation to know what the tuple means. |
| **Constructor disjointness**                    | Yes. Consumers must agree that an atom containing some bytes is not the same value as a tuple. Otherwise identity becomes ambiguous.                                                                                              | Yes. This is purely structural. It does not privilege any domain category.                                                                                                                                                                                            |
| **Tuple arity, order, and multiplicity**        | Yes. If these are not part of identity, the foundation has already imposed equations such as commutativity, idempotence, or flattening. Some consumers will need to distinguish those cases.                                      | Yes. Order and repetition here are not claims about meaning. They are merely part of the structural inscription. Consumers that want unordered or duplicate-insensitive meaning can define that above.                                                                |
| **Finiteness**                                  | Yes. Values must be transportable, storable, comparable, attestable, and recursively inspectable. Infinite objects require evaluation, approximation, streaming, or reference semantics, all of which are consumer-level choices. | Yes. The foundation says only that exchanged values are finite structures. It does not prevent consumers from representing infinite things by finite descriptions.                                                                                                    |
| **Well-foundedness**                            | Yes. Equality must terminate, and subvalue structure must not depend on dereferencing or solving cycles. Cyclic graphs can be represented explicitly as finite data, but the value itself should not be cyclic.                   | Yes. This is a property of the carrier structure, not of any domain.                                                                                                                                                                                                  |
| **Immutability**                                | Yes. If a value could change while remaining “the same value,” reasoning, attestation, storage, and diffing would disagree catastrophically.                                                                                      | Yes. Immutability is true of values as values. Mutable cells, histories, versions, and state transitions are things one can model using values; they are not themselves valuehood.                                                                                    |
| **Structural equality**                         | Yes. Every consumer needs a shared answer to “is this the same value?”                                                                                                                                                            | Yes. It depends only on the constructors and bytes, not on truth, authority, schema, storage, display, or domain meaning.                                                                                                                                             |

That is the entire foundation.

Everything else is upstairs.

---

# 4. Why the tuple is the right primitive compound

The main design fork is whether the foundation should include richer compounds: maps, sets, records, graphs, tagged nodes, arrays, or typed objects.

I would not.

The tuple is the correct primitive because it is the least opinionated recursive composition operator.

A tuple imposes almost no algebraic laws. It does not say that order is meaningful in the world. It says only that this value has these children in these positions.

By contrast, a set constructor would impose at least these equations:

```text
Set(a, b) = Set(b, a)
Set(a, a) = Set(a)
```

A map constructor would impose key uniqueness, key equality, absence semantics, and usually some idea of fieldhood.

A record constructor would impose names, field identity, missingness, probably schema expectations, and possibly openness versus closedness.

A graph constructor would impose node identity, edge identity, possibly cycles, reachability, and graph isomorphism questions.

Those are not innocent. They look structural, but they are already semantic commitments.

The foundational model should never identify two things merely because some later consumer would like them identified. It should preserve difference. Consumers can always quotient later.

This is the conservative rule:

> The foundation may distinguish too much; upper layers can collapse.
> The foundation must not collapse too much; upper layers cannot recover distinctions that foundational identity has erased.

That rule strongly favors a free tuple constructor over sets, maps, records, or graphs.

---

# 5. What is deliberately excluded

## Types, classes, and categories

No foundational types beyond `Atom` and `Tuple`.

No `Person`, `Event`, `Document`, `Claim`, `Rule`, `Relation`, `Entity`, `Attribute`, `Object`, `Property`, or `Process`.

Those are ontology-level categories. They are exactly the kind of thing that should not be frozen into the substrate.

A domain ontology may encode class membership as values. For example:

```text
Tuple(Atom("instance-of"), Atom("alice"), Atom("Person"))
```

But the foundation does not know what `instance-of` means.

The old upper-ontology temptation is to put a few apparently obvious categories at the bottom. That is how foundations ossify. The value model should not say what kinds of things there are. It should only say how finite structures are formed.

## Strings

No primitive string type.

Text has encoding, normalization, collation, locale, grapheme segmentation, casing, directionality, and language issues. Those are real, but they are not valuehood.

A UTF-8 string can be represented as a byte atom under a text convention. A different text layer can choose a different encoding or normalization discipline.

The foundation only sees bytes.

## Numbers

No primitive integers, decimals, rationals, floats, reals, dates, durations, or quantities.

Numbers are not just marks. They come with arithmetic, normalization, precision, units, exceptional values, overflow behavior, display notation, and equality questions.

For example:

```text
1
01
1.0
1e0
+1
```

may or may not denote the same number depending on the layer. The foundation should not decide.

A numeric tower can be encoded above the value model.

## Booleans and null

No primitive `true`, `false`, or `null`.

Logical truth belongs to logic. Data booleans belong to a data language. Missingness belongs to schemas and records. Null-like sentinels are notorious precisely because they conflate absence, unknown, empty, invalid, undefined, and explicitly null.

If a layer wants booleans, it can define two values as its booleans.

If a layer wants missingness, it can define where absence is meaningful.

The foundation should not.

## Maps, records, and objects

No primitive map.

A map is not merely “structure.” It carries commitments:

```text
key equality
key uniqueness
duplicate handling
field absence
field ordering or non-ordering
open versus closed records
whether keys are strings, symbols, values, or something else
```

Different consumers will want these differently.

A storage layer may want ordered key-value pairs for canonical addressing. A reasoning layer may want finite partial functions. A UI tool may want insertion order. An authority system may care whether the original assertion used duplicate keys. A schema language may distinguish absent from present-null.

So maps fail the agnostic test.

They can be encoded as tuples under a higher-level convention.

## Sets

No primitive set.

Sets are attractive to an ontology theorist because they are extensional and mathematically clean. But that is exactly the danger.

A set imposes duplicate-insensitivity and order-insensitivity. Those are semantic equations. Some consumers will want them; others must not be forced to accept them.

A set language can be built above the foundation by choosing a canonical representation. But “this tuple denotes a set” is not foundational.

## Graphs

No primitive graph, even though many ontologies are graph-shaped.

A graph requires decisions about node identity, edge identity, labels, directionality, multiedges, hyperedges, cycles, blank nodes, and graph isomorphism.

Those are not universal value concerns.

A graph can be represented as a finite value, for example by an adjacency structure, an edge list, or a set-like encoding defined by a graph layer.

But the value itself is not a graph. It is a tree-shaped finite term that may denote a graph.

## References, links, and addresses

No primitive reference or link.

A reference is not pure value structure. It introduces dereferencing, resolution, failure, authority, mutability, locality, availability, and possibly time.

A content ID, URL, database key, or pointer may appear as bytes inside an atom, but the foundation does not treat it as a link.

This is important: a byte atom that happens to contain a content hash is not automatically the value it names. It is just an atom. A storage layer may interpret it as an address.

## Hashes and content addressing

No primitive hash.

A hash is an artifact of an addressing scheme over some encoding of values. Hash algorithms change. Multihash schemes change. Collision policies matter. Truncation policies matter.

The identity of the value must be prior to all of that.

A storage system may define:

```text
address = hash(canonical-encoding(value))
```

But the hash is not the value.

## Signatures, attestations, and trust

No primitive signature, public key, issuer, subject, validity, revocation, or trust chain.

The authority substrate absolutely needs these. That does not make them foundational.

An attestation is a value whose meaning is supplied by the authority layer. For example, the authority layer may define a structure whose fields are issuer, claim, signature algorithm, signature bytes, and validity interval.

The foundation should not know any of that.

It only carries the exact claim value being attested.

## Time, versioning, and history

No primitive time.

Time is not one thing. There are instants, intervals, clocks, calendars, monotonic counters, logical clocks, causal histories, block heights, transaction orderings, and validity periods.

Different consumers will need incompatible temporal disciplines.

A timestamp may be represented as bytes or as a structured tuple under a time ontology. But the foundation has no clock.

## Variables, binders, rules, and inference

No primitive variable.

No quantifier.

No lambda.

No rule.

No implication.

No negation.

No truth predicate.

These belong to reasoning languages built on top of values. The reasoner may encode formulas as values, but the value model does not itself have logical syntax.

This prevents a disastrous conflation between “a value that denotes a proposition” and “a true proposition.”

## Schemas and validation

No primitive schema, required field, type constraint, default, migration, or validation rule.

Schemas are interpretations of values. They are also historically unstable. Once schema concepts enter the foundation, the substrate becomes coupled to one style of application design.

A schema language can itself be encoded as values.

## Namespaces and global identifiers

No primitive IRI, URI, UUID, DID, package name, module name, or namespace.

Names are social and institutional. They involve governance, collision policies, delegation, persistence guarantees, and resolution.

The foundation allows byte atoms. A naming layer can interpret some atoms as names.

## Canonical serialization

No canonical serialization in the semantic foundation.

I would publish at least one canonical codec for practical hashing and signing, but I would not make the codec part of what a value is.

The semantic contract is:

```text
decode(encode(v)) = v
```

for conforming codecs.

A canonical codec is infrastructure. It is not ontology.

## Compression, encryption, chunking, and storage layout

No primitive compression.

No primitive encryption.

No primitive chunks.

No primitive pages, blocks, sectors, packets, streams, or Merkle links.

Those are storage and transport concerns. They may preserve values, protect values, address values, or move values. They are not values as such.

## Presentation

No primitive rendering, display order beyond tuple position, labels, pretty names, comments, whitespace, formatting, or annotations.

A renderer may choose how to display values. A semantic renderer may use an ontology to display certain values specially.

But presentation is not foundational identity.

---

# 6. Genuine forks

Some choices are forced by the brief. Others are design forks where a reasonable person could choose differently.

I distinguish them sharply.

## Forced: structural identity, not semantic identity

This is not optional.

If the foundation uses semantic equality, it has chosen some consumer’s semantics. That violates the agnostic test.

## Forced: immutability

Also not optional.

Mutable values would make attestation, storage, reasoning, and diffing incoherent at the boundary. Mutation can be modeled, but a value itself must not mutate.

## Forced: no authority, truth, schema, time, or storage semantics

These fail the agnostic test directly.

They are certainly needed by consumers. That is not enough.

## Forced: some shared recursive structure

If the foundation had only opaque bytes, every structured consumer would need a private parser and private identity rules. That recreates the translation boundary the project is trying to remove.

So the foundation needs recursive structure.

## Not fully forced: byte atoms rather than bitstrings or abstract symbols

I lean strongly toward byte atoms.

Theoretically, one could choose finite bitstrings, Unicode scalar sequences, natural numbers, or interned symbols. The abstract role is “opaque finite atom with decidable equality.”

Bytes are the practical choice because every storage and transport system already has bytes, and byte equality is uncontroversial.

But the deep requirement is not octethood. It is finite uninterpreted atomic material.

## Not fully forced: tuple as the only compound constructor

I think tuple-only is the right answer, but this is the largest genuine fork.

A designer could add maps and sets as primitive structural forms. That would make many applications more ergonomic.

I would still refuse them because they impose equations and policies not forced by valuehood. The tuple is the free compound form. It preserves distinctions and lets upper layers collapse them.

My lean is therefore:

```text
primitive tuple only;
sets, maps, records, graphs above.
```

## Not fully forced: n-ary tuple rather than binary pair

One could define everything using only:

```text
Pair(x, y)
Unit
Atom(b)
```

That is slightly smaller.

I would not do it. Binary pairs make list spine and associativity choices visible in foundational identity. Then every three-part structure must choose between:

```text
Pair(a, Pair(b, c))
Pair(Pair(a, b), c)
```

An n-ary tuple is cleaner. It treats finite arity as structural, not as an implementation accident.

## Not fully forced: whether to standardize a canonical codec beside the model

I would standardize one canonical codec, but I would keep it outside the semantic definition.

The value model should say what values are.

A codec spec should say how to serialize them.

A hashing or authority spec should say which codec it commits to.

Those should be separate layers, even if they are developed together.

## Not fully forced: whether to permit implementation-level DAG sharing

Implementations should absolutely be allowed to hash-cons, deduplicate, chunk, and store values as DAGs.

But that sharing must be unobservable in value identity.

So this is not a semantic fork: DAG sharing is allowed as representation, not as value structure.

---

# 7. How consumers build on this

## Reasoning system

The reasoning system defines a language whose syntax is encoded as values.

For example, it may define conventions for:

```text
variables
constants
predicate applications
quantifiers
rules
proofs
normal forms
logical equivalence
```

All of those are values structurally, but their logical meaning belongs to the reasoner.

The reasoner may conclude that two values are logically equivalent. That does not make them the same foundational value.

This distinction matters because the authority substrate may care about the exact sentence asserted, not merely its consequences.

## Authority / attestation substrate

The authority layer treats some values as claims, some as attestations, some as keys, some as signatures, and some as trust policies.

But those roles are not foundational.

The crucial thing the foundation gives authority is exactness: the substrate can say, “this agent attested to this exact value.”

That exactness depends on structural identity.

Validity, revocation, delegation, trust, and signature verification all live above the value model.

## Storage and transport

Storage stores values.

Transport moves values.

They may encode, chunk, compress, encrypt, hash, address, replicate, cache, and deduplicate values.

None of those operations changes what a value is, provided decoding recovers the same abstract value.

A content address is an address of a value, not the value itself.

## Tools

Generic tools can render and diff the bare structure:

```text
Atom bytes changed
Tuple element inserted
Tuple element removed
Tuple subtree changed
```

Semantic tools can do more if they understand an upper-layer convention:

```text
record field changed
set member added
logical rule strengthened
signature invalid
schema migration needed
```

The foundation supports both, but only the first kind is foundational.

---

# 8. Stress test for longevity

The model survives future data kinds because it does not try to enumerate data kinds.

A future kind of data becomes one of two things:

1. **Opaque payload** carried in an atom.
2. **Structured language** encoded using tuples and atoms.

That is enough for almost everything a digital system can exchange.

## Images, audio, models, binaries

Represent as byte atoms, or as structured values containing metadata plus byte atoms.

The foundation does not need image, audio, tensor, matrix, executable, or model-weight primitives.

## Graphs and cyclic structures

Represent a graph as data:

```text
Tuple(
  Atom("graph-format-x"),
  nodes,
  edges
)
```

Cycles are properties of the represented graph, not of the value’s containment structure.

No foundational cycle support is needed.

## Mathematical objects

Integers, rationals, matrices, polynomials, proofs, categories, ordinals, and formal theories can all be encoded by mathematical languages above the foundation.

The value model does not need to know arithmetic.

## Legal, social, and institutional objects

Contracts, claims, credentials, permissions, policies, and identities can all be represented by upper-layer ontologies.

The foundation does not need a concept of personhood, obligation, jurisdiction, role, or consent.

## New authority systems

A future signature scheme, proof system, capability system, reputation model, decentralized identifier system, or institutional trust model can be encoded without changing the value model.

The foundation remains indifferent to the meaning of the bytes and tuples.

## New storage systems

A future storage layer may use quantum media, erasure coding, content addressing, locality-sensitive chunking, authenticated data structures, or something stranger.

As long as it can preserve and recover finite values, the value model does not change.

## The real weakness

The model cannot directly contain genuinely infinite, live, or intensional things.

It cannot contain “the stream itself,” “the current state of this remote service,” “the real number π as completed infinity,” or “whatever this pointer resolves to tomorrow.”

It can contain finite descriptions of those things:

```text
a stream descriptor
a service reference
a formula defining π
a program
a snapshot
a proof
a content address
```

But the value itself remains finite.

I regard this not as a flaw but as a necessary boundary. Shared transportable data must be finite. Infinite or live phenomena require interpretation, observation, execution, or reference. Those are consumer semantics.

---

# 9. The central discipline

The value model should be boring.

It should not know what anything means.

It should not helpfully include the obvious things.

It should not contain the first five abstractions every application designer asks for.

It should be closer to syntax than ontology: a common substrate in which ontologies, schemas, proofs, claims, records, graphs, documents, signatures, and programs can be expressed.

The final model I would freeze is therefore:

```text
Value =
    Atom(finite bytes)
  | Tuple(finite ordered sequence of Value)
```

with identity by exact structural equality.

Everything else is interpretation.

That austerity is the point.
