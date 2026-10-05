# Consuming `ontos-over-deixis-v1`

The profile itself is specified in [PROJECTION.md](PROJECTION.md). That is the normative
document; this file is only about getting it and calling it.

The profile bridges ontos values and [deixis](https://github.com/Bitspark/deixis) trees. Its
faces are conformant against the same hand-authored vectors in
[`vectors/ontos-projection.json`](vectors/ontos-projection.json):

| face | path | how to get it |
| --- | --- | --- |
| Go | [`go/`](go/) | `github.com/bitspark/ontos/projection/deixis/go`, from the Go module proxy |
| Rust | [`rs/`](rs/) | `bitspark-ontos-deixis-projection`, from crates.io (from v0.14.0) |
| TypeScript | [`ts/`](ts/) | `@bitspark/ontos-deixis-projection`, from npmjs (from v0.14.0) |

Every face generates κ (the key of a tuple's `i`-th child) from the same `deixis-pos` code: κ is
the profile's spine, so every face pins the **same deixis revision**, today `0.6.0`, exactly.

deixis's **mandatory node values** model fixes the bridge's codomain: every node carries an own
value independently of its children, so the profile targets **`Node[Option[Bytes]]`**.
`Option` is the bridge's chosen payload, not a deixis feature. See
[PROJECTION.md](PROJECTION.md#the-codomain-nodeoptionbytes).

**The bridge stays optional.** `ontos/core` does not depend on this profile or on deixis. The
Go face is a separate module and the Rust face a separate crate, so an ordinary ontos consumer
acquires no deixis dependency by importing `core`, `codec`, `data` or `data-json`. The
dependency direction is `ontos → deixis`, one-way, and only along this edge.

## Go

The Go face is a nested module, versioned by a path-prefixed tag cut at the same commit as each
ontos release: `projection/deixis/go/v0.13.0` goes with `v0.13.0`.

```sh
go get github.com/bitspark/ontos/projection/deixis/go@v0.13.0
```

```go
import (
	core "github.com/bitspark/ontos/core/go"
	projection "github.com/bitspark/ontos/projection/deixis/go"
)

node := projection.Project(value)          // P — TOTAL, cannot fail
value, err := projection.Recognize(node)   // R — PARTIAL, exact or refusal
```

`projection.Node` is `deixis.Node[[]byte]`. A refusal returns `*projection.Unrecognized`,
carrying the ontos index `Path` to the offending node and a `Reason`.

> **Do not branch on the `Reason` text.** It is informative, not normative
> ([PROJECTION.md §Vectors](PROJECTION.md)): conformance is the *refusal*, not the wording, and
> two conforming faces are free to word it differently. Branch on the error being non-nil, or
> on `Path`.

## Rust

```toml
[dependencies]
ontos-deixis-projection = { package = "bitspark-ontos-deixis-projection", version = "0.14.0" }
```

The library name is `ontos_deixis_projection`. The crate pulls deixis's `bitspark-deixis-core`
and `bitspark-deixis-pos` (imported as `deixis_core` and `deixis_pos`) from crates.io at exactly
`0.6.0`. Keep the rest of your graph's ontos on the same version
(see [docs/distribution.md](../../docs/distribution.md)).

## TypeScript

```sh
npm install @bitspark/ontos-deixis-projection
```

```ts
import { project, recognize } from "@bitspark/ontos-deixis-projection";

const node = project(value);    // P: total, cannot fail
const back = recognize(node);   // R: partial, throws an Unrecognized refusal
```

It depends on `@bitspark/ontos-core` and on `@bitspark/deixis-core` and `@bitspark/deixis-pos`,
pinned exactly at `0.6.0`. It is browser-compatible: no Node-only imports.

## What you are relying on

The profile is **additive**. It changes nothing in `ontos/core` or `ontos-codec-v1`, both
frozen, and it defines no equality of its own: identity stays at L0. Its one byte-level claim is
compositional:

```text
toOntosBytes(P(v)) = encodeOntosV1(v)     byte for byte
```

**Maturity: unwitnessed, permanently.** Every face was written by ontos's own authors, so the
faces are independent of each other's *code* (the Go face was written from `PROJECTION.md`
alone) but not of the organisation that wrote them. A second witness by an implementer outside
ontos was sought, and the one eligible candidate's seal (writing `P` and `R` from
`PROJECTION.md` alone, having read neither the faces nor the vectors) was deliberately left
unspent. Treat cross-implementation agreement here as evidenced by the vectors rather than
proven by independent derivation, and treat that as the settled ceiling, not a pending gap.
