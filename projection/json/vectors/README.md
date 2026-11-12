# JSON projection vectors

Conformance vectors for the two JSON profiles of ground values:

| file | profile | spec |
|---|---|---|
| [`total.json`](total.json) | `ontos-total-json/1` | [docs/spec/ontos-total-json.md](../../../docs/spec/ontos-total-json.md) |
| [`readable.json`](readable.json) | `ontos-readable-json/1` | [docs/spec/ontos-readable-json.md](../../../docs/spec/ontos-readable-json.md) |

Both pin the codec `ontos-codec-v1`, whose order sorts maps and sets. A face of
`projection/json/` conforms to a profile when it agrees with every case of that file
(design record [0010](../../../docs/design/0010-json-projections.md) §5).

## What a case pins

Each case pins its fields independently of each other, so that a reader and a writer that
agree with each other while both being wrong still fail. Round-trip tests alone would not
catch that.

| field | meaning |
|---|---|
| `name` | unique within the file |
| `group` | what the case is about (see *Coverage* below) |
| `note` | optional; why the case is there |
| `input` | the input text, for reading, when it is well-formed UTF-8. Informative: `input_hex` is normative |
| `input_hex` | the **exact bytes** of the input, as lowercase hex, so that ill-formed UTF-8 can be expressed. A case with ill-formed input has no `input` |
| `limits` | bounds that differ from the profile's shipped defaults, by their names in spec §9: `max_text_bytes`, `max_json_depth`, `max_value_depth`, `max_atom_bytes`, `max_tuple_arity`, `max_integer_digits` |
| `value` | the value, in the datum notation below. Informative: `value_hex` is normative |
| `value_hex` | the `ontos-codec-v1` bytes of the value, as hex |
| `output` | the preferred output text: what the writer emits for the value |
| `refusal` | the reader's refusal: `code`, `path` (a JSON array of member names and indexes), `span` (`[start, end)` in input bytes) and, for `limit_exceeded`, `kind` |
| `render_refusal` | the writer's refusal: `code` and `kind`. The writer's path is informative (spec §9.3), so it is not pinned |
| `origins` | readable only: for every node of the value in pre-order, `[value path, JSON path, span]` (readable §10.2) |

## How a face replays a case

With the case's limits (the defaults, overridden by `limits`):

1. **Reading a refused input.** If the case has `refusal`, reading `input_hex` MUST refuse
   with exactly that code, path, span and kind.
2. **Reading an accepted input.** If the case has `input_hex` and `value_hex`, reading
   `input_hex` MUST give a value whose codec encoding is exactly `value_hex`. If the case has
   `origins`, the origins reader MUST give exactly those origins.
3. **Writing.** If the case has `output`, writing the value that `value_hex` decodes to MUST
   give exactly the UTF-8 bytes of `output`. If it has `render_refusal`, writing MUST refuse
   with that code and kind.
4. **The laws.** For every case with `output`, reading `output` MUST give `value_hex`
   again, and writing that value MUST give `output` again.

A case with `output` but no input exists only for writing. Every case with an accepted input
also has an output.

## Runs

A deep or long case would be tens of kilobytes. So `input`, `input_hex`, `value_hex`, `output`
and a refusal's `path` may instead be written as runs: `{"runs": [[piece, count], …]}`,
which stands for each piece repeated `count` times, concatenated in order. A piece is a string
for the text and hex fields, and an array of path segments for `path`. For example, the path
`{"runs": [[["tuple", 0], 1025]]}` is `["tuple", 0, "tuple", 0, …]`, 2050 segments long.

## The datum notation

`value` writes a value as a JSON array whose first element names a constructor:

| datum | value |
|---|---|
| `["atom", "<hex>"]` | `Atom` with those bytes |
| `["utf8", "<string>"]` | `Atom` with the UTF-8 bytes of the string (a label, typically) |
| `["tuple", [d, …]]` | `Tuple` of the children |
| `["compound", "<label>", [d, …]]` | `Tuple(Atom(<label as UTF-8>), children…)` |
| `["int", "<decimal>"]` | `int` (ontos-data §5.1); the decimal is canonical |
| `["text", "<string>"]` | `utf8-text` |
| `["bool", true\|false]` | `bool` |
| `["null"]` | `null()` |
| `["list", [d, …]]` | `list` |
| `["map", [[k, v], …]]` | `map`; the entries may be in any order and are sorted by the codec |
| `["set", [d, …]]` | `set`; likewise sorted |
| `["decimal", "<m>", "<e>"]` | `decimal(int m, int e)`; the pair must be canonical |
| `["deep", n, wrapper, d]` | `d` wrapped `n` times, where `wrapper` is `"tuple"` (a one-child tuple), `"list"` (a one-element list) or `["compound", "<label>"]` (a one-argument compound). Only at the top of `value` |

A case whose value is easier to give as bytes has `value_hex` and no `value`.

## Provenance

The cases are **hand-authored from the two spec pages** (Class A in the sense of
[`docs/conformance-vector-provenance.md`](../../../docs/conformance-vector-provenance.md)).
The judgments are written by hand: which inputs are accepted, the value each denotes, the
preferred output, and each refusal's code, path, span and kind. So are the origins. Two
fields are derived mechanically, by
[`tools/json-projection/gen.mjs`](../../../tools/json-projection/gen.mjs):

- `input_hex`, as the UTF-8 bytes of `input`;
- `value_hex`, from `value` with the frozen encoders of `@bitspark/ontos-data` and
  `@bitspark/ontos-codec`. [`vectors/data.json`](../../../vectors/data.json) pins those to all
  four faces, and they share no code with the projection.

[`tools/json-projection/check.mjs`](../../../tools/json-projection/check.mjs) then checks every
case. It has its own strict reader, its own interpreters and writers for both profiles, its own
codec and its own `ontos/data` encoders, written from the spec pages, and it imports nothing. It
also rebuilds each `value` with its own encoders, which cross-checks `value_hex` against the
frozen packages. `scripts/check.sh vectors` runs the generator, fails if the files change, and
runs the checker. A face that disagrees with a case has found a defect in the face, the case or
the checker. The spec page decides which, and the fix goes to the case and the checker together.

## Coverage

The cases cover the closing suite of the expert's advice (research 0004 in the internal
record), the cases the command lines need, and both profiles' refusal codes and limits:

| group | covers |
|---|---|
| `values`, `normalization` (total) | atoms, tuples, empties, a two-byte uvarint length, an int-shaped tuple spelled node for node, whitespace and escape normalizations |
| `cli` (total) | the command line's cases: a trailing `]` or `}`, trailing values and comments, non-JSON whitespace (form feed, U+00A0, U+2028, vertical tab), a byte order mark, repeated members after escape decoding, and depth at and past the default cap (value depth 1024, JSON depth 2050) |
| `lexical`, `utf8` | the strict JSON reading shared by both profiles: truncation, control characters, escapes, lone surrogates, comments, trailing commas, number and literal syntax, and ill-formed UTF-8 with its maximal-subpart spans |
| `shape`, `hex` (total) | `invalid_total_form` and `invalid_hex` at each position |
| `plain`, `objects` (readable) | plain JSON, string escaping, no Unicode normalization, a leading U+FEFF as content, codec order of members (including keys of 129 and 256 bytes), `__proto__`, `$bytes` and `$undefined` as data, and a text that the two profiles read differently |
| `integers`, `numbers`, `decimals` | the window ±(2⁵³ − 1) and both sides of 2⁵³, integers beyond `i128`, `-0`, tagged small integers, canonical integer text, fraction and exponent refusals, canonical decimals, large exponents and mantissas |
| `bytes`, `base64` | canonical padded base64, pad bits, padding, line breaks, the URL alphabet |
| `maps`, `sets` | codec order, the reserved key `$ontos` through the map tag, text-keyed map tags written as objects, duplicates by ground-value equality across spellings, the order of entry checks |
| `compounds`, `preferred`, `raw` | unknown, empty, namespaced and non-UTF-8 labels, malformed registered-label tuples preserved, preferred-spelling normalizations, raw subtrees in total form |
| `envelope` | the reservation of `$ontos` after escape decoding, extra members, malformed envelopes, unknown tags, arities |
| `empties`, `origins` | all distinct empty values, and origins across sorting and through `raw` |
| `depth`, `limits`, `write-limits` | JSON depth against value depth (each refusing where the other does not), the defaults at and past their bounds, every limit kind for reading and for writing |

A real binding round trip (input, domain conversion, service result, export, re-import) is the
bindings' to test.

## Adding a case

Write the case with `input`, `value`, `output` or `refusal` (and `limits`, `note`,
`origins` as needed), leave out `input_hex` and `value_hex`, then run:

```sh
node tools/json-projection/gen.mjs     # after the ts build (scripts/check.sh vectors builds it)
node tools/json-projection/check.mjs
```

Commit the regenerated file. If the checker disagrees, find out from the spec page which is
right before changing anything.
