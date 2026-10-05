# ontos/data — the JSON reading (a domain-JSON → ontos/data projection, non-normative)

**Status:** companion (non-normative-for-the-value-model). **Maturity: UNWITNESSED** — three implementations (Go, `data/json/go`; TypeScript, `data/json/ts`; Rust, `data/json/rs`), **all ontos-authored**. Its vectors are frozen and CI-enforced, so it is protected against regression; it is NOT protected against being wrong, because the label turns on independent AUTHORSHIP rather than face count — a face written inside ontos inherits the first reader's resolution of every under-determined clause, so no reading here has yet been derived from this spec by an implementer outside ontos (ontos-internal#255) ([`ontos-conformance.md` §Maturity](ontos-conformance.md#maturity--what-a-surfaces-conformance-actually-rests-on), ontos-internal#191). This documents a
*recommended* total projection from **domain JSON** onto
[`ontos/data`](ontos-data.md) values, so that independent application consumers
converge on **one** reading instead of each inventing its own. It introduces **no
new value, no new embedding, and no new rule about what a value *is***: every value
it produces is an ordinary `ontos/data` value whose meaning, canonical form, and
identity are fixed by [`ontos-data.md`](ontos-data.md) (§5) and the
[`ontos` CLI](ontos-cli.md). If this page and `ontos-data.md` ever appear to
disagree on what a value *is*, `ontos-data.md` wins.

It does, however, **judge its source**. A projection necessarily decides which JSON
forms it accepts, which it refuses, and which source distinctions survive the
crossing — `1.0` is refused rather than coerced, trailing data is refused, repeated
object keys resolve last-wins. Those judgments are this profile's contract, not an
implementation detail, and they are stated in *[Hard edges](#hard-edges-stated-as-contract)*
below. A reading that made no such judgments would not be a projection. The claim
above is therefore the narrow one — nothing here changes value identity — and it
should not be read as *"this projection decides nothing."*

The question this answers is *"a system holds a tree of domain JSON — objects,
arrays, strings, numbers, booleans, `null` — what is the **one** `ontos/data`
value each form reads as, and which forms are refused?"* It records the projection
that visual-atlas, the first application consumer, shipped
(`backend/internal/assertion/projection.go`, filed as prior art in ontos-internal#135),
generalized to a profile a second consumer can adopt verbatim — so the second
consumer aligns with the first instead of minting a third reading.

## Profile identity and revision discipline — `ontos-data-json/1`

A consumer that pins its **own identity digests** to this reading (hashing the
`ontos-codec-v1` bytes of a projected value) needs a stable, named handle on the
projection so it cannot be silently re-pointed as this page evolves. This section
gives it one.

**What is and isn't normative here.** The **identity** of every value this
projection emits — its canonical bytes, its canonical form, its equality — is
already normative and **frozen**, fixed by [`ontos-data.md`](ontos-data.md) §5
(each embedding "byte form frozen") and by `ontos-codec-v1` (frozen; a byte-mapping
change ships as `ontos-codec-v2`, never an edit). This section adds **no** value,
embedding, or judgment and does **not** change the page's
*non-normative-for-the-value-model* status. What it names and pins is the
**projection map itself** — which JSON form reads to which already-frozen datum.

**The profile id is `ontos-data-json/1`.** Revision `1` fixes exactly the arms
this page defines today: object→[`map`](#the-projection), array→`list`,
string→`utf8-text`, integer-literal→`int`, `true`/`false`→`bool`, `null`→`null()`
(the reserved `decimal` arm is **not** part of any revision until it graduates —
see below). This is the naming convention for consumer-pinned readings of
`ontos/data`: `ontos-data-json/<rev>`, `<rev>` a monotone natural number.

**The pin is the pair `( ontos-data-json/1 , ontos-codec-v1 )`.** Both axes are
required because `map` and `set` canonical order is **codec-version-relative**
([ontos-data §6](ontos-data.md) / [ontos-codec §6](ontos-codec.md)): the reading
alone does not fix map-key order; the codec epoch does. The two freeze axes are
**independent** and are pinned as two coordinates, never folded into one compound
string — a codec `v2` would not by itself re-revision the reading, and a reading
`/2` does not touch the codec.

**Revision discipline (add-only).** A future graduation — most concretely the
reserved [`decimal` arm](#the-reserved-arm-json-number-with-fractionexponent--decimal)
— mints `ontos-data-json/2` as an **add** that assigns a reading to a form that
`/1` **rejected**. A revision bump **never changes an existing arm's reading**: no
form that `/1` maps to datum *X* is ever re-mapped to datum *Y* by a later
revision. An `ontos-data-json/1` consumer is therefore **drift-proof by
construction** — `/2` can only give a canonical reading to inputs `/1` refused, so
every value `/1` accepts keeps byte-identical identity forever. (Were a form's
reading ever to genuinely need to *change* rather than *extend* — it should not,
given the frozen §5 identities — that is a new profile family, not a revision of
this one.)

## This is NOT the CLI's `--from-json`

The `ontos` CLI's [`--from-json`](ontos-cli.md#value-input) is a spelling of the
**value tree** — the authoring notation `{"atom":"<hex>"}` / `{"tuple":[ … ]}`,
the exact inverse of `--format json` rendering, which serializes an L0 `Value`
node-for-node. It reads *structure*, not *domain data*: `{"atom":"00"}` is "the
atom whose bytes are `0x00`," not "the JSON number 0."

This page reads **domain JSON** — the JSON a system actually exchanges, where `0`
is the integer zero, `"hi"` is text, and `[...]` is a list. The two never overlap:
`--from-json` answers "what L0 node is this," this page answers "what `ontos/data`
datum is this." A consumer projecting domain JSON uses this reading and then builds
the `ontos/data` value directly (canonical by construction); it does **not** route
domain JSON through `--from-json`.

## The projection

The projection is **total over exactly these forms and rejects everything else**,
naming the JSON path of the offending node (e.g. `$.value`, `$[3].key`). It
**never coerces**: an input is read as the datum its *form* denotes, or it is
refused — acceptance never depends on evaluating the input.

| JSON | ontos/data | notes |
|---|---|---|
| object | [`map`](ontos-data.md#57-map--finite-association--byte-form-frozen-added-2026-06-01) | keys read as [`utf8-text`](ontos-data.md#52-utf8-text--unicode-text--byte-form-frozen-v1); see *duplicate keys* below |
| array | [`list`](ontos-data.md#55-list--ordered-sequence--byte-form-frozen-v1) | element order preserved |
| string | [`utf8-text`](ontos-data.md#52-utf8-text--unicode-text--byte-form-frozen-v1) | bytes verbatim, no normalization (ontos-data §5.2) |
| number — **integer literal only** (`^-?[0-9]+$`) | [`int`](ontos-data.md#51-int--exact-integer--byte-form-frozen-v1) | fraction/exponent forms are **rejected**, not coerced — see *hard edges* and *reserved: decimal* |
| `true` / `false` | [`bool`](ontos-data.md#53-bool--boolean--byte-form-frozen-v1) | |
| `null` | [`null()`](ontos-data.md#510-null--the-single-no-value--byte-form-frozen-added-2026-06-13) | the **resolved** arm — `Tuple(Atom("null"))`, ontos-data §5.10 |

**Duplicate object keys.** JSON permits an object with repeated keys; this reading
resolves them **last-wins at the decoder**, before any `ontos/data` value is
built. The `map` encoder (ontos-data §5.7) forbids duplicate keys, but because the
JSON decoder has already collapsed them, **the `map` encoder's duplicate-key
rejection is unreachable from this projection** — a JSON object never presents a
duplicate key to the encoder.

**The opt-in strict mode — `duplicateKeys: reject` (ontos-internal#322).** A consumer
whose own request contract forbids repeated members should not have to run a
second JSON scan whose acceptance must agree with this reader's, so a face MAY
offer, beside its default entry point, a mode that **refuses** a document at the
first repeated member instead of collapsing it (Go `ProjectWith(raw,
Options{DuplicateKeys: DuplicateKeysReject})`, Rust `project_with(raw, Options {
duplicate_keys: DuplicateKeys::Reject })`, TS `project(raw, { duplicateKeys:
"reject" })`). It is a stricter **source-admission policy over the same mapping**,
not a second reading, and it is bound by four rules:

- **Same value, same bytes.** Every document the strict mode accepts projects to
  exactly the `ontos/data` value — and so the `ontos-codec-v1` bytes — the default
  mode emits for it. The mode admits fewer documents; it re-points none.
- **Exact decoded content, no normalization.** Two members repeat iff their
  names are the same *decoded* string: `"a"` and `"\u0061"` are one name, a
  surrogate-pair escape and its literal are one name, while `"é"` (U+00E9) and
  `"e\u0301"` are two names — the same no-normalization rule as
  [`utf8-text`](ontos-data.md#52-utf8-text--unicode-text--byte-form-frozen-v1).
  Names are scoped to their object: the same name in two objects is not a repeat.
- **A typed, path-named refusal in the admission class.** The refusal names the
  repeated member (the *first* repeat in source order, in the `$.key` / `$[i]`
  spelling of every other rejection) and carries the name; it is distinct from
  the resource-limit class (a policy refusal is a judgment about the document,
  never a bound), and distinct from the `/1` domain rejections whose reasons the
  vectors pin. Its **wording is informative, never a cross-language contract** —
  what conformance pins is the refusal, its path and its key.
- **Nothing else moves.** The number-literal, text-fidelity, trailing-data and
  depth-limit outcomes are unchanged under the strict mode; it never repairs,
  drops or reorders a member. The reader refuses a repeat *before* the projection
  walk runs, so a document carrying both a repeat and a `/1` defect is refused for
  the repeat under strict mode and for the defect under the default.

The `duplicateKeys` section of [`vectors/data-json.json`](../../vectors/data-json.json)
pins the mode as equivalences between documents under one face (no digests: each
repeat-bearing document must project, by default, to the bytes of its hand-written
collapsed equivalent, which the strict mode then accepts identically), and each
face's suite replays every locked `valid`/`reject` case through the strict mode to
show it changes no other outcome.

## Hard edges, stated as contract

- **Reads literals, never evaluates.** A JSON number is read as `int` **iff its
  literal form matches `^-?[0-9]+$`**. `1.0` and `1e3` are **rejected** even though
  they denote whole numbers — accepting them would make acceptance depend on
  *numeric evaluation* rather than on *form*, which is exactly the coercion this
  reading refuses. (The reserved `decimal` arm below is where fraction/exponent
  forms would land once a consumer names the need; until then they are refused, not
  silently promoted to `int`.)
- **A string with no `utf8-text` reading rejects — the projection never emits a
  repaired stand-in.** ontos-data §4.1 law 2 forbids a producer to **succeed with
  a different admissible datum**, and for an identity-digest projection that
  outcome class is the worst one available: the substitution is admissible, so it
  is invisible to every reader, and the reported digest is not the digest of the
  input (ontos-internal#216). Concretely: a JSON escape can name an unpaired surrogate
  (`"\uD800"`), and a byte transport can carry invalid UTF-8 inside a string
  literal; neither denotes any
  [`utf8-text`](ontos-data.md#52-utf8-text--unicode-text--byte-form-frozen-v1)
  value, so both reject path-named — decoders that quietly substitute `U+FFFD`
  (or any other repair) do not satisfy this reading. The rule is the outcome
  class, not those two mechanisms: however a face's decoder mangles a
  non-denoting string, success-with-something-else is never conformant.
  `vectors/data-json.json` pins the unpaired-surrogate case. An *authentic*
  `U+FFFD` present in the input is an ordinary character and accepts.
- **Repeated members collapse last-wins by default, and MAY be refused on
  request.** The default reading keeps the last occurrence; the opt-in
  `duplicateKeys: reject` mode (above) refuses the document instead, at the first
  repeat, on exact decoded names, without changing any accepted document's bytes.
- **Trailing data rejects.** The input is exactly one JSON document. Any
  non-whitespace after the top-level value is a rejection — there is no "parse the
  first value and ignore the rest."
- **Errors carry the JSON path.** A rejection names the path to the offending node
  (`$`, `$.value`, `$[3].key`), so a producer can locate the form that has no
  canonical reading rather than getting a whole-document "invalid" verdict.
- **No JSON form maps to `set`.** JSON has no set literal, so this reading produces
  no [`set`](ontos-data.md#58-set--finite-set--byte-form-frozen-added-2026-06-01)
  (a JSON array is always a `list`, order-preserving and duplicate-permitting).
  Sets arrive only through natively-authored values/descriptors, never through this
  projection.
- **Acceptance is decided on the source, so a face reads the source.** Two of the
  edges above turn on distinctions that exist only in the JSON source text — the
  number literal's *form*, and a string's exact content together with the
  path-named, index-carrying rejection it must produce when no `utf8-text` reading
  exists. A conformant face therefore reads the raw source itself, **or must
  demonstrate that its decoder preserves both distinctions AND can carry this
  profile's error surface** (the JSONPath and the pinned reason, including the
  UTF-16 index of the first unpaired surrogate). The rule is the property, not a
  mechanism: a decoder that genuinely satisfies both is conformant however it is
  packaged — but no stock decoder surveyed does (see *Implementing a face*), so
  reaching for the language's default JSON library is, empirically, the start of
  a nonconformant face (ontos-internal#224).

## Implementing a face: why every face so far ships its own reader

The requirement above is empirical, not predicted — it was established by writing
faces (ontos-internal#215, ontos-internal#216/#222, and the decoder survey on ontos-internal#218). Stock decoders fail the
profile in **four different ways across four languages**, none of which is "the
library is bad"; each library is behaving reasonably for its own contract, which
is simply not this profile's contract:

| decoder | what it destroys |
| --- | --- |
| Go `encoding/json` | **string fidelity** — substitutes `U+FFFD` for invalid UTF-8 and unpaired surrogate escapes, then *succeeds* (ontos-internal#216) |
| JS `JSON.parse` | **number form** — evaluates the literal to a `number`; `1e3`, `1000.0` and `1000` become one value |
| Rust `serde_json` | **the error surface** — rejects a lone surrogate at decode, but with no JSONPath, no index, no pinnable reason |
| Python `json` | **the error surface** — preserves lone surrogates (so the defect survives to the primitive), but the strict-encode failure downstream names no path either |

All three existing faces ([`data/json/go`](../../data/json/go/),
[`data/json/ts`](../../data/json/ts/), [`data/json/rs`](../../data/json/rs/))
accordingly carry a small recursive-descent reader accepting exactly RFC 8259 —
TS and Rust from their first commit, Go after ontos-internal#216 demonstrated what inheriting
the stock decoder's repairs costs an identity-digest projection. A new face
should budget for the same, and
[`vectors/data-json.json`](../../vectors/data-json.json) pins the behaviours the
reader exists to preserve: the reject cases carry raw `docSource` precisely
because a parsed value can no longer express what is being tested.

## Resource limits are implementation bounds, never semantics

Hand-rolled readers reintroduced a hazard the stock decoders they replaced had
already solved: none bounded **nesting depth**, so a hostile `[[[[…` document
was a stack overflow — escaping the face's own error surface entirely (a bare
`RangeError` in JS, a process abort in Rust; measured, ontos-internal#236). The posture,
on the precedent `ontos-codec` already sets (`decode_with_limits`,
`limit_exceeded` as an implementation bound, never a domain error):

- **A conformant face MUST accept nesting to depth 512** (the floor).
  `vectors/data-json.json` pins the floor's accept side (`depth-floor-512`).
- **Above its ceiling, a face rejects with a LIMIT class distinct from domain
  rejection.** A depth limit says nothing about the document's admissibility
  under `/1` — another conformant face with a higher ceiling may accept it — so
  folding the limit into the domain-rejection surface would move an
  implementation bound into the profile's semantics, which is exactly wrong.
  Each face reports the limit through its own error surface, clearly typed as
  a limit (`datajson.LimitError` in Go, `LimitError` in TS,
  `ProjectionError::DepthLimit` in Rust).
- **Ceilings are per-face, stated, and never pinned by vectors.** Stacks
  differ, so the faces cannot honestly promise one number: the Go face states
  10000 (restoring the bound its stock decoder had), the TS face 1024 and the
  Rust face 512 — each measured against its real stack cliff, not guessed.
  Pinning a shared ceiling would either force the lowest bound on everyone or
  turn a resource property into a byte-contract lie.
- **The limit fires as a bound, never as a repair.** No truncation, no partial
  value, no coercion — the same never-succeed-with-something-else discipline as
  §4.1, applied to resource exhaustion.

## The reserved arm: JSON number with fraction/exponent → `decimal`

A JSON number carrying a fraction or exponent (`1.5`, `1e3`, `1E3`, `1.0`) is
**deliberately not mapped yet** — it is **rejected**, not coerced. This mirrors
`ontos/data`'s demand-gated discipline ([ontos-data §9](ontos-data.md#9-future-embeddings--a-demand-driven-candidate-register-no-embeddings-added-here)):
a reading is not built ahead of a concrete consumer need, and acceptance never
depends on evaluating the literal.

The one question a future consumer must answer **here, once** (not per consumer) to
graduate this arm is: **which JSON literal forms are canonical for a decimal
reading.** Concretely —

- Is `1.50` normalized to the same value as `1.5` (it is the same `decimal` — the
  canonical form pins the mantissa not divisible by 10, ontos-data §5.9 — so the
  reading must decide whether the *literal* `1.50` is accepted and normalized, or
  refused as non-canonical input)?
- Are `1e3`, `1E3`, and `1.0` accepted as decimal literals, and to what canonical
  `decimal` do they read (e.g. does `1e3` read as `decimal(1, 3)` or `decimal(1000,
  0)` — the canonical form forces one answer, but the *literal acceptance set* is
  the open choice)?

Until a named consumer needs JSON-number → `decimal`, fraction/exponent literals
**reject** (path-named, like every other refused form). When one does, the answer
is recorded here and the arm becomes total over its chosen literal set — the same
demand-gated graduation `decimal` itself underwent (ontos-data §9, "Graduated so
far").

## The null arm is resolved (no longer reserved)

When ontos-internal#135 was filed, JSON `null` had **no** family reading: the first
consumer bridged it with an interim app-namespace compound
`Tuple(Atom("visual-atlas/null"))`, pending the ontos-internal#134 decision. **That
decision shipped.** ontos-internal#134 chose to admit a single canonical no-value, and the
[`null` embedding](ontos-data.md#510-null--the-single-no-value--byte-form-frozen-added-2026-06-13)
landed as `ontos/data` §5.10: `null()` = `Tuple(Atom("null"))`, the one nullary
no-value, frozen 2026-06-13.

So in this reading the `null` arm is now **total and canonical**: **JSON `null` →
`null()`**. The interim `visual-atlas/null` is **retired** — a consumer migrating
from the old reading replaces that one constant with `null()`, and no consumer
needs to mint its own `appN/null` again. `null()` is precisely "present-but-no-value,
NOT absence" (ontos-data §5.10, guardrail 2): a JSON `null` is a *present* value
saying "no value here," which is what `null()` means; an *absent* JSON object key
is structural absence and produces no `map` entry at all.

## Inter-object references — one atom, never a structure

A consumer that projects a document graph into this reading needs to point from one
object at another. Six frozen era-2 families in
[`vectors/data-json.json`](../../vectors/data-json.json) already do, all the same way,
and until now the convention existed only as precedent (ontos-internal#192).

**The invariant, and the load-bearing part:**

> An inter-object reference rides as a **JSON string**, and therefore — by the table in
> *[The projection](#the-projection)* — as **exactly one `utf8-text` atom**. Never a
> nested tuple, never a structured object.

That holds for **every** reference-shaped value in the frozen corpus, without exception.
It is what makes a reference a leaf rather than a subtree, so a document's shape does not
change depending on whether a field happens to point somewhere.

**Inside the atom, two forms — and the discriminator is the REFERENT, not the field name:**

| form | when | frozen precedents |
|---|---|---|
| `<kind>:<alg>:<hex>` | the referent is an **object of a named kind** | `bind1:` (`bindingDigest`), `pdecl1:` (`declarationDigest`), `decl1:` (`forDeclaration`), `art:` (`imageArtifactId`), `tree:` (`sourceRoot`, `cases`) |
| `<alg>:<hex>` | the reference addresses **content bytes** — the algorithm is the whole type | `sha256:…` (`entries[].digest` ×7, `image.rootDigest`) |

**The field name does not decide it.** `bindingDigest` carries `bind1:` while `rootDigest`
is bare, and both end in `Digest`. What separates them is what is on the other end: a
binding, declaration, artifact or tree is an object *of a kind*, and the kind is part of
what you are naming; a content digest names bytes, where `sha256` already says everything
there is to say about the type.

**Domain separation therefore happens twice, at different granularities**, and both are
now written down rather than one:

1. **Inside** the atom — the `<kind>:` prefix typing the referent (this section).
2. **Outside** the value — the era-2 tag wrap `Tuple(Atom(tag), value)`.

### When the referent's id is itself domain-separated

> **If the referent's identifier is computed under a domain-separation string, `<kind>`
> SHOULD be that string verbatim.** A reference is then not merely *typed* but
> **reproducible**: a reader holding the referent can recompute the id from what the
> reference says.

Motivating case (thesmos, ruled 2026-08-21): a `stele` FactID is
`SHA-256("stele.fact-id.v1" ‖ signing_bytes)`. Spelled bare, `sha256:<hex>` is **actively
misleading** rather than merely under-specified — it invites a verification that fails,
because SHA-256 over the signing bytes alone yields a different value and nothing in the
reference says why. The correct spelling is the three-segment form with the domain string
in the kind slot:

```text
stele.fact-id.v1:sha256:<hex>
```

**The alg segment is not optional here**, and the reason is grammatical rather than
stylistic: all six kind-prefixed references in the frozen corpus spell it
(`art:sha256:…`, `bind1:sha256:…`, `decl1:sha256:…`, `pdecl1:sha256:…`, `tree:sha256:…` ×2).
Drop it and `stele.fact-id.v1:<hex>` is a **two-segment** string — and two segments is
already the bare `<alg>:<hex>` form, so a reader cannot tell a kind with an implied alg
from an alg with no kind. Segment count is what disambiguates the two forms; an implied
alg destroys it.

⚠ **This kind carries dots, and every frozen kind is `[a-z]+[0-9]*`.** That is a habit of
the founding corpus, not a rule — no charset for `<kind>` is pinned anywhere in this
document, and the separator is `:`, which neither dots nor hyphens are. The habit is not a
reason to refuse a better-motivated spelling.

⇒ **The existing five kinds do NOT have this property and are not being migrated.**
`bind1:` names what is on the other end without saying how its digest was separated, so it
is typed but not reproducible. A short kind stays valid where the id is not
domain-separated, or where the domain string is not a stable public fact. Where it *is*,
prefer the verbatim string — the reference that can be checked beats the one that merely
looks native.

**This section pins a CONVENTION, not a byte form.** `ontos/data` neither recognizes these
prefixes nor validates them: to `utf8-text` a reference is an ordinary string, and to L0 an
ordinary atom (§1 — recognition is partial and opt-in). Nothing here adds a rule to the
value model, and no `ontos/data` recognizer changes. What it fixes is that a seventh family
had no way to learn the shape the first six chose, and could reasonably have carried a
reference as a nested tuple — producing a **split convention inside a single frozen
artifact**, discovered at pin time when it is expensive rather than at authoring time when
it is free.

## Prior art and conformance seeds

This page generalizes visual-atlas's shipped reference implementation,
`backend/internal/assertion/projection.go` (the total, exact, reject-never-coerce
projection filed as prior art in ontos-internal#135), and updates its one open arm (`null`)
to the resolved `null()` reading. visual-atlas's table-driven round-trip and
rejection suites (`projection_test.go`) are offered as **conformance seed
material** should this projection ever gain its own vector cases in
[`vectors/`](../../vectors/).

This page is deliberately **austere**: it *claims the problem space* and records
the canonical reading so independent consumers converge — it does **not** (yet) add
vectors, embeddings, or judgments. A reading gains its own
[`vectors/data.json`](../../vectors/data.json) cases only when a consumer need
names it, exactly as embeddings graduate from the candidate register (ontos-data
§9).

## See also

- [`ontos-data.md`](ontos-data.md) — the registered embeddings; **authoritative**
  for every value this reading produces (§5), the demand-gated candidate register
  (§9), and the `null` embedding (§5.10).
- [`ontos-cli.md`](ontos-cli.md) — the `ontos` CLI, whose `--from-json` spells the
  value *tree*, a different thing from this domain-JSON reading.
