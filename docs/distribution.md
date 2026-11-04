# ontos — distribution

ontos is published from this repository to the public registries of each language. No
credential is needed to install any of it.

| Ecosystem | Packages | From |
| --- | --- | --- |
| TypeScript | `@bitspark/ontos-core`, `@bitspark/ontos-codec`, `@bitspark/ontos-data`, `@bitspark/ontos-data-json` | npmjs, with provenance |
| TypeScript | `@bitspark/ontos-deixis-projection`, the `ontos-over-deixis-v1` bridge (from v0.14.0) | npmjs, with provenance |
| TypeScript | `@bitspark/ontos-wire`, the optional mixed profile and compact native realization (from v0.16.0) | npmjs, with provenance |
| Rust | `bitspark-ontos-core`, `bitspark-ontos-codec`, `bitspark-ontos-data`, `bitspark-ontos-data-json` | crates.io |
| Rust | `bitspark-ontos-deixis-projection`, the `ontos-over-deixis-v1` bridge (from v0.14.0) | crates.io |
| Go | `github.com/bitspark/ontos/{core,codec,data,data/json}/go` | the Go module proxy (one module, `github.com/bitspark/ontos`) |
| Go | `github.com/bitspark/ontos/projection/deixis/go`, the `ontos-over-deixis-v1` bridge | a nested module, tagged `projection/deixis/go/vX.Y.Z` at the same commit as each release |
| Go | `github.com/bitspark/ontos/wire/go`, the optional mixed profile and compact native realization | a nested module, tagged `wire/go/vX.Y.Z` at the same commit as each release |

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
  "@bitspark/ontos-core":  "^0.16.0",
  "@bitspark/ontos-codec": "^0.16.0",
  "@bitspark/ontos-data":  "^0.16.0"
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
ontos-core  = { package = "bitspark-ontos-core",  version = "0.16" }
ontos-codec = { package = "bitspark-ontos-codec", version = "0.16" }
ontos-data  = { package = "bitspark-ontos-data",  version = "0.16" }
```
```rust
use ontos_core::Value;
```

**One ontos per Rust dependency graph.** Cargo treats two sources of ontos as two crates, so a
graph that pulls ontos from crates.io in one place and from a git dependency (or an
incompatible version) in another links two different `ontos_core::Value` types, and any
boundary that passes a `Value` fails with "expected `Value`, found `Value`". Keep every ontos
dependency in the graph, transitive ones included, on one compatible version from one source.
Go uses one module path per value family. TypeScript also needs one compatible package
instance wherever native class identity crosses a boundary; npm deduplication alone cannot
reconcile the former bitwire mirror with public ontos classes.

**Go:**

```sh
go get github.com/bitspark/ontos@v0.16.0
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

### First publication of a new npm name

npm requires an existing package before its trusted publisher can be configured.
For a new name, the same release rehearsal builds the exact archive and signs an
external provenance bundle on the GitHub-hosted runner. The bundle contains one
npm purl and the archive's SHA-512 digest, the actual checked-out release commit,
and the workflow/run identity. Signature and exact certificate identity are
verified before the bundle is saved beside the archive. No npm credential is
needed to produce this evidence.

After reviewed green-main integration and successful rehearsal, the release
operator can use normal native npm authentication and its provider MFA to publish
that unchanged archive with `--provenance-file=<archive>.sigstore.json`,
`--access=public` and `--ignore-scripts`. First verify the artifact's run/commit,
subject, signature and byte digest. Never rebuild or edit the downloaded archive,
generate provenance locally or simulate a CI identity. The manifest of a new
bootstrap package must leave `publishConfig.provenance` unset: npm treats its
automatic-provenance setting and `provenance-file` as mutually exclusive.

Configure the exact package's GitHub repository, release workflow and environment
publisher after it exists. Normal publication continues through `release.yml`
with its explicit `--provenance` flag; it compares and reuses identical already
published artifacts and completes registry and installed-consumer verification.
The bootstrap is not complete merely because npm accepted an upload. Record the
registry integrity and attestation, trusted-publisher read-back and outside
consumer result. This path avoids a reusable bootstrap token while retaining
the release's provenance requirement.
