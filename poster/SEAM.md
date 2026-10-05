# SEAM.md — ontos's public surface, with evidence

Extracted from source for `poster/index.html`. Every claim carries a `path:line`
citation into this tree. Nothing appears on the poster without one.

**Extraction run: 2026-10-05**, public repository `github.com/Bitspark/ontos`, at commit
`5482386` (release `v0.14.0` is `a44df59`; the two commits after it, a CI actions bump and a
`cli/ts` tsconfig fix, change no fact below). Specifications, vectors and the conformance
harness are byte-identical to the `v0.13.0` publication commit `ecd09be`; only manifests,
`docs/distribution.md`, the README install block and `projection/deixis/` moved.

How the facts were checked, rather than read:

- **The CLI** was built from this tree (`go build -o ontos-go.exe ./cli/go/cmd/ontos`), and
  every byte string and transcript below was produced by running it.
- **Cross-implementation identity** was checked by running the differential harness over the
  Go build and the Python lane (`node tools/conformance/run.mjs --impl go=… --impl py="python
  cli/py/main.py" --decode-roundtrip --from-json-roundtrip --human-roundtrip`), exit `0`:
  *"44 hexes x 5 commands x 2 impls + human: 44 hexes x 13 commands x 2 impls + from-json: 44
  encode cases x 2 impls (author->bytes) (go, py) — all byte-identical and every emit == pinned
  hex"*. The Rust and TypeScript CLIs were **not** built locally (the host disk was at its
  floor); their parity rests on the spec and CI, cited in §5.
- **Attachment** was checked as an anonymous consumer: empty projects outside the repo, no
  user registry configuration, no Go env file (`GOENV=off`), installing 0.14.0 from npmjs,
  crates.io and `proxy.golang.org` (with `sum.golang.org`). Each lane's program printed
  `01020003696e74000100` (§6). The deixis bridge was installed and round-tripped the same way
  in all three languages.
- **Registries** were queried directly on 2026-10-05: npmjs `dist-tags.latest` = `0.14.0` for
  all five `@bitspark/ontos-*` packages; crates.io `max_version` = `0.14.0` for all five
  `bitspark-ontos-*` crates; the Go proxy lists `v0.13.0 v0.14.0` for both modules.

---

## 0. What kind of repo this is

**All four categories at once, and that is the point.** ontos ships:

- a **normative specification** that decides: "When code and specification disagree, the
  specification is right until a pull request changes it" — `CONTRIBUTING.md:59-63`;
- **libraries** in Go / Rust / TypeScript on the public registries, with no credential needed —
  `docs/distribution.md:3-13`;
- an **executable**, `ontos`, deliberately *not* published — `docs/spec/ontos-cli.md:33-43`;
- a **multi-language surface** with **four implementations and no reference one** —
  `README.md:81-87`, `docs/spec/ontos-conformance.md:26-32`.

The unifying fact: the seam is neither an API nor a binary. **The seam is a byte string.** Two
tags. Everything else is four independent ways of arriving at the same bytes.

The plain-language thesis, in the README's own words: ontos "says only one thing, and says it
the same way everywhere: here is a thing, and here is the kind of thing it is" —
`README.md:21-23`; "the one model they all share, so that crossing from one system to another
is not a conversion but an identity" — `README.md:35-37`.

---

## 1. The frozen floor — `ontos/core` (L0)

### The value set

```text
Atom(b)              ∈ V    for every finite byte string b
Tuple(v₀, …, vₙ₋₁)   ∈ V    for every finite n ≥ 0 and all vᵢ ∈ V
```

— `docs/spec/ontos-core.md:24-27`. `V` is the initial algebra `μX. Bytes + List(X)`
(`docs/spec/ontos-core.md:29-30`).

- **Exactly two constructors. No third kind of value** — "no nil, no variable, no number, no
  string, no map, no reference, no label slot" — `docs/spec/ontos-core.md:39-43`.
- Atom bytes are **uninterpreted**: "not text, not a number, not a hash, not a key" —
  `docs/spec/ontos-core.md:32-34`.
- Tuple order and arity are **part of the value**; no flattening, sorting, or de-duplication —
  `docs/spec/ontos-core.md:35-37`.
- Notation is not the model: "the model is the abstract tree, not any spelling of it" —
  `docs/spec/ontos-core.md:56-57`.

### Intrinsic properties

Finite · well-founded (a finite tree, never cyclic) · immutable · closed / context-free (no
address, owner, time, provenance) · complete / ground (no holes) —
`docs/spec/ontos-core.md:63-81`.

### Identity — structural, the keystone invariant

```text
Atom(b) = Atom(c)   iff b and c are the same finite byte string (octet-for-octet).
Tuple(x₀…xₘ₋₁) = Tuple(y₀…yₙ₋₁)   iff m = n and xᵢ = yᵢ for every i.
Atom(_) ≠ Tuple(_)  always — the two constructors are disjoint.
```

— `docs/spec/ontos-core.md:91-100`.

- `Atom("") ≠ Tuple()`; neither is "null" — `docs/spec/ontos-core.md:104-105`.
- **No object identity, no hidden identity bit** — `docs/spec/ontos-core.md:113-116`.
- Every higher layer "inherits it unchanged and MUST NOT redefine it" —
  `docs/spec/ontos-core.md:85-87`.
- The floor is frozen: "New capability is added *above* L0 … never *to* L0" —
  `docs/spec/ontos-core.md:222-226`.

### The L0 API, per language

| | Go (`core/go/value.go`) | Rust (`core/rs/src/lib.rs`) | TypeScript (`core/ts/src/index.ts`) |
|---|---|---|---|
| construct | `NewAtom` `:76`, `NewTuple` `:91` | `Value::atom` `:84`, `Value::tuple` `:89` | `atom()` `:132`, `tuple()` `:136` |
| atom bytes / len | `Atom.Bytes()` `:103`, `Atom.Len()` `:110` | `Atom::bytes` `:131`, `Atom::len` `:135` | `Atom#bytes()` `:66`, `#length` `:61` |
| children / arity / index | `Tuple.Items()` `:113`, `.Len()` `:120`, `.At(i)` `:123` | `Tuple::items` `:155`, `::len` `:160`, `::at` `:171` | `Tuple#items()` `:102`, `#length` `:97`, `#at()` `:106` |
| structural equality | `Equal` `:166` | `PartialEq` `:236`, `:261` | `equals()` `:144` |
| diagnostic string | `String()` `:168`, `:178` | `Display` `:457` | `toString()` `:78`, `:127` |

The naming is parallel on purpose — `core/ts/src/index.ts:13-26`. Per-language extras are
documented as intentional: TS `kind` discriminant + `toJSON`/`toHex`; Rust
`is_atom`/`is_tuple`/`as_atom`/`as_tuple` — `core/ts/src/index.ts:28-40`.

The Rust core is dependency-free: "The frozen floor depends on nothing." —
`core/rs/Cargo.toml:14-15`.

---

## 2. The canonical codec — `ontos-codec-v1` (FROZEN)

### The whole byte mapping

```text
encode(Atom(b))             = 0x00 ‖ uvarint(len(b)) ‖ b
encode(Tuple(v0 … v_{n-1})) = 0x01 ‖ uvarint(n) ‖ encode(v0) ‖ … ‖ encode(v_{n-1})
```

— `docs/spec/ontos-codec.md:48-51`. Frozen since 2026-05-31; "any change ships as a *new
version*" — `docs/spec/ontos-codec.md:10-12`.

- The codec is a **side axis**, not a layer: "It adds no values and no identity" —
  `docs/spec/ontos-codec.md:3-8`; `README.md:73`.
- **The tag set is CLOSED**: `{0x00, 0x01}`; `0x02`–`0xFF` reserved and rejected as
  `unknown_tag`; "there is no variable tag"; a consumer needing a variable "MUST NOT redefine
  `0x00` or `0x01`" — `docs/spec/ontos-codec.md:61-71`.
- Self-delimiting, therefore **prefix-free** — `docs/spec/ontos-codec.md:57-59`.
- `uvarint` = unsigned LEB128, **shortest form**; the encoding of 0 is the single byte `0x00`
  — `docs/spec/ontos-codec.md:75-79`.
- The integer domain is **pinned to u64**; a canonical uvarint is **at most 10 bytes** —
  `docs/spec/ontos-codec.md:84-91`.

### Why it is security-critical

- "**arche signs over ontos encodings** — a signed fact is an Ed25519 signature over the
  canonical bytes … If two cores encode the same value differently, a signature verifies in
  one and fails in another." "**logos hashes encodings** — proof-DAG leaf citations and clause
  identity flow through the canonical hash" — `docs/spec/ontos-codec.md:27-31`.
- Hence four-language byte-for-byte agreement is **mandatory**, and any mapping change is "a
  **breaking change for the entire stack**" — `docs/spec/ontos-codec.md:35-39`; it ships as
  `ontos-codec-v2` with a migration, "never as an edit to v1" —
  `docs/spec/ontos-codec.md:277-282`; `CONTRIBUTING.md:31-34`.
- Upgrading never changes stored bytes: "Upgrading ontos never changes the bytes of a value you
  already store, hash or sign." — `docs/distribution.md:19-22`.

### Rejection codes (normative; the message is not)

| code | when | source |
|---|---|---|
| `unexpected_eof` | input ends mid-value | `docs/spec/ontos-codec.md:114` |
| `unknown_tag` | tag byte outside `{0x00,0x01}` | `:115` |
| `non_canonical_uvarint` | uvarint not shortest-form | `:116` |
| `uvarint_overflow` | uvarint ≥ 2^64 | `:117` |
| `trailing_bytes` | bytes left after one complete value | `:118` |

"The code is **normative**; an implementation's human-readable message is not." —
`docs/spec/ontos-codec.md:120`. Plus the implementation-local `limit_exceeded` —
`docs/spec/ontos-codec.md:121-124`, which since v0.11.0 names the bound that stopped it
(`decode_depth`, `atom_bytes`, `tuple_arity`, `native_width`) —
`docs/spec/ontos-codec.md:177-198`.

**Run 2026-10-05** (`ontos decode --format json`, all exit `1`):

| input | output |
|---|---|
| `00818000` | `{"ok":false,"command":"decode","error":"non_canonical_uvarint"}` |
| `000000` | `{"ok":false,"command":"decode","error":"trailing_bytes"}` |
| `02` | `{"ok":false,"command":"decode","error":"unknown_tag"}` |
| `0005` | `{"ok":false,"command":"decode","error":"unexpected_eof"}` |
| `01ffffffffffffffffffff7f` | `{"ok":false,"command":"decode","error":"uvarint_overflow"}` |

### Canonicality obligations

Determinism · round-trip · injectivity · canonical rejection — "so that 'valid encoding' and
'canonical encoding' coincide. (This is what lets a hash/signature over the bytes stand in for
the value.)" — `docs/spec/ontos-codec.md:251-258`.

### The total order — what `map` / `set` stand on

`order(A,B)` = lexicographic comparison of the encodings; canonical + injective + prefix-free ⇒
a **total order**, identical across cores; "**not** part of L0 identity" —
`docs/spec/ontos-codec.md:262-273`.

### Resource limits

`max decode depth = 1024` in all four cores — `docs/spec/ontos-codec.md:135-137`. Host-width
uvarint ceilings differ (`2^63−1` go / `usize::MAX` rs / `2^53−1` ts / none py) —
`docs/spec/ontos-codec.md:140`; they "cannot bite an input a core can receive", so cores
"differ only on *which* rejection code fires, never on whether the input is valid" —
`docs/spec/ontos-codec.md:142-166`.

### The codec API, per language

| Go (`codec/go/codec.go`) | Rust (`codec/rs/src/lib.rs`) | TS (`codec/ts/src/index.ts`) |
|---|---|---|
| `Encode` `:99` | `encode` `:154` | `encode` `:98` |
| `Decode` `:148` | `decode` `:161` | `decode` `:157` |
| `DecodeWithLimits` `:153` | `decode_with_limits` `:166` | `decode(input, options)` `:157` + `DecodeOptions` `:36` |
| `EncodeUvarint` `:145` | `encode_uvarint` `:183` | `encodeUvarint` `:168` |
| `Limits` `:35` / `DefaultLimits` `:42` | `DecodeLimits` `:31` | `DecodeOptions` `:36` |
| `DecodeError` `:58` | `DecodeError` `:55`, `DecodeLimitKind` `:83` | `DecodeError` `:80`, `DecodeLimitKind` `:63` |

---

## 3. The registered embeddings — `ontos/data` (L2)

Eight labels: **four scalars** (`int`, `utf8-text`, `bool`, `decimal`), **three structural**
(`list`, `map`, `set`), and the **nullary no-value** `null` — `docs/spec/ontos-data.md:271-275`.
Enumerated in code: `data/go/data.go:86`, `data/rs/src/lib.rs:117`, `data/ts/src/index.ts:69`.

L2 adds **readings, never a new equality** — "An L2 embedding MUST NOT introduce any equality
of its own" — `docs/spec/ontos-data.md:93-97`; `README.md:53-58`.

| label | shape | canonical rule | source |
|---|---|---|---|
| `int` | `Tuple(Atom("int"), Atom(payload))` | sign byte (`00`+ / `01`−) then big-endian minimal magnitude; **zero is exactly `0x00`**; no negative zero; unbounded in principle | `docs/spec/ontos-data.md:297-311` |
| `utf8-text` | `Tuple(Atom("utf8-text"), Atom(utf8))` | valid UTF-8 **verbatim — no Unicode normalization** | `docs/spec/ontos-data.md:381-392` |
| `bool` | `Tuple(Atom("bool"), Atom(marker))` | single byte `00` false / `01` true; exactly two values | `docs/spec/ontos-data.md:412-419` |
| `list` | `Tuple(Atom("list"), e₀ … eₙ₋₁)` | order and multiplicity are identity; never sorted or deduplicated; **the bare unlabeled tuple is forbidden** | `docs/spec/ontos-data.md:450-475` |
| `map` | `Tuple(Atom("map"), Tuple(k,v) …)` | entries **strictly ascending by key** under the codec order | `docs/spec/ontos-data.md:504-530` |
| `set` | `Tuple(Atom("set"), e₀ … eₙ₋₁)` | strictly ascending under the codec order — order and no-duplicates in one check | `docs/spec/ontos-data.md:588-609` |
| `decimal` | `Tuple(Atom("decimal"), int(m), int(e))` | exact `m × 10^e`, not IEEE-754, not a general rational; zero is `decimal(int 0, int 0)`; non-zero mantissa not divisible by 10, so `3.14` is uniquely `decimal(int 314, int -2)` | `docs/spec/ontos-data.md:649-676` |
| `null` | `Tuple(Atom("null"))` | arity exactly 1; exactly one inhabitant, forever; no `undefined`, `nil`, `missing`, typed null | `docs/spec/ontos-data.md:745-763` |

`map` and `set` are the only **codec-version-relative** embeddings —
`docs/spec/ontos-data.md:281-286`. `null` means **present-but-no-value, not absence** —
`docs/spec/ontos-data.md:764-770`.

### Canonical encodings — run 2026-10-05 (`ontos canon --emit --from-json`)

Each hex was then fed to `ontos read --all --format json`, which recognized exactly the label in
the first column.

| value | authoring JSON in | canonical `ontos-codec-v1` hex out |
|---|---|---|
| `int(0)` | `{"tuple":[{"atom":"696e74"},{"atom":"00"}]}` | `01020003696e74000100` |
| `bool(true)` | `{"tuple":[{"atom":"626f6f6c"},{"atom":"01"}]}` | `01020004626f6f6c000101` |
| `utf8-text("hi")` | `{"tuple":[{"atom":"757466382d74657874"},{"atom":"6869"}]}` | `01020009757466382d7465787400026869` |
| `null()` | `{"tuple":[{"atom":"6e756c6c"}]}` | `010100046e756c6c` |
| `list(int 1)` | `{"tuple":[{"atom":"6c697374"},{"tuple":[{"atom":"696e74"},{"atom":"0001"}]}]}` | `010200046c69737401020003696e7400020001` |
| `decimal(314, -2)` | `{"tuple":[{"atom":"646563696d616c"},{"tuple":[{"atom":"696e74"},{"atom":"00013a"}]},{"tuple":[{"atom":"696e74"},{"atom":"0102"}]}]}` | `01030007646563696d616c01020003696e74000300013a01020003696e7400020102` |

The `int(0)` and `bool(true)` rows match the spec's own tables (`docs/spec/ontos-data.md:318`,
`:421`).

### Producer admission — the three laws

§4.1 "Producer admission — the three laws" — `docs/spec/ontos-data.md:199-237`: soundness,
fidelity, rejection completeness. For `utf8-text`, an unpaired surrogate is outside the domain
and "MUST NOT be encoded verbatim … and MUST NOT be repaired by substituting U+FFFD … which
succeeds with a *different* datum (law 2) and is undetectable once the host string is gone" —
`docs/spec/ontos-data.md:399-408`.

### The L2 API (symmetric encode / read per label)

Go `data/go/data.go`: `EncodeInt:150` `RecognizeInt:210` `ReadInt:221` · `EncodeBool:238`
`ReadBool:250` · `EncodeText:288` `ReadText:314` · `EncodeList:331` `ReadList:345` ·
`EncodeMap:381` `ReadMap:420` · `EncodeSet:476` `ReadSet:516` · `EncodeDecimal:637`
`RecognizeDecimal:649` `ReadDecimal:658` · `EncodeNull:678` `RecognizeNull:689` `ReadNull:712`.

TS `data/ts/src/index.ts`: `encodeInt:120` `recognizeInt:169` `readInt:180` · `encodeBool:189`
`readBool:198` · `encodeText:256` `readText:273` · `encodeList:291` `readList:301` ·
`encodeMap:329` `readMap:357` · `encodeSet:407` `readSet:435` · `encodeDecimal:517`
`recognizeDecimal:534` `readDecimal:544` · `encodeNull:558` `recognizeNull:570` `readNull:586`.

Rust `data/rs/src/lib.rs`: `encode_int:290` `recognize_int:344` `read_int:356` … `encode_null:792`
`recognize_null:805` `read_null:819`.

Host integer types differ and are not divergence: Go `*big.Int` (`data/go/data.go:150`), TS
`bigint` (`data/ts/src/index.ts:120`), Rust `i128` (`data/rs/src/lib.rs:290`); a canonical
`int` beyond `i128` is still recognized in every binding — `docs/spec/ontos-data.md:334-365`.

---

## 4. The `ontos` CLI — bytes in, evidence out

**Not a published package**: the TS package is `"private": true` (`cli/ts/package.json:6`), the
Rust crate is `publish = false` (`cli/rs/Cargo.toml:11`), the Go build is `go install` —
`docs/spec/ontos-cli.md:33-43`. "Nothing imports the CLI — you run it, you don't depend on it."
The command-line tools "are built from source" — `docs/releases/v0.13.0.md:36-37`.

Because `cli/go/cmd/ontos` sits inside the root module (`go.mod:1`, no nested `go.mod` under
`cli/go`), Go builds it straight from the proxy. **Run 2026-10-05**, anonymous (`GOENV=off`):

```console
$ go install github.com/bitspark/ontos/cli/go/cmd/ontos@v0.14.0
go: downloading github.com/bitspark/ontos v0.14.0
$ ontos inspect 01020003696e74000100
Tuple(Atom(0x696e74), Atom(0x00))
canonical: yes
recognized: int
```

### Invocation contract

```text
ontos <command> [--format human|json] [--from-json <json|->] [<hex>]
```

— verified from `ontos --help`; contract at `docs/spec/ontos-cli.md:56-74`.

| command | does |
|---|---|
| `ontos decode [<hex>]` | decode bytes → the L0 value tree |
| `ontos inspect [<hex>]` | decode + codec id, canonical?, value, recognized embeddings |
| `ontos read [--all\|--kind <k>] [<hex>]` | recognize registered embeddings |
| `ontos canon [--check\|--emit] [<hex>]` | is it canonical? / print canonical bytes |

— `docs/spec/ontos-cli.md:121-126`; all four commands ship in every implementation —
`docs/spec/ontos-cli.md:128-129`.

- Input: canonical bytes as positional hex, or stdin when the argument is `-` or omitted —
  `docs/spec/ontos-cli.md:62-64`.
- `--from-json` is the *only* text→bytes path, using the authoring notation `vectors/` already
  use — `docs/spec/ontos-cli.md:45-54`, `:65-67`; mutually exclusive with a positional hex,
  **including `-`** — `docs/spec/ontos-cli.md:98-101`. "never sign, hash, or exchange the JSON
  text; hash the emitted bytes" — `docs/spec/ontos-cli.md:53-54`; authoring/debugging only —
  `:113-117`. A *pleasant* text form was deliberately not invented — `:50-52`.
- **There is no `ontos hash`**: "a **canonical byte witness**, not a signing tool" —
  `docs/spec/ontos-cli.md:131-132`.

### The process touches argv, stdin, stdout, stderr — nothing else

No CLI spec line states this; it is checked against all four sources (searched 2026-10-05
for environment, file, and network access):

- Go: imports only `bytes encoding/hex encoding/json errors fmt io os strings` plus the three
  ontos packages (`cli/go/cmd/ontos/main.go:23-36`); `os` is used for `Args`, `Stdin`,
  `Stdout`, `Stderr`, `Exit` (`:73`). No `Getenv`, `Open`, `ReadFile`, `net`.
- Rust: the only `std::env` use is `std::env::args()` (`cli/rs/src/main.rs:85`); no `std::fs`,
  no `std::net`.
- TypeScript: `readFileSync` is imported (`cli/ts/src/main.ts:29`) and only ever reads fd `0`,
  stdin (`:196`, `:242`); no `process.env`, no network module.
- Python: imports `json`, `sys`, `pathlib`, `typing` and the three ontos packages
  (`cli/py/main.py:29-46`); `pathlib` only locates the sibling packages. No `os.environ`, no
  `open(`, no socket or HTTP module.

Hence Fig. 5's "no env vars · no files · no network · no state".

### Exit codes

| code | meaning | source |
|---|---|---|
| `0` | success — decoded / canonical / recognized | `docs/spec/ontos-cli.md:221` |
| `1` | a well-formed **negative** — the tool ran; the answer is "no" | `:222` |
| `2` | usage error — the tool could not run | `:223` |

**Run 2026-10-05:** `canon --check` on canonical bytes → `0`; `decode 02` → `1`;
`read --kind int --format json 010100046e756c6c` →
`{"ok":true,"command":"read","kind":"int","recognized":false}`, exit `1`; `--from-json` plus a
positional `0000` → `2`; `--from-json` plus `-` → `2`; `decode zz` → `2`.

### Both output formats are byte-pinned

JSON Lines: compact, keys in order, lowercase hex, one object per line, no free-text `message`
— `docs/spec/ontos-cli.md:175-181`. `--format human` is **also** identical across
`go · rs · ts · py`, enforced by `--human-roundtrip` — `docs/spec/ontos-cli.md:185-192`. Only
stderr is free-text — `docs/spec/ontos-cli.md:178-179`.

A recognition miss is **not an error**: no `not_recognized` code —
`docs/spec/ontos-cli.md:158-162`. Recognition is **structural, not materialization** —
`docs/spec/ontos-cli.md:164-173`.

### The worked example — run 2026-10-05

```console
$ ontos canon --emit --from-json '{"tuple":[{"atom":"696e74"},{"atom":"00"}]}'
01020003696e74000100
$ ontos inspect 01020003696e74000100
Tuple(Atom(0x696e74), Atom(0x00))
canonical: yes
recognized: int
$ ontos inspect --format json 01020003696e74000100
{"ok":true,"command":"inspect","codec":"ontos-codec-v1","canonical":true,"value":{"tuple":[{"atom":"696e74"},{"atom":"00"}]},"recognized":["int"]}
$ ontos canon --emit 01020003696e74000100 | xxd -r -p | sha256sum
0022704d463f6d3b29ce24b75b79cfa95b5ffa848560d79164cbd8a18a57a586 *-
```

The first two match `README.md:92-100` and `docs/spec/ontos-cli.md:108-111`. The `*-` is how GNU
`sha256sum` on this Windows host prints the stdin marker; the digest is the SHA-256 of the ten
octets `01 02 00 03 69 6e 74 00 01 00` (checked against `printf` of those bytes).

**Why the hash pipe has `xxd -r -p` in it.** `canon --emit` prints the canonical bytes **as
lowercase hex text plus a newline** (`docs/spec/ontos-cli.md:126`, `:204`). Piped straight into
`sha256sum` — the form the CLI spec gives at `docs/spec/ontos-cli.md:54` and `:132` — it hashes
those 21 bytes of text (digest `2cd3c476…149e0139`), not the 10 canonical octets. The tree's own
oracle uses the hex-decoding pipe: `vectors/data-json.oracle.json:8`
(`… | xxd -r -p | sha256sum`). The poster shows the oracle's form. *(Drift, recorded in §8.)*

### Cross-implementation identity, checked directly

Go build vs `python cli/py/main.py` over `01020003696e74000100`: `decode --format json`,
`inspect --format json`, `read --all --format json`, `canon --emit` and human `inspect` — stdout
**byte-identical** for all five. `read --all` answers with a `recognized` **array**;
`read --kind` with a **boolean** plus the `kind` — `docs/spec/ontos-cli.md:140-145`.

---

## 5. Four implementations, no reference one

- "The implementations are peers: none is the reference. They agree **byte for byte**" —
  `README.md:83-87`.
- The harness's subjects are four peer CLIs; "**There is no reference implementation**";
  conformance is agreement — `docs/spec/ontos-conformance.md:26-38`. Python is a stdlib-only
  validation lane, registered as a fourth `--impl` — `docs/spec/ontos-cli.md:23-31`; it is
  source-only — `docs/releases/v0.13.0.md:36`; `CONTRIBUTING.md:43-46`.
- Comparison is **byte-for-byte on stdout AND on the exit code** — `tools/conformance/run.mjs:20-27`,
  `docs/spec/ontos-conformance.md:90-98`. A new implementation "can prove its conformance by
  being added as another `--impl` here, with NO in-process test code ported" —
  `tools/conformance/run.mjs:15-18`; `docs/spec/ontos-conformance.md:80-88`.
- **Three check modes**: decode (hex → JSON Lines), `--from-json-roundtrip` (author → bytes,
  differential + oracle), `--human-roundtrip` — `tools/conformance/run.mjs:29-46`.
- A behavior change lands in every language that carries the part, "or it does not land" —
  `CONTRIBUTING.md:41-48`.

### The vectors (counts read programmatically, 2026-10-05)

| file | contents |
|---|---|
| `vectors/identity.json` | 17 L0 identity cases |
| `vectors/codec.json` | 6 uvarint · 8 encode · 10 reject; codec id `ontos-codec-v1` |
| `vectors/data.json` | 36 encode · 49 reject |
| `vectors/data.generated.json` | 14 cases, generated from `data.source.json` |
| `vectors/codec-limits.json` | 13 operational limit-reporting cases (kept apart from the byte corpus — `docs/spec/ontos-codec.md:234-236`) |
| `vectors/data-json.json` | 7 valid · 3 reject, plus a corpus |
| `vectors/data-json.oracle.json` | 202,201-byte oracle document set |
| `vectors/producer-v1/cases.json` | 12 host-value → L2 cases |

The harness corpus is the `encode` arrays of `codec.json` + `data.json` —
`docs/spec/ontos-conformance.md:116-128` — 8 + 36 = **44** byte strings, matching the harness's
own report above. Vectors are computed from the spec, never copied from an implementation —
`CONTRIBUTING.md:50-55`.

### Maturity ladder

experimental / unwitnessed → witnessed → portable → frozen —
`docs/spec/ontos-conformance.md:204-209`. Current labels —
`docs/spec/ontos-conformance.md:219-224`:

| surface | label |
|---|---|
| `ontos/core`, `ontos/codec`, `ontos/data` | **portable**, frozen where declared — four implementations, byte-identical, vector-pinned in CI |
| producer admission | **portable** — four implementations, `tools/producer-conformance` |
| `ontos-data-json/1` | **unwitnessed** — three faces, all ontos-authored; pending (`:239-240`) |
| `ontos-over-deixis-v1` | **unwitnessed, permanently** — three faces, all ontos-authored (`:241-254`; `projection/deixis/README.md:94-100`) |

### Local check targets

`scripts/check.sh` targets: `test` · `lint` · `conformance` · `producer` · `fuzz` · `vectors` ·
`all` — `scripts/check.sh:26-33`; `README.md:120-123`. `conformance` rebuilds every CLI first so
a stale binary cannot cause a false divergence — `scripts/check.sh:14-15`.

---

## 6. How a consumer attaches

**License: Apache-2.0** — `README.md:131-133`, `LICENSE:2-3`; every package manifest says so
(`Cargo.toml:7`, `core/ts/package.json:4`).

**Public registries, no credential** — `docs/distribution.md:3-4`; `README.md:107`. Every lane
carries the release number; the first public release was `v0.13.0` —
`docs/distribution.md:15-17`. The current release is `v0.14.0`, and it changes no API and no
bytes outside the projection — `docs/releases/v0.14.0.md:3-6`.

| ecosystem | coordinate | source |
|---|---|---|
| npm (npmjs, with provenance) | `@bitspark/ontos-core`, `-codec`, `-data`, `-data-json` @ `0.14.0` | `docs/distribution.md:8`; `core/ts/package.json:2-3,11-15` |
| crates.io | `bitspark-ontos-core`, `-codec`, `-data`, `-data-json` @ `0.14.0`; library names `ontos_core`, `ontos_codec`, `ontos_data`, `ontos_data_json` | `docs/distribution.md:10`; `core/rs/Cargo.toml:2-3,10-11`, `codec/rs/Cargo.toml:2,11`, `data/rs/Cargo.toml:2,11`, `data/json/rs/Cargo.toml:2,11` |
| Go module proxy | module `github.com/bitspark/ontos`, packages `core/go`, `codec/go`, `data/go`, `data/json/go`, @ `v0.14.0` | `docs/distribution.md:12`; `go.mod:1` |

The README's install block — `README.md:109-113`:

```sh
npm install @bitspark/ontos-core @bitspark/ontos-codec @bitspark/ontos-data
cargo add bitspark-ontos-core bitspark-ontos-codec bitspark-ontos-data
go get github.com/bitspark/ontos@v0.14.0
```

All three lines run 2026-10-05 in empty projects: npm `added 3 packages`, all `0.14.0` from
`registry.npmjs.org`; cargo `Adding bitspark-ontos-{core,codec,data} v0.14.0`; go
`added github.com/bitspark/ontos v0.14.0`.

**Rust manifest form**, keeping the short dependency names — `docs/distribution.md:46-57`,
`docs/releases/v0.13.0.md:19-25`:

```toml
[dependencies]
ontos-core  = { package = "bitspark-ontos-core",  version = "0.14" }
ontos-codec = { package = "bitspark-ontos-codec", version = "0.14" }
ontos-data  = { package = "bitspark-ontos-data",  version = "0.14" }
```

**One ontos per Rust dependency graph**: two sources link two `ontos_core::Value` types and
fail with "expected `Value`, found `Value`" — `docs/distribution.md:59-64`.

**Go imports** — `docs/distribution.md:68-77`.

### Attachment, proved — the three programs (run 2026-10-05, anonymous)

Each was a fresh project outside the repo; each printed `01020003696e74000100`.

Go (`go get github.com/bitspark/ontos@v0.14.0`, `GOENV=off`, via `proxy.golang.org` and
`sum.golang.org`; `go.sum` gained `github.com/bitspark/ontos v0.14.0`):

```go
import (
	"encoding/hex"
	"fmt"
	"math/big"

	codec "github.com/bitspark/ontos/codec/go"
	data "github.com/bitspark/ontos/data/go"
)

func main() {
	fmt.Println(hex.EncodeToString(codec.Encode(data.EncodeInt(big.NewInt(0)))))
}
```

TypeScript (`npm install @bitspark/ontos-core @bitspark/ontos-codec @bitspark/ontos-data`, empty
user config, `--registry https://registry.npmjs.org/`; the lockfile resolved all three to
`https://registry.npmjs.org/@bitspark/…-0.14.0.tgz`):

```js
import { encode } from "@bitspark/ontos-codec";
import { encodeInt } from "@bitspark/ontos-data";

console.log(Buffer.from(encode(encodeInt(0n))).toString("hex"));
```

Rust (the manifest above; `Cargo.lock` resolved all three to
`registry+https://github.com/rust-lang/crates.io-index` at `0.14.0`):

```rust
use ontos_codec::encode;
use ontos_data::encode_int;

fn main() {
    let bytes = encode(&encode_int(0));
    println!("{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
}
```

### Dependency edges (from the manifests)

`codec → core`; `data → core, codec`; `data-json → core, data`; `cli → core, codec, data`;
`deixis-projection → core` **plus deixis**. Sources: `codec/rs/Cargo.toml:15`,
`data/rs/Cargo.toml:15-16`, `data/json/rs/Cargo.toml:15-16`, `cli/rs/Cargo.toml:20-22`,
`projection/deixis/rs/Cargo.toml:15-19`, and the TS `dependencies` blocks
(`codec/ts/package.json:25-27`, `data/ts/package.json:25-28`, `data/json/ts/package.json:25-28`,
`projection/deixis/ts/package.json:25-29`).

**Nothing outside ontos** in the core, the codec or the embeddings: "each language uses its
standard library. The one exception is the deixis projection" — `CONTRIBUTING.md:22-26`. The Go
module has no `require` at all (`go.mod:1-3`). Observed: the npm install of three packages added
exactly 3 packages.

### The optional bridge — `ontos-over-deixis-v1`

- Published in all three languages from v0.14.0: `@bitspark/ontos-deixis-projection` (npmjs),
  `bitspark-ontos-deixis-projection` (crates.io), `github.com/bitspark/ontos/projection/deixis/go`
  (Go proxy, a nested module tagged `projection/deixis/go/v0.14.0`) — `docs/distribution.md:9,11,13`;
  `docs/releases/v0.14.0.md:3-6,37-41`; `projection/deixis/README.md:10-14`.
- **Optional and one-way**: `ontos/core` does not depend on it; a separate module / crate /
  package, so importing `core`, `codec`, `data` or `data-json` acquires no deixis; "The
  dependency direction is `ontos → deixis`, one-way, and only along this edge." —
  `projection/deixis/README.md:24-27`; `docs/releases/v0.14.0.md:47-49`.
- Every face pins deixis **exactly** at `0.6.0` — `projection/deixis/README.md:16-17`;
  `projection/deixis/rs/Cargo.toml:18-19`; `projection/deixis/ts/package.json:27-28`;
  `projection/deixis/go/go.mod:14`.
- **Additive**: `P` is total, `R` partial and exact; its one byte-level claim is
  `toOntosBytes(P(v)) = encodeOntosV1(v)` — `projection/deixis/README.md:44-45,86-92`.
- Maturity **unwitnessed, permanently** — `projection/deixis/README.md:94-100`.
- **Run 2026-10-05**, anonymous: the TS package (4 packages added: the projection, `ontos-core`,
  `deixis-core`, `deixis-pos`), the Go module (`go get …/projection/deixis/go@v0.14.0` added
  `deixis v0.6.0`, `ontos v0.14.0`) and the Rust crate (lock: `bitspark-deixis-core 0.6.0`,
  `bitspark-deixis-pos 0.6.0`) each computed `recognize(project(v)) == v` → `true` for
  `int(0)`.

---

## 7. Companion: `ontos-data-json/1` (non-normative)

A total projection of domain JSON onto `ontos/data`; it adds no value and no identity but
"judges its source" — `1.0` refused rather than coerced, trailing data refused, repeated keys
last-wins — `docs/spec/ontos-data-json.md:1-20`. The pin is the **pair**
`(ontos-data-json/1, ontos-codec-v1)`, never folded into one string —
`docs/spec/ontos-data-json.md:46-59`. Entry points: Go `Project` `data/json/go/datajson.go:153`,
Rust `project` `data/json/rs/src/lib.rs:129`, TS `project` (`data/json/ts/src/index.ts`).
Shipped as the fourth package in each registry — `docs/distribution.md:8,10,12`.

---

## 8. Drift found during extraction (records, not poster claims)

1. **The CLI spec's hash pipe hashes hex text, not the bytes.** `docs/spec/ontos-cli.md:54` and
   `:132` say `ontos canon --emit <hex> | sha256sum`; `canon --emit` prints hex, so that digest
   is over 21 bytes of text (`2cd3c476…149e0139`) and not the 10 octets a signature or a
   consumer's hash is over (`0022704d…57a586`). `vectors/data-json.oracle.json:8` has the right
   pipe (`| xxd -r -p | sha256sum`). The poster shows the oracle's form and does not repeat the
   spec's.
2. **`docs/distribution.md:51-53`** still writes the Rust manifest at `version = "0.13"`, which
   resolves within `0.13.x` and never reaches `0.14.0`; the rest of that page is at `0.14.0`.
   The poster writes `"0.14"`, verified by a build.
3. **`ontos --help`** lists `--kind int|utf8-text|bool|list|map|set|decimal`, omitting `null`,
   although `read --kind null` works (run: `{"ok":true,"command":"read","kind":"null",
   "recognized":true}`, exit `0`). The poster lists all eight labels, the true surface.
4. **`projection/deixis/README.md:24-26`** names the Go module and the Rust crate as the
   separate units that keep deixis out of core consumers, but not the TypeScript package, which
   is equally separate (`projection/deixis/ts/package.json:2`). Wording only.
5. **`docs/spec/ontos-core.md:216-218` and `docs/spec/ontos-codec.md:300-302`** still say the
   vectors are replayed by `go`, `rs` and `ts` "as of this writing"; Python replays them too
   (`docs/spec/ontos-codec.md:12`). The poster says four.

---

## 9. Negative space — what ontos refuses

- **Truth, inference, proof** — "the province of a logic engine above it" — `README.md:62`;
  variables, rules, proof, truth live in logos — `docs/spec/ontos-core.md:189`.
- **Authority, identity, attestation** — `README.md:63`; facts, signers, attestation, trust,
  time belong to arche / an authority layer — `docs/spec/ontos-core.md:191`.
- **Persistence, location, addressing, time** — `README.md:64`; references, addresses,
  content-addressing belong to a storage layer — `docs/spec/ontos-core.md:192`.
- **Schema, validation, interpretation** — `README.md:65-66`; `docs/spec/ontos-core.md:190`;
  `docs/spec/ontos-data.md:895-898`.
- **No third constructor** — `docs/spec/ontos-core.md:39-43`.
- **No variable, and the codec cannot encode one** — `docs/spec/ontos-codec.md:63-71`.
- **No ordering at L0** — `docs/spec/ontos-codec.md:271-273`; `docs/spec/ontos-core.md:188`.
- **No arithmetic** — numeric equality, arithmetic, ordering belong to "logos / math / domain
  layer" — `docs/spec/ontos-core.md:188`; `2/4 = 1/2` is a producer-side canonical embedding,
  never an equality — `docs/spec/ontos-data.md:116-119`; `README.md:57-58`.
- **No floating point, ever** — `docs/spec/ontos-data.md:300-303`, `:654-661`.
- **No Unicode normalization** in `utf8-text` — `docs/spec/ontos-data.md:385-392`.
- **No second no-value** — against CBOR / DAG-CBOR / Ion prior art —
  `docs/spec/ontos-data.md:755-763`.
- **No `ontos hash`** — `docs/spec/ontos-cli.md:131-132`.
- **The codec is not the model** — a side axis adding no values and no identity —
  `docs/spec/ontos-codec.md:3-8`; the model is the abstract tree — `docs/spec/ontos-core.md:56-57`.
- **The CLI is not published** — `docs/spec/ontos-cli.md:33-43`.

---

## 10. What the poster deliberately omits

- Per-file internals of the four implementations.
- The release machinery (`.github/workflows/release.yml`, trusted publishing, the release
  environment) beyond the one consumer-relevant fact that every lane carries one number —
  `docs/distribution.md:86-92`.
- History before the first public release (`README.md:125-129`): not a seam fact. The poster
  mentions it nowhere and cites no issue number.
- Exhaustive vector listings and per-language symbol tables (above, reference-only).
- `ontos-data-json/1`'s hard edges and the deixis bridge's `P` / `R` semantics beyond one line —
  the bridge is optional and the poster's reader is a core consumer.

---

## 11. Editorial tiers — which facts earn the sheet, and for whom

**C** = consumer, **O** = operator / maintainer, **T** = contributor.

### Thesis-critical

| fact | poster § | audience |
|---|---|---|
| The seam is a byte string, not an API — two tags, length-prefixed | §02 | C |
| One canonical spelling per value; valid = canonical | §02 | C |
| Four implementations, none of them the reference | §00, §07 | C |
| arche signs and logos hashes *these exact bytes* — why parity is not taste | §00 | C |
| L0 is `Atom \| Tuple` and nothing else; identity is structural | §01 | C |

### Differentiating proof

| fact | poster § | audience |
|---|---|---|
| The tag set is closed: 2 defined, 254 reserved | §02, Fig. 3 | C |
| The whole byte mapping is two lines, and they are immutable | §02 | C |
| L2 adds readings and **no new equality** | §04 | C |
| Three registries, three languages, the same ten octets from a consumer's own code | §05 | C |
| The harness compares stdout **and** exit code, byte-for-byte, in three modes | §07 | C/T |
| A new language conforms by registering one more `--impl` | §07, §09 | T |

### Attachment-critical

| fact | poster § | audience |
|---|---|---|
| Public registries, no credential, one release number (`0.14.0`) | masthead, §05 | C |
| The install block and the three coordinates, exact spellings | masthead, §05 | C |
| Rust: `bitspark-` crate names, unchanged library names; one ontos per graph | §05 | C |
| Dependency edges; nothing outside ontos except the optional bridge | §05 | C |
| The CLI is unpublished — run it, do not depend on it; Go builds it from the module | §06, §09 | C |

### Trust-critical

| fact | poster § | audience |
|---|---|---|
| A byte-mapping change ships as `ontos-codec-v2`; upgrading never changes stored bytes | §02 | C |
| The five normative rejection codes; `limit_exceeded` is implementation-local and names its bound | §02 | C |
| Exit codes `0` / `1` / `2` | §06 | C |
| A recognition miss is not an error; recognition is structural | §06 | C |
| Max decode depth 1024 everywhere; differing host ceilings cannot bite a receivable input | §02 | C |
| Producer admission — reject an unpaired surrogate, never repair it | §04 | C |
| Hash the octets, not the JSON and not the hex text | §03 | C |
| The deixis bridge is optional and one-way | §05 | C |
| The negative space | §08 | C |

### Reference-only

Per-language symbol tables; the full vector corpus; `codec-limits.json` details;
`ontos-data-json/1`'s hard edges; the bridge's `P`/`R` semantics; the release workflow.

### Audience discipline

The primary reader is a **consumer** (`DESIGN.md`). The `--impl` fact sits in §07 and §09;
`scripts/check.sh` appears only in §07. No contributor-only fact appears above §05.
