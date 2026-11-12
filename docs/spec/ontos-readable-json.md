# ontos-readable-json/1 — the readable JSON form of ground values

**Status:** profile `ontos-readable-json/1`, specified 12 November 2026 from
[design record 0010](../design/0010-json-projections.md) (step 1 of its §5). This page and
the vectors under [`projection/json/vectors/`](../../projection/json/vectors/) are the
contract. The library faces under `projection/json/`, including the origins API of §10.2,
follow as separate changes (0010 §5, step 4). Cross-face conformance is claimed only once every
face passes the vectors of both JSON profiles (0010 §5, step 5). The companion profile is
[`ontos-total-json/1`](ontos-total-json.md). This profile reads text with that page's stages 1
to 3 and embeds it in the `raw` arm.

The keywords MUST, MUST NOT, SHOULD and MAY are used in the IETF sense, and only where a face
could otherwise reasonably do something else.

---

## 1. What this profile is

`ontos-readable-json/1` spells the common ground values as ordinary JSON: `null`, `true` and
`false`, strings, integers in the safe range, arrays, and objects with text keys. Every other
value goes through one reserved envelope, `{"$ontos":[tag,…]}`, with the seven tags `bytes`,
`int`, `decimal`, `map`, `set`, `compound` and `raw`. The `raw` tag wraps the total form, so
this profile is **total** over L0 as well: every value has exactly one preferred spelling, and
every accepted text denotes exactly one value.

```text
257                                        int(257)
"hi"                                       utf8-text("hi")
[1,"a",null]                               list(int 1, utf8-text "a", null())
{"b":true,"aa":false}                      map(utf8-text "b" → bool true, utf8-text "aa" → bool false)
{"$ontos":["bytes","AA=="]}                Atom(0x00)
{"$ontos":["int","9007199254740993"]}      int(9007199254740993)
{"$ontos":["decimal","314","-2"]}          decimal(int 314, int −2), that is 3.14
{"$ontos":["set",[1,2]]}                   set(int 1, int 2)
{"$ontos":["compound","ok",[257]]}         Tuple(Atom("ok"), int 257)
{"$ontos":["raw",{"tuple":[]}]}            Tuple()
```

The profile is defined from the value alone. It takes no type descriptor, and a known type
does not change a spelling (0010 §1). Conveniences that depend on a type, such as a base64
field or a decimal text box, belong to the bindings, which build a value and then write it with
this profile (0010, row 3).

**A presentation, not the form of record.** A JSON profile is a presentation: it may travel,
but the value is recovered from it before any identity operation. Identity, hashing and
signing use the codec bytes of the recovered value, and ontos's APIs for them take bytes or
values, never JSON text. The form of record is the codec bytes (design 0010 §3).

**Identity of the profile.** The profile id is `ontos-readable-json/1`. The text accepted, the
value read, the text written, the recognition table of §2.3 and the refusal codes are fixed for
`/1`. A change to any of them is a new profile, `ontos-readable-json/2`, and never an edit to
`/1`. A library upgrade does not change what `/1` writes. The limits of §9 are operational;
their shipped defaults are part of `/1`.

**Selection is explicit.** A reader is told which profile it reads. No ontos surface detects
a profile from the shape of a text. Under this profile `{"atom":"00"}` is an ordinary map from
the text `"atom"` to the text `"00"`, and under the total profile it is `Atom(0x00)`. §11
states where this profile and [`ontos-data-json/1`](ontos-data-json.md) agree.

## 2. The value mapping

### 2.1 The spellings

| value | preferred spelling |
|---|---|
| `null()` | `null` |
| `bool` false, true | `false`, `true` |
| `utf8-text(s)` | the JSON string of `s` |
| `int(n)` with `−(2⁵³ − 1) ≤ n ≤ 2⁵³ − 1` | the integer literal of `n` |
| `int(n)` outside that window | `{"$ontos":["int","<n>"]}` |
| `list(e₀, …)` | `[W(e₀),…]` |
| `map` whose keys are all `utf8-text` and none is the text `$ontos` | `{"<k₀>":W(v₀),…}`, members in codec order |
| any other `map` | `{"$ontos":["map",[[W(k₀),W(v₀)],…]]}`, entries in codec order |
| `set(e₀, …)` | `{"$ontos":["set",[W(e₀),…]]}`, elements in codec order |
| `decimal(int m, int e)` | `{"$ontos":["decimal","<m>","<e>"]}` |
| `Atom(b)` | `{"$ontos":["bytes","<b in canonical base64>"]}` |
| any other `Tuple(Atom(l), a₀, …)` | `{"$ontos":["compound",<l>,[W(a₀),…]]}`, with `<l>` the JSON string of `l` when `l` is well-formed UTF-8, and `["bytes","<l in base64>"]` otherwise |
| any other tuple: `Tuple()`, or a tuple whose first child is a tuple | `{"$ontos":["raw",<its ontos-total-json/1 spelling>]}` |

Integers are written in canonical decimal (§4.5), bytes in canonical base64 (§4.7), and maps and
sets in the codec order of their keys and elements (§4.8). The `raw` arm holds the total form of
the whole subtree. The children of a raw tuple are total form too, not readable spellings.

A label is the bytes of an atom. The string in a compound's label position stands for those
bytes and introduces no `utf8-text` child: `{"$ontos":["compound","ok",[]]}` is
`Tuple(Atom("ok"))`.

### 2.2 Distinct empty values

| value | preferred spelling |
|---|---|
| `utf8-text("")` | `""` |
| `Atom("")` | `{"$ontos":["bytes",""]}` |
| empty `list` | `[]` |
| empty `map` | `{}` |
| empty `set` | `{"$ontos":["set",[]]}` |
| `Tuple()` | `{"$ontos":["raw",{"tuple":[]}]}` |
| `null()` | `null` |
| `Tuple(Atom(""))`, a compound with the empty label | `{"$ontos":["compound","",[]]}` |

### 2.3 The recognition order, frozen for `/1`

The writer chooses a spelling in this order, the first match winning:

1. **The eight `ontos/data` kinds, exactly as [ontos-data §5](ontos-data.md#5-the-v1-label-set)
   defines their canonical forms.** A value is recognized as one of them when its label atom
   is that kind's label and the value is that kind's canonical form:

   | label | canonical form | spelling |
   |---|---|---|
   | `null` | [§5.10](ontos-data.md#510-null--the-single-no-value--byte-form-frozen-added-2026-06-13) | `null` |
   | `bool` | [§5.3](ontos-data.md#53-bool--boolean--byte-form-frozen-v1) | `false`, `true` |
   | `utf8-text` | [§5.2](ontos-data.md#52-utf8-text--unicode-text--byte-form-frozen-v1) | string |
   | `int` | [§5.1](ontos-data.md#51-int--exact-integer--byte-form-frozen-v1) | literal, or the `int` tag |
   | `list` | [§5.5](ontos-data.md#55-list--ordered-sequence--byte-form-frozen-v1) | array |
   | `map` | [§5.7](ontos-data.md#57-map--finite-association--byte-form-frozen-added-2026-06-01) | object, or the `map` tag |
   | `set` | [§5.8](ontos-data.md#58-set--finite-set--byte-form-frozen-added-2026-06-01) | the `set` tag |
   | `decimal` | [§5.9](ontos-data.md#59-decimal--exact-decimal-value--byte-form-frozen-added-2026-06-06) | the `decimal` tag |

   Recognizing a list, map or set checks only that container's own canonical rules. Its
   children are arbitrary values, written by `W` in turn, whether or not they are themselves
   recognized. A decimal's canonical form includes its two canonical `int` children
   (ontos-data §5.9).
2. **Atoms**: the `bytes` tag.
3. **Compounds** ([ontos-compound §1](ontos-compound.md#1-the-reading)), the tuples whose first
   child is an atom, that step 1 did not take: the `compound` tag, with the literal label and
   the remaining children as arguments.
4. **Everything else**: `Tuple()` and the tuples whose first child is a tuple, through the
   `raw` tag.

**A malformed registered-label tuple is preserved, never repaired.**
`Tuple(Atom("decimal"), int(100), int(0))` is a valid value but not a canonical decimal
(its mantissa is divisible by 10). Step 1 does not take it, step 3 writes it as
`{"$ontos":["compound","decimal",[100,0]]}`, and reading that text gives back the same tuple,
not `decimal(1, 2)`.

**The table is frozen.** A label that `ontos/data` registers after `/1` (a `rational`, say,
[ontos-data §9](ontos-data.md#9-future-embeddings--a-demand-driven-candidate-register-no-embeddings-added-here))
is not in this table. `/1` writes such a value as a compound in step 3, for good. Recognizing
it would be `ontos-readable-json/2`.

## 3. Grammar

The accepted language is the set of byte strings that are well-formed UTF-8 and match
`readable-text`, subject to the constraints of [ontos-total-json §4.3](ontos-total-json.md#43-json-the-strict-reading)
(escapes, repeated member names, depth) and those stated with each rule below. The grammar is
ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)). `ws`, `begin-object`,
`end-object`, `begin-array`, `end-array`, `name-separator`, `value-separator`, `string`,
`minus` and `int` are [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)'s. `ALPHA` and
`DIGIT` are RFC 5234's, and `total-value` is [ontos-total-json §3](ontos-total-json.md#3-grammar)'s.
Every literal character is written as `%x` so that matching is case-sensitive. A prose value
`<a string whose decoded content …>` stands for any RFC 8259 `string` whose content after
escape decoding matches, as in the total profile.

```abnf
readable-text  = ws r-value ws

r-value        = %x6E.75.6C.6C                  ; null
               / %x74.72.75.65                  ; true
               / %x66.61.6C.73.65               ; false
               / string
               / safe-integer
               / r-array
               / r-object
               / envelope

safe-integer   = [ minus ] int
                 ; no fraction, no exponent; magnitude at most 9007199254740991

r-array        = begin-array [ r-value *( value-separator r-value ) ] end-array

r-object       = begin-object [ r-member *( value-separator r-member ) ] end-object
r-member       = plain-name name-separator r-value
plain-name     = <a string whose decoded content is not "$ontos">

envelope       = begin-object ontos-name name-separator tag end-object
ontos-name     = <a string whose decoded content is "$ontos">

tag            = bytes-tag / int-tag / decimal-tag / map-tag
               / set-tag / compound-tag / raw-tag

bytes-tag      = begin-array name-bytes value-separator b64-string end-array
int-tag        = begin-array name-int value-separator int-string end-array
decimal-tag    = begin-array name-decimal value-separator int-string
                 value-separator int-string end-array
                 ; the pair is a canonical decimal (section 4.6)
map-tag        = begin-array name-map value-separator
                 begin-array [ map-entry *( value-separator map-entry ) ] end-array
                 end-array
                 ; no two keys denote the same value
map-entry      = begin-array r-value value-separator r-value end-array
set-tag        = begin-array name-set value-separator
                 begin-array [ r-value *( value-separator r-value ) ] end-array
                 end-array
                 ; no two elements denote the same value
compound-tag   = begin-array name-compound value-separator label value-separator
                 begin-array [ r-value *( value-separator r-value ) ] end-array
                 end-array
label          = string
               / begin-array name-bytes value-separator b64-string end-array
raw-tag        = begin-array name-raw value-separator total-value end-array

name-bytes     = <a string whose decoded content is "bytes">
name-int       = <a string whose decoded content is "int">
name-decimal   = <a string whose decoded content is "decimal">
name-map       = <a string whose decoded content is "map">
name-set       = <a string whose decoded content is "set">
name-compound  = <a string whose decoded content is "compound">
name-raw       = <a string whose decoded content is "raw">

int-string     = <a string whose decoded content matches int-text>
int-text       = %x30 / [ %x2D ] %x31-39 *DIGIT          ; 0, or no leading zero and no -0

b64-string     = <a string whose decoded content matches b64-content>
b64-content    = *( 4b64-char ) [ b64-final ]
b64-final      = b64-char b64-z4 %x3D.3D                 ; one byte, low four bits zero
               / 2b64-char b64-z2 %x3D                   ; two bytes, low two bits zero
b64-char       = ALPHA / DIGIT / %x2B / %x2F             ; A-Z a-z 0-9 + /
b64-z4         = %x41 / %x51 / %x67 / %x77               ; A Q g w
b64-z2         = %x41 / %x45 / %x49 / %x4D / %x51 / %x55 / %x59 / %x63
               / %x67 / %x6B / %x6F / %x73 / %x77 / %x30 / %x34 / %x38
                                                         ; A E I M Q U Y c g k o s w 0 4 8
```

## 4. Reading

### 4.1 Stages

A reader runs the four stages of [ontos-total-json §4.1](ontos-total-json.md#41-four-stages-in-order),
in order. Stages 1 to 3 (size, UTF-8, the strict JSON reading) are exactly the total
profile's, with this profile's default `max_json_depth` (§9). Stage 4 interprets the JSON tree
as below: the root at value depth 0 and path `[]`, every node checked in the order given, the
first failing check being the refusal. "At `x`" means the refusal's path and span are those of
node `x`.

After a node's own checks pass, its **limit checks** run (§4.9). Then its children are
interpreted in document order, each subtree completing before the next begins.

### 4.2 Plain JSON

| node | value | checks, in order |
|---|---|---|
| `null` | `null()` | limits |
| `true`, `false` | `bool` true, false | limits |
| string | `utf8-text` of its decoded content | limits |
| number | `int` (§4.5) | `invalid_number` at the node if the lexeme has a fraction or an exponent; `unsafe_integer_literal` at the node if the integer is outside the window; limits |
| array | `list` of the elements' values, in order | limits; element `i` at value depth `d + 1`, path `P + [i]` |
| object with no member named `$ontos` | `map` from each member name, as `utf8-text`, to its value | limits; each member value, in source order, at value depth `d + 2`, path `P + [name]` |
| object with a member named `$ontos` | the envelope (§4.3) | |

A string's decoded content is a sequence of Unicode scalar values by stage 3, so every string
and member name is a well-formed `utf8-text`. Stage 3 has already refused repeated member names,
so an object's keys are distinct. Its entries are sorted by codec order (§4.8) whatever their
source order.

### 4.3 The envelope and the `$ontos` reservation

The member name `$ontos` is reserved, and only it: `$bytes`, `$undefined` and every other name
that starts with `$` are ordinary keys. Names are compared after escape decoding, so
`"\u0024ontos"` is the reserved name. An object that contains the reserved name is an envelope
and nothing else. A malformed envelope is refused. It never falls back to being read as a map.

An object `x` at value depth `d` and path `P` that has a member named `$ontos` is checked:

1. `x` has exactly one member, else `invalid_envelope` at `x`.
2. The member's value `y` (path `P + ["$ontos"]`) is an array, else `invalid_envelope` at `y`.
3. `y` is not empty, else `invalid_envelope` at `y`.
4. `y[0]` is a string, else `invalid_envelope` at `y[0]`.
5. The decoded content of `y[0]` is one of `bytes`, `int`, `decimal`, `map`, `set`,
   `compound` and `raw`, else `unknown_tag` at `y[0]`. Tag names are compared after escape
   decoding and are case-sensitive.
6. The tag's own checks (§4.4). `y[i]` has path `P + ["$ontos", i]`, and a tag's *arity* is
   the length of `y`, its name included.

A map whose keys include the text `$ontos` is written with the `map` tag, so the reservation
needs no second escaping language. The map from the text `$ontos` to `null()` is
`{"$ontos":["map",[["$ontos",null]]]}`.

### 4.4 The seven tags

| tag | arity | checks after arity, in order | value |
|---|---|---|---|
| `bytes` | 2 | `y[1]` is a string, else `invalid_tag` at `y[1]`; its content is canonical base64 (§4.7), else `invalid_base64` at `y[1]`; limits | `Atom` of the decoded bytes |
| `int` | 2 | `y[1]` is a string, else `invalid_tag` at `y[1]`; its content matches `int-text`, else `invalid_integer` at `y[1]`; limits | `int` of that integer, at any magnitude |
| `decimal` | 3 | for `i` = 1, then 2: `y[i]` is a string, else `invalid_tag` at `y[i]`, and its content matches `int-text`, else `invalid_integer` at `y[i]`; then the pair is canonical (§4.6), else `noncanonical_decimal` at the offending component; limits | `decimal(int m, int e)` |
| `map` | 2 | `y[1]` is an array, else `invalid_tag` at `y[1]`; every entry `y[1][j]` is an array of exactly two elements, else `invalid_tag` at that entry; limits; then for each entry `j` in source order: the key at value depth `d + 2` and path `P + ["$ontos", 1, j, 0]`, then `duplicate_map_key` at the key if it equals an earlier key, then the value at value depth `d + 2` and path `P + ["$ontos", 1, j, 1]` | `map` of the entries, sorted by codec order of the keys |
| `set` | 2 | `y[1]` is an array, else `invalid_tag` at `y[1]`; limits; then for each element `j` in source order: the element at value depth `d + 1` and path `P + ["$ontos", 1, j]`, then `duplicate_set_element` at it if it equals an earlier element | `set` of the elements, sorted by codec order |
| `compound` | 3 | the label `y[1]` (below); `y[2]` is an array, else `invalid_tag` at `y[2]`; limits; then each argument `y[2][i]` in order, at value depth `d + 1` and path `P + ["$ontos", 2, i]` | `Tuple(Atom(label), arguments…)` |
| `raw` | 2 | `y[1]` is interpreted as [ontos-total-json §4.4](ontos-total-json.md#44-interpretation-as-a-total-form-value) does, at value depth `d` and path `P + ["$ontos", 1]`, with its codes (`invalid_total_form`, `invalid_hex`) and limit checks | the total-form value |

A wrong arity is `invalid_tag` at `y`, checked before anything else of the tag.

**Labels.** A compound's label `y[1]` is either a string, whose decoded content's UTF-8 bytes
are the label, or an array `["bytes", B64]` whose decoded base64 is the label. It is checked in
this order. If `y[1]` is a string, the label is its UTF-8. Otherwise `y[1]` is an array of exactly
two elements, else `invalid_tag` at `y[1]`. `y[1][0]` is a string whose decoded content is
`bytes`, else `invalid_tag` at `y[1][0]`. `y[1][1]` is a string, else `invalid_tag` at
`y[1][1]`. Its content is canonical base64, else `invalid_base64` at `y[1][1]`. The label
array is not an envelope, and nothing else may stand in the label position.

**Equality is ground-value equality.** A duplicate key or element is one whose value equals an
earlier one's as a ground value ([ontos-core §3](ontos-core.md#3-identity--when-two-values-are-the-same)),
whatever its spelling. `1` and `{"$ontos":["int","1"]}` are the same key, and so are `"a"` and
`{"$ontos":["raw",{"tuple":[{"atom":"757466382d74657874"},{"atom":"61"}]}]}`. Two values
are equal exactly when their codec encodings are equal, so a face may compare encodings. It MUST
NOT use a host equality that differs, such as JavaScript's `===` on objects or a host map's
key coercion. Keys such as `__proto__` and `constructor` are data.

**Duplicates are refused, never merged.** A repeated key is not last-wins, not first-wins and
not merged (ontos-data §5.7). A repeated set element is not deduplicated (§5.8).

**Sorting applies only where the syntax asks for a canonical map or set.** A `compound` or
`raw` spelling keeps its children in source order. `{"$ontos":["compound","map",[…]]}` with
unsorted entries is a valid tuple that is not a canonical map, and it is preserved as written.

### 4.5 Integers

**The window.** A bare integer literal denotes an `int` only within
`−(2⁵³ − 1) ≤ n ≤ 2⁵³ − 1`, that is, within ±9007199254740991. A literal outside the window is
refused with `unsafe_integer_literal`, even though this reader could read it exactly. Command
output written in this profile is read downstream by ordinary JSON decoders, and many of them
round integers outside this window silently, the interval in which RFC 8259 §6 says
implementations agree. A writer therefore never emits such a literal, and a reader refuses one,
so that no such text is accepted from anyone. This deliberately diverges from
`ontos-data-json/1`, which reads integer literals of any size (0010, row 6).

**The `int` tag** carries any integer as canonical decimal text (`int-text`: `0`, or an optional
`-` and a non-zero digit followed by digits). `"+1"`, `"01"`, `"-0"`, `""` and `" 1"` are
refused with `invalid_integer`. A tagged integer inside the window is accepted and written back
bare (normalization `tagged-small-int`), so a producer may tag every integer.

**Negative zero.** The bare literal `-0` reads as `int(0)` and is written `0` (normalization
`negative-zero`). RFC 8259 permits the literal, and an integer has no negative zero
(ontos-data §5.1). `ontos-data-json/1` reads `-0` the same way.

**Number syntax** is judged by form, never by evaluation: `1.0`, `1e0` and `1E+2` are refused
with `invalid_number`, though each denotes a whole number.

**No integer passes through a bounded host type.** A reader converts decimal text to the
sign-magnitude bytes of ontos-data §5.1, and a writer converts back, at any magnitude, subject
only to `max_integer_digits` (§9). In particular Rust MUST NOT route an integer through `i128`.
An integer with more digits than that bound is a `limit_exceeded` refusal with kind
`integer_digits`, in every face alike. It is never written another way.

### 4.6 Decimals

`{"$ontos":["decimal","m","e"]}` carries the two components of `decimal(int m, int e)` (the
value `m·10ᵉ`, ontos-data §5.9) as canonical integer text. The pair must be the canonical
decimal:

- zero is exactly `"0","0"`, and `"0"` with any other exponent is refused with
  `noncanonical_decimal` at the exponent;
- a non-zero mantissa does not end in the digit `0`, else `noncanonical_decimal` at the
  mantissa. `["decimal","100","0"]` is refused, and the decimal 100 is `["decimal","1","2"]`.

Both rules are decided on the text, without arithmetic. A reader never expands `m·10ᵉ`, so an
exponent of any size stays an integer component. `{"$ontos":["decimal","1","0"]}` and `1` are
distinct values, a decimal and an integer. A decimal entry field that accepts `100.0` belongs
to a binding, which builds the canonical decimal before writing it.

### 4.7 Base64

Bytes are written in canonical base64: the standard alphabet of
[RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648#section-4) (`A`–`Z`, `a`–`z`, `0`–`9`,
`+`, `/`), padded with `=` to a multiple of four characters, with no line breaks or other
characters, and with the unused bits of the last character zero (RFC 4648 §3.5). Equivalently,
a string is canonical exactly when decoding it and encoding the result reproduces the string.
The empty string is the empty byte string. `"AB=="` is refused because its pad bits are not zero
(`"AA=="` is the byte `00`). `"AA"` lacks padding, `"AA==\n"` has a line break, and `"-_8="` uses
the URL alphabet: all three are refused with `invalid_base64`.

Bytes are base64 here and hexadecimal in the total form. Hexadecimal stays available through the
`raw` arm and the total profile for exact inspection.

### 4.8 Maps and sets: codec order

Maps and sets are written, and read back, in **codec order**: entries ordered by the
`ontos-codec-v1` encoding of their keys, and elements by their own encoding, compared as
unsigned bytes ([ontos-codec §6](ontos-codec.md#6-the-canonical-total-order-over-values-unblocks-map)).
This is the order of the value itself (ontos-data §5.7, §5.8), and the only total order ontos
defines over arbitrary keys (0010, row 9). A reader accepts any source order, then sorts.

For an object, every key is `utf8-text`, whose encoding is a fixed prefix followed by
`uvarint(len) ‖ bytes`. So members are ordered by the uvarint of their byte length, then by
their bytes:

- below 128 bytes, a shorter key comes first, and keys of equal length compare bytewise:
  `{"b":…,"aa":…}`, and `"Z"` before `"a"`;
- from 128 bytes on, the uvarint is not in numeric order: a key of 256 bytes (uvarint `80 02`)
  comes before a key of 129 bytes (`81 01`).

A face sorts by encoding, never by string comparison or length alone. It emits members in that
order directly, never through a host map or object whose iteration order it does not control.

### 4.9 Limit checks at each node

Every node of the JSON tree accounts for some nodes of the value: its **contribution**, the
atoms and tuples it produces itself, not counting those its child JSON nodes produce. A
string at value depth `d` contributes the tuple `utf8-text(…)` at depth `d` and its two atoms at
depth `d + 1`. An object contributes the map tuple, its label atom, one entry tuple per member,
and each member's key text (a tuple and two atoms, at depths `d + 2` and `d + 3`), while the
member values are its children. An envelope contributes all of its tag's value except what its
value positions produce (the keys and values of `map`, the elements of `set`, the arguments of
`compound`, the subtree of `raw`): the atom for `bytes`, the whole value for `int` and
`decimal`, the map tuple, its label atom and the entry tuples for `map`, the tuple and its label
atom for `set` and `compound`, and nothing for `raw`.

After a node's own checks, its contribution is checked against the value-side bounds in this
order, and the first exceeded bound is the refusal, `limit_exceeded` at the node:

1. `decode_depth`: a contributed value lies deeper than `max_value_depth`;
2. `tuple_arity`: a contributed tuple has more children than `max_tuple_arity`;
3. `integer_digits`: an integer the node carries (a literal, an `int` tag, a decimal
   component) has more decimal digits in its magnitude than `max_integer_digits`. This check
   comes before the integer is converted;
4. `atom_bytes`: a contributed atom is longer than `max_atom_bytes`, label atoms included.

The total-form nodes inside `raw` contribute their atom or tuple, as in the total profile.

## 5. Writing: deterministic emission

The writer emits the preferred spelling of §2 as UTF-8 bytes:

- no byte order mark, no whitespace between tokens and no trailing newline;
- the envelope exactly as `{"$ontos":[` tag-name `,` payload… `]}`, with tag names unescaped;
- integers in canonical decimal: `0`, or an optional `-` and digits without a leading zero;
- bytes in canonical base64, and atoms inside `raw` in lowercase hexadecimal;
- object members, map entries and set elements in codec order (§4.8);
- list elements, compound arguments and raw tuple children in order.

**Strings** (values, member names and labels) escape exactly these characters:

| character | written |
|---|---|
| `"` U+0022 | `\"` |
| `\` U+005C | `\\` |
| U+0008, U+0009, U+000A, U+000C, U+000D | `\b`, `\t`, `\n`, `\f`, `\r` |
| any other U+0000 to U+001F | `\u00xx`, lowercase hexadecimal |

Every other scalar value is written as itself, including `/`, U+007F, U+2028, U+2029 and all
non-ASCII characters. This is the string serialization of ECMAScript's `JSON.stringify` for
well-formed strings and of [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) §3.2.2.2. It
keeps the short escapes a reader expects to see and adds no policy of ontos's own. No Unicode
normalization is applied.

A line-oriented tool frames each value outside the writer, and a pretty-printer may add
whitespace. The reader accepts either output as the same value.

## 6. Named normalizations

Every source distinction that the reader accepts and the writer does not reproduce is named
here. Every other distinction is refused. Nothing is collapsed silently.

| source distinction | rule | name or refusal |
|---|---|---|
| space, tab, line feed and carriage return between tokens | accepted, never emitted | `json-whitespace` |
| any other whitespace outside strings | refused | `invalid_json` |
| a byte order mark | refused | `byte_order_mark` |
| a string spelled with escapes, including member names, `$ontos` and tag names | accepted, written with the escaping of §5 | `string-escapes` |
| strings that differ only by Unicode normalization | preserved as distinct; nothing is normalized | none |
| object member order | accepted in any order, written in codec order | `member-order` |
| entry order in a `map` tag, element order in a `set` tag | sorted into codec order | `entry-order` |
| list elements, compound arguments, raw tuple children | order preserved | none |
| the bare literal `-0` | read as `int(0)`, written `0` | `negative-zero` |
| an `int` tag inside the window | accepted, written bare | `tagged-small-int` |
| a `map` tag whose keys are all text and none is `$ontos` | accepted, written as an object | `text-keyed-map` |
| a `raw` or `compound` spelling of a value that has another preferred spelling | accepted, written in its preferred spelling | `preferred-spelling` |
| a compound label spelled `["bytes", …]` whose bytes are well-formed UTF-8 | accepted, written as a string | `utf8-label` |
| a fraction or an exponent | refused | `invalid_number` |
| a bare integer outside the window | refused | `unsafe_integer_literal` |
| integer text with `+`, a leading zero, `-0`, or anything but digits | refused | `invalid_integer` |
| decimal components that are not the canonical pair | refused | `noncanonical_decimal` |
| base64 that is not canonical | refused | `invalid_base64` |
| hexadecimal inside `raw` that is not even-length lowercase | refused | `invalid_hex` |
| a repeated member name, compared after escape decoding | refused | `duplicate_member` |
| a repeated key in a `map` tag or element in a `set` tag, by ground-value equality | refused | `duplicate_map_key`, `duplicate_set_element` |
| an object that has `$ontos` and anything else, or a malformed envelope | refused | `invalid_envelope` |
| a tag name outside the seven | refused | `unknown_tag` |
| a tag with the wrong arity or a payload of the wrong JSON kind | refused | `invalid_tag` |
| comments, a second value, anything after the value | refused | `trailing_data` or `invalid_json` |
| ill-formed UTF-8, an escape naming a lone surrogate | refused | `invalid_utf8`, `invalid_unicode_escape` |

## 7. Laws

The laws of [ontos-total-json §7](ontos-total-json.md#7-laws) hold for this profile's `R`, `W`
and accepted language: `R(W(v)) = v` for every value, `W(R(j)) = j` on the writer's image, and
`N = W ∘ R` is idempotent and keeps the value. Here `N` applies exactly the normalizations of
§6. Origins (§10.2) are not part of the value, and no law mentions them.

## 8. Refusals

The refusal record, paths and spans are those of
[ontos-total-json §8](ontos-total-json.md#8-refusals), with `profile` set to
`ontos-readable-json/1`. As there, the refusal is determined by the input and the limits, and
every face reports the same code, path, span and kind. Stages 1 to 3 use the shared codes, the
`raw` arm uses the total profile's, and stage 4 adds these:

| code | when |
|---|---|
| `invalid_number` | a number literal has a fraction or an exponent |
| `unsafe_integer_literal` | a bare integer literal lies outside ±(2⁵³ − 1) |
| `invalid_envelope` | an object with a member named `$ontos` has another member, or the member's value is not a non-empty array that starts with a string |
| `unknown_tag` | the tag name is not one of the seven |
| `invalid_tag` | a tag has the wrong arity, or a payload element or label is of the wrong JSON kind |
| `invalid_integer` | an integer string is not canonical decimal text |
| `noncanonical_decimal` | decimal components are canonical integers but not the canonical pair |
| `invalid_base64` | a base64 string is not canonical padded standard base64 |
| `duplicate_map_key` | a `map` tag repeats a key, by ground-value equality; the refusal names the second occurrence |
| `duplicate_set_element` | a `set` tag repeats an element, by ground-value equality; the refusal names the second occurrence |

The total-form codes inside `raw` are `invalid_total_form` and `invalid_hex`.

## 9. Limits

The bounds, their kinds and their meaning are
[ontos-total-json §9](ontos-total-json.md#9-limits)'s, with one more bound:

| bound | kind | counts | source of the kind |
|---|---|---|---|
| `max_integer_digits` | `integer_digits` | the decimal digits of an integer's magnitude: a literal, an `int` tag, a decimal component, and every integer the writer would spell in decimal | new for the projection |

**JSON depth against value depth.** An envelope adds JSON levels that are not value levels. A
`set` or `compound` tag takes three JSON levels per value level (the object, the tag array, the
payload array). A `raw` tag takes two levels, plus the total form's two per tuple. A list takes
one level per value level, and an object one per two. Over every arm, an accepted text whose
value has depth `h` has a JSON depth of at most `3·h + 4`. The bound is reached by a chain of
compounds around a raw empty tuple:

```text
JSON depth of any accepted text  ≤  3·h + 4,   h = value depth of the value it denotes
```

Unlike the total form, a deep value can have a shallow spelling: 1025 nested lists have JSON
depth 1025. So both bounds can refuse under the defaults, `json_depth` in stage 3 and
`decode_depth` in stage 4.

**The shipped defaults**, exact and the same in every face:

| bound | default |
|---|---|
| `max_text_bytes` | unbounded |
| `max_json_depth` | **3076** = 3·1024 + 4 |
| `max_value_depth` | **1024** |
| `max_atom_bytes` | unbounded |
| `max_tuple_arity` | unbounded |
| `max_integer_digits` | **4300** |

- `max_json_depth = 3076` is the deepest spelling of a value within depth 1024. Under the
  defaults, `json_depth` never refuses a text whose value is within `max_value_depth`, and it
  stops any deeper chain of envelopes before stage 4.
- `max_integer_digits = 4300` bounds the work of converting between decimal and binary, which
  is quadratic in the digit count for the simple algorithms some faces need (Rust has no
  standard big integer). With this bound, the work for a whole input stays proportional to its
  length times the bound. 4300 is the limit CPython has applied to `int`/`str` conversion since
  3.11 (CVE-2020-10735), so the Python face reads within it with the standard conversions. It
  covers every magnitude below 10⁴³⁰⁰, about 14,000 bits. A writer refuses to spell a larger
  integer in decimal under the defaults, with kind `integer_digits`. The caller may raise the
  bound, or use the total profile, which spells integers' bytes in hexadecimal.

The writer checks the same bounds, and the operational round trip of total §9.3 holds: what a
writer emits under limits `L` is read back under `L`.

## 10. API in each face

### 10.1 Reading and writing

The API is [ontos-total-json §10](ontos-total-json.md#10-api-in-each-face)'s, with the same
names, in the readable module: Go package `github.com/bitspark/ontos/projection/json/go/readable`,
Rust `ontos_json::readable`, TypeScript `@bitspark/ontos-json/readable`, and Python
`ontos_json.readable`. The `Limits` record carries `max_integer_digits` for both profiles, and
the total profile never reports it. The host-string readers check surrogates as the total
profile's do.

### 10.2 Origins

An optional reader returns the value together with **origins**, which map each node of the value
back to the source text (0010, row 15). A consumer that rejects a value later can then point at
what the person typed: horos reporting a value path, or a binding's domain check. Origins are
metadata. They are not part of the value, its identity or its encoding.

| face | call | result |
|---|---|---|
| Go | `readable.ParseUTF8WithOrigins(input []byte, limits Limits) (Parsed, error)` | `Parsed{Value core.Value; Origins Origins}` |
| Rust | `ontos_json::readable::parse_utf8_with_origins(input: &[u8], limits: &Limits) -> Result<Parsed, Error>` | `Parsed { value, origins }` |
| TypeScript | `parseUtf8WithOrigins(input: Uint8Array, limits?: Partial<Limits>): Parsed` | `{ value, origins }` |
| Python | `parse_utf8_with_origins(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> Parsed` | a named tuple `Parsed(value, origins)` |

A **value path** addresses a node of the value by tuple child indices from the root: `[]` is the
root, and `[2, 1]` is child 1 of child 2. It addresses the L0 tree, so it is defined for every
value and needs no recognition. After sorting, a map entry's index is its position in codec
order: the value path of the second entry's value in a map is `[2, 1]`, wherever that entry stood
in the source. A face may also offer paths in terms of embeddings, derived from these.

`Origins` gives, for every node of the value (every atom and tuple of the expanded tree), the
**origin**: the JSON path (§8) and the span of the source that produced it. A face offers a
lookup by value path and an enumeration in pre-order of the value. The JSON node that produces
each value node is:

| source node | the value nodes whose origin it is |
|---|---|
| string, number, literal | the whole value it denotes: the tuple and its atoms |
| array | the list tuple and its label atom; element `i` is the origin of child `i + 1` |
| object | the map tuple and its label atom. Each **member** (span from the start of its name to the end of its value, path `P + [name]`) is the origin of its entry tuple. The member's **name** token (its span, path `P + [name]`) is the origin of the key tuple and its two atoms. The member value is the origin of the entry's value |
| envelope with `bytes`, `int` or `decimal` | the whole value it denotes |
| envelope with `map` | the map tuple and its label atom; each entry array `[k, v]` is the origin of its entry tuple, `k` of the key and `v` of the value |
| envelope with `set` | the set tuple and its label atom; each element node is the origin of its element |
| envelope with `compound` | the compound tuple and its label atom; each argument node is the origin of its argument |
| envelope with `raw` | nothing itself: each total-form object inside is the origin of the atom or tuple it spells |

The vectors pin origins for several cases, among them a map whose entries move when sorted.

## 11. The common subset with `ontos-data-json/1`

[`ontos-data-json/1`](ontos-data-json.md) reads domain JSON into `ontos/data` values and stays
as it is (0010, row 21). Its readings do not change. Its arms coincide with this profile's plain
spellings: an object is a `map` with text keys, an array a `list`, a string `utf8-text`, an
integer literal `int`, `true` and `false` `bool`, and `null` `null()`. The two differ in what
they accept and in one reading:

| JSON text | `ontos-total-json/1` | `ontos-data-json/1` | `ontos-readable-json/1` |
|---|---|---|---|
| `{"atom":"00"}` | `Atom(0x00)` | map `{"atom" → "00"}` | map `{"atom" → "00"}` |
| `257` | refused (`invalid_total_form`) | `int(257)` | `int(257)` |
| `9007199254740993` | refused | `int(9007199254740993)` | refused (`unsafe_integer_literal`) |
| `{"$ontos":["bytes","AA=="]}` | refused | map `{"$ontos" → list("bytes", "AA==")}` | `Atom(0x00)` |
| `{"a":1,"a":2}` | refused (`duplicate_member`) | map `{"a" → 2}` (last wins; strict mode refuses) | refused (`duplicate_member`) |
| `1.5` | refused | refused (reserved decimal arm) | refused (`invalid_number`) |
| `-0` | refused | `int(0)` | `int(0)` |
| `{"$bytes":"AA=="}` | refused | map `{"$bytes" → "AA=="}` | the same map |
| `"\ud800"` | refused | refused | refused (`invalid_unicode_escape`) |

From the arms, two statements follow:

1. **Shared texts read alike, except for envelopes.** If both `ontos-data-json/1` and this
   profile accept a text, and no object in it has a member named `$ontos`, both read the same
   value, and so the same codec bytes. Texts accepted by both contain no repeated member and no
   integer outside the window, because this profile refuses those. Only `$ontos` objects remain,
   and those this profile reads as envelopes.
2. **Plain output is domain JSON.** If the readable spelling of a value contains no envelope,
   `ontos-data-json/1` reads that spelling back as the same value, within its own depth limits.
   This holds for every value built from `null()`, `bool`, `utf8-text`, `int`s in the window,
   `list`s, and maps whose keys are text other than `$ontos`.

A consumer still names the profile it reads. The table shows why no reader can detect it:
`{"atom":"00"}` has a different reading under each of the three.

## 12. Conformance vectors

[`projection/json/vectors/readable.json`](../../projection/json/vectors/readable.json) pins this
profile, in the format of the [vectors README](../../projection/json/vectors/README.md). Each case
pins its input as hex of the exact bytes and, independently, the `ontos-codec-v1` bytes of the
value read, the preferred output, or the refusal's code, path, span and kind, together with any
non-default limits. Some cases also pin origins. A face conforms when it agrees with every
case. [`tools/json-projection/check.mjs`](../../tools/json-projection/check.mjs) checks every
vector against this page with its own reader and writer, and `scripts/check.sh vectors` runs it.
The cases cover the advice's closing suite: the distinct empty values, collisions with the
reserved name, integers around 2⁵³ and beyond `i128`, large decimal exponents, escaped duplicate
names and duplicate decoded keys, malformed registered-label tuples, unknown and non-UTF-8 labels,
invalid Unicode and non-canonical encodings, trailing data, and JSON depth against value depth.
A round trip through a real binding is the bindings' to test.
