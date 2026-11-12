# Consultation 0001: a reversible JSON projection of ground values

**Status: answered, 12 November 2026.** Requested 10 November 2026 by the ontos coordinator
(m-01), for the owner's expert-consultation flow, which runs from the owner's PC. Whoever runs
it records the answer in this file. The decision stays with the ontos coordinator.

This brings in [ontos issue 33](https://github.com/Bitspark/ontos/issues/33). That issue
carries row 21 of bittype research 0014
([bittype issue 194](https://github.com/Bitspark/bittype/issues/194)): the request for a
lossless, reversible JSON profile of ground values. Row 20 of the same research adopts
`toJSON = P ∘ E` and `fromJSON = D ∘ P⁻¹` for presenting service values in a command line
and in web forms. Here `P` is that named JSON projection of abstract ground values.

## Decided before the consultation

1. **ontos owns the projection.** A JSON spelling of ontos values is representation, the
   same family as `ontos-data-json/1` and the vectors' authoring notation. It states nothing
   about meaning. If each consumer spelled it, the spellings would drift, which is the seam
   ontos exists to remove. bittype's charter excludes serialization (research 0014).
2. **A total, lossless form already exists.** The authoring notation,
   `{"atom":"<lowercase hex>"}` | `{"tuple":[…]}` (`vectors/README.md`,
   [ontos-cli](../spec/ontos-cli.md) *Value rendering* and *Value input*), is reversible
   over every ground value. Every ground value is an L0 value. Today it is specified only as
   a vector notation and a command-line contract. Whatever the answer, one rule stays:
   **JSON is presentation, and the canonical bytes are the value.** Nobody signs, hashes or
   exchanges the JSON (ontos-cli, *Value input*).
3. **Row 28 is declined for ontos/wire.** ontos/wire will not provide a reusable check of a
   mixed value against a descriptor-like contract, meaning required fields, labels and arity
   around capability leaves.
   - That check is a schema/type judgment. ontos refuses schema, types and validation
     ([ontos-core §7](../spec/ontos-core.md), CONTRIBUTING).
   - ontos/wire's admission checks a mixed value's own well-formedness and leaf
     recognition, not its conformance to a declared type.
   - Type meaning belongs to `horos/wire`
     ([design record 0007](../design/0007-optional-wire-extension.md), §1 and its ownership
     table). The check belongs there, or in the binding backend under a horos
     specification.

## The question

Which reversible JSON projection or projections of ground values should ontos specify for
presentation by generated bindings, and in what shape?

1. **One profile or two.** One option promotes only the total form above to a named profile
   with library functions. The other adds a *readable* profile:
   - recognized `ontos/data` embeddings render naturally: text as a JSON string, `bool`,
     `null`, `list` as an array, and `int`, `decimal`, `map` and `set` in some agreed form;
   - every other value falls back to the total form behind a reserved escape.
2. **The readable profile's hard edges, if there is one.**
   - The escape scheme: a domain object that happens to look like a reserved shape must
     still round-trip.
   - Integer exactness: always a string, or a JSON number inside ±(2^53 − 1)?
   - Map keys that are not text, and the rendering of sets.
   - Compounds and labels (`ontos/compound`).
   - Byte atoms as hex or base64.
3. **The law and its domain.** `P⁻¹(P(v)) = v` must hold for every ground `v`. Must
   `P(P⁻¹(j)) = j` also hold on the image, and under which normalization of key order,
   whitespace and number spelling? Which inputs does `P⁻¹` refuse, with which stable codes?
4. **Placement and faces.** The candidates are `core`, `data` and `data/json`. CONTRIBUTING
   holds `core`, `codec`, `data` and `cli` to four languages. `data/json` has Go, Rust and
   TypeScript faces. The Rust faces are std-only (no serde), and each existing JSON face
   carries its own reader.
5. **Its relation to `ontos-data-json/1`**, the one-way projection of domain JSON. Should the
   readable profile be its reversible sibling? How do the two avoid reading the same JSON
   differently? For example, `ontos-data-json/1` reads the JSON number `1` as an `int`.

## The options as seen

- **A.** Promote only the total form: a named profile, a short normative page, and
  library parse and render functions in each face. This is cheap, but its JSON is unreadable
  in a web form.
- **B.** A, plus a readable profile specified now under a versioned name (`…/1`), total over
  ground values through the escape.
- **C.** A, and leave readable presentation to the binding backend, built on A.

The coordinator leans towards **B**. Presentation spellings multiply as fast as value
spellings would, and the hard edges above are exactly the ones ontos has already ruled on
once, in `ontos-data-json/1`.

## What depends on the answer

- bittype research 0014's presentation path (rows 20 and 21), and with it the command lines and web
  forms of horos-declared services.
- Nothing in ontos is blocked. [Issue 35](https://github.com/Bitspark/ontos/issues/35)
  (`measure`) proceeds independently.

## Answer

The question went to an outside expert as research 0004 of ontos's internal research record,
`ontos-internal research-docs/0004-reversible-json-projection.md`, which holds the
self-contained document, the verified advice, and the evaluation of each recommendation
against ontos at `87a03b6`. The run was submitted on 11 November and answered the same night.

**The advice: B.** Specify two value-only profiles. Neither takes a type descriptor.
- **`ontos-total-json/1`** is today's `{atom}/{tuple}` notation, promoted to a full parser
  and rendering contract.
- **`ontos-readable-json/1`** is total over ground values:
  - The plain cases are ordinary JSON: `null`, booleans, strings, integers within
    ±(2^53 − 1), arrays, and objects whose keys are all text.
  - Everything else uses one reserved envelope, `{"$ontos": [tag, …]}`, with the tags
    `bytes` (canonical base64), `int` (a canonical decimal string), `decimal`, `map`, `set`,
    `compound` and `raw` (a fallback to the total form).
  - `$ontos` is the only reserved name, compared after escape decoding. A map whose key is
    that text uses the `map` tag, so every value stays representable.

In the expert's view, type-driven reading (C) does not remove ambiguity across unions
(`bytes | utf8-text`, a list against a set, compounds with their labels left out). Avro's JSON
encoding, for one, still tags union branches.

The rest of the advice:
- **Laws:** `R(W(v)) = v` for every value, and `W(R(j)) = j` on the writer's image. Every other
  accepted spelling normalizes through `W∘R` under a named table: escapes, member order, `-0`,
  tagged small integers, and the `raw` or `compound` spelling of a value that has a plainer
  one. Duplicates (after escape decoding), trailing data, a BOM, fractions and exponents are
  refused.
- **Refusals:** stable lowercase codes with a typed path and a UTF-8 byte span; the message
  is not normative. The reader can also return origins, so that horos's and D's errors map
  back to the source.
- **Limits:** limits are stated apart from the semantics, and JSON depth is counted apart
  from value depth.
- **Placement:** a separate `projection/json/{total,readable}` module in all four languages.
  The normative input is UTF-8 text read by ontos's own strict reader.
- **Relation to `ontos-data-json/1`:** a separate surface with a documented common subset.
  The profile is selected explicitly, never detected from the input's shape.

**The decision** (the ontos coordinator, 12 November): **B.** All 23 recommendations are
accepted. Four are accepted with adaptations:
- the command-line page's "never sign, hash, or exchange the JSON text" becomes: a profile
  may travel, but identity, hashing and signing use the codec bytes of the recovered value;
- `data/rs` gains an unbounded, byte-level decimal path;
- the profiles reuse and extend the codec's limit-kind and measure vocabulary;
- four faces is this module's policy, recorded in its design record, and the shared strict
  lexer lives in the total module.

The record of the decision is `docs/design/0010`. The command lines' stricter acceptance
lands with the defect fixes now in progress and is listed in their release notes.
