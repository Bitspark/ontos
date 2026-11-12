# ontos-total-json/1 — the total JSON form of ground values

**Status:** profile `ontos-total-json/1`, specified 12 November 2026 from
[design record 0010](../design/0010-json-projections.md) (step 1 of its §5). This page and
the vectors under [`projection/json/vectors/`](../../projection/json/vectors/) are the
contract. The library faces under `projection/json/` follow as separate changes (0010 §5,
steps 3 and 4), and cross-face conformance is claimed only once every face passes the vectors
of both JSON profiles (0010 §5, step 5). The companion profile is
[`ontos-readable-json/1`](ontos-readable-json.md), which reads JSON text exactly as §4.2 and
§4.3 of this page define and embeds this profile in its `raw` arm.

The keywords MUST, MUST NOT, SHOULD and MAY are used in the IETF sense, and only where a face
could otherwise reasonably do something else.

---

## 1. What this profile is

`ontos-total-json/1` spells every ground value ([ontos-core §1](ontos-core.md)) as JSON
text, node for node:

```text
Atom(b)              →  {"atom":"<b as lowercase hex>"}
Tuple(v₀, …, vₙ₋₁)   →  {"tuple":[<v₀>,…,<vₙ₋₁>]}
```

It promotes the authoring notation of [`vectors/`](../../vectors/README.md) and of the
command line's `--from-json` and `--format json` ([ontos-cli](ontos-cli.md#value-input)) to
a named, versioned profile with a reader and a writer. It is **total** over L0: every value
has exactly one preferred spelling, and every accepted text denotes exactly one value. It
says nothing about embeddings. `{"tuple":[{"atom":"696e74"},{"atom":"0001"}]}` is the tuple
whose children are the atoms `0x696e74` and `0x0001`. That this tuple is also the integer 1
([ontos-data §5.1](ontos-data.md)) is not this profile's concern.

**A presentation, not the form of record.** A JSON profile is a presentation: it may travel,
but the value is recovered from it before any identity operation. Identity, hashing and
signing use the codec bytes of the recovered value, and ontos's APIs for them take bytes or
values, never JSON text. The form of record is the codec bytes
([ontos-codec](ontos-codec.md), design 0010 §3).

**Identity of the profile.** The profile id is `ontos-total-json/1`. The text accepted, the
value read, the text written and the refusal codes are fixed for `/1`. A change to any of
them is a new profile, `ontos-total-json/2`, and never an edit to `/1`. The limits of §9 are
operational and may be configured per call. The shipped defaults are part of `/1`, so a
change to a default is versioned like any other change.

**Selection is explicit.** A reader is told which profile it reads. No ontos surface detects
a profile from the shape of the text: `{"atom":"00"}` is `Atom(0x00)` here, a map from the
text `"atom"` to the text `"00"` under [`ontos-data-json/1`](ontos-data-json.md), and the
same map under [`ontos-readable-json/1`](ontos-readable-json.md).

## 2. The value mapping

The writer `W` and the reader `R` of §7 are defined over this mapping and nothing else.

| value | preferred spelling |
|---|---|
| `Atom(b)` | `{"atom":"h"}`, where `h` is `b` as lowercase hexadecimal, two digits per byte, `""` for the empty atom |
| `Tuple(v₀, …, vₙ₋₁)` | `{"tuple":[W(v₀),…,W(vₙ₋₁)]}`, `[]` for the empty tuple |

`Atom("")` is `{"atom":""}`, and `Tuple()` is `{"tuple":[]}`. They are distinct values with
distinct spellings.

## 3. Grammar

The accepted language is the set of byte strings that are well-formed UTF-8 (§4.2) and match
`total-text` below, subject to the constraints of §4.3 (escapes, repeated member names, depth).
The grammar is ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)). The rules `ws`,
`begin-object`, `end-object`, `begin-array`, `end-array`, `name-separator`,
`value-separator` and `string` are those of
[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) §2 and §7, and `DIGIT` is RFC 5234's.

```abnf
total-text    = ws total-value ws

total-value   = atom-object / tuple-object

atom-object   = begin-object atom-name name-separator hex-string end-object

tuple-object  = begin-object tuple-name name-separator tuple-items end-object

tuple-items   = begin-array [ total-value *( value-separator total-value ) ] end-array

atom-name     = <a string whose decoded content is "atom">

tuple-name    = <a string whose decoded content is "tuple">

hex-string    = <a string whose decoded content matches hex-content>

hex-content   = *( lc-hex lc-hex )

lc-hex        = DIGIT / %x61-66        ; 0-9 a-f, lowercase only
```

**Decoded content.** A prose value of the form `<a string whose decoded content …>` (RFC 5234
§4) stands for any RFC 8259 `string` whose content matches. A string's *decoded content* is
the sequence of Unicode scalar values between its quotation marks after each escape is replaced
by what it denotes (RFC 8259 §7): `"\u0061tom"` and `"atom"` have the same decoded content.

RFC 8259's `ws` is exactly space, horizontal tab, line feed and carriage return. Every other
character outside a string, including U+00A0, U+2028 and U+FEFF, is outside the language.

## 4. Reading

### 4.1 Four stages, in order

A reader takes the input as bytes and runs four stages. Each stage runs to completion before
the next begins, and the first refusal ends the reading:

1. **Size.** The input is at most `max_text_bytes` bytes long (§9).
2. **Text.** The input is well-formed UTF-8 (§4.2).
3. **JSON.** The input is one JSON text under the strict reading of §4.3: RFC 8259's syntax,
   RFC 8259's whitespace and nothing else, no byte order mark, no escape that names a lone
   surrogate, no repeated member name, at most `max_json_depth` open arrays and objects, and
   nothing after the value. This stage builds a JSON tree whose nodes carry their spans.
4. **Profile.** The JSON tree is interpreted as a value (§4.4 for this profile, and
   [ontos-readable-json §4](ontos-readable-json.md#4-reading) for the readable one).

Stages 1 to 3 are shared by both JSON profiles: the same input gets the same refusal from them
under either profile, apart from the default of `max_json_depth` (§9). The order of the stages
is part of the contract, so a text that is not JSON is refused as such even when an earlier
part of it would also fail stage 4. A face that interprets while it parses still reports the
refusal this order defines.

### 4.2 Text: well-formed UTF-8

The input MUST be well-formed UTF-8 as [Unicode §3.9](https://www.unicode.org/versions/latest/)
defines it (Table 3-7): no overlong forms, no encoded surrogates, nothing above U+10FFFF, and
no truncated sequence. The reader scans the whole input before stage 3. At the first offset
`s` where the bytes are not well-formed, it refuses with `invalid_utf8`, the empty path, and
the span `[s, e)` of the **maximal subpart** there: the longest run of bytes from `s` that is
a prefix of some well-formed sequence in Table 3-7, or the one byte at `s` when no
well-formed sequence starts with it.

| bytes at `s` | span length | why |
|---|---|---|
| `80` | 1 | a continuation byte cannot start a sequence |
| `C0 80` | 1 | `C0` starts no well-formed sequence (overlong) |
| `E2 82` then `41` | 2 | `E2 82` is a prefix of `E2 82 AC`, and `41` cannot continue it |
| `ED A0 80` | 1 | after `ED` only `80`–`9F` may follow, so `ED` alone is the subpart |
| `F4 90 80 80` | 1 | after `F4` only `80`–`8F` may follow (above U+10FFFF otherwise) |
| `E2 82` at the end of input | 2 | a truncated sequence |

A reader never repairs text: it does not replace an ill-formed sequence with U+FFFD, and it
does not drop one. An authentic U+FFFD in the input is an ordinary character.

### 4.3 JSON: the strict reading

Stage 3 reads the text from left to right with the procedure below. Every refusal it can
produce is listed with its code, its path (§8.2) and its span (§8.3). `p` is the current byte
offset and `n` the input length. "The character at `p`" means the one Unicode scalar value
whose UTF-8 encoding starts at `p`, and its span is that encoding's bytes. A span written
`[n, n)` is the empty span at the end of the input, used when the text ends where more was
required.

**Text.**

1. If the input begins with the bytes `EF BB BF` (U+FEFF), refuse with `byte_order_mark`,
   path `[]`, span `[0, 3)`. RFC 8259 §8.1 permits a parser to ignore a byte order mark. This
   profile refuses it, so that a text and the same text behind a byte order mark are not two
   spellings of one value.
2. Skip whitespace, read one value at path `[]` and JSON depth 0, then skip whitespace.
3. If `p < n`, refuse with `trailing_data`, path `[]`, span `[p, n)`.

*Whitespace* is the bytes `20`, `09`, `0A` and `0D`, and nothing else.

**A value**, at path `P` and enclosed by `k` open arrays and objects:

- At `p = n`, refuse with `invalid_json`, path `P`, span `[n, n)`.
- `{` reads an object, `[` an array, `"` a string, `t`, `f` and `n` a literal, and `-` or a
  digit a number. Any other character refuses with `invalid_json`, path `P`, and the
  character's span.

**An object or array** first checks its depth. If `k + 1 > max_json_depth`, refuse with
`limit_exceeded`, kind `json_depth`, path `P`, span `[p, p + 1)` (the bracket). Then:

- *Object.* After `{` and whitespace, `}` ends an empty object. Otherwise read members. For
  each member:
  1. The next byte must be `"`, else refuse with `invalid_json`, path `P`, and the character's
     span, or `[n, n)` at the end. Read the string. That is the member name `m`, and its
     token is the span from its opening to its closing quotation mark.
  2. If an earlier member of this object has the same decoded name, refuse with
     `duplicate_member`, path `P + [m]`, span of the second name's token. Names are compared
     after escape decoding and without Unicode normalization: `"a"` and `"\u0061"` are the
     same name, while `"é"` (U+00E9) and `"e\u0301"` are two names.
  3. After whitespace, the next byte must be `:`, else refuse with `invalid_json`, path
     `P + [m]`, and the character's span, or `[n, n)`.
  4. After whitespace, read a value at path `P + [m]`, enclosed by `k + 1`.
  5. After whitespace, `,` and whitespace continue with the next member, and `}` ends the
     object. Anything else refuses with `invalid_json`, path `P`, and the character's span,
     or `[n, n)`.
- *Array.* After `[` and whitespace, `]` ends an empty array. Otherwise read elements, the
  `i`-th (from 0) as a value at path `P + [i]` enclosed by `k + 1`. After each element and
  whitespace, `,` and whitespace continue with element `i + 1`, and `]` ends the array.
  Anything else refuses with `invalid_json`, path `P`, and the character's span, or `[n, n)`.

**A string**, from its opening quotation mark, reads characters until the closing one:

- At `p = n`, refuse with `invalid_json`, span `[n, n)`.
- A byte below `20` (an unescaped control character) refuses with `invalid_json`, span
  `[p, p + 1)`.
- `\` starts an escape. `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r` and `\t` denote their RFC 8259
  characters. `\u` must be followed by four hexadecimal digits, of either case, which
  name a code point `c`. A missing or non-hexadecimal digit refuses with `invalid_json` and
  that character's span, or `[n, n)`.
  - If `c` is a high surrogate (`D800`–`DBFF`), the next six bytes must be `\u` and four
    hexadecimal digits naming a low surrogate (`DC00`–`DFFF`). The pair then denotes one
    scalar value. Otherwise refuse with `invalid_unicode_escape`, span of the high escape's
    six bytes.
  - If `c` is a low surrogate not consumed by a pair, refuse with `invalid_unicode_escape`,
    span of its six bytes.
  - Any other escape (`\x`, `\'`, …) refuses with `invalid_json`, span of the backslash and
    the character after it. A backslash at the end of the input refuses with `[n, n)`.
- Any other character is copied as itself.

The path of a refusal inside a string is the path of the value being read. For a member name,
it is the object's path `P`, because the name is not complete yet.

**A literal** is exactly `true`, `false` or `null`. At the first byte that differs, refuse with
`invalid_json` and that character's span, or `[n, n)`.

**A number** is the longest match of RFC 8259's `number` at `p`: an optional `-`, then `0` or
a non-zero digit followed by digits, then optionally `.` and one or more digits, then
optionally `e` or `E`, an optional sign and one or more digits. A `-`, `.`, `e` or sign that
is not followed by what the grammar requires refuses with `invalid_json` and the span of the
character found, or `[n, n)`. The number token ends where the match ends. Whatever follows is
handled by the enclosing step, so `01` at the top level is the number `0` followed by trailing
data.

**The JSON tree.** Stage 3 yields a tree of nodes: objects (with members in source order,
each with its decoded name and the name's token span), arrays, strings (with decoded content),
numbers (with their lexeme), and the three literals. Every node carries its span: a string's
from its opening to its closing quotation mark, a number's or a literal's lexeme, and an
object's or array's from its opening to its closing bracket, inclusive.

### 4.4 Interpretation as a total-form value

Stage 4 interprets the root node at value depth 0 and path `[]`. A node `x` at value depth `d`
and path `P` is checked in this order, and the first failing check is the refusal:

1. `x` is an object, else `invalid_total_form` at `x`.
2. `x` has exactly one member, else `invalid_total_form` at `x`.
3. The member's decoded name is `atom` or `tuple`, else `invalid_total_form` at `x`.
4. **`atom`**, with member value `y`:
   1. `y` is a string, else `invalid_total_form` at `y`.
   2. The decoded content of `y` matches `hex-content`: even length, digits and lowercase
      `a`–`f` only. Otherwise `invalid_hex` at `y`.
   3. Limits: `d > max_value_depth` refuses with kind `decode_depth` at `x`, and a byte
      length above `max_atom_bytes` refuses with kind `atom_bytes` at `x`.

   The value is the atom whose bytes the hex denotes.
5. **`tuple`**, with member value `y`:
   1. `y` is an array, else `invalid_total_form` at `y`.
   2. Limits: `d > max_value_depth` refuses with kind `decode_depth` at `x`, and an element
      count above `max_tuple_arity` refuses with kind `tuple_arity` at `x`.
   3. Each element `y[i]`, in order, is interpreted at value depth `d + 1` and path
      `P + ["tuple", i]`.

   The value is the tuple of the elements' values, in order.

"At `x`" means the refusal's path is `x`'s path and its span is `x`'s span. Stage 3 has already
refused repeated member names, so `{"atom":"00","atom":"01"}` is `duplicate_member`, not
`invalid_total_form`.

## 5. Writing: deterministic emission

The writer emits the preferred spelling of §2 as UTF-8 bytes:

- no byte order mark, no whitespace between tokens and no trailing newline;
- the member names `atom` and `tuple` written without escapes;
- atom bytes as lowercase hexadecimal, two digits per byte;
- tuple children in order, separated by `,`.

Every byte of the output is ASCII, so the string escaping rule of
[ontos-readable-json §5](ontos-readable-json.md#5-writing-deterministic-emission) never
applies here. A line-oriented tool frames each value outside the writer: the command line ends
each JSON Lines record with a line feed ([ontos-cli](ontos-cli.md)), and a pretty-printer may
add whitespace. Either output is still accepted by the reader, and it reads back as the same
value.

The writer is total over values, but a finite implementation checks the limits of §9 while it
writes (§9.3).

## 6. Named normalizations

Every source distinction that the reader accepts and the writer does not reproduce is named
here. Every other distinction is refused. Nothing is collapsed silently.

| source distinction | rule | name or refusal |
|---|---|---|
| space, tab, line feed and carriage return between tokens | accepted, never emitted | normalization `json-whitespace` |
| any other whitespace, such as U+00A0, U+2028 or a form feed, outside strings | refused | `invalid_json` |
| a byte order mark at the start | refused | `byte_order_mark` |
| a member name or hex string spelled with escapes (`"\u0061tom"`, `"\u0030\u0030"`) | accepted, emitted without escapes | normalization `string-escapes` |
| uppercase or odd-length hex | refused | `invalid_hex` |
| a repeated member name, compared after escape decoding | refused | `duplicate_member` |
| comments, a second value, or anything after the value | refused | `trailing_data` (after a complete value) or `invalid_json` |
| ill-formed UTF-8 anywhere in the input | refused | `invalid_utf8` |
| an escape naming a lone surrogate | refused | `invalid_unicode_escape` |

The normalization `N = W ∘ R` (§7) therefore changes only whitespace and escapes.

## 7. Laws

Let `V` be the set of ground values, `A` the accepted language (the byte strings `R` accepts),
`W : V → A` the writer and `R : A → V` the reader. With unbounded limits:

1. **Round trip.** `R(W(v)) = v` for every `v ∈ V`.
2. **Stable preferred text.** Let `C = W(V)`, the writer's image. Then `W(R(j)) = j` for every
   `j ∈ C`.
3. **Normalization.** For every `j ∈ A`, `N(j) = W(R(j))` satisfies `N(N(j)) = N(j)` and
   `R(N(j)) = R(j)`: accepted alternatives converge on one spelling, and the value is unchanged.
4. **Single reading.** `R` is a function: an accepted text denotes exactly one value, whatever
   face reads it.

Law 1 makes `W` injective. Laws 2 and 3 state the edit-and-render cycle: render a value, edit
the text, read it back, render again, and the text settles on the preferred spelling. The
preferred text is convenient for fixtures and diffs, and it has no authority over identity.

With finite limits, the laws hold for every value and text inside the limits, and §9.3 adds
an operational round trip.

## 8. Refusals

### 8.1 The refusal record

A refusal carries:

| field | contents | normative |
|---|---|---|
| `profile` | `ontos-total-json/1` | yes |
| `code` | a stable lowercase code from §8.4 | yes |
| `path` | the typed path of §8.2 | yes |
| `span` | the zero-based, half-open UTF-8 byte span `[start, end)` of §8.3 | yes |
| `kind` | for `limit_exceeded` only, the limit kind of §9.1 | yes |
| `message` | a human-readable explanation | no: wording may improve, and nobody may parse it |

For a given input and limits, the refusal is determined: the stages of §4.1, the procedure of
§4.3 and the check order of §4.4 select exactly one refusal, and every face reports the same
code, path, span and kind. The vectors pin all four.

### 8.2 Paths

A path is a sequence of typed segments from the root of the JSON text: a **member name**, as
its decoded string, for a step into an object, and an **index**, a non-negative integer
counting from 0, for a step into an array. The two kinds of segment stay distinguishable in
every face. A member named `"0"` is the segment `"0"`, not the index `0`. In vectors and JSON
output, a path is a JSON array of strings and integers.

Refusals from stages 1 and 2 have the empty path. Stage 3 gives the path of the value being
read when the fault was found (§4.3). Stage 4 gives the path of the node the check names. A
path does not distinguish repeated occurrences of one member name, and the span does: a
`duplicate_member` refusal carries the span of the second occurrence. The record names only
that one. A face may mention the first occurrence in its message.

### 8.3 Spans

A span `[start, end)` counts bytes of the input from 0, `start` included and `end` excluded.
Spans count bytes rather than characters or UTF-16 code units, because the input is bytes. An
editor converts them to its own coordinates. An empty span `[n, n)` marks the end of the input.
A refusal for `max_text_bytes` has the span `[max_text_bytes, n)`, the bytes beyond the bound.

### 8.4 Codes

| code | stage | when |
|---|---|---|
| `limit_exceeded` | any | an operational bound of §9 was reached; `kind` names it |
| `invalid_utf8` | 2 | the input is not well-formed UTF-8 (§4.2) |
| `byte_order_mark` | 3 | the input begins with U+FEFF |
| `invalid_json` | 3 | the input is not an RFC 8259 JSON text, with the whitespace of §4.3 |
| `invalid_unicode_escape` | 3 | a `\u` escape names a lone surrogate |
| `duplicate_member` | 3 | an object repeats a member name after escape decoding |
| `trailing_data` | 3 | something other than whitespace follows the value |
| `invalid_total_form` | 4 | a node is not exactly `{"atom": string}` or `{"tuple": array}` |
| `invalid_hex` | 4 | an atom string is not even-length lowercase hexadecimal |

Codes are shared with the readable profile, which adds its own (readable §8). An identifier is
never reassigned to another meaning.

## 9. Limits

The mathematical projection is total, and a finite reader or writer has bounds. A limit
refusal (`limit_exceeded`) reports that this reading or writing stopped at a bound. It does
not say the text or the value is malformed, and another call with larger bounds may succeed.
This is the posture of the codec's decoder limits
([ontos-codec §4.1–§4.2](ontos-codec.md#42-operational-limit-reporting)).

### 9.1 The bounds and their kinds

The projection reuses the codec's limit kinds where they mean the same thing, and adds kinds
for what only text has. The kinds share the codec's namespace and stability rule: identifiers
are append-only and never reassigned.

| bound | kind | counts | source of the kind |
|---|---|---|---|
| `max_text_bytes` | `text_bytes` | bytes of the input text (reader) or of the output text (writer) | new for the projection |
| `max_json_depth` | `json_depth` | **JSON depth**: arrays and objects open at once. A top-level scalar has depth 0, `[]` depth 1, `{"tuple":[]}` depth 2 | new for the projection |
| `max_value_depth` | `decode_depth` | **value depth**: how deep the value is nested, with the root at depth 0, the codec's `height` measure ([ontos-codec §10.1](ontos-codec.md#101-the-three-measures)) | [ontos-codec §4.2](ontos-codec.md#42-operational-limit-reporting) |
| `max_atom_bytes` | `atom_bytes` | the byte length of any atom in the value | ontos-codec §4.2 |
| `max_tuple_arity` | `tuple_arity` | the arity of any tuple in the value | ontos-codec §4.2 |

The value-side bounds (`max_value_depth`, `max_atom_bytes`, `max_tuple_arity`) mean exactly
what the codec decoder's bounds mean. A value the reader returns under them is accepted by an
`ontos-codec-v1` decoder given the same bounds, once encoded. The codec's `native_width` kind
counts uvarint lengths and has no counterpart in text, so the projection never reports it.

JSON depth and value depth differ because the spelling adds nesting. In this profile, a tuple
takes two JSON levels (`{"tuple":[`) and an atom one. A value of depth `h` is therefore
spelled with JSON depth `2h + 1` when its deepest values are all atoms, and `2h + 2` when one
of them is an empty tuple:

```text
JSON depth of any accepted text  ∈  { 2·h + 1 , 2·h + 2 },  h = value depth of the value it denotes
```

### 9.2 The shipped defaults

| bound | default |
|---|---|
| `max_text_bytes` | unbounded |
| `max_json_depth` | **2050** |
| `max_value_depth` | **1024** |
| `max_atom_bytes` | unbounded |
| `max_tuple_arity` | unbounded |

Every face ships exactly these defaults, so the vectors can pin depth at and past them.

- `max_value_depth = 1024` is the codec decoder's shipped depth
  ([ontos-codec §4.1](ontos-codec.md#41-the-per-implementation-resource-limits-documented-non-divergent-on-valid-input)).
  A value read under the defaults decodes under the decoder's defaults once encoded.
- `max_json_depth = 2050 = 2·1024 + 2` is the deepest spelling of a value within that depth,
  an empty tuple at depth 1024. By §9.1, a text exceeds 2050 exactly when its value is nested
  deeper than 1024. Under the defaults, a value at depth 1024 is accepted, and one at depth
  1025 is refused in stage 3 with kind `json_depth`. A deeper value is therefore never built.
  The command line's interim cap of 2050 levels on `--from-json` is this bound
  ([ontos-cli](ontos-cli.md#value-input)).
- The other bounds are unbounded, as in the codec. The caller already holds the input, and
  every count is bounded by its length. A service sets `max_text_bytes` to its own request
  limit.

A face MUST NOT rely on native recursion to reach these depths. 2050 levels exceed the default
recursion limit of Python, and the stack of some threads elsewhere. The codec's decoders and
the command lines' readers keep an explicit stack for the same reason.

### 9.3 When each bound is checked

- **Reader.** `max_text_bytes` is checked first (stage 1), `max_json_depth` when an array or
  object opens (stage 3), and the value-side bounds at each node in stage 4 (§4.4).
- **Writer.** The writer checks the same bounds against the value it writes and the text it
  would emit. Walking the value in output order, it checks each node's depth, arity and atom
  length before writing the node, checks `max_json_depth` when it opens an array or object,
  and checks `max_text_bytes` when the output would first exceed it. The first bound reached
  is the refusal, with its kind. A writer refusal has no span, because there is no input
  text. Its path is informative: a face SHOULD give the value path of the node being written
  (readable §10), and vectors do not pin it.
- **Operational round trip.** If `W` writes `v` under limits `L`, then `R` reads `W(v)` under
  the same `L` and returns `v`. In particular, everything a writer emits under the defaults is
  readable under the defaults. A service that exports values for re-import therefore writes
  them under its import limits.

A failure that is not one of these bounds, such as an allocation failure or a host recursion
limit, is not a limit kind. It is a defect of the face, as it is for the codec.

## 10. API in each face

Source text is the normative input (0010, row 19). A reader takes the text as bytes and owns
the boundary where invalid UTF-8 could otherwise be replaced or dropped. The API is stated here
as a contract. The packages are those of design 0010 §4: one per language, holding both
profiles, with `readable` depending on `total`.

| face | package | read | write |
|---|---|---|---|
| Go | `github.com/bitspark/ontos/projection/json/go/total` | `ParseUTF8(input []byte, limits Limits) (core.Value, error)` | `RenderUTF8(v core.Value, limits Limits) ([]byte, error)` |
| Rust | crate `bitspark-ontos-json`, module `ontos_json::total` | `parse_utf8(input: &[u8], limits: &Limits) -> Result<Value, Error>` | `render_utf8(value: &Value, limits: &Limits) -> Result<Vec<u8>, Error>` |
| TypeScript | `@bitspark/ontos-json`, entry point `./total` | `parseUtf8(input: Uint8Array, limits?: Partial<Limits>): Value` | `renderUtf8(value: Value, limits?: Partial<Limits>): Uint8Array` |
| Python | `ontos_json.total` | `parse_utf8(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> Value` | `render_utf8(value: Value, *, limits: Limits = DEFAULT_LIMITS) -> bytes` |

- **Host strings.** A language whose strings are already decoded also gets a string reader:
  TypeScript `parseString(input: string, limits?)` and Python `parse_str(text: str, *, limits)`.
  It reads the string as the byte reader would read the string's generalized UTF-8 encoding,
  in which a lone surrogate becomes the three bytes `ED A0–BF 80–BF`. A lone surrogate is
  therefore refused with `invalid_utf8`, path `[]`, and the one-byte span at the UTF-8 length
  of the characters before it. A string reader cannot know whether the string was decoded
  lossily before it arrived, which is why the byte reader is the normative one. Rust's `&str`
  and Go's `string` cannot hold a lone surrogate, so Rust's `parse_str(input: &str, limits)`
  and Go's `ParseUTF8([]byte(s), …)` need no check. TypeScript also offers
  `renderString(value, limits?)`, the UTF-8 decoding of `renderUtf8`.
- **Limits.** One record with the fields of §9.1, shared by both profiles: Go `Limits` with
  `DefaultLimits()`, Rust `Limits` whose `Default` is §9.2, TypeScript `Limits` with
  `DEFAULT_LIMITS` and partial overrides, and Python a frozen `Limits` with `DEFAULT_LIMITS`.
  Every face represents "unbounded" and every bound it can hold exactly. A bound it cannot
  represent is a caller error, not a refusal.
- **Errors.** One error type, shared by both profiles, exposes `profile`, `code`, `path` (the
  typed segments of §8.2), `span` (`start` and `end`), `kind` (for `limit_exceeded`) and a
  message: Go `*Error`, returned as `error`; Rust `Error`; TypeScript `ProjectionError`,
  thrown; Python `ProjectionError`, raised. A reader never returns a partial value with an
  error.
- **No tree API validates source.** A face MAY also convert an already-parsed host JSON tree,
  but such an API MUST NOT claim to validate text. A host tree has already lost repeated
  members and escape spellings, and in some hosts number lexemes.

## 11. Conformance vectors

[`projection/json/vectors/total.json`](../../projection/json/vectors/total.json) pins this
profile, and its [README](../../projection/json/vectors/README.md) gives the format. Each case
pins, independently of the others:

- the input as hex of its exact bytes, so ill-formed UTF-8 is expressible;
- for an accepted input, the `ontos-codec-v1` bytes of the value and the preferred output text;
- for a refused input, the refusal's code, path, span and, for a limit, its kind;
- any non-default limits the case runs under.

A face conforms when, for every case, it reads the input to a value with exactly those codec
bytes or refuses with exactly that code, path, span and kind, and writes the value as exactly
that output. [`tools/json-projection/check.mjs`](../../tools/json-projection/check.mjs) checks
every vector against this page with its own reader and writer, and `scripts/check.sh vectors`
runs it.

## 12. Relation to other surfaces

- **The command line.** `--from-json` and `--format json` use this notation today. When the
  command lines move onto this profile's library reader (0010 §5, step 3), `--from-json`
  accepts exactly this profile's language, and `--format json` emits exactly `W`. The command
  line reports a refusal with its own stable codes
  ([ontos-cli](ontos-cli.md#json-lines-output-schema)).
- **The readable profile** embeds this profile in its `raw` arm, and reads text with stages 1
  to 3 of §4.
- **`ontos-data-json/1`** reads domain JSON into embeddings and is a separate surface. The two
  never agree on a text: every text this profile accepts is an object with an `atom` or `tuple`
  member, which `ontos-data-json/1` reads as a map from text to text or to a list
  ([readable §11](ontos-readable-json.md#11-the-common-subset-with-ontos-data-json1)).
