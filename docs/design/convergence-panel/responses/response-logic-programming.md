# Proposal: the free finite value algebra

My proposal is deliberately austere:

> A foundational value is a finite, closed, well-founded ground term in a free algebra whose only primitives are opaque byte atoms and finite positional product nodes.

Equivalently: a value is an immutable finite tree. Leaves are byte strings. Internal nodes are finite ordered tuples of child values. There are no other built-ins.

This is the smallest model I would be willing to freeze for a long-lived shared substrate. It is close in spirit to a Herbrand universe: values are syntax, not interpretation. Consumers may interpret values as facts, attestations, schemas, addresses, documents, programs, proofs, images, or anything else, but the foundation does not know those interpretations.

The main discipline is this:

> The foundation should give consumers a common *object of manipulation*, not a common *theory of meaning*.

Once the value model contains equations such as numeric equality, string normalization, map key uniqueness, alpha-equivalence, trust validity, hash resolution, or schema conformance, it is no longer a foundational value model. It has become one consumer’s semantic layer.

---

# 1. Core semantics

Let `Bytes` be the set of all finite byte strings.

Define the set of values `V` as the least set satisfying:

```text
Atom(b) ∈ V
    for every b ∈ Bytes

Node(v0, v1, ..., vn-1) ∈ V
    for every finite n ≥ 0 and v0, ..., vn-1 ∈ V
```

So, formally:

```text
V = μX. Bytes + List(X)
```

or, in first-order term-algebra language, the signature is:

```text
A_b      : 0-ary constructor, for each byte string b
N_n      : n-ary constructor, for each natural number n
```

A value is any finite ground term over that signature.

For readability, one might write:

```text
"a"                         -- an Atom containing the byte 0x61
["person", "alice", "42"]    -- a Node with three children
[]                           -- a zero-child Node
[["x"], ["y", "z"]]           -- nested Nodes
```

But the quotation marks and brackets are only notation. There is no built-in string type, list type, array type, or record type. There are only byte atoms and nodes.

The model has these primitive observations:

```text
is this value an Atom or a Node?

if Atom:
    what exact byte string does it contain?

if Node:
    how many children does it have?
    what is child i?
```

That is all.

Everything else is above the foundation.

---

# 2. Identity

Two values are the same value exactly when they are structurally identical.

The equality rules are:

```text
Atom(b) = Atom(c)
    iff b = c as exact byte strings

Node(v0, ..., vn-1) = Node(w0, ..., wm-1)
    iff n = m and vi = wi for every i

Atom(_) ≠ Node(_)
```

There is no normalization, no coercion, no implicit decoding, no schema-aware equality, no map-order equality, no alpha-equivalence, no hash resolution, no pointer identity, no provenance-sensitive identity, and no “same meaning” relation in the foundation.

This is Herbrand equality.

I think this answer is forced.

If equality is **coarser** than structural equality, then the foundation has smuggled in a theory. For example, saying that `"01"` equals `"1"` means the foundation has adopted some numeric interpretation. Saying that `[a, b]` equals `[b, a]` means the foundation has adopted some set-like interpretation. Saying two differently encoded strings are equal means the foundation has adopted a text-normalization theory. These are exactly the kinds of commitments different consumers may want differently.

If equality is **finer** than structural equality, then identical values can differ because of something hidden: location, allocation history, transport encoding, storage address, creator, signature, or provenance. That is also wrong. A value must survive copying, transport, serialization, deserialization, hash-consing, caching, and re-materialization without changing identity.

So the only stable choice is:

> Same structure, same atom bytes, same value.

Not because it is convenient, but because every other equality either adds consumer-specific meaning or depends on non-value context.

---

# 3. Why each included element belongs

## 3.1 Finite values

A value is finite.

**Necessary:** storage, transport, attestation, diffing, and interoperation need a complete object that can be handed across a boundary. A genuinely infinite object cannot be transmitted as itself. It can only be represented by a finite description, generator, reference, or promise.

**Agnostic:** finiteness says nothing about what the value means. It merely says the object is a closed, transmissible datum.

This excludes streams, live processes, lazy thunks, databases, network resources, and infinite mathematical objects as primitive values. Those can be represented by finite values, but they are not foundational values themselves.

---

## 3.2 Atoms

The model needs irreducible atomic material.

**Necessary:** without atoms, every identifier, literal, tag, symbol, external payload, and uninterpreted name would have to be encoded using some higher-level convention. That convention would immediately become shared infrastructure anyway. A reasoning system needs symbols; an authority system needs named subjects and claims; storage needs payloads and handles; tools need stable labels to render and compare.

**Agnostic:** an atom has no meaning except exact identity. It is not a string, number, URI, timestamp, public key, hash, actor, or predicate. It is just a finite byte sequence.

I choose byte strings as the atom carrier because bytes are the least interpreted portable spelling we have. The truly forced part is not “bytes” specifically, but “an unbounded supply of finite opaque atoms with exact identity.” Bytes are the cleanest concrete realization.

---

## 3.3 Disjoint atom/node forms

Atoms and nodes are disjoint.

```text
Atom(b) ≠ Node(...)
```

**Necessary:** consumers must be able to decompose a value unambiguously. If an empty byte string, an empty node, and a null value could collapse into one another, every boundary would need extra interpretation to recover intent.

**Agnostic:** the distinction is purely structural. It does not say what either form means.

This is the ordinary free-algebra requirement that constructors are injective and disjoint.

---

## 3.4 Finite positional nodes

The only compound form is a finite ordered node:

```text
Node(v0, ..., vn-1)
```

**Necessary:** values need composition. A substrate with only atoms cannot express structured data without forcing every consumer to invent private parsers inside atoms. Child positions are necessary to express asymmetric structure: subject vs predicate vs object, left vs right, name vs body, algorithm vs digest, key vs value.

**Agnostic:** a node does not mean list, tuple, record, function call, fact, claim, expression, array, or syntax form. It only says: here are `n` child values in these positions.

The positional nature matters. If the foundation made children unordered, it would already be choosing set-like equality. Many consumers need ordered structure; consumers that want unordered sets can define a set encoding above the foundation.

---

## 3.5 Recursive closure

Nodes may contain values, which may contain nodes, and so on.

**Necessary:** without recursive composition, the model cannot represent arbitrary finite structure. Every nontrivial consumer would need an escape hatch.

**Agnostic:** recursion is only shape. It does not prescribe semantics.

This gives the usual structural induction principle:

> To define something over all values, define it for atoms and define it for nodes from their children.

That is exactly the kind of totality a long-lived substrate should have.

---

## 3.6 Free algebra, no equations

The constructors are free. There are no equations beyond structural equality.

**Necessary:** shared identity must not depend on any consumer’s semantic theory. If the foundation includes equations, then consumers that do not accept those equations cannot faithfully use the value model.

**Agnostic:** freedom is the absence of interpretation. It is the cleanest possible common ground.

This is the most important inclusion. The foundation is not merely “tree-shaped”; it is a free term algebra. That means consumers can safely impose their own interpretations above it without fighting hidden equations below it.

---

## 3.7 Immutability and contextlessness

A value has no mutable state, no ambient environment, no owner, no address, no clock, no validity status, and no authority.

**Necessary:** if a value could change while remaining “the same value,” then storage, attestation, reasoning, and diffing would lose a stable object. If a value’s identity depended on context, crossing a boundary would not be identity-preserving.

**Agnostic:** immutability and contextlessness say nothing about meaning. They only make the object stable.

A changed value is a different value. A value plus provenance is another value or an external relation, not the original value secretly acquiring metadata.

---

# 4. What is deliberately excluded

## Types, schemas, classes, and validation

Excluded.

A schema is a theory about which values are acceptable and how to interpret them. Different consumers will want different schemas, schema languages, versioning rules, open-world or closed-world assumptions, and failure behavior.

A schema can be represented as a value. Schema conformance is not valuehood.

---

## Strings and text

Excluded as primitives.

Text requires choices about encoding, Unicode normalization, locale, case folding, collation, invalid sequences, grapheme clusters, and display. Those choices are not foundational.

A text layer may define, for example:

```text
["utf8-text", <bytes>]
```

But that is a higher-level convention.

---

## Numbers

Excluded as primitives.

Integers, rationals, decimals, floats, NaNs, infinities, signed zero, precision, units, canonical forms, and arithmetic equality all bring semantic commitments.

A numeric language can be built above the foundation:

```text
["int", <canonical big-endian bytes>]
["decimal", <coefficient>, <scale>]
["float64", <ieee-bytes>]
```

But the foundation should not decide that `"1"`, `"01"`, `1.0`, and `1` are the same or different. That belongs above.

---

## Booleans, null, missing, undefined, and errors

Excluded.

These are not value-theoretic necessities. They are conventions in particular languages.

A consumer can use atoms or tagged nodes:

```text
"true"
"false"
["none"]
["error", code, detail]
```

But the foundation should not decide what absence, failure, truth, or unknownness means.

This matters especially for reasoning systems. “Unknown” is not a value; it is an epistemic condition of a theory or query.

---

## Maps, records, objects, dictionaries

Excluded as primitives.

Maps require decisions about key identity, duplicate keys, ordering, canonicalization, missing fields, optional fields, record extension, and schema interaction.

They can be represented above the foundation, for example:

```text
["map", [[key1, value1], [key2, value2]]]
```

A particular map layer may require sorted keys and no duplicates. That is a consumer-level law, not a foundational law.

---

## Sets and multisets

Excluded.

A set has order-insensitive equality. A multiset has multiplicity-sensitive but order-insensitive equality. Those are equations. Equations do not belong in the foundation.

Represent them with a tagged node and define the equality discipline above.

---

## Variables, binders, quantifiers, and substitution

Excluded.

This is where my logic-programming instincts initially pull toward inclusion, and where the inclusion filter says no.

A reasoning system needs variables. The value model does not.

Different reasoning systems disagree about variable identity, scoping, binding, alpha-equivalence, higher-order variables, nominal constants, eigenvariables, existential witnesses, metavariables, and substitution discipline. Those are not facts about values as such.

A rule language may encode variables as values:

```text
["var", "X"]
["forall", ["var", "X"], body]
["rule", head, body]
```

But those are ground values representing syntax. The variable behavior lives in the reasoning layer.

The foundation contains ground terms only.

---

## Predicates, facts, rules, truth, negation, and entailment

Excluded.

A fact can be represented as a value. A rule can be represented as a value. A proof can be represented as a value. But facthood, rulehood, proof validity, negation-as-failure, classical negation, paraconsistency, open-world reasoning, closed-world reasoning, and entailment are all reasoning-layer concerns.

The foundation should not know that:

```text
["parent", "alice", "bob"]
```

is a fact. It only knows that it is a three-child node whose first child is an atom.

---

## Provenance, authorship, signatures, trust, and authority

Excluded.

Authority systems need these desperately, but that is not enough. They fail the agnostic test.

A signature scheme, trust root, actor model, validity window, revocation rule, or attestation chain is not true of a value as such. It is a relation involving values.

An authority layer may define values like:

```text
["asserted-by", actor, content]
["signature", algorithm, public_key, signature_bytes, signed_value]
["delegation", issuer, subject, scope]
```

But the foundation does not know whether a signature is valid or whether an assertion counts.

---

## Addresses, hashes, links, references, and resolution

Excluded as primitive semantics.

A hash can be a value. An address can be a value. A content identifier can be a value. But the relation “this address resolves to that value” is not foundational value identity.

This distinction is crucial.

```text
["sha256", digest_bytes]
```

is a value.

It is not the same value as the thing whose digest it contains.

The storage layer may use such values as addresses. The foundation does not.

---

## Serialization, wire format, compression, and encryption

Excluded from core semantics.

There should certainly be standard encodings for transport. Some consumers may require canonical encodings for hashing or signing. But the encoding is not the value.

A conforming codec should be injective with respect to the abstract value model, or at least decode into it unambiguously. But choosing CBOR, protobuf, s-expressions, IPLD-like blocks, custom binary framing, compression, or encryption is not part of value identity.

I would specify canonical encodings in separate companion documents, not in the semantic core.

---

## Object identity, pointers, sharing, and cycles

Excluded.

Two in-memory objects with the same structure are the same value. A hash-consed DAG and an expanded tree can represent the same value. Sharing is representation, not value identity.

Cycles are also excluded. Cyclic graphs require a different equality theory: pointer equality, bisimulation, rational-tree equality, or explicit reference resolution. Reasonable systems disagree about these.

If a consumer needs graphs, encode graph structure explicitly:

```text
["graph", nodes, edges]
```

or use storage-layer references. Do not make cyclicity foundational.

---

## Comments, formatting, rendering, and human syntax

Excluded.

Pretty-printing is not valuehood. Whitespace, comments, field order in a surface syntax, and display conventions belong to tools or languages above the foundation.

---

## Total ordering of values

Excluded.

A canonical total order is useful for indexing, sorting, deterministic maps, and canonical encodings. But different consumers may want different orders: lexicographic byte order, structural order, size order, term orderings for theorem proving, cache-friendly orderings, or domain-specific orderings.

The foundation gives equality and structure. Ordering is above.

---

# 5. Genuine forks

Some choices are forced by the constraints. Others are not. Here are the real forks.

## Fork 1: byte atoms versus another atom carrier

The model needs opaque finite atoms. I do not think the exact carrier is mathematically forced.

Possible carriers include:

```text
finite byte strings
Unicode scalar strings
natural numbers
UUID-like symbols
interned global names
```

My lean is strongly toward finite byte strings.

Reason: bytes are the least semantic portable substrate. Unicode strings already commit to text. Natural numbers need a spelling when transported. UUID-like names bake in a naming discipline. Bytes let higher layers define text, numbers, names, hashes, public keys, media, or arbitrary payloads without the foundation knowing which is which.

So: opaque atoms are forced; bytes are my preferred concrete choice.

---

## Fork 2: variadic nodes versus binary pairs

One could define the whole model using only:

```text
Atom(b)
Pair(left, right)
Unit
```

and encode n-ary nodes as lists or nested pairs.

That is mathematically equivalent.

I prefer primitive variadic nodes because arity is a direct structural fact, not an encoding convention. It makes diffing, traversal, rendering, and term inspection simpler without adding semantic theory.

But this is not deeply forced. A binary-pair foundation could be equally clean if everyone accepted the encoding discipline.

---

## Fork 3: unlabeled nodes versus labeled functors

A classic logic-programming term model would use:

```text
f(t1, ..., tn)
```

where `f` is a functor symbol.

My proposed model instead uses unlabeled nodes:

```text
Node(Atom("f"), t1, ..., tn)
```

when a consumer wants a functor-like encoding.

This is a deliberate restraint. Built-in functor labels would privilege one style of syntax. Unlabeled nodes plus atom children are sufficient to encode functor terms, records, application forms, envelopes, and many other structures.

A reasonable designer could choose labeled nodes:

```text
Node(label, children)
```

I lean against it because it creates two places where atomic labels live: as ordinary values and as node metadata. The cleaner foundation has only values inside values.

---

## Fork 4: allowing zero-child and one-child nodes

I would allow nodes of every finite arity, including zero and one.

```text
[]
[x]
[x, y]
```

A stricter model could forbid zero-child or one-child nodes as redundant.

I prefer allowing them because the algebra is simpler and total. There is no special case. Empty structure is distinct from the empty byte atom, and unary grouping is distinct from its child. If a higher layer considers unary nodes redundant, that layer can normalize them. The foundation should not.

---

## Fork 5: canonical serialization in the core document

This is the most tempting fork.

A storage or authority team will immediately ask: “How do we hash this? How do we sign this? What are the canonical bytes?”

Those are important questions. I still would not put canonical serialization into the core value semantics.

My preferred split is:

```text
Core value model:
    abstract free algebra and structural identity

Conformance codec:
    one or more specified encodings from bytes to values and values to bytes

Canonical codec:
    optional separate profile for hashing/signing
```

The reason is simple: a value should not be confused with its spelling. Multiple encodings can carry the same value. Content addressing may standardize one spelling, but that is a storage/authority profile, not value identity itself.

That said, I would expect any serious deployment to define at least one canonical codec very early.

---

## Fork 6: maximum atom size or maximum depth

The abstract model allows any finite byte atom and any finite tree.

Real systems need limits.

Those limits should not be semantic. They are implementation, transport, admission-control, or resource-policy constraints.

A small device may reject a value that a large server accepts. That does not mean the rejected object was not a value. It means the device could not process it.

---

# 6. How the consumers build on top

## Reasoning system

The reasoning system can define an object language inside values.

For example:

```text
["fact", ["parent", "alice", "bob"]]

["rule",
  ["ancestor", ["var", "X"], ["var", "Y"]],
  [["parent", ["var", "X"], ["var", "Y"]]]]

["rule",
  ["ancestor", ["var", "X"], ["var", "Y"]],
  [["parent", ["var", "X"], ["var", "Z"]],
   ["ancestor", ["var", "Z"], ["var", "Y"]]]]
```

The foundation does not know what `rule`, `var`, or `ancestor` mean.

The reasoning engine may impose variable binding, unification, substitution, alpha-equivalence, stratification, negation discipline, or proof theory. Those are reasoning-layer semantics.

The key benefit is that the reasoning layer starts from a clean Herbrand-like substrate: no hidden equations, no host-language object identity, no accidental normalization.

---

## Authority substrate

The authority layer can make attestations about values:

```text
["assertion",
  actor,
  content,
  evidence]

["signed",
  algorithm,
  key_id,
  signature_bytes,
  content]
```

Validity is not structural. A structurally well-formed signature value may be invalid cryptographically. A valid signature does not become part of the signed value’s identity.

This separation matters. The value being attested and the attestation about it are different values.

---

## Storage and transport

Storage can persist values however it wants, provided it preserves the abstract value.

It may chunk large atoms. It may hash-cons repeated subtrees. It may compress. It may encrypt. It may store nodes as rows, blocks, pages, or content-addressed DAGs.

All of that is representation.

The storage layer is correct if decoding returns the same structural value.

---

## Tools

Renderers, differs, normalizers, and transformers get a total recursive structure:

```text
Atom case
Node case
```

A generic diff can operate structurally. A domain-aware diff can interpret higher-level encodings. Neither needs the foundation to know about text, maps, rules, or schemas.

---

# 7. Longevity stress test

The model survives new kinds of data because it does not classify data by kind.

A future consumer may need tensors, biological sequences, legal contracts, probabilistic programs, neural-network weights, quantum circuits, zero-knowledge proofs, CRDTs, CAD models, synthetic organisms, or something we do not yet have a name for.

The foundation does not need a new constructor for any of these.

Each can be represented as a value-language:

```text
["tensor", element_type, shape, storage_order, bytes]
["zk-proof", system, statement, proof_bytes]
["crdt-op", replica_id, clock, operation]
["quantum-circuit", gates, wires]
["legal-clause", jurisdiction, body]
```

Those tags have no foundational magic. They are merely values used by higher-level conventions.

The model would need to grow only if we later insist that some non-finite, context-dependent, resource-like, or quotient-defined entity must itself be a foundational value. Examples:

```text
an actually infinite stream
a live network socket
a mutable database cell
a cyclic object with pointer identity
a value whose equality depends on a theorem prover
a value whose identity depends on who asserted it
```

My answer is: do not grow the foundation for those. Represent them by finite descriptions, references, protocols, or attestations above the foundation.

The longevity strategy is therefore not extensibility by adding primitives. It is extensibility by refusing primitives.

---

# 8. The central boundary

The foundation owns:

```text
finite atom
finite node
recursive composition
structural identity
```

Consumers own:

```text
meaning
validity
typing
schema
truth
authority
addressing
serialization profile
normalization
equivalence beyond structure
resource limits
```

That boundary is the design.

As a logic-programming theorist, I would summarize the proposal this way:

> Freeze the Herbrand universe, not the theories over it.

A shared substrate should be a place where all consumers can meet before they disagree. The moment the value model says what a number is, what a record is, what a valid claim is, what a variable binds, what a hash denotes, or what two differently written things “really mean,” it has moved above the line.

The foundational value model should be boring, total, free, finite, and syntactic.

That is its strength.
