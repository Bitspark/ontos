# JSON projections of ground values: a total profile and a readable profile

**Status: decided, 12 November 2026, by the ontos coordinator, answering
[ontos issue 33](https://github.com/Bitspark/ontos/issues/33) after
[consultation 0001](../consults/0001-reversible-json-projection.md).** The research
document, the expert's advice and the research owner's evaluation are in the private
ontos-internal repository at `research-docs/0004-reversible-json-projection.*`. This record
states what ontos does with the advice. The two profile pages, their vectors and the
implementations follow as separate changes (§5).

## 1. The decision

ontos specifies **two value-only JSON projections** of ground values:

- **`ontos-total-json/1`** promotes the existing authoring notation,
  `{"atom":"<lowercase hex>"} | {"tuple":[…]}`, to a named profile. It is total over L0 and
  says nothing about embeddings.
- **`ontos-readable-json/1`** spells the common ground values as ordinary JSON: `null`,
  booleans, strings, safe integers, arrays and text-keyed objects. Every other value goes
  through one reserved envelope, `{"$ontos": [tag, …]}`, with the tags `bytes`, `int`,
  `decimal`, `map`, `set`, `compound` and `raw`. `raw` wraps the total form, so the readable
  profile is total over L0 too.

Neither profile takes a type descriptor: each is defined from the value alone. This is option
B of the request. The advice also showed why C's case doesn't hold: a known type does not
remove ambiguity across unions, such as `bytes | utf8-text` or `list-of | set-of`.

The rule that the canonical bytes are the value stands. A JSON profile is a presentation:
it may travel, but the value is recovered from it before any identity operation (§3, row 2).

## 2. The advice, row by row

The research owner checked each recommendation against ontos at `87a03b6`. All 23 are
accepted. Rows 2, 7, 16 and 18 are accepted with the adaptation stated. Rows 12 and 14 were
adapted on 12 November 2026, at the review of the profile pages (§5, step 1).

| row | recommendation | ruling |
|---|---|---|
| 1 | Two value-only profiles (B) | Accepted. |
| 2 | Clarify "exchange" | Adapted, §3. |
| 3 | Type-directed conveniences live in the bindings | Accepted; owned by the bittype backends. |
| 4 | The readable grammar, with the tags `bytes`, `int`, `decimal`, `map`, `set`, `compound` and `raw`; exact arities; unknown tags refused | Accepted. The spec page states it in ABNF. |
| 5 | Reserve `$ontos` alone, compared after escape decoding; an object containing it is exactly the envelope and never falls back to a map; a map with the text key `$ontos` uses the map tag | Accepted. `$bytes`, `$undefined` and other `$` keys stay ordinary data. |
| 6 | Integers: bare literals within ±(2⁵³ − 1), the `int` tag with a canonical decimal string beyond; an untagged literal outside the range is refused; `-0` reads as `int(0)` under a named normalization | Accepted, including the deliberate divergence from `ontos-data-json/1`, which reads integer literals of any size. Scripts read command output with ordinary decoders, and a large bare literal is silently rounded there. |
| 7 | Decimals as `["decimal", m, e]` with canonical integer strings; never expanded | Adapted: `data/rs` gains a byte-level decimal path with unbounded components, like `encode_int_bytes`/`read_int_bytes`. It is additive. |
| 8 | Bytes as canonical padded standard base64 in the readable profile, hex in the total form | Accepted. |
| 9 | Maps and sets: an object when every key is canonical text and none is `$ontos`, else the map tag; any input order; output in codec order; duplicates refused by ground-value equality | Accepted. Codec order puts `"b"` before `"aa"`, which surprises a reader, but it is the only total order ontos defines over arbitrary keys. A second order would need its own definition. |
| 10 | Compounds: a generic `compound` arm, a fixed recognition order, the recognition table frozen per `/1` | Accepted. |
| 11 | The laws: `R(W(v)) = v`; `W(R(j)) = j` on the writer's image; normalization `N = W∘R` idempotent | Accepted. |
| 12 | Deterministic emission: UTF-8 without BOM, no insignificant whitespace, fixed escaping, codec order | Adapted: strings are escaped as ECMAScript's `JSON.stringify` and RFC 8785 escape them (`\b`, `\t`, `\n`, `\f`, `\r`, lowercase `\u00xx` for the other controls, everything else literal), not with `\u00xx` for every control as the advice proposed, because bindings emit through `JSON.stringify`. Ruled at the review of step 1. |
| 13 | A named normalization table: JSON whitespace accepted; other whitespace, BOM, comments, trailing data and duplicate members (after escape decoding) refused | Accepted, for the total form too. The CLI fix in progress already applies it to `--from-json` (§4). |
| 14 | Refusals as stable lowercase codes with a typed path and a UTF-8 byte span; the message is not normative | Adapted: a duplicate refusal names the second occurrence, by its path and span; the first may appear in the message, which is not normative. Ruled at the review of step 1. |
| 15 | An optional reader result that maps value paths back to source spans | Accepted. It lands with the readable profile. |
| 16 | Separate semantic totality from capacity | Adapted: the projection reuses and extends the codec's limit-kind and measure vocabulary (`ontos-codec.md` §4.2, §10) and defines JSON depth and value depth separately. |
| 17 | A separate projection module; nothing in `core/`; `data/` doesn't depend on it | Accepted; layout in §4. |
| 18 | Four faces for both profiles | Adapted: four faces is ontos policy for this module, recorded here. CONTRIBUTING's four-language rule covers `core/`, `codec/`, `data/` and `cli/`, and doesn't reach `projection/`. |
| 19 | Source text is the normative input: `parseUtf8`, `renderUtf8`, `parseUtf8WithOrigins`; a host-string overload that checks surrogates | Accepted. |
| 20 | The binding's outer boundary never parses a whole request lossily | Accepted; owned by bittype and `@bitspark/service-cli`. |
| 21 | A separate surface from `ontos-data-json/1`, with a documented common subset; never detected from shape; an explicit profile selector on the CLI | Accepted. `ontos-data-json/1`'s readings don't change. |
| 22 | Release gate: structural equality for keys and sets, `__proto__` kept as data, vectors that pin input text, codec bytes, preferred output and refusal fields independently | Accepted. horos's missing number type goes to horos. |
| 23 | bittype row 21's disposition | Accepted: ontos owns both projections, and bindings use the readable profile for exported ground-value payloads. |

## 3. What changes in existing text

`docs/spec/ontos-cli.md` says "never sign, hash, or exchange the JSON text" and "not a value
to store, sign, or exchange". Both become:

> A JSON profile is a presentation: it may travel, but the value is recovered from it before
> any identity operation. Identity, hashing and signing use the codec bytes of the recovered
> value, and ontos's APIs for them take bytes or values, never JSON text. The form of record
> is the codec bytes.

The original wording could not hold under any option: versioned command output and exported
requests already carry presentation between programs.

## 4. Placement and packaging

- **Layout.** `projection/json/{go,rs,ts,py}`, one package per language holding both
  profiles: `total` and `readable` modules, with a module-internal strict lexer that both use.
  `readable` depends on `total`, since its `raw` arm embeds the total form. The dependencies
  are the standard library plus sibling ontos packages: total needs core; readable needs
  core, `data` recognition and codec order. Nothing goes in `core/`, and neither `data/` nor
  `data/json/` depends on the projection.
- **Names.** Go: packages `…/projection/json/go/total` and `…/projection/json/go/readable` in
  the root module `github.com/bitspark/ontos`. They have no external dependency, so they need
  no nested module and no extra tag line. Rust: one crate, `bitspark-ontos-json` (library
  `ontos_json`). TypeScript: one package, `@bitspark/ontos-json`, with the entry points
  `./total` and `./readable`. Python: `projection/json/py/ontos_json`, source-only like the
  other Python faces.
- **One package rather than one per profile** keeps the new registry names to two. Each new
  name needs a one-time trusted-publisher setup on its registry before the release workflow
  can publish it, since the repository holds no publishing token. That setup is the owner's
  step at the first release that carries the projection.
- **The CLIs** move their `--from-json` reading onto the total profile's library reader, and
  gain an explicit profile selector for JSON input and output. The total form stays the
  default, so existing invocations keep working. The interim reader that the CLIs get now
  (§5, step 0) already follows row 13.

## 5. Delivery

0. **Now, in progress:** the four CLIs read `--from-json` the same way: strict RFC 8259 text,
   only JSON whitespace, nothing after the value, duplicate members refused, and nesting capped
   at 1024 value levels. Hex input gets the same whitespace rule.
1. **Spec and vectors:** `docs/spec/ontos-total-json.md` and `docs/spec/ontos-readable-json.md`
   with ABNF, the normalization table, the refusal taxonomy and the limits, plus the wording
   change of §3. Vectors pin the input text, the codec bytes, the preferred output and the
   refusal fields independently.
2. **`data/rs` byte-level decimals** (row 7). Independent of step 1.
3. **`ontos-total-json/1`** in all four faces, with the CLIs moved onto it and the selector.
4. **`ontos-readable-json/1`** in all four faces, including the origins API (row 15).
5. **Release.** Cross-face conformance is claimed only when both profiles pass their vectors
   in all four faces.

## 6. What this does not decide

- Anything in `ontos-data-json/1`. Its readings are unchanged, and it gains no Python face.
- Type-directed entry conveniences, which stay in the bindings.
- A number type for horos.
