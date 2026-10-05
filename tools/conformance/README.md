# `ontos-conformance` — the differential conformance runner

`tools/conformance/run.mjs` is a small, dependency-free Node ESM **maintainer tool**
that drives the `ontos` CLI in every implementation over a shared corpus of vector
hexes and asserts their machine output is **byte-identical**. It is the executable
form of [`docs/spec/ontos-conformance.md`](../../docs/spec/ontos-conformance.md):
"no favored language" only counts as a property because this enforces it.

## What it is

The `ontos` CLI ships in three peers — `go` · `rs` · `ts` — each built over its own
core, all implementing the single contract in
[`docs/spec/ontos-cli.md`](../../docs/spec/ontos-cli.md). This runner is an
**out-of-process, black-box** check: it knows nothing about any core's internals and
speaks only the CLI contract — the `--format json` **JSON Lines** output, which is
byte-comparable by design (compact, fixed key order, lowercase hex, `\n`-terminated).

For every `(hex, command)` pair drawn from the vector corpus, the runner executes
each implementation and captures **stdout** and the **process exit code**. It compares
all implementations **byte-for-byte on stdout and on the exit code** — stdout is the
conformance protocol (the JSON Lines object), and the exit code is part of the CLI
contract too ([`ontos-cli.md`](../../docs/spec/ontos-cli.md) "Exit codes"), so an impl
that emits the right bytes but the wrong code is a real non-conformance. (stderr is
*not* compared — human diagnostics carry no determinism guarantee.) Any disagreement is
a **divergence**, printed with the command, the hex, and each implementation's output
and exit code.

- **Corpus.** By default the hexes are the `.hex` of every element in the `"encode"`
  array of **both** [`vectors/codec.json`](../../vectors/codec.json) and
  [`vectors/data.json`](../../vectors/data.json). Extend or override with `--vectors`.
- **Commands.** By default the five standard inspector verbs, each of which emits
  exactly one JSON Lines object:
  `decode` · `inspect` · `read --all` · `canon --check` · `canon --emit`.

## Three check modes

The runner has **three** independent check passes; select any combination (with no mode
flag, the **decode** mode runs alone — back-compatible):

| flag | mode | what it pins |
|---|---|---|
| `--decode-roundtrip` | **decode** (default) | for each `(hex, command)`: `hex → JSON Lines`, **differential** (all impls byte-identical) |
| `--human-roundtrip` | **human** | for each `(hex, command)`: `hex → --format human` (same corpus), **differential** |
| `--from-json-roundtrip` | **author→bytes** | for each vector encode case: `value → canonical bytes` via `canon --emit --from-json`, **differential** AND **oracle** |

**Human mode (`--human-roundtrip`)** re-runs the same `(hex, command)` corpus as decode
mode but with `--format human`, asserting all impls' stdout + exit code are byte-identical.
`--format human` *used* to carry "no determinism guarantee"; ontos-internal#46 makes the
recognized-line rendering canonical and tri-core-enforced (`recognized: ` followed by the
labels joined by `, `, or `none` when empty — on **both** `inspect` and `read --all`), and
this mode is what enforces it. It is purely **differential** — there is no oracle, because
human output is a tri-core identity property, not something pinned in the vectors. (stderr
is still not compared.)

**Author→bytes mode (`--from-json-roundtrip`)** inverts the protocol. Every element of
the `"encode"` array carries both an **authoring `value`** (`{"atom":…}` / `{"tuple":…}`)
and the canonical **`hex`**. For each case the runner drives
`<impl> canon --emit --format json --from-json <value-json>` — passing the compact value
JSON as a **single argv token** (no shell) — and asserts both:

- **(a) differential** — all impls' stdout + exit code are byte-identical, and
- **(b) oracle** — the emitted hex equals that vector case's pinned `.hex`.

This makes the full round-trip **author → canonical bytes** a checked, tri-core property:
the JSON the CLI *emits* in decode mode (its `--format json` value rendering) is the exact
notation it *parses* here, and the bytes it parses to are the same frozen bytes the decode
side started from. The three modes are independent; a divergence in **any** fails the run
(exit `1`). A divergent author→bytes case skips its oracle check (with no agreed bytes the
"emitted hex" is ill-defined; the differential finding already names the case to fix).

## How to run

The one-command way — `scripts/check.sh conformance` (Linux/macOS) or
`scripts/check.ps1 conformance` (Windows). It builds the three compiled CLIs **fresh**,
then runs all three modes over all four implementations, exactly as CI's
`cli (tri-core parity)` job does. Building fresh is
deliberate: a stale repo-root binary (`ontos-go`, `target/debug/ontos`) left over from
an earlier build can otherwise produce a **false** divergence against current source —
so the documented local flow always rebuilds first (ontos-internal#69).

To run it by hand — to vary `--impl` / `--vectors` / the modes, or to add another
implementation — build the three compiled CLIs first (the py lane runs from source),
then run the runner from the **repo root**:

```sh
# rust — builds ./target/debug/ontos
cargo build -p ontos-cli --locked

# go — built as ./ontos-go
go build -o ontos-go ./cli/go/cmd/ontos

# ts — npm workspaces; the @bitspark packages import each other by name, so build
# core → codec → data → cli into dist/, then run node ./cli/ts/dist/src/main.js
npm ci
npm run -w @bitspark/ontos-core  build
npm run -w @bitspark/ontos-codec build
npm run -w @bitspark/ontos-data  build
npm run -w @bitspark/ontos-cli   build

# py — nothing to build: the stdlib-only validation lane (ontos-internal#60) runs straight
# from source as python3 cli/py/main.py

# the four standard implementations, over both vector files, ALL THREE check modes
# (decode hex→JSON Lines, human hex→--format human, and author→bytes via --from-json —
# exactly what CI runs):
node tools/conformance/run.mjs \
  --impl ontos-rs=./target/debug/ontos \
  --impl ontos-go=./ontos-go \
  --impl "ontos-ts=node ./cli/ts/dist/src/main.js" \
  --impl "ontos-py=python3 cli/py/main.py" \
  --vectors vectors/codec.json --vectors vectors/data.json \
  --decode-roundtrip --human-roundtrip --from-json-roundtrip
```

On success it prints a single summary line and exits `0`:

```text
ontos-conformance: checked decode: 41 hexes x 5 commands x 4 impls + human: 41 hexes x 12 commands x 4 impls + from-json: 41 encode cases x 4 impls (author->bytes) (ontos-rs, ontos-go, ontos-ts, ontos-py) — all byte-identical and every emit == pinned hex
```

(With no mode flag — `--decode-roundtrip` implied — it prints the shorter
`checked decode: 41 hexes x 5 commands x 4 impls … — all byte-identical`.)

On any divergence it prints one block per divergence (`DIVERGENCE [<command> <hex>]`
followed by each impl's output) and a `FAIL` summary, exiting `1`.

> On Windows the rust/go binaries carry a `.exe` suffix
> (`./target/debug/ontos.exe`, `./ontos-go.exe`); CI is Linux, where they do not.

## CLI surface

```text
node tools/conformance/run.mjs \
  --impl <name>=<command> [--impl <name>=<command> ...] \
  [--vectors <path> ...] [--commands "<csv>"] \
  [--decode-roundtrip] [--human-roundtrip] [--from-json-roundtrip]
```

- **`--impl NAME=COMMAND`** (repeatable, **≥1 required**) — an implementation to
  drive. `COMMAND` is whitespace-split into an argv array
  (`"ontos-ts=node ./cli/ts/dist/src/main.js"` → `["node","./cli/ts/dist/src/main.js"]`);
  the runner appends the subcommand tokens, then `--format <json|human>`, then the hex,
  and execs via `spawnSync` with **no shell**.
- **`--vectors PATH`** (repeatable) — a vector JSON file whose `"encode"` array is
  read; the **decode** and **human** modes collect every `.hex`, the **author→bytes**
  mode collects every `{value, hex}` pair. Defaults to both `vectors/codec.json` and
  `vectors/data.json`.
- **`--commands "a,b,..."`** — override the command list (decode and human modes);
  comma-separated, each entry itself whitespace-split into subcommand tokens (so
  `read --all` is one entry).
- **`--decode-roundtrip`** — run the **decode** check mode (`hex → JSON Lines`). Implied
  when no mode flag is given; naming it lets it run **alongside** the other modes.
- **`--human-roundtrip`** — run the **human** check mode (`hex → --format human`, same
  corpus as decode mode), asserting all impls agree byte-for-byte on stdout + exit code.
  Enforces the canonical human rendering (ontos-internal#46); purely differential, no oracle.
- **`--from-json-roundtrip`** — run the **author→bytes** check mode: for each vector
  encode case, `canon --emit --from-json <value-json>` for each impl, asserting all impls
  agree byte-for-byte **and** the emitted hex equals the vector's pinned `.hex`.

**Assumption — no spaces in paths.** Because `--impl COMMAND` and each `--commands`
entry are tokenized on whitespace, neither an impl's program path/flags nor a command
entry may contain an embedded space. The standard impls have none; keep binaries on a
space-free path.

## Exit codes

| code | meaning |
|---|---|
| `0` | every check passed — decode/human modes: byte-identical across all impls; author→bytes mode: byte-identical across all impls **and** every emit equals the pinned hex |
| `1` | at least one divergence (the tool ran; the impls disagree — or, in author→bytes mode, an emitted hex did not equal the vector's pinned hex) |
| `2` | usage error — no `--impl`, an unreadable/ill-formed `--vectors` file, or an impl binary that cannot be spawned (the tool could not run) |

## How a new implementation proves conformance

Because the check is purely the CLI contract's bytes in and the contract's JSON Lines
bytes out, a **new implementation in any language** proves its conformance by being
added as one more `--impl` — **no in-process test code is ported**:

```sh
node tools/conformance/run.mjs \
  --impl ontos-rs=./target/debug/ontos \
  --impl ontos-go=./ontos-go \
  --impl "ontos-ts=node ./cli/ts/dist/src/main.js" \
  --impl "ontos-py=python3 cli/py/main.py" \
  --impl "ontos-new=/path/to/your/ontos" \
  --decode-roundtrip --human-roundtrip --from-json-roundtrip
```

If its `--format json` **and** `--format human` output agrees byte-for-byte with the
established peers over the full corpus — in **all three** of the decode, human, and
author→bytes modes — it conforms; if not, the divergence names the exact case to fix
(and, in author→bytes mode, whether it was a cross-impl disagreement or a hex that missed
the pinned vector). This is exactly how CI enforces cross-impl parity (the
`cli (tri-core parity)` job in
`.github/workflows/vectors.yml`).

This claim is no longer hypothetical: **ontos-internal#60 discharged it** with the
stdlib-only **Python** lane (`core/py` · `codec/py` · `data/py` · `cli/py`),
registered in CI as `--impl "ontos-py=python3 cli/py/main.py"` — no protocol
change, no new judgment, no reference status, and no ported test code. The py
lane is a validation lane, not a published package.

## Differential fuzz bout (`tools/fuzz/gen.mjs`)

The frozen vectors are a fixed corpus. To widen the cross-impl oracle **beyond** the
frozen corpus, [`tools/fuzz/gen.mjs`](../fuzz/gen.mjs) is a small, dependency-free
(node stdlib) generator that emits a **seeded, ephemeral** corpus of arbitrary hexes in
the exact vectors-file shape this runner's `--vectors` override reads. Each generated
case carries only `{ name, hex }` — the **differential agreement** (all four CLIs decode
to byte-identical output) **is** the judgment, so no pinned `value` is needed, and the
runner is reused **unchanged** (ontos-internal#127).

It emits three families (mirroring the strategy in
[`codec/go/fuzz_test.go`](../../codec/go/fuzz_test.go)):

- **valid** — a randomly built `Value` tree encoded with `ontos-codec-v1` (atoms of
  random bytes, tuples of bounded arity/depth). All four impls must decode and agree.
- **near-valid** — a valid encoding with exactly one byte flipped; these land in the
  decode-success branch far more often than uniform-random bytes, stressing agreement on
  real nested structure and on the reject paths a mutation opens.
- **reject-shaped** — uniform-random buffers plus a few structural reject literals; the
  property is that all four impls *reject identically* (same error object + exit code).

**Seeded + reproducible.** The corpus is a pure function of the seed; the effective seed
is printed **loudly to stderr** so any disagreement is replayable. With no `--seed`, the
default derives from `$GITHUB_SHA` when set (so a CI rerun on the same commit reproduces
the exact corpus), else a time-based seed.

```text
node tools/fuzz/gen.mjs [--seed <u64>] [--count <N>] [--out <path>]
```

Run the bout the same way CI's `differential fuzz (four-CLI seeded bout)` job does — build
all four CLIs (as for the conformance run above), generate a corpus, then drive it through
the runner in **decode + human** modes (the `--from-json-roundtrip` oracle is **not** used:
random bytes have no pinned hex):

```sh
# build all four CLIs first (see "How to run" above), then:
node tools/fuzz/gen.mjs --count 300 --out fuzz-corpus.json   # prints SEED=0x… to stderr
node tools/conformance/run.mjs \
  --impl ontos-rs=./target/debug/ontos \
  --impl ontos-go=./ontos-go \
  --impl "ontos-ts=node ./cli/ts/dist/src/main.js" \
  --impl "ontos-py=python3 cli/py/main.py" \
  --vectors fuzz-corpus.json \
  --decode-roundtrip --human-roundtrip
```

`scripts/check.sh fuzz` (or `scripts/check.ps1 fuzz`) runs this bout after the Go-native
fuzz legs, building the four CLIs fresh first; set `FUZZ_SEED=<u64>` to pin a seed and
`FUZZ_COUNT=<N>` to vary the case count.

**Replaying a failure.** A bout failure prints the runner's `DIVERGENCE` block (the exact
command, hex, and each impl's output) *and* the generator already printed its `SEED=0x…`.
Regenerate the identical corpus and rerun with `--seed <printed>`:

```sh
node tools/fuzz/gen.mjs --seed 0xDEADBEEF --count 300 --out fuzz-corpus.json
# …then the same run.mjs invocation above — the same divergence reproduces.
```

The corpus is **ephemeral** — `fuzz-corpus.json` is gitignored and never committed; the
**seed** is the reproducible artifact, not the file.

## See also

- [`docs/spec/ontos-conformance.md`](../../docs/spec/ontos-conformance.md) — the
  differential-conformance policy this tool implements.
- [`docs/spec/ontos-cli.md`](../../docs/spec/ontos-cli.md) — the CLI contract,
  including the JSON Lines output schema and exit codes the runner compares.
- [`tools/fuzz/gen.mjs`](../fuzz/gen.mjs) — the seeded generator for the differential
  fuzz bout (ontos-internal#127).
