# ontos/data (L2) — registered canonical embeddings

**Layer:** L2 (`ontos/data`). **Status:** **v1 frozen** (`int`, `utf8-text`,
`bool`, `list`), 2026-05-31. The framework, governance, and the four v1
embeddings — including their **exact canonical byte forms** — are decided here and
byte-pinned in [`vectors/data.json`](../../vectors/data.json), now that
[`ontos/codec`](ontos-codec.md) is frozen as `ontos-codec-v1`. `list` is the
**structural** embedding (an ordered sequence built only from the floor's `Tuple`)
that also discharges the agnosticism gate (§7): it is a value-kind no single
consumer's scalar sorts dictate. `map` (§5.7) and `set` (§5.8) are now **defined and
frozen** too (2026-06-01) — the keyed association and the unique collection, both
ordered by `ontos/codec` byte order (§6), so they are the first embeddings that
depend on the frozen codec and are codec-version-relative. With them, `list`/`map`/
`set` form a structural triad (ordered / keyed / unique). `decimal` (§5.9) was added
**2026-06-06** — an exact decimal value (`mantissa × 10^exponent`) built on `int`, the
fourth scalar; its canonical form is **purely structural** (no codec dependency),
graduated from the §9 candidate register at logos's named need (ontos-internal#102, logos
ontos-internal#331). Changing a frozen embedding's bytes is a breaking change shipped as a new
version, never an edit (§6).

`ontos/data` is a **registry of recognized labels** with canonical embeddings
into L0 values. An embedding is a way of writing a common datum — an integer, a
text string, a boolean, an ordered list — as an ordinary `ontos/core` value
([ontos-core.md](ontos-core.md)), so that systems that care about integers can
agree on *one* representation, while systems that don't can still carry, compare,
and round-trip the value untouched.

`ontos/data` adds **vocabulary and producer discipline. It adds no new value and
no new identity.** Every L2 value *is* an L0 value; identity is L0 structural
identity, unchanged ([ontos-core §3](ontos-core.md)). This is the discipline from
[design/0003 §"The governing rule"](../design/0003-layered-architecture.md): a
higher layer is a *reading* of values that already exist, never an extension of
the value set or of equality.

The keywords MUST, MUST NOT, SHOULD, MAY are used in the IETF sense.

---

## 1. What an embedding is

An **embedding** is a recognized **L1 labeled compound**
([ontos/compound](../design/0003-layered-architecture.md)) — a
`Tuple(Atom(label), payload…)` — whose `label` is registered here and whose
payload shape is fixed by this spec.

```text
an L2 value  =  Tuple(Atom(<registered-label>), <canonical payload as L0 values>)
```

- At **L0**, this is just a tuple whose first child is an atom. L0 assigns it no
  meaning.
- At **L1**, it is a labeled compound `label(payload…)`. L1 assigns the *label
  slot* significance, but no meaning to any particular label.
- At **L2**, `label` is **recognized**: a consumer that adopts this profile reads
  the value as the integer/text/boolean it embeds.

Recognition is **partial and opt-in** (the direction discipline of
[design/0003](../design/0003-layered-architecture.md)): a consumer recognizes the
labels it has adopted and treats every other value — including an unrecognized
label, or a recognized label with a malformed payload — as an ordinary L0 value.
**Downward is total** (every L2 value is an L0 value); **upward is partial** (not
every L0 value is a recognized embedding).

### 1.1 Labels are a reserved namespace; user data does not collide by accident

A registered label is a real word (`int`, `bool`, `utf8-text`, `list`), so in
principle a consumer's *own* data could be the compound `Tuple(Atom("int"), …)` and a
recognizer would read it as the integer embedding. This is the same reserved-name
hazard logos handles for its variable (which is why logos's `Var` is a genuine
sort, not `Tuple(Atom("var"), …)` — see
[design/0003 §"Two consequences"](../design/0003-layered-architecture.md)). The
decision here:

- **The `ontos/data` label set is a reserved namespace.** A consumer that has
  adopted the `ontos/data` profile MUST treat its registered labels as reserved —
  it MUST NOT mint its own application compounds under a registered label with a
  *different* intended meaning. Within an adopted profile there is exactly one
  reading of `Tuple(Atom("int"), …)`: the integer embedding.
- **Non-adopters are unaffected.** A consumer that has *not* adopted `ontos/data`
  reads the very same value as an ordinary L1 compound `int(…)` with no special
  meaning — recognition is opt-in, so there is no collision for them to suffer.
- **Application labels SHOULD be namespaced.** To keep application vocabularies
  clear of the registry, application-defined labels SHOULD use a namespaced form
  (e.g. `acme.example/int`) rather than bare words; `ontos/data` will only ever
  register short, unprefixed labels, so a namespaced application label can never
  collide with a future registration.

The hazard is therefore resolved by **reservation + opt-in recognition**, not by
payload heuristics: a recognizer never tries to "guess" whether a registered-label
compound is really data — under an adopted profile the label *is* the meaning, and
that is precisely why the label set must be reserved.

## 2. Identity is L0's, always — no new equality

An L2 embedding MUST NOT introduce any equality of its own. Two embeddings are
the same value **iff they are the same L0 value** (octet-for-octet atoms, same
arity and children, recursively — [ontos-core §3](ontos-core.md)).

The consequence is the load-bearing one, and it is the whole reason the floor
stays austere:

- Each embedding has **exactly one canonical form**. A datum that has multiple
  surface spellings (e.g. the integers `1` and `+01`) is canonicalized by the
  **producer** *before* the L0 value is built (§4). What is stored, hashed, and
  exchanged is already canonical.
- A non-canonical spelling is **not** "an equal embedding" — it is **not a
  well-formed L2 value of that kind** at all, while remaining a perfectly valid
  L0 value. A recognizer encountering it treats it as an unrecognized compound,
  never as a quotient-equal datum.

```text
Tuple(Atom("int"), <canonical bytes for 1>)      → the integer 1 (well-formed L2 int)
Tuple(Atom("int"), <non-canonical bytes for 1>)  → a valid L0 value, NOT a well-formed L2 int
```

This is [ontos-core §3.1](ontos-core.md)'s "values are already in normal form"
applied one layer up: a domain that wants an equation (e.g. `2/4 = 1/2`) defines a
**canonical embedding and normalizes at the producer** — never an L2 equality
rule. The floor distinguishes maximally; L2 may collapse spellings *by
canonicalizing before producing*, never by quotienting after.

**What L2 is — and is not — opinionated about.** State the three-way line
directly, because "ontos is structural / agnostic" is easily over-read as "ontos
takes no positions" — which is false *of this layer*:

- **Equality — never L2's.** Structural identity is fixed at L0 and inherited
  unchanged ([ontos-core §3](ontos-core.md)). No embedding defines its own. This
  is the sense in which ontos is "purely structural": it is a statement about the
  floor and about *equality*, not about ontos as a whole.
- **Representation — L2's whole job.** Choosing the *one* canonical spelling of an
  integer, a decimal, or a map *is* taking a position, and `ontos/data` takes it
  deliberately. `ontos/data` is part of ontos and is opinionated about
  representation on purpose — but it expresses each position as a **canonical
  form** (a producer-side normalization, §4), never as a new equality.
- **Arithmetic / numeric equality / ordering — not ontos at all.** `2/4 = 1/2`,
  `1 < 2`, and "does dividing two integers yield an integer or a decimal" are
  theories *over* values; they live in logos / math / the domain (the membership
  test of [design/0003](../design/0003-layered-architecture.md)), never here.
  `decimal` (§5.9) embeds the *representation* of an exact decimal; it defines no
  arithmetic on it.

So the discipline of this section — canonical form, opt-in recognition, identity
unchanged — is exactly what lets ontos commit to *representations* at L2 while the
*equality* it is famous for stays untouched at L0.

### 2.1 Canonical form is a property of the value, not its position

> **The canonical form of a datum is a property of the value, never of where it
> sits.**

A producer MUST choose an embedding's shape from the datum *alone* — never from
the slot it occupies. The same integer is the same `int(…)` value whether it is
top-level, the third argument of a compound, or the second element of a `list`;
the same text is the same `utf8-text(…)` everywhere. A "this context already knows
it is text / a list, so drop the tag/label" optimization is **forbidden**: L0
identity is purely structural and context-free, so a position-dependent shape
silently *forks identity across sites* — the same datum would hash two ways
depending on where it appears, and a signature taken at one site would fail at
another. This single rule is what makes upward recognition (§1) context-free (a
recognizer reads a value the same way regardless of its surroundings), and it is
the discipline behind every embedding below: a tagged scalar inside a
known-homogeneous `list` is still tagged; a `list` nested in another `list` is
still `list`-labeled. (It generalizes the divergences found in
[0005](../design/0005-worked-example-pressure-test.md) — text/bytes tagging,
integer width, and list shape were all the *same* defect: letting position, not
the value, pick the form.)

## 3. Governance (verbatim from design/0003)

```text
L0 conformance must NEVER require L1 or L2.
L1 conformance must NEVER require L2.
L2 labels MUST be ignorable by L0/L1 consumers (carry, compare, round-trip
    unchanged without recognizing them).
Each profile is independently versioned and independently adoptable.
```

Consequences for this spec:

- An `ontos/core` (L0) or `ontos/compound` (L1) implementation is fully conformant
  knowing **nothing** about `int`/`utf8-text`/`bool`/`list`. It carries them as
  tuples.
- Each embedding (and the profile as a whole) is **independently versioned**. A
  new embedding added later cannot break a consumer that never recognized it —
  because that consumer was treating it as an opaque L0 value all along. This is
  the forward-compatibility the layering buys: growth is *additive recognition*,
  never a change to the floor.

## 4. Producer normalization

For any embedding with more than one possible spelling of the same datum, this
spec defines a single **canonical form**, and a producer MUST emit only that form.
`normalize(surface) → canonical` is a **producer-side** operation; it is **not**
an equality claim and the checker/consumer side performs no normalization (it
either recognizes the already-canonical value or does not). Determinism of the
canonical form is what makes an L2 datum safe to **sign and hash** (the codec is a
soundness dependency — [ontos-codec §1](ontos-codec.md), ontos-internal#4).

### 4.1 Producer admission — the three laws

§4 governs the producer's **output** (one canonical spelling). This section governs
its **input**: which host values a producer accepts, and what it MUST do with one it
cannot represent.

Every embedding has an **admissible domain** — the set of host values that denote a
datum of that embedding. `utf8-text` (§5.2) admits exactly the sequences of Unicode
scalar values (equivalently: valid UTF-8); an unpaired surrogate or an invalid byte
sequence is **outside** it. `int` (§5.1) admits exact integers, and a host boolean
is outside it even where the host's type system says otherwise. A producer given a
host value outside its embedding's domain has exactly one correct behavior — refuse —
and the following three laws say so precisely.

Let `encode` be a producer for embedding *E*, `recognize` the corresponding
recognizer, and `h` a host value.

1. **Producer soundness.** If `encode(h)` succeeds and yields `v`, then
   `recognize(v)` MUST succeed. A producer MUST NOT mint a value that its own
   recognizer rejects. *(A successful encode is a claim that the result is a
   well-formed member of the embedding; a value only this producer can make and no
   reader can read is not one.)*

2. **Fidelity.** If `h` is outside the admissible domain, `encode(h)` MUST NOT
   succeed with a value denoting some *other, admissible* datum. Substituting a
   replacement character, truncating, rounding, or coercing across embeddings all
   violate this. *(This is the most dangerous failure of the three: the output is
   well-formed, so soundness holds and every downstream check passes, while the datum
   is not the one the caller supplied. Once the host value is gone the substitution is
   generally undetectable.)*

3. **Rejection completeness.** If `h` is outside the admissible domain, `encode(h)`
   MUST fail, and MUST report the failure through **this profile's own declared error
   channel** in that implementation — not by propagating a host standard-library
   exception unchanged, and not by substituting. *(A caller that already handles the
   profile's error type must not additionally have to catch a host-specific exception
   to be correct. An implementation that lets, say, a UTF-8 encoding exception escape
   from its own encoder has not rejected the input in any way the caller can rely
   on.)*

   This law fixes **through what channel** a domain rejection is reported, not what
   it is *called*. The error vocabularies are currently implementation-defined and
   differ in shape across the peers — the Rust peer exposes coarse structural
   variants, while the TypeScript and Python peers expose finer string codes — and
   this spec does not (yet) register a shared code vocabulary. Aligning those is a
   separate question from the three laws, and nothing here should be read as
   requiring identical code strings.

**Mechanisms may differ; outcome classes may not.** These laws constrain *what
happens*, not *how it is enforced*. A language whose string type already carries the
UTF-8 invariant satisfies the text case by making the inadmissible value
unconstructible, and its producer is then total — that is full conformance, not an
exemption. A language whose string type does not carry that invariant MUST check.
What no implementation may do is **succeed with a different datum** (law 2) or
**succeed with an unreadable one** (law 1).

Consequently a producer's signature is part of its conformance: where a language
admits inadmissible host values into the producer's parameter type, a total
(non-failing) producer for that embedding **cannot** satisfy these laws, and the
signature MUST be fallible.

These laws are cross-language obligations. They constrain the **host-value → L2**
step, which sits *upstream* of the byte encoding and is therefore invisible to any
check that begins from an L0 value — including the differential corpus in
[`vectors/`](../../vectors/) and the runner in `tools/conformance/`
([`ontos-conformance.md`](ontos-conformance.md)), both of which start from a value
that already exists. Enforcing them differentially requires a conformance axis that
can construct **host** values in each language; until one exists, these laws are
normative but pinned only by each implementation's own tests.

## 5. The v1 label set

`ontos/data` registers eight embeddings — **four scalars** (`int`, `utf8-text`,
`bool`, `decimal`), **three structural** kinds (`list`, `map`, `set`), and the
**nullary no-value** `null` (§5.10) — neither a scalar (it carries no value) nor a
container (it holds nothing), but its own little category: the single canonical
spelling of *present-but-no-value*. The three **L0-only scalars** (`int`,
`utf8-text`, `bool`), `list`, and `null` are *self-contained*: specifiable with no
dependency outside L0, no total order, and no cross-embedding coupling. `decimal`
(§5.9) is the one scalar that **does** couple to another embedding — it is built on
`int`, recursing into two `int` children (§5.9) — yet it needs no codec and no total
order, so its canonical form is still purely structural and, like the self-contained
kinds, it is **not** codec-version-relative. `map` (§5.7) and `set` (§5.8) add the
one thing the floor
lacks — a **total order over values**, supplied by [`ontos/codec` §6](ontos-codec.md)
— to canonicalize a keyed association and a unique collection respectively; they are
the first embeddings whose canonical form depends on the codec, hence
*codec-version-relative* (§6). `null` (§5.10) is the empty-container *shape* with a
new label — `Tuple(Atom("null"))`, structurally the empty `list`/`map`/`set` form —
but it is not a container: it has exactly one inhabitant and is read as a no-value,
not as an empty collection. (The original v1 set — `int`, `utf8-text`, `bool`,
`list` — was frozen 2026-05-31; `map` and `set` were added 2026-06-01; `decimal`
(§5.9) was added 2026-06-06; `null` (§5.10) was added 2026-06-13. Their exact
canonical byte forms are pinned in
[`vectors/data.json`](../../vectors/data.json); see §6.)

### 5.1 `int` — exact integer  *(byte form FROZEN, v1)*

An exact, **unbounded-in-principle** integer (not bounded to 64-bit). Shape:
`Tuple(Atom("int"), Atom(<sign-magnitude bytes>))` — one payload atom.

- **Exact only.** No floating-point, ever (it would break "one canonical form per
  value" — [ontos-core §3.1](ontos-core.md)). Inexact/float arithmetic, if a
  consumer needs it, is a *consumer/engine* concern that never produces an L2
  `int`; its results are not exact data.
- **Canonical payload (frozen):** **one leading sign byte** followed by the
  **big-endian, minimal-length magnitude** (most-significant byte first, **no
  leading `0x00` bytes**):
  - sign byte `0x00` = non-negative, `0x01` = negative;
  - magnitude = `|n|` big-endian with leading zero bytes stripped;
  - **zero is exactly the single byte `0x00`** (sign `0x00`, empty magnitude) —
    there is no negative zero;
  - chosen on its own merits, not inherited from any consumer's `i64`.

  This gives **one spelling per integer**. Examples (payload-atom bytes, then the
  full v1-codec encoding of the whole `int(...)` value):

  | integer | payload atom bytes | full encoded value (hex) |
  |---|---|---|
  | `0`   | `00`     | `01 02 00 03 69 6e 74 00 01 00` |
  | `1`   | `00 01`  | `01 02 00 03 69 6e 74 00 02 00 01` |
  | `-1`  | `01 01`  | `01 02 00 03 69 6e 74 00 02 01 01` |
  | `255` | `00 ff`  | `01 02 00 03 69 6e 74 00 02 00 ff` |
  | `256` | `00 01 00` | `01 02 00 03 69 6e 74 00 03 00 01 00` |

  (Full encoding = `Tuple(Atom("int"), Atom(payload))`: `01`=tuple tag, `02`=arity
  2, then `Atom("int")` = `00 03 69 6e 74`, then `Atom(payload)` = `00 ‖ len ‖
  payload`. "int" is bytes `69 6e 74`.)
- **Non-canonical magnitude** (any leading `0x00` in the magnitude, e.g. payload
  `00 00 01`, or a negative-zero `01` with empty magnitude) is **not** a
  well-formed `int` — it remains a valid L0 value, never a quotient-equal integer
  (§2).
- **arche reconciliation:** arche's carrier uses fixed 8-byte big-endian `i64`;
  arche **re-encodes** to this canonical sign-magnitude form. No transitional
  i64-relabel encoding lives on the value path (§6).
- **Implementation bindings & integer width (non-normative).** The byte form above
  is unbounded; an implementation *binding* MAY expose it over a bounded host
  integer type. A canonical `int` whose magnitude exceeds that type is still
  **recognized** as a well-formed `int` — it simply cannot be *materialized* into
  the host type, so the binding signals an implementation-local **resource limit**
  (never a "malformed" / not-recognized rejection, and never a panic). This mirrors
  `ontos/codec`'s native-width materialization limit
  ([ontos-codec.md §3.1](ontos-codec.md)): a valid value that exceeds an
  implementation's usable integer width is a resource-limit condition, not a domain
  error. The reference bindings: TypeScript (`bigint`) and Go (`*big.Int`) are
  unbounded; Rust exposes `i128` and returns a typed out-of-range error past it.
  The `py` validation lane's binding is likewise unbounded (Python `int`). This is
  a *binding choice only* — it changes no canonical byte form, and byte parity
  holds across all four bindings for every value they can represent.
- **Recognition is binding-independent (non-normative).** Because recognition is
  *structural* — "does the value have the canonical `int` form?" — and not
  materialization, every binding reports a `> host-width` canonical `int` as
  **recognized**; the resource limit surfaces only when a caller asks for the host
  datum (the binding's `read_int` / `ReadInt` / `readInt`), not from the recognizer
  (`recognize_int` / `RecognizeInt` / `recognizeInt`, which the `ontos` CLI's
  `read --kind int` uses). The host-width boundary is exact and pinned per core:
  `i128::MAX` (`2^127 - 1`) and `i128::MIN` (`-2^127`) materialize in all four
  bindings, while the next value outward in each direction — `2^127` and
  `-(2^127 + 1)` — is the smallest canonical `int` that Rust's `i128` reports as a
  resource limit (`IntOutOfRange`) while Go (`*big.Int`), TS (`bigint`) and py
  (Python `int`) materialize and round-trip it. All four bindings nonetheless
  **recognize** these values identically, so a `> i128` int sits *in* the
  byte-identical differential conformance corpus (`int_2pow128` in
  `vectors/data.json`, recognized as `int` by every core); the materialization
  difference is pinned separately by per-core boundary tests in
  `data/{rs,go,ts,py}` ([ontos-conformance.md](ontos-conformance.md),
  "Relationship to `vectors/`").
- **Producer domain ([§4.1](#41-producer-admission--the-three-laws)).**
  The admissible input is an exact integer. A host value of a *different* kind that
  the host's type system merely permits in an integer position — notably a **boolean**
  in a language where `bool` is a subtype of `int` — is **outside** the domain:
  `bool` has its own embedding (§5.3), so encoding one as an `int` succeeds with a
  datum the caller did not supply (law 2), and does so while type-checking clean.
  The test a producer MUST apply is *"does this host value denote a datum of a
  **different** embedding?"* — which a subtype check cannot answer, since
  `isinstance(True, int)` holds. A host subtype that denotes an ordinary exact
  integer and that **no other embedding claims** (an integer-valued enum, say) stays
  admissible; it is the collision with `bool`'s own embedding that puts a boolean
  outside the domain, not its subtype-ness as such.

### 5.2 `utf8-text` — Unicode text  *(byte form FROZEN, v1)*

A text string. Shape: `Tuple(Atom("utf8-text"), Atom(<utf-8 bytes>))`.

- The payload atom MUST be **valid UTF-8**; an atom that is not valid UTF-8 is not
  a well-formed `utf8-text` (it remains a valid L0 atom).
- **Canonical form (frozen): the valid UTF-8 bytes verbatim — no Unicode
  normalization** (no NFC/NFD). Rationale: keeps v1 self-contained and
  dependency-free, and avoids baking one normalization regime into the floor.
  *Consequence to know:* two strings that are Unicode-canonically-equivalent but
  byte-distinct are **distinct** `utf8-text` values (the floor distinguishes
  maximally — [ontos-core §3.1](ontos-core.md)). A consumer that wants
  normalization defines a *separate, later* embedding (e.g. `utf8-text-nfc`) and
  normalizes at the producer; it is **not** part of `utf8-text`.
- **Reading is exact.** Reading a well-formed `utf8-text` yields exactly the sequence
  of Unicode scalar values its payload encodes, so re-encoding the result reproduces
  the payload byte for byte. A reader MUST NOT drop, add or replace a scalar value.
  In particular, a leading U+FEFF is content, not a byte-order mark: a payload that
  begins `EF BB BF` reads as a string that begins with U+FEFF. (Pinned by the
  `utf8_leading_feff` vector, with `utf8_inner_feff` as its control; ontos-internal#338.)
- **Producer domain ([§4.1](#41-producer-admission--the-three-laws)).**
  The admissible input is exactly those host values denoting a sequence of Unicode
  scalar values. An unpaired surrogate, or a host string carrying bytes that are not
  valid UTF-8, is **outside** the domain and MUST be rejected. Specifically, such an
  input MUST NOT be encoded verbatim — that mints a value this section's own first
  bullet makes unreadable (law 1) — and MUST NOT be repaired by substituting U+FFFD
  or any other replacement character, which succeeds with a *different* datum
  (law 2) and is undetectable once the host string is gone. A language whose string
  type already guarantees valid UTF-8 satisfies this by construction, and its
  producer is total.

### 5.3 `bool` — boolean  *(byte form FROZEN, v1)*

A boolean. Shape: `Tuple(Atom("bool"), Atom(<marker>))` — one payload atom.

- **Canonical form (frozen):** the payload atom is the **single byte** `0x00` =
  false, `0x01` = true. Exactly two well-formed values: `bool(Atom(0x00))` and
  `bool(Atom(0x01))`. Any other payload (empty, longer, or a different byte) is
  **not** a well-formed `bool`. (Chosen over two nullary-style labels because a
  single-byte payload is the smallest one-spelling-per-value form and needs no
  second label registration.)
  - full encodings: `false` = `01 02 00 04 62 6f 6f 6c 00 01 00`,
    `true` = `01 02 00 04 62 6f 6f 6c 00 01 01` ("bool" = `62 6f 6f 6c`).

### 5.4 Mapping a five-sort term world onto this profile (e.g. arche)

A consumer whose term language has the classic five sorts — variable, string,
integer, bytes, compound (this is arche's `Var/Str/Int/Bytes/Comp`, and the
general logic-term shape) — maps onto ontos as follows. **The mapping is
deliberately not sort-preserving, and that asymmetry is correct:**

| Source sort | ontos home |
|---|---|
| bytes | a **bare** `Atom(bytes)` (L0) — opaque bytes *are* the floor's leaf |
| string | `utf8-text(Atom(bytes))` — an L2 **compound**, §5.2 |
| integer | `int(Atom(…))` — an L2 **compound**, §5.1 |
| compound `f(a…)` | the L1 labeled-compound reading `Tuple(Atom("f"), a…)` |
| variable | **not ontos** — it is logos's `Var` (a logic term, never an ontos value); reified for storage via `quote` |

The surprise to flag for anyone doing such a migration: **`bytes` and `string`
diverge in *structure*, not just in label.** A source `Bytes("x")` becomes a bare
atom; a source `Str("x")` becomes a compound `utf8-text(Atom("x"))`. This is the
austere floor working as intended — "text" is *bytes plus the claim that they are
text*, and that claim is the label — and it **preserves the source distinction**
(`Str("x") ≠ Bytes("x")` maps to `utf8-text(Atom("x")) ≠ Atom("x")`, two
structurally distinct L0 values). A migration that flattened both to a bare atom
would silently merge two values the source kept apart; the compound wrapper on
`string`/`int` is exactly what prevents that.

### 5.5 `list` — ordered sequence  *(byte form FROZEN, v1)*

An **ordered, finite sequence** of arbitrary values. Shape:
`Tuple(Atom("list"), elem₀, …, elemₙ₋₁)` — the label `list` followed by the `n`
elements in order (tuple arity `n + 1`). Label bytes: `list` = `6c 69 73 74`.

- **Elements are arbitrary L0 values**, in order. `list` constrains *only its own
  shape* (the `list` label plus ordered children); it imposes **no** constraint on
  element kind. A list may be heterogeneous, and an element may itself be any L0
  value — a bare atom (i.e. bytes, §5.4), another embedding, or a nested `list`.
  This is what makes `list` a *generic container* rather than a typed one (§7).
- **Order and multiplicity are identity** (inherited from L0 — [ontos-core
  §3](ontos-core.md)): `[a, b] ≠ [b, a]` and `[a] ≠ [a, a]`. A `list` is **never
  sorted or deduplicated** — it is a sequence, not a set or a multiset. Because
  order is positional (not key-sorted), `list` needs **no total order over values**
  (that is `map`'s dependency, §5.6) and stays self-contained.
- **Empty list:** `Tuple(Atom("list"))` — arity 1, zero elements — the one
  canonical empty sequence.
- **Canonical form (frozen):** exactly one `list` value per ordered sequence of
  elements. Wrap once with the `list` label, preserve order, and normalize nothing
  of its own — beyond requiring each element to *already be in its own canonical
  form* (the value-not-position rule, §2.1: an `int` element is the canonical
  `int(…)` it would be standalone, a text element the canonical `utf8-text(…)`, a
  bytes element a bare `Atom`). The `list` wrapper adds no further normalization.
- **The bare form is forbidden.** A bare `Tuple(elem₀, …)` with no `list` label is
  **not** a `list`: at L1 it is indistinguishable from the compound
  `elem₀(elem₁ …)` ([ontos-compound](ontos-compound.md)), so it does not even
  describe itself as a sequence. Only the `list`-labeled form is a recognized list.
  (This is the R4 fix from
  [0005](../design/0005-worked-example-pressure-test.md): the missing label is
  exactly what let blind encoders fork list identity.) A bare tuple remains a
  perfectly valid L0 value — it is simply not a well-formed `list`.
- **Mirrors no consumer scalar sort.** Unlike `int`/`utf8-text`/`bool`, `list` is
  not the image of any scalar primitive of arche's term world
  (`Var/Str/Int/Bytes/Comp` has no sequence sort — a sequence there is an ordinary
  compound, exactly as it is here). `list` is therefore the embedding that shows
  the registry carries a *structural* value-kind no single consumer dictated — the
  agnosticism gate (§7).

### 5.6 `map` — the deferral (historical), now resolved

`map` was originally **reserved but deferred** — a historical sequencing note, not a
current caveat: a canonical `map` must sort its entries by key, and keys are
arbitrary L0 values, which needs a **total order over all ontos values** deliberately
kept out of L0 ([design/0003](../design/0003-layered-architecture.md)). The
resolution was always "canonical map order = `ontos/codec` byte order," which had to
wait on the codec. That dependency was satisfied when `ontos-codec-v1` was frozen
(it supplies a total order over all values, [ontos-codec §6](ontos-codec.md)).

**`map` is no longer deferred:** it is **defined and frozen in §5.7** (2026-06-01),
the first embedding whose canonical form depends on the codec rather than on L0
structure alone (see §5.7 and §6). It is — and was throughout — a reserved label
(§1.1): no consumer may define a rival.

### 5.7 `map` — finite association  *(byte form FROZEN, added 2026-06-01)*

A **finite association** of distinct keys to values — the graph of a finite partial
function over L0 values. Shape:
`Tuple(Atom("map"), Tuple(k₀, v₀), …, Tuple(kₙ₋₁, vₙ₋₁))` — the label `map` followed
by `n` **entries**, each an **exactly-arity-2** `Tuple(key, value)` (tuple arity
`n + 1`). Label bytes: `map` = `6d 61 70`. `map` is the structural sibling of `list`
(§5.5) — wrap once with a label, membership is L0 identity — plus the one thing
`list` deliberately lacks: a **total key order**, supplied by
[`ontos/codec` §6](ontos-codec.md)'s `order(·,·)`.

- **Keys and values are arbitrary L0 values.** Like `list` elements (§5.5), `map`
  **constrains only its own shape** — the `map` label, the arity-2 entries, and the
  key order/uniqueness below; it imposes **no** constraint on key or value *kind*. A
  key may be a bare `Atom` (bytes), any embedding, an unrecognized compound, or a
  nested `map`. Recognizing a `map` does **not** recurse into whether a key or value
  that *claims* an embedding label is itself canonical — that is the producer's
  value-not-position obligation (§2.1), exactly as for `list` elements. A key shaped
  like a non-canonical `int` is a perfectly good *key* (a valid L0 value with a
  unique encoding, hence a definite sort position); it is simply not *also* a
  recognized `int`. So `map` well-formedness is a purely **structural + codec-order**
  check, independent of which other embeddings exist or are adopted.
- **Entries are sorted by key, strictly ascending, under the codec total order.** The
  canonical form lists entries so that `order(kᵢ, kᵢ₊₁)` holds **strictly** for every
  adjacent pair — i.e. `encode(k₀) < encode(k₁) < … < encode(kₙ₋₁)` as unsigned
  bytewise-lexicographic comparison of the `ontos-codec-v1` encodings
  ([ontos-codec §6](ontos-codec.md)). Because keys are pairwise distinct and `order`
  is total (codec injectivity), **sorting by the key alone is already total** — there
  is exactly one ascending arrangement, and **no value tiebreak is defined or
  permitted** (a value tiebreak could only ever mask a duplicate key). The order is
  over codec **bytes**, *not* numeric or Unicode collation: `int` keys do **not** sort
  by numeric value, `utf8-text` keys do **not** sort by Unicode order — a domain order
  would bake a consumer's type system into the floor and fail the agnosticism gate
  (§7). A consumer wanting a domain order materializes the map and sorts in its own
  layer; the stored, signed, and hashed form is byte-ordered.
- **Duplicate keys are forbidden.** A value with two entries whose keys are the same
  L0 value is **not** a well-formed `map` (it remains a valid L0 value, merely
  unrecognized). **Never last-wins, never first-wins, never merge** — each is a
  reader-side collapse that would declare two byte-distinct L0 values to be the same
  map, i.e. a **quotient applied after the value is built**, which §2/§2.1 forbid (it
  would introduce an equality the floor does not have). A producer handed a surface
  multimap resolves its duplicate intent **before** building (§4); what is stored,
  signed, and hashed already has unique keys. This is `int`'s non-minimal-magnitude
  rejection one structure up: a second spelling of an already-expressible association
  is simply not well-formed.
- **Empty map:** `Tuple(Atom("map"))` — arity 1, zero entries — the one canonical
  empty map (the `n = 0` case; the strict-ascending invariant holds vacuously). It is
  distinct at L0 from the empty `list` `Tuple(Atom("list"))` (`map` ≠ `list`
  octet-for-octet), so an empty map never collides with `[]`.
- **Canonical form (frozen):** exactly one `map` value per association. Wrap once with
  the `map` label; resolve duplicates and sort entries by key at the **producer**; the
  recognizer only verifies, in one left-to-right pass: **(1)** `v` is a `Tuple` of
  arity ≥ 1 whose child 0 is `Atom("map")`; else not a map. **(2)** arity 1 ⇒ the
  empty map, accept. **(3)** every later child is a `Tuple` of arity **exactly 2**;
  else not a map. **(4)** for each entry after the first, require
  `encode(prevKey) < encode(key)` strictly — this single comparison decides **both**
  sortedness (out of order ⇒ mis-sorted) **and** duplicate-freedom (equal ⇒ duplicate,
  by injectivity). Accept iff all pass; every rejection yields an unrecognized L0
  value, never an error and never a quotient.
- **The bare, flat, and unlabeled forms are forbidden** (as for `list`, §5.5): a bare
  `Tuple(Tuple(k,v), …)` with no `map` label, a flat `Tuple(Atom("map"), k, v, …)`
  whose children are not arity-2 entries, and the arity-0 `Tuple()` are each a valid
  L0 value but **not** a well-formed `map`.
- **Codec-version-relative.** `map` is the first embedding whose canonical form is
  defined by `ontos/codec` (its entry order is `ontos-codec-v1`'s `order`). A future
  `ontos-codec-v2` would change the order, hence the set of canonical maps, so it
  implies a **new `map` version** — `map`-over-v1 is frozen against `ontos-codec-v1`.

Worked byte forms (authoring notation mirrors
[`vectors/data.json`](../../vectors/data.json); full `ontos-codec-v1` encodings,
generated by the real encoder):

| map | value | full encoded (hex) |
|---|---|---|
| `{}` | `Tuple(Atom("map"))` | `01 01 00 03 6d6170` |
| `{int 1 → "hi"}` | `Tuple(Atom("map"), Tuple(int(1), utf8-text("hi")))` | `01 02 00 03 6d6170  01 02  01020003696e7400020001  01020009757466382d7465787400026869` |

`vectors/data.json` pins these plus heterogeneous-key ordering (a bare-atom key
before an `int` key before a `utf8-text` key — by codec bytes, not by kind),
prefix-related keys, a nested `map`, a `map` used as a key, a non-canonical-`int`
key (accepted — no recursion), and the reject set: unsorted entries, a duplicate
key, an arity-3 entry, the flat form, the unlabeled form, the empty tuple, and a
cross-kind read.

### 5.8 `set` — finite set  *(byte form FROZEN, added 2026-06-01)*

A **finite set** of distinct values — an unordered collection with no duplicates.
Shape: `Tuple(Atom("set"), e₀, …, eₙ₋₁)` — the label `set` followed by `n`
**elements** in canonical order (tuple arity `n + 1`). Label bytes: `set` =
`73 65 74`. `set` completes the structural family: `list` (§5.5) is *ordered, with
duplicates*; `map` (§5.7) is *keyed*; `set` is *unordered and unique*. It is `map`'s
key-discipline with no values — it reuses the same total order
([`ontos/codec` §6](ontos-codec.md)) to give exactly one canonical spelling per set.

- **Elements are arbitrary L0 values.** Like `list` elements (§5.5) and `map` keys
  (§5.7), `set` **constrains only its own shape** (the `set` label, the element order,
  and the uniqueness below); it imposes **no** constraint on element *kind* and does
  **not** recurse into whether an element that claims an embedding label is itself
  canonical — a non-canonical-`int` element is an accepted element (it is simply not
  *also* a recognized `int`). `set` well-formedness is a purely structural +
  codec-order check, independent of which other embeddings exist.
- **Elements are sorted, strictly ascending, under the codec total order.** The
  canonical form lists elements so that `order(eᵢ, eᵢ₊₁)` holds **strictly** for every
  adjacent pair — `encode(e₀) < encode(e₁) < … < encode(eₙ₋₁)` as unsigned
  bytewise-lexicographic comparison of the `ontos-codec-v1` encodings
  ([ontos-codec §6](ontos-codec.md)). The strict increase makes the order canonical
  **and** forbids duplicates in one check. The order is over codec **bytes**, *not* any
  consumer's numeric or Unicode collation (§7).
- **Duplicate elements are forbidden.** A value with the same L0 element twice is
  **not** a well-formed `set` (it remains a valid L0 value, merely unrecognized) —
  never deduplicated by the reader (a reader-side dedup would be a quotient declaring
  two byte-distinct L0 values the same set, which §2/§2.1 forbid). The producer
  removes duplicates **before** building (§4). A collection that *keeps* multiplicity
  is a different value-kind (a multiset), not a `set`.
- **Empty set:** `Tuple(Atom("set"))` — arity 1, zero elements — the one canonical
  empty set. It is distinct at L0 from the empty `list` `Tuple(Atom("list"))`, the
  empty `map` `Tuple(Atom("map"))`, and the bare empty tuple `Tuple()`, so an empty set
  never collides with `[]` or `{}`.
- **Canonical form (frozen):** exactly one `set` value per finite set of values. Wrap
  once with the `set` label; remove duplicates and sort elements by codec bytes at the
  **producer**; the recognizer verifies in one left-to-right pass: **(1)** `v` is a
  `Tuple` of arity ≥ 1 whose child 0 is `Atom("set")`; else not a set. **(2)** arity 1
  ⇒ the empty set. **(3)** for each element after the first, require
  `encode(prev) < encode(elem)` strictly — equal ⇒ duplicate (reject), greater ⇒ out of
  order (reject). Accept iff all pass; every rejection yields an unrecognized L0 value,
  never an error and never a quotient.
- **The bare and unlabeled forms are forbidden** (as for `list`/`map`): a bare
  `Tuple(e₀, …)` with no `set` label and the arity-0 `Tuple()` are valid L0 values but
  not well-formed sets.
- **Codec-version-relative** (like `map`): the element order is `ontos-codec-v1`'s, so
  a future `ontos-codec-v2` would change it and implies a new `set` version.

Worked byte forms (authoring notation mirrors
[`vectors/data.json`](../../vectors/data.json); full `ontos-codec-v1` encodings):

| set | value | full encoded (hex) |
|---|---|---|
| `{}` | `Tuple(Atom("set"))` | `01 01 00 03 736574` |
| `{0x61, 0x62}` | `Tuple(Atom("set"), Atom(0x61), Atom(0x62))` | `01 03 00 03 736574  000161  000162` |

`vectors/data.json` pins these plus a heterogeneous set (a bare-atom element before an
`int` before a `utf8-text`, by codec bytes), a nested set-of-sets, an accepted
non-canonical-`int` element, and the reject set: unsorted, duplicate, unlabeled, empty
tuple, bare atom, and cross-kind.

### 5.9 `decimal` — exact decimal value  *(byte form FROZEN, added 2026-06-06)*

An **exact decimal** number — the value `mantissa × 10^exponent` for two exact
integers. Shape: `Tuple(Atom("decimal"), int(mantissa), int(exponent))` — the label
`decimal` followed by **two `int` children** (§5.1), the mantissa then the exponent
(tuple arity 3). Label bytes: `decimal` = `64 65 63 69 6d 61 6c`.

- **Exact only; a subset of the rationals.** `mantissa × 10^exponent` represents
  exactly the rationals whose denominator divides a power of ten (every terminating
  decimal). It is **not** IEEE-754 binary floating-point — that has ±0, NaN bit
  patterns, and multiple spellings of one value, breaking "one canonical form per
  value" exactly as it would for `int` (§5.1). It is **not** a general rational
  either: `1/3` is not a terminating decimal and has no `decimal` form (a general
  ratio is the separate, still-unbuilt `rational` candidate, §9). Inexact/float
  arithmetic, if a consumer needs it, never produces an L2 `decimal`.
- **Built on `int`, by the value-not-position rule (§2.1).** The mantissa and exponent
  are each the **full canonical `int` embedding**, not a bare sign-magnitude atom. The
  same integer is the same `int(…)` value wherever it sits (§2.1); spelling the
  mantissa as a bare atom here would be a second, position-dependent spelling of an
  integer, which §2.1 forbids. (It is also the shape a future `rational` (§9) would
  reuse — numerator/denominator as two `int`s.)
- **Canonical form (frozen) — one spelling per value:**
  - **zero** is exactly `decimal(int 0, int 0)` — mantissa `int(0)` **and** exponent
    `int(0)`. Pinning the exponent to `0` collapses `0 × 10^5`, `0 × 10^0`, … to one
    spelling.
  - a **non-zero** decimal has a mantissa that is **not divisible by 10** (no trailing
    base-10 zero); the exponent is any canonical `int`. So `3.14` is uniquely
    `decimal(int 314, int -2)`, and the integer-valued `100` is `decimal(int 1, int 2)`
    (`100 = 1 × 10^2`; a `mantissa` of `100` or `10` carries a trailing zero and is not
    canonical).
  - **both children must each be a canonical `int`** (§5.1) — see the recursion note.

  This is `int`'s minimal-magnitude discipline (§5.1) lifted to a pair: a second
  spelling of an already-expressible decimal (a trailing-zero mantissa, or a non-zero
  exponent on zero) is **not well-formed** — it remains a valid L0 value, never a
  quotient-equal decimal (§2).
- **`decimal` recurses into its children — unlike `list`/`map`/`set`.** `list` (§5.5),
  `map` (§5.7), and `set` (§5.8) are **containers**: their identity is the structural
  arrangement of arbitrary children, so they do **not** recurse — a non-canonical-`int`
  element or key is still an accepted *element/key* (it is simply not *also* a
  recognized `int`). `decimal` is a **scalar**: its identity is the number it denotes,
  so one-spelling-per-value **requires** its mantissa and exponent to be canonical
  `int`s. `decimal(int(000001), int 0)` — a mantissa shaped like an `int` but with a
  non-minimal magnitude — is therefore **not** a well-formed `decimal` (it is a valid
  L0 value, not a recognized decimal). Recursion here is the **scalar** discipline (one
  canonical spelling of the embedded integer), not the **container** discipline.
- **A `decimal` and an `int` of the same number are distinct L0 values.**
  `decimal(int 1, int 2)` (the decimal `100`) and `int(100)` are different octet
  strings, hence different values — the floor distinguishes maximally (§2). Cross-kind
  numeric equality (`decimal 100 = int 100`) is a **consumer/engine** concern (e.g.
  logos's arithmetic), never an ontos equality; `ontos/data` supplies only the
  *representation*.
- **Recognition vs materialization — mirrors `int` (§5.1).** Recognizing a `decimal` is
  **structural** and host-width-independent: a value is a well-formed `decimal` iff it
  has the shape above, both children are canonical `int`s (the structural `int`
  recognizer, §5.1), and the mantissa/exponent satisfy the canonical rule — the
  "mantissa not divisible by 10" test is decided on the mantissa **magnitude bytes**
  (mod 10), so a mantissa beyond any host integer width is recognized **identically**
  across bindings. *Materializing* the pair into host integers is the separate concern:
  a binding over a bounded host type (Rust's `i128`) signals a **resource limit** when a
  child exceeds it (never a not-recognized rejection, never a panic), exactly as `int`
  does — the unbounded bindings (Go `*big.Int`, TS `bigint`) materialize it. So a
  `> i128`-mantissa decimal is **recognized** by every core and sits in the
  byte-identical differential corpus, while only its *materialization* differs per
  binding. The same host-width limit applies on the **producer** side: a bounded
  binding signals the resource limit (rather than overflowing) if normalizing a decimal
  would push its canonical exponent past the host type — an astronomically large
  exponent the unbounded bindings encode without limit. This is a binding detail; it
  changes no byte form (the exponent is an unbounded `int` child in the frozen shape).
- **Self-contained — codec-independent.** Unlike `map`/`set`, a `decimal`'s canonical
  form needs **no** total order over values: it is fixed by structure (shape +
  canonical-`int` children + the mod-10 rule) alone. `decimal` is therefore **not**
  codec-version-relative — it is frozen on L0 structure and `int`, like the other
  scalars and `list`.

Worked byte forms (full `ontos-codec-v1` encodings; each is the `decimal` tuple wrapper
over the already-pinned `int` child encodings of §5.1):

| decimal | value | full encoded (hex) |
|---|---|---|
| `0`            | `decimal(int 0, int 0)`   | `01030007646563696d616c  01020003696e74000100    01020003696e74000100` |
| `1`            | `decimal(int 1, int 0)`   | `01030007646563696d616c  01020003696e7400020001  01020003696e74000100` |
| `3.14`         | `decimal(int 314, int -2)`| `01030007646563696d616c  01020003696e74000300013a  01020003696e7400020102` |
| `100` (=1×10²) | `decimal(int 1, int 2)`   | `01030007646563696d616c  01020003696e7400020001  01020003696e7400020002` |
| `-0.5` (=-5×10⁻¹)| `decimal(int -5, int -1)`| `01030007646563696d616c  01020003696e7400020105  01020003696e7400020101` |

(Full encoding = `Tuple(Atom("decimal"), int(m), int(e))`: `01`=tuple tag, `03`=arity 3,
then `Atom("decimal")` = `00 07 646563696d616c`, then the two `int` children verbatim
from §5.1. `decimal` = bytes `64 65 63 69 6d 61 6c`.)

`vectors/data.json` pins these plus a `> i128`-mantissa decimal (recognized by every
core, materialized only by the unbounded bindings — the `int_2pow128` analog), and the
reject set: a trailing-zero mantissa, a non-zero exponent on zero, a non-canonical-`int`
mantissa (the recursion case), a child that is not an `int` embedding, a wrong arity, a
bare atom, and a cross-kind read.

### 5.10 `null` — the single no-value  *(byte form FROZEN, added 2026-06-13)*

The single canonical spelling of **present-but-no-value**. Shape:
`Tuple(Atom("null"))` — the label `null` with **no payload children** (tuple arity
**exactly 1**). Label bytes: `null` = `6e 75 6c 6c`. `null` is structurally the
empty-container *shape* — the same nullary compound as the empty `list`
(`Tuple(Atom("list"))`, §5.5), empty `map` (§5.7), and empty `set` (§5.8), with a new
label — but it is **not** a container: it holds nothing, has exactly one inhabitant,
and is read as a no-value rather than as an empty collection. It is neither a scalar
(it carries no value) nor structural (it has no children); it is its own little
category, the nullary no-value.

- **Single inhabitant; exactly one no-value, forever.** There is exactly one
  well-formed `null` value — `Tuple(Atom("null"))` — because there is no payload to
  vary. The spec **forecloses a second no-value** for v1: there is no `undefined`, no
  `nil`, no `missing`, and no typed-null variant (`null(int)`, `null<T>`, …). This is
  the one-canonical-form-per-value rule (§2, [ontos-core §3.1](ontos-core.md))
  applied to the no-value itself, and it is a deliberate response to the prior art:
  CBOR shipped both `null` and `undefined` and DAG-CBOR had to **ban one** to regain
  canonicity; Ion's typed nulls multiply the no-value across every type. A canonical,
  signed/hashed floor that admits a no-value admits **exactly one**.
- **`null()` means present-but-no-value, NOT absence.** A `null` is a *value that is
  present and says "no value here"* — distinct from a key simply not being in a `map`
  or an optional field being omitted. **Absence stays structural** — an absent `map`
  key (§5.7), an omitted optional — and remains the **preferred** modeling for *new*
  vocabulary: if a producer controls the schema, leaving the position out is cleaner
  than filling it with `null()`. `null()` exists for the cases where absence cannot
  carry the meaning: it is the canonical **projection target for a foreign `null`**
  (e.g. JSON `null`, which arrives with every application consumer and must land on
  *one* agreed ontos value, not a per-consumer `appN/null` re-derivation), and for a
  genuinely-meaningful bare no-value (a `label` predicate whose value is a meaningful
  `null`, distinct from `""` and from key-absence — the named demand, §9). This
  mirrors [ontos-codec §8](ontos-codec.md)'s "ontos has no Nil … projected onto a
  chosen value at the producer": the chosen L2 target is now **named** — it is `null()`.
- **Recognition is purely structural.** A value is a well-formed `null` iff it is a
  `Tuple` of arity **exactly 1** whose only child is `Atom("null")`. **Any payload
  (arity > 1) is not a `null`** — `Tuple(Atom("null"), x)` is a valid L0 value, merely
  unrecognized (the typed not-recognized rejection, never a panic and never a
  quotient, per the cross-core contract settled in ontos-internal#49). The bare unlabeled arity-0 `Tuple()`
  and a bare `Atom("null")` are likewise not a `null`. There is nothing to
  *materialize* — recognition is the whole reading — so the binding's `read_null` /
  `ReadNull` / `readNull` and its recognizer coincide, exactly as they do for the
  empty containers.
- **Self-contained — codec-independent.** Like `list` and `bool` (and unlike
  `map`/`set`), a `null`'s canonical form needs **no** total order over values: it is
  fixed by structure alone (the label plus arity 1). `null` is therefore **not**
  codec-version-relative — it is frozen on L0 structure, so a future `ontos-codec-v2`
  does not change it.
- **A `null` is not any other embedding.** `Tuple(Atom("null"))` is octet-distinct
  from the empty `list`/`map`/`set` (different label bytes) and from every scalar, so
  the labels stay disjoint (§7): the one `null` value is recognized **only** as
  `null`, never as a list/bool/etc., and vice versa.

Worked byte form (full `ontos-codec-v1` encoding, generated by the real encoder):

| value | L0 value | full encoded (hex) |
|---|---|---|
| `null()` | `Tuple(Atom("null"))` | `01 01 00 04 6e756c6c` |

(Full encoding = `Tuple(Atom("null"))`: `01`=tuple tag, `01`=arity 1, then
`Atom("null")` = `00 04 6e756c6c`. `null` = bytes `6e 75 6c 6c`.)

`vectors/data.json` pins this canonical form plus the reject set: a `null` with a
payload (arity 2 and arity 3 — the guardrail-1 cases), a near-miss label, the arity-0
empty tuple, a bare atom, and a cross-kind read (an empty `list` read as `null`).

## 6. Status of the byte forms

`ontos/codec` is **frozen as `ontos-codec-v1`** ([ontos-codec §7](ontos-codec.md)),
so the v1 embeddings' canonical byte forms are now **decided and frozen**, and
byte-pinned in [`vectors/data.json`](../../vectors/data.json):

- **`int`** — sign byte + big-endian minimal-magnitude (§5.1). Frozen.
- **`utf8-text`** — valid UTF-8 verbatim, no normalization (§5.2). Frozen.
- **`bool`** — single payload byte `0x00`/`0x01` (§5.3). Frozen.
- **`list`** — `Tuple(Atom("list"), elem*)`, ordered, bare form forbidden (§5.5).
  Frozen.
- **`map`** — `Tuple(Atom("map"), Tuple(key, value)*)`, entries strictly ascending by
  `ontos/codec` byte order on the key, duplicates forbidden (§5.7). Frozen
  (2026-06-01), against `ontos-codec-v1`. The first embedding whose canonical form
  depends on the codec, not on L0 structure alone — so it is **codec-version-relative**
  (a future `ontos-codec-v2` implies a new `map` version).
- **`set`** — `Tuple(Atom("set"), elem*)`, elements strictly ascending by `ontos/codec`
  byte order, duplicates forbidden (§5.8). Frozen (2026-06-01), against
  `ontos-codec-v1`; **codec-version-relative** like `map`.
- **`decimal`** — `Tuple(Atom("decimal"), int(mantissa), int(exponent))`, the mantissa
  not divisible by 10 with zero pinned to `decimal(int 0, int 0)`, both children
  canonical `int`s (§5.9). Frozen (2026-06-06). **Codec-independent** — its canonical
  form is purely structural, so unlike `map`/`set` it is *not* codec-version-relative.
- **`null`** — `Tuple(Atom("null"))`, arity exactly 1, no payload; the single
  inhabitant of present-but-no-value (§5.10). Frozen (2026-06-13). **Codec-independent**
  — its canonical form is fixed by structure alone, so like `list`/`bool`/`decimal` it
  is *not* codec-version-relative.

Nothing remains deferred: the v1 label set (`int`, `utf8-text`, `bool`, `list`), the
structural pair `map` (§5.7) and `set` (§5.8), the scalar `decimal` (§5.9), and the
nullary no-value `null` (§5.10) are all defined and frozen. A *new* embedding added later is additive recognition (§3) — it
cannot break a consumer that never recognized it.

These v1 forms are load-bearing canonical artifacts (signed and hashed by the
layers above — [ontos-codec §1](ontos-codec.md)); changing one is a breaking
change shipped as a new embedding version, never an edit.

## 7. Conformance — including the agnosticism gate

An implementation conforms to an `ontos/data` embedding iff it recognizes the
label, accepts exactly the canonical payloads, rejects non-canonical/malformed
payloads as unrecognized (never as quotient-equal), and round-trips the value as
the underlying L0 value unchanged.

**The agnosticism gate — satisfied by `list`.** The profile MUST be pinned by a
**non-arche conformance fixture**: at least one embedding, with cross-language
vectors, whose value-kind is *not* a relabeling of any single consumer's type
system. **`list` (§5.5) is that fixture, and it is in place.** It is a
*structural* kind — an ordered sequence built only from the floor's `Tuple` — that
mirrors **no** scalar sort of arche's term world (`Var/Str/Int/Bytes/Comp` has no
sequence primitive). Its canonical form and its conformance vectors
([`vectors/data.json`](../../vectors/data.json): `list_empty`, `list_bytes_ab`,
`list_int_text`, `list_nested`) are derived from L0's structure and authored here,
not lifted from arche's fact/term corpus, and they exercise the slot in ways a
scalar cannot — heterogeneity, nesting, and the value-not-position rule (§2.1).

`map` (§5.7) **reinforces** the gate as a second structural, non-arche kind: it is
a keyed association whose canonical order is dictated by the codec's *byte* order,
not by any consumer's numeric or collation sort (`int` keys do not sort numerically,
`utf8-text` keys do not sort by Unicode). `set` (§5.8) does the same for a unique
collection. A registry that standardizes generic structural containers ordered on
their own structural terms — rather than mirroring a consumer's sorted-map or
sorted-set type — is exactly the agnostic-floor evidence the gate asks for: `list`,
`map`, and `set` together are a structural triad (ordered / keyed / unique) no single
consumer's sort list dictates.

Rationale: `ontos/data` is the slot a typed consumer's values drop into. Some
scalar embeddings image an arche sort (`Int ↔ int`, `Str ↔ utf8-text`), so on their
own those scalars could be read as "one consumer's scalar type system wearing ontos
labels" — the exact "agnostic floor in name only" failure the layering exists to
prevent. (`decimal` (§5.9) is itself a scalar that images **no** arche sort — arche
has no decimal — so it is mild extra evidence the registry is not merely arche's
scalars relabeled.) A *structural* embedding that no consumer's sort list
dictates is what proves the slot is generic. (This is the symmetric form of
[design/0003](../design/0003-layered-architecture.md)'s asymmetry discipline: the
floor stays austere *and* the first profile demonstrates it carries a value-kind no
single consumer dictated.) The honest scope of the claim: **not** that arche
*cannot* represent a sequence — it can, as a compound, exactly as `list` *is* a
compound — but that the registry standardizes a generic structural datum on its own
terms, with its own independent cross-language vectors, rather than mirroring a
consumer primitive.

## 8. What `ontos/data` is not

- **Not the floor.** It defines no value L0 lacks and no equality L0 lacks (§2).
  Removing `ontos/data` entirely leaves L0 and L1 fully conformant (§3).
- **Not a schema or type system.** It does not validate consumer data, require
  fields, or police shapes beyond recognizing its own labels. (A consumer's
  `int(…)` that isn't a well-formed embedding is simply not recognized — not an
  error at L0/L1.)
- **Not the codec.** It says *which* L0 values mean an integer/text/boolean;
  `ontos/codec` says how *any* L0 value becomes bytes. Different axes
  ([design/0003](../design/0003-layered-architecture.md)).
- **Not new equality.** Always L0 structural identity (§2).

See also: [`ontos-data-json.md`](ontos-data-json.md) — *the JSON reading*, a
non-normative companion recording the recommended total projection from domain
JSON onto these embeddings (so independent consumers converge on one reading). It
adds no value and no judgment; this spec (§5) remains authoritative for what the
values are.

## 9. Future embeddings — a demand-driven candidate register (no embeddings added here)

The v1 label set is **complete and frozen by design** (§6). New embeddings are
**additive recognition** under the conservative-extension rule (§3): a new label
never changes an existing embedding, the codec, or the L0 floor, so adding one later
can never break a consumer that did not recognize it. The corollary is **austerity**:
because every candidate is a safe future add, *none* should be built ahead of a
**concrete consumer need** — building speculatively adds frozen surface (a new byte
form, vectors, and four-language parity to maintain forever) with no demand behind it.

This register records the anticipated-but-deliberately-unbuilt candidates so the
deferral is an explicit decision (not an oversight) and they are not re-derived each
time. **Each is a candidate only; this section adds no embedding and pins no bytes.**
A candidate is built only when a real consumer need names it, at which point it gets
its own frozen `§5.x` and its own `vectors/data.json` cases — never before.

**Graduated so far.** `decimal` (the decimal half of the former `float / decimal` row)
was the first candidate to graduate: built as §5.9 on 2026-06-06 at logos's named need
for evaluable decimal literals (ontos-internal#102 / logos). `null` (§5.10) graduated
2026-06-13 at the first **named application-consumer need** — visual-atlas
(atlas answer 3; ontos-internal#134), whose JSON projection
(`backend/internal/assertion/projection.go`) hit a meaningful bare `null` on its first
predicate (`label`, where `null` is distinct from `""` and from key-absence). `null`
was never on the candidate register below: unlike the contingent-demand candidates,
its demand is **structural** — it arrives with JSON, and JSON arrives with every
application consumer — so it is added and graduated in one move. Its interim was the
§1.1-sanctioned app compound `Tuple(Atom("visual-atlas/null"))`; recording
absence-is-the-position instead would have forced every JSON-projecting consumer to
mint its own `appN/null`, the exact N-re-derivations-of-one-semantic disease
`ontos/data` exists to cure. A prior-art survey (IPLD Null, DER NULL, CBOR null, Avro
null, EDN nil) is unanimous: a canonical/signed floor that has a no-value has **exactly
one** (§5.10, guardrail 1). IEEE-754 **binary float** is
*not* carried forward as a candidate — it has multiple bit-spellings per value (±0, NaN
payloads) and so cannot have one canonical form (§5.9); a consumer needing exact
fractional values uses `decimal`, and an exact non-decimal ratio is `rational` below.

| Candidate | What it would embed | Triggering need that would justify building it |
| --------- | ------------------- | ---------------------------------------------- |
| `utf8-text-nfc` | Unicode text **NFC-normalized at the producer** (a *separate* label — frozen `utf8-text` stays byte-verbatim, no normalization, §5.2) | A consumer that must compare/dedup text by Unicode canonical equivalence rather than by bytes. |
| raw bytes | An explicitly-labeled opaque byte string, distinct from a bare `Atom` | A consumer needing to mark "these bytes are uninterpreted payload," disambiguated from a labeled scalar. |
| timestamp | An instant on an agreed epoch/scale (e.g. integer nanoseconds), built on `int` | A consumer exchanging times that needs one canonical instant spelling rather than ad-hoc text/int. |
| rational | An exact ratio (numerator/denominator), normalized at the producer | A consumer exchanging exact fractions (e.g. `2/4 = 1/2` via producer-side normalization, [design/0003](../design/0003-layered-architecture.md)). |

Each row is **additive-only** (no L0/codec/existing-embedding change) and therefore
no-risk to defer. The bar to graduate a candidate from this register into §5 is a
named consumer need — not "it would be nice," and not "to round out the set."
