# ontos — distribution

ontos is published from this repository to the public registries of each language. No
credential is needed to install any of it.

| Ecosystem | Packages | From |
| --- | --- | --- |
| TypeScript | `@bitspark/ontos-core`, `@bitspark/ontos-codec`, `@bitspark/ontos-data`, `@bitspark/ontos-data-json` | npmjs, with provenance |
| TypeScript | `@bitspark/ontos-deixis-projection`, the `ontos-over-deixis-v1` bridge (from v0.14.0) | npmjs, with provenance |
| Rust | `bitspark-ontos-core`, `bitspark-ontos-codec`, `bitspark-ontos-data`, `bitspark-ontos-data-json` | crates.io |
| Rust | `bitspark-ontos-deixis-projection`, the `ontos-over-deixis-v1` bridge (from v0.14.0) | crates.io |
| Go | `github.com/bitspark/ontos/{core,codec,data,data/json}/go` | the Go module proxy (one module, `github.com/bitspark/ontos`) |
| Go | `github.com/bitspark/ontos/projection/deixis/go`, the `ontos-over-deixis-v1` bridge | a nested module, tagged `projection/deixis/go/vX.Y.Z` at the same commit as each release |

Every lane carries the release's number: the TypeScript packages and the crates are versioned
`X.Y.Z` for the repository tag `vX.Y.Z`, and the Go modules resolve at the tag. The first public
release is **v0.13.0**.

**No byte mapping changes between releases.** `ontos-codec-v1` is frozen
([`spec/ontos-codec.md`](spec/ontos-codec.md)): a change to the byte mapping would ship as a new
codec version, never as an edit. Upgrading ontos never changes the bytes of a value you already
store, hash or sign.

**The deixis projection** is published in all three languages from v0.14.0. Its Go face has been
published since the first release; its TypeScript package and Rust crate waited for deixis to
reach npmjs and crates.io. Every face pins deixis exactly (`0.6.0`), because κ, the key of a
tuple's `i`-th child, must come from the same code in every face.

## Consume

**TypeScript:**

```jsonc
"dependencies": {
  "@bitspark/ontos-core":  "^0.14.0",
  "@bitspark/ontos-codec": "^0.14.0",
  "@bitspark/ontos-data":  "^0.14.0"
}
```
```ts
import { atom, tuple, equals } from "@bitspark/ontos-core";
import { encode, decode } from "@bitspark/ontos-codec";
import { encodeInt, readInt } from "@bitspark/ontos-data";
```

**Rust.** The crates carry the vendor prefix, because crates.io has one flat namespace; the
library names do not, so the code you write is the same:

```toml
[dependencies]
ontos-core  = { package = "bitspark-ontos-core",  version = "0.13" }
ontos-codec = { package = "bitspark-ontos-codec", version = "0.13" }
ontos-data  = { package = "bitspark-ontos-data",  version = "0.13" }
```
```rust
use ontos_core::Value;
```

**One ontos per Rust dependency graph.** Cargo treats two sources of ontos as two crates, so a
graph that pulls ontos from crates.io in one place and from a git dependency (or an
incompatible version) in another links two different `ontos_core::Value` types, and any
boundary that passes a `Value` fails with "expected `Value`, found `Value`". Keep every ontos
dependency in the graph, transitive ones included, on one compatible version from one source.
Go's minimal version selection and npm's deduplication make this a Rust-specific concern.

**Go:**

```sh
go get github.com/bitspark/ontos@v0.14.0
```
```go
import (
    core  "github.com/bitspark/ontos/core/go"
    codec "github.com/bitspark/ontos/codec/go"
    data  "github.com/bitspark/ontos/data/go"
)
```

## Verify what you installed

Every face replays the same conformance corpus in [`vectors/`](../vectors/). Running it against
an installed version is the strongest check there is that a face agrees with the others byte for
byte; the [conformance spec](spec/ontos-conformance.md) describes the protocol, and
`scripts/check.sh conformance` runs it from a clone.

## How a release is made

[`release.yml`](../.github/workflows/release.yml) publishes a tagged release: the npm packages to
npmjs with provenance, and the crates to crates.io, both by trusted publishing, so no long-lived
token exists. Every run waits on the `release` environment, a dispatched rehearsal publishes
nothing, and each release ends with a round trip that installs what it published. The Go
modules need no publish step: a Go module is its repository, and the tag is the release.
