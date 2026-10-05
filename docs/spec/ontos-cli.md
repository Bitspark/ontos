# ontos-cli — the `ontos` CLI contract

**Status:** v1 contract (tooling, non-normative-for-the-value-model). This is a
spec for the **`ontos` command-line tool**, not for the value model — but it *is*
the source of truth the tool implements, so it is versioned and pinned like the
rest of the surface.

`ontos` is a **byte-first inspector** for ontos values: bytes in, evidence out. It
exists so a human (or a script) can answer *"what are these `ontos-codec-v1` bytes,
are they canonical, and what do they read as?"* — the questions that matter because
consumers sign and hash those bytes.

## Tri-core, no favored language

`ontos` ships in **`go` · `rs` · `ts`** as peers — exactly like `core`/`codec`/
`data` — each built over its own core. **This document is the contract they all
implement.** No binary is "the canonical one": the contract here, plus
[`vectors/`](../../vectors/), are the source of truth, and the differential
conformance harness (ontos-internal#15) enforces that the CLIs produce **identical**
machine output for identical input. That is what keeps any single language's quirks
from quietly becoming the spec.

**A fourth face runs under the harness, and every parity claim below covers it.**
`cli/py` (ontos-internal#60) is a **validation lane**, not a fourth peer: stdlib-only, no
reference status, not published, carrying no judgment the three peers do not. It
implements this same contract and is registered in CI as a fourth `--impl`, so the
harness enforces byte-identical output across **four** implementations
(`go` · `rs` · `ts` · `py`) — an implementation proves conformance by being added as
another `--impl`, with no test code ported. Read "tri-core" below as naming the
**peers**; wherever a sentence says what the harness *enforces*, the enforced set is
all four. See [`tools/conformance/README.md`](../../tools/conformance/README.md).

### Not a published package

The CLI is a **repo-local developer tool**, built from source in each language — it
is deliberately **not** distributed on any registry. In the three peer cores the `ts`
package is `private`, the `rs` crate is `publish = false`, and the `go` build is
`go install` from this repo; the `py` validation lane has no packaging manifest at
all, so there is nothing there to suppress. Only the value-model **libraries**
(`@bitspark/ontos-{core,codec,data}`) are published, because those are what
downstream code (logos, thesmos, …) imports.
Nothing imports the CLI — you run it, you don't depend on it — so publishing it would
add a distribution surface to maintain for no consumer.

The tool is **bytes-out only**, and its input is normally canonical
`ontos-codec-v1` bytes. The one text→bytes affordance is **`--from-json`** (see
[Value input](#value-input)): it accepts the **authoring
notation** `vectors/` already use (`{"atom":"<hex>"}` / `{"tuple":[ … ]}`) as input,
so a human can hand a value to the tool and get its canonical bytes. That is a
deliberately **austere** answer to ontos-internal#17: it reuses the verbose `{atom}/{tuple}`
JSON rather than inventing a *pleasant* text form, precisely because a pleasant
notation risks becoming a second, exchangeable value surface. The discipline holds —
only the **canonical bytes** are the value: never sign, hash, or exchange the JSON
text; hash the emitted bytes (`canon --emit --from-json … | sha256sum`).

## Synopsis

```text
ontos <command> [options] [<hex>]
```

- **Input** is canonical `ontos-codec-v1` bytes, given as a positional **hex
  string**, or read from **stdin** when the argument is `-` or omitted (hex,
  surrounding whitespace ignored).
- **`--from-json <json|->`** supplies the input value as the **authoring notation**
  instead of hex (see [Value input](#value-input)) — the CLI's
  only text→bytes path. Mutually exclusive with a positional `<hex>`.
- **`--format <human|json>`** (default `human`). `json` emits **JSON Lines** (one
  JSON object per result line): a stable, machine-readable contract that doubles as
  the differential-harness protocol. `human` is for people, but is **also
  byte-identical across implementations** — its rendering is pinned (see
  [Human format](#human-format)) and
  enforced across all four implementations. Only **stderr** diagnostics are free-text.
- `-h, --help`, `--version`.

## Value rendering

A decoded `Value` is rendered two ways:

- **human** — the core's existing `Display` / `String` / `toString` form, e.g.
  `Tuple(Atom(0x6d6170), Atom(0x61))`.
- **json** — the **authoring notation** already used by `vectors/`:
  `{"atom":"<hex>"}` or `{"tuple":[ … ]}`. Reusing it means the CLI's JSON output
  round-trips with the vectors and is directly diffable by the harness.

## Value input

Every command operates on one `Value`, obtained from exactly one source:

- **canonical bytes** (default) — the positional `<hex>` or stdin, decoded via
  `ontos-codec-v1`. A decode failure is the command's negative/error result.
- **`--from-json <json|->`** — the value is **parsed** from the authoring notation
  (`{"atom":"<hex>"}` | `{"tuple":[ … ]}`), the exact inverse of the `--format json`
  value rendering. `-` reads the JSON from stdin. No bytes are decoded; the value is
  built directly, so it is canonical by construction (an L0 `Value` has exactly one
  `ontos-codec-v1` encoding).

`--from-json` and a positional `<hex>` are **mutually exclusive**: supplying both is a
`usage_error` (exit `2`). This holds for **any** positional, **including the `-` stdin
sentinel** — `-` still names a bytes source (stdin), so combining it with `--from-json`
(its own source) is equally ambiguous and is rejected by every implementation. Malformed JSON,
or JSON that is not the authoring shape — not exactly one of `atom`/`tuple`, an
`atom` that is not even-length lowercase hex, a non-array `tuple` — is the stable
`invalid_json` error (exit `2`).

The intended use is **author → canonical bytes**:

```text
ontos canon --emit --from-json '{"tuple":[{"atom":"696e74"},{"atom":"00"}]}'
# → 01020003696e74000100    (pipe to sha256sum to hash)
```

`--from-json` works with every command (it is simply the other input source):
`inspect`/`read` recognize the embeddings of an authored value, and
`canon --check --from-json` is **always** canonical (the value was built, not
decoded). It is **authoring/debugging only** — the JSON text is not a value to
store, sign, or exchange; only the emitted bytes are.

## Commands (v1)

| command | does | scope |
|---|---|---|
| `ontos decode [<hex>]` | decode the bytes → the L0 value tree | **shipped** (scaffold ontos-internal#18) |
| `ontos inspect [<hex>]` | decode + report codec id, canonical?, value, and the registered embeddings recognized at the top level | **shipped** (ontos-internal#19) |
| `ontos read [--all\|--kind <k>] [<hex>]` | recognize registered embeddings (`int·utf8-text·bool·list·map·set·decimal·null`); `--all` tries each | **shipped** (ontos-internal#20) |
| `ontos canon [--check\|--emit] [<hex>]` | `--check`: is the input canonical (decodes **and** re-encodes to the same bytes)?; `--emit`: print the canonical bytes (hex) for piping to a hasher | **shipped** (ontos-internal#21) |

All four commands ship in all three peer cores (`go` · `rs` · `ts`) and in the `py`
validation lane; the issue refs above are history, not pending work.

`ontos` is a **canonical byte witness**, not a signing tool — there is no
`ontos hash`. Hash by piping: `ontos canon --emit <hex> | sha256sum`.

## JSON Lines output schema

One object per result. The shape per command:

```jsonc
// decode
{"ok": true, "command": "decode", "codec": "ontos-codec-v1", "value": <authoring-json>}
// inspect
{"ok": true, "command": "inspect", "codec": "ontos-codec-v1", "canonical": true,
 "value": <authoring-json>, "recognized": ["map"]}
// read
{"ok": true, "command": "read", "kind": "map", "recognized": true}
// canon --check
{"ok": true, "command": "canon", "canonical": true}
// canon --emit
{"ok": true, "command": "canon", "hex": "01..."}
// any negative / error result
{"ok": false, "command": "decode", "error": "non_canonical_uvarint"}
```

`error` reuses the codec's stable `DecodeError` codes (`unexpected_eof`,
`trailing_bytes`, `unknown_tag`, `non_canonical_uvarint`, `uvarint_overflow`,
`limit_exceeded`) plus CLI codes: `invalid_hex`, `invalid_json`, `usage_error`.

There is **no** `not_recognized` error code: a recognition miss is a positive-shaped
result, not an error. `read --kind <k>` on a non-match returns
`{"ok":true,"command":"read","kind":"<k>","recognized":false}` and exits `1` (the boolean
`recognized` field above carries the answer); `inspect` and `read --all` simply omit the
missing label from their `recognized` array.

**Recognition is structural, not materialization.** `read` (and the `recognized`
arrays of `inspect` / `read --all`) reports whether a value has an embedding's
canonical L0 form — **not** whether a given binding can materialize it into a host
datum. So a canonical `int` whose magnitude exceeds a binding's host integer width
(e.g. Rust's `i128`) is **`recognized: true`** / **`int: yes`** (exit `0`) in every
binding; the host-width limit is a separate materialization concern
([ontos-data.md §5.1](ontos-data.md), the int-layer analog of
[ontos-codec.md §3.1](ontos-codec.md)), never a recognition miss. The CLIs therefore
agree byte-for-byte on recognition for such values, pinned by the
`int_2pow128` conformance vector.

**Output is byte-comparable across implementations.** JSON Lines output MUST be
**compact** (no insignificant whitespace), with object keys in the **order shown
above**, hex lowercase, one object per line terminated by `\n`, and carries **only
the stable fields above** — no free-text `message`. (Free-text diagnostics go to
**stderr**, which carries no determinism guarantee and is never compared.) This
is what lets the differential harness (ontos-internal#15) assert the CLIs emit *identical bytes*
for identical input.

## Human format

`--format human` is for people, not machines — but it is **still identical across
implementations**, not a per-language free-for-all. The `--format json` schema above is
byte-pinned for scripts; the `human` rendering of the same commands MUST also be
byte-identical across `go` · `rs` · `ts` · `py`, and is enforced by the conformance
harness `--human-roundtrip` mode (ontos-internal#46). (This supersedes the earlier "human output
carries no determinism guarantee" disclaimer; that freedom was only ever an unenforced
gap, and cores that disagree on a line a human reads is exactly the "favored language"
wart the project forbids. Only **stderr** diagnostics remain free-text and uncompared.)

The canonical human rendering per command:

- **`decode`** — the value's `Display`/`String`/`toString` form on one line, e.g.
  `Tuple(Atom(0x6d6170), Atom(0x61))`.
- **`inspect`** — the value line, then `canonical: yes|no`, then a **`recognized:` line**
  (see below).
- **`read --all`** — a single **`recognized:` line** (see below). The `recognized: `
  prefix is present here, **identically to `inspect`**.
- **`read --kind <k>`** — `<k>: yes|no` (the kind name, a colon, then the answer).
- **`canon --check`** — `canonical: yes|no`.
- **`canon --emit`** — the canonical bytes as lowercase hex on one line.

The **`recognized:` line** (shared by `inspect` and `read --all`) is the string
`recognized: ` followed by the recognized embedding labels **joined by `, `**
(comma-space), in the fixed `int · utf8-text · bool · list · map · set · decimal · null` order,
or the literal **`none`** when no embedding is recognized:

```text
recognized: int
recognized: list, map     # (illustrative — a value recognizes at most one label today)
recognized: none
```

## Exit codes

| code | meaning |
|---|---|
| `0` | success — decoded / canonical / recognized |
| `1` | a well-formed **negative** result — decode failed, not canonical, or not recognized (the tool ran; the answer is "no") |
| `2` | usage error — bad flags, non-hex input, or missing input (the tool could not run) |

The `0` / `1` split makes the tool scriptable: `ontos canon --check <hex> && echo OK`.

## What the scaffold (ontos-internal#18) delivers

The scaffold establishes the contract above + a runnable `ontos` in all three
languages implementing **`decode`** and `--format human|json` (plus the arg surface
and dispatch); `inspect`/`read`/`canon` land in ontos-internal#19–ontos-internal#21. A CI smoke check asserts
`ontos decode --format json` is byte-identical across `go`/`rs`/`ts` for a set of
inputs — the first enforced CLI-parity check.
