# ontos — repository layout

**Status:** decided. Records where code, vectors, and specs live, and the
language split. Promotes the `ontos-draft` exploration into the real repo,
split along the layer seam from [0003](0003-layered-architecture.md).

> **Forward-note (2026-06-01) — codec, the higher layers, and `data` have since
> shipped.** This ADR is a dated, point-in-time record; the layout sketch below
> marks `ontos-codec.md` / `ontos-compound.md` / `ontos-data.md` as "(later)",
> calls `codec.json` "draft-codec cases", and shows `compound/` `data/` getting
> their language shape "when they are implemented" — all accurate when written.
> Since then `ontos/codec` is **frozen as `ontos-codec-v1`** (`codec.json` pins the
> frozen codec, not a draft), the L1/L2 specs are written, and `data/{go,rs,ts}`
> ships the registered embeddings (`int`, `utf8-text`, `bool`, `list`, plus `map`/
> `set` frozen 2026-06-01). `compound` remains intentionally spec-only (no module —
> see [`docs/spec/ontos-compound.md`](../spec/ontos-compound.md)). Per the repo's
> convention, ADRs are historical decisions, not living docs — the text below is
> preserved unchanged, with this note as the only pointer to the current state.

## Two axes: layer × language

ontos is organized by **layer** (the conformance profiles of 0003) and, within
each implemented layer, by **language**. The languages are **`go`, `rs`, `ts`** —
kept as a first-class split because ontos is the genuinely multi-language floor:
arche's facts service is Go, and arche's existing `DataNode` is already
go/rs/ts + vector-pinned, so ontos must speak all three. (This is the one place
the multi-language discipline is load-bearing; logos by contrast is Rust-primary
with adapters.)

```text
ontos/
  README.md                     conceptual manifesto
  docs/
    design/                     the decisions (0001–000N)
    spec/
      ontos-core.md             L0 normative spec (the frozen floor)
      ontos-codec.md            (later) the canonical byte encoding spec
      ontos-compound.md         (later) L1 labeled-compound reading
      ontos-data.md             (later) L2 registered embeddings
  vectors/                      SHARED, language-agnostic conformance vectors
    README.md                   vector-file format + what each pins
    identity.json               L0 structural-identity cases (equal / distinct)
    codec.json                  draft-codec cases (uvarint / roundtrip / reject)
  core/                         L0 — the value model only (no codec, no interp)
    rs/                         crate  ontos-core
    ts/                         pkg    @bitspark/ontos-core
    go/                         module ontos-core
  codec/                        the byte encoding (depends on core)
    rs/   ts/   go/
```

Higher layers (`compound/`, `data/`) get the same `rs/ ts/ go/` shape when they
are implemented. Each layer in each language is independently buildable.

## The core / codec split (from 0003)

`ontos/core` (L0) and `ontos/codec` are **separate axes**, so the split is
physical, not just conceptual:

- **`core/`** holds only `Value = Atom(Bytes) | Tuple(Value*)`, its constructors,
  and **structural identity**. It has *no* dependency on the codec and *no* byte
  encoding. This is the part pinned hardest and intended never to change.
- **`codec/`** depends on `core` and realizes the byte encoding (two tags +
  canonical uvarint), carried over from `ontos-draft` and now **frozen as
  `ontos-codec-v1`** ([`docs/spec/ontos-codec.md`](../spec/ontos-codec.md)).

The `ontos-draft` repo bundled model + codec in one unit per language. On
promotion, each language's draft splits into `core/<lang>` + `codec/<lang>`, and
the draft dir names `rust`/`typescript` become `rs`/`ts`. The draft Rust + TS code
is the seed; the Go implementations are written to the same spec + vectors.

## Vectors are the contract, not mirrored tests

The draft has parallel hand-written unit tests in Rust and TS — which can silently
drift. The real repo replaces that with **one shared vector set** under
`vectors/`, expressed language-agnostically, that every language (`go`, `rs`,
`ts`) replays. This is what turns cross-implementation agreement from a hope into a
checkable property — and it is the prerequisite that makes adding the Go impl safe
(Go conforms iff it passes the same vectors). See `vectors/README.md`.

## Tooling layout (`cli/`, `tools/`) — added 2026-06-01

The developer/inspection tooling (ontos-internal#12) follows the **same layer × language
discipline**, with one new top-level component and one maintainer area:

```text
ontos/
  cli/                    the `ontos` CLI — byte-first inspector, TRI-CORE peers
    rs/                   crate ontos-cli, [[bin]] name="ontos" (the repo's first binary)
    go/cmd/ontos/         package main, under the existing module
    ts/                   pkg @bitspark/ontos-cli, "bin": { "ontos": … }
  docs/spec/ontos-cli.md  the language-neutral CLI CONTRACT (the source of truth)
  tools/                  MAINTAINER tooling — NOT the value model, NOT tri-core
    conformance/          ontos-conformance: the differential harness (drives the 3 CLIs)
    vector/               ontos-vector: the map/set byte-form generator
```

The discipline that makes this consistent with the floor:

- **`cli/` is tri-core, no favored language.** The `ontos` command ships in
  `go`/`rs`/`ts` as peers, each a normal workspace member (Cargo member, a `package
  main` under the single Go module, an npm `bin` package). All three implement
  [`docs/spec/ontos-cli.md`](../spec/ontos-cli.md); parity is **vector-pinned** by
  the differential harness, exactly as `core`/`codec`/`data` parity is. No binary is
  "the canonical implementation" — the contract + `vectors/` are.
- **`tools/` is maintainer machinery, off the top level.** The harness and the
  generator are *orchestrators/derivers*, not the value model, so each may be a
  **single** tool in one language (favoring a language for a test driver is fine).
  The one guard: the vector generator's output is CI-cross-checked against **all
  three** encoders, so no single language becomes the map/set "byte authority".
- **Fuzzing colocates** with the code it fuzzes (`codec/<lang>` fuzz targets), not a
  standalone component.
- Wiring: `cli/rs` joins the Cargo workspace `members`; `cli/ts` joins the npm
  `workspaces`; `cli/go` needs no `go.mod` change (single module). Consumers of the
  libraries never pull the CLI unless they explicitly install it.
