# ontos-conformance — the differential conformance protocol

**Status:** v1 contract (tooling, non-normative-for-the-value-model). This is a
spec for the **differential conformance protocol + harness**, not for the value
model. It does not introduce any new judgments: it elevates the `ontos` CLI's
`--format json` output ([`ontos-cli.md`](ontos-cli.md) "JSON Lines output schema")
to a documented, implementation-independent **protocol**, and pins how a harness
drives the four CLIs against each other.

The question this answers is *"do `go`, `rs`, `ts`, and `py` agree, byte-for-byte,
on what these bytes are?"* — the cross-language parity that keeps any single
language's quirks from quietly becoming the spec.

## The protocol is the CLI's JSON Lines output

The conformance protocol **is** the `ontos` CLI's `--format json` output. It is
not re-specified here. The single source of truth for the wire shape — the
per-command object keys, key order, compactness, lowercase hex, `\n`
termination, the stable `error` codes, and the rule that output carries **only**
the stable fields — is [`ontos-cli.md`](ontos-cli.md) "JSON Lines output schema".

This document specifies how that output is **used** as a differential contract;
[`ontos-cli.md`](ontos-cli.md) remains normative for what the bytes on the line
say. If the two ever appear to disagree, `ontos-cli.md` wins.

## No reference implementation

The subjects of the harness are the **four peer CLIs** (`go` · `rs` · `ts` ·
`py`) — the tri-core published lanes plus the Python validation lane (ontos-internal#60); as
harness subjects they are exact peers. **There is no reference
implementation** — no binary is "the canonical one" against which the others are
graded. Conformance is defined purely as **agreement**:

> An input *conforms* iff every implementation emits **byte-identical** JSON
> Lines for it. A divergence is a finding against *whichever* implementation is
> the odd one out — the harness reports the disagreement; it does not adjudicate
> which line is "correct". (That judgment is made against
> [`ontos-cli.md`](ontos-cli.md) and [`vectors/`](../../vectors/) by a human.)

This is why the JSON Lines output is held to the austere, deterministic shape in
`ontos-cli.md`: with no oracle line to diff against, the only thing that makes
"identical" meaningful is that every implementation has exactly one legal byte
sequence to emit.

## Invocation contract

Each implementation is invoked uniformly:

```text
<impl-cmd> <subcommand...> --format json <hex>
```

- `<impl-cmd>` is the per-language command that runs that CLI (below).
- `<subcommand...>` is one CLI subcommand with its flags, e.g. `read --all`.
- `--format json` selects the protocol output (one JSON Lines object per result).
- `<hex>` is the positional input — canonical `ontos-codec-v1` bytes as a
  lowercase hex string (bytes-in only, per `ontos-cli.md`).

A single invocation emits **exactly one** JSON Lines object on stdout. Human
diagnostics go to stderr and are **not** part of the protocol.

The four standard implementation commands:

| impl | `<impl-cmd>` |
|---|---|
| `rust` | `target/debug/ontos` (`cargo build -p ontos-cli`) |
| `go` | `./ontos-go` (`go build -o ontos-go ./cli/go/cmd/ontos`) |
| `ts` | `node ./cli/ts/dist/src/main.js` (after building `core`→`codec`→`data`→`cli`) |
| `py` | `python3 cli/py/main.py` (stdlib-only; no build step) |

(On Windows the `rust`/`go` binaries carry a `.exe` suffix.)

The standard subcommands the harness covers — each emits exactly one object:

```text
decode            inspect            read --all
canon --check     canon --emit
```

### A fourth implementation plugs in as just another `--impl`

The invocation contract is the **only** thing an implementation must satisfy to
be a subject. A new implementation (a `c` CLI, a second `ts` build, a fuzzer's
stub) joins by registering its `<impl-cmd>` as another `--impl` on the runner —
no protocol change, no new judgment, no "reference" status. Four impls is the
current roster — the fourth (`py`, ontos-internal#60) joined exactly this way, empirically
validating the clause — not a property of the protocol; the protocol is *n*-ary
agreement over identical input.

## Comparison rule

For each (input, subcommand) pair the harness runs every registered
implementation and compares their stdout **byte-for-byte**. There is no
normalization, no JSON re-parse, no field-by-field tolerance: the bytes are
equal or they are not. (This is sound precisely because `ontos-cli.md` fixes a
single legal byte sequence per result — compact, ordered keys, lowercase hex,
`\n`-terminated.) Process exit codes are compared the same way: agreeing
implementations agree on the exit code too.

## Runner exit codes

The harness runner reports its own verdict via process exit code:

| code | meaning |
|---|---|
| `0` | **agree** — every implementation produced byte-identical output (and exit codes) for every input |
| `1` | **divergence** — at least one input produced disagreement; the harness ran and found a real difference |
| `2` | **usage** — the harness could not run (bad flags, an `--impl` command that would not start, an unreadable corpus) |

The `0` / `1` split mirrors the CLI's own scriptable `0` / `1` convention
(`ontos-cli.md` "Exit codes"): `1` is a well-formed negative answer ("they
disagree"), `2` is "could not even ask".

## Relationship to `vectors/`

The harness does not author inputs. Its corpus is the **`encode` array** of the
existing conformance vectors — each element carries a `.hex` field that is the
full canonical `ontos-codec-v1` encoding of a value:

- [`vectors/codec.json`](../../vectors/codec.json) — the frozen
  `ontos-codec-v1` byte forms (`encode[].hex`).
- [`vectors/data.json`](../../vectors/data.json) — the `ontos/data` (L2)
  embeddings (`int` · `utf8-text` · `bool` · `list` · `map` · `set` · `decimal` · `null`)
  (`encode[].hex`).

These two files are complementary, not redundant: `codec.json` exercises the L0
byte mapping, `data.json` exercises the embeddings layered over it. Reusing them
means the differential harness and the vector runners share one corpus.

The `data.json` corpus deliberately includes a canonical `int` beyond a 128-bit host
width (`int_2pow128`). All four CLIs must agree it is **recognized** (`read --all`,
`read --kind int`), which pins that recognition is *structural* and host-width-
independent — even though one binding (Rust's `i128`) cannot *materialize* it into its
host integer type. The materialization limit is not a recognition miss
([ontos-data.md §5.1](ontos-data.md)), so a `> host-width` int belongs in the
byte-identical corpus rather than being excluded from it.

Note the layering of guarantees. `data.json` is **itself differentially pinned**
to all four encoders — the per-lane vector jobs replay its `encode` cases
(`encode(value) == hex` **and** `decode(hex) == value`) across `go`/`rs`/`ts`/`py`,
so its `.hex` values are already four-way agreed bytes before this harness ever
reads them ([`vectors/README.md`](../../vectors/README.md),
[`conformance-vector-provenance.md`](../conformance-vector-provenance.md)). The
harness then drives the **CLIs** over those same bytes, extending the byte-level
agreement up through the inspector surface (`decode` / `inspect` / `read` /
`canon`).

The corpus is, by construction, the set of values **every core can both decode and
recognize identically** — which is why a `> host-width` `int` such as `int_2pow128`
*does* belong here: recognition is structural, so all four CLIs agree it is an
`int` (above). What the cores are *specified* to differ on is **materialization**
into a bounded host integer (Rust's `i128`; Go, TS, and Python are unbounded —
[ontos-data.md §5.1](ontos-data.md)) — and materialization is not what the CLI's
`read`/`inspect` recognition surface reports, so it never breaks byte-identity. That
host-width difference is pinned separately by per-core boundary tests in
`data/{rs,go,ts,py}`, not by the differential corpus.

### Author→bytes is pinned too (`--from-json`)

Each `encode` case carries not only the canonical `.hex` but the authoring
`value` (`{"atom":…}` / `{"tuple":…}`) — the exact notation the CLI's
`--format json` value rendering emits. The harness uses this to pin the
**inverse** direction as well. In a second check pass it drives
`<impl> canon --emit --from-json <value-json>` ([`ontos-cli.md`](ontos-cli.md)
"Value input") for every case and asserts **both**:

- **differential** — all four CLIs emit byte-identical stdout (and exit code),
  exactly as in the decode pass; and
- **oracle** — the emitted hex equals that case's pinned `.hex`.

This closes the round-trip into a cross-implementation theorem: *author →
canonical bytes* is checked byte-for-byte across `go`/`rs`/`ts`/`py` and against
the frozen vectors, so the text→bytes affordance (`--from-json`) cannot drift
between implementations or away from the pinned encoding. It adds no new
judgment — `--from-json` builds an L0 `Value`, which has exactly one
`ontos-codec-v1` encoding — it only asserts the four CLIs build and emit that one
encoding *identically*. The mode is the harness
runner's `--from-json-roundtrip`; CI runs it alongside the decode pass
([`tools/conformance/README.md`](../../tools/conformance/README.md)).

## Austerity

The harness **consumes** the CLI; it adds nothing to the value model. It defines
no new values, recognizes no new embeddings, and makes no judgment that the CLI
does not already make — it only asks whether the four CLIs make those judgments
*identically*. It is therefore **not normative for the value model** (and not for
the codec, the embeddings, or even the CLI's wire shape, which `ontos-cli.md`
owns). Like the CLI itself, it is bytes-in only and introduces no second value
surface. Its sole contribution is the *differential* assertion: four-CLI parity,
made checkable.

## Maturity — what a surface's conformance actually rests on

Not every surface in this repo carries the same assurance, and the difference is not
visible from where a directory sits. `core`, `codec` and `data` are four-language and
vector-pinned; `projection/` sits beside them under the same conventions, with its own
vectors, in CI — and is single-language. A reader, or a consumer choosing what to depend
on, has no signal separating *"four implementations agree, byte for byte"* from *"one
implementation, pinned against goldens it produced itself."*

Both are legitimate states. Only one is what "conformance vectors, CI-enforced" normally
means here. **Every conformance-bearing surface therefore declares one of these:**

| label | what it means |
|---|---|
| **experimental / unwitnessed** | one implementation; goldens only |
| **witnessed** | two independently authored implementations agree |
| **portable** | every language named by the surface's portability promise passes a shared corpus |
| **frozen** | mapping and corpus are versioned; a change requires a new profile version |

**The distinction that matters:** a single-implementation surface pinned to goldens is
protected against *regression*, not against being *wrong*. Its vectors prove today's bytes
match yesterday's. They cannot prove the reading is the one a second implementer would
arrive at from the spec — which is exactly the property `vectors/` supplies for
`core`/`codec`/`data`, and the reason four-language parity is a rule rather than a habit.

Current labels:

| surface | label | why |
|---|---|---|
| `ontos/core`, `ontos/codec`, `ontos/data` | **portable**, frozen where declared | four implementations, byte-identical, vector-pinned in CI |
| producer admission (`ontos-data.md` §4.1) | **portable** | four implementations, differentially enforced by `tools/producer-conformance` |
| `ontos-data-json/1` | **unwitnessed** | three faces (go · rs · ts), all ontos-authored |
| `ontos-over-deixis-v1` | **unwitnessed**, permanently | three faces (rs · go · ts), all ontos-authored; the witness seal is unspent and will not be spent (ontos-internal#255, closed) |

**Both projections are unwitnessed with more than one face, and that is not a
contradiction — it is the whole point of the label.** The ladder turns on *authorship*,
not on how many directories exist: `witnessed` requires two **independently authored**
implementations, and a second face written inside ontos inherits the first reader's
reading of every under-determined clause, so it confirms nothing (ontos-internal#255). Counting
faces is exactly the inference this table exists to prevent.

The two projections no longer sit in disjoint languages — both are implemented in Go,
Rust and TypeScript — so the older reasoning that *neither could witness the other because
no language held both* has lapsed. What still holds, and is the operative fact, is that every face of
both is ontos-authored. Labelling this is not a demotion — it makes an existing fact
legible instead of leaving it to be inferred from a directory listing.

**The two `unwitnessed` rows no longer mean the same thing.** `ontos-data-json/1` is
unwitnessed *pending*: a second witness would still be accepted and would move it.
`ontos-over-deixis-v1` is unwitnessed *permanently*. The seal such a witness spends —
writing the profile's `P`/`R` from `PROJECTION.md` alone, having read neither face nor the
vector corpus — is one-shot and cannot be restored. It went unspent **not for want of an eligible
witness**: one was found outside ontos, answered the seal evidentially, and was ruled
seal-intact at the *cross-organisation, code-sealed* tier — the strong form. The choice
was put as **spend the one intact seal, or accept `unwitnessed`**, and `unwitnessed` was
accepted; ontos-internal#255 was closed with the seal **unspent** and the aspiration closed rather
than deferred.

**The ladder gains no rung for this.** `witnessed: never` is not a fifth label — it is a
statement about the *aspiration*, not about what the surface rests on, and what a surface
rests on is the only thing the four labels above measure. So the label stays
`unwitnessed` and the permanence is recorded beside it. The practical difference is for a
consumer choosing what to depend on: read that row as **final** rather than provisional.

## See also

- [`ontos-cli.md`](ontos-cli.md) — the `ontos` CLI contract and the normative
  JSON Lines output schema this protocol references.
- [`tools/conformance/README.md`](../../tools/conformance/README.md) — the
  maintainer harness that implements this protocol (the runner, its `--impl`
  registration, and the corpus wiring).
- ontos epic **ontos-internal#15** — the differential conformance harness that this protocol
  and harness together discharge.
