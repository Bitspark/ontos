# ontos — private distribution

> **Superseded on 2026-10-05.** ontos became a public repository, published to npmjs
> and crates.io and fetched from the Go module proxy. This record is kept as the
> history of the private distribution that preceded it. The current distribution is
> [docs/distribution.md](../distribution.md).

**Status:** decided. Records how each language's ontos packages are published
and consumed *privately*, so that other Bitspark repos (logos, arche) can depend
on them without ontos ever becoming public. The mechanism differs per ecosystem;
the through-line is **one repo-wide semver tag per release**
(`vMAJOR.MINOR.PATCH`, first `v0.1.0`) that every language pins to.

This is ontos's *instance* of the org-wide private-distribution **strategy**.
The single canonical how-to is the Bitspark playbook (Bitspark/logos
`docs/guides/private-packages.md`, which operationalizes logos ADR 0005);
ontos-specific consume snippets and build wiring are in
[`docs/distribution.md`](../distribution.md). Both ADRs point at the one playbook.

## Converged standards

One standard, not one-per-lane — matching the playbook:

- **Two tokens, by intent.** *Reads* use one org-provisioned, **read-only** secret,
  `BITSPARK_CI_TOKEN` (`repo` + `read:packages`): Rust/Go git fetches and TS
  installs. *Writes* — publishing TS to GitHub Packages — use this repo's built-in
  `GITHUB_TOKEN` (`packages: write`). The shared secret deliberately carries no
  `write:packages`, so it can never publish or overwrite. (ontos's own publish
  needs no read token at all: its codec→core dependency is an in-repo workspace,
  resolved locally.)
- **One pin model.** Every ecosystem pins the same per-release tag `vX.Y.Z` — TS
  through its published version, Rust and Go through the git tag.
- **One git-auth method.** HTTPS + `BITSPARK_CI_TOKEN` via `url.insteadOf` — no SSH
  keys, so the one read token covers git fetches and package installs alike.
- **One canonical guide.** The Bitspark playbook
  (Bitspark/logos `docs/guides/private-packages.md`), referenced by the strategy
  ADR 0005 and by this instance ADR.

## The shared anchor: one tag per release

ontos ships as a single versioned unit cut from `main`. A GitHub *Release* on a
`vX.Y.Z` tag is the event that (a) triggers the npm publish workflow and (b)
gives Rust and Go consumers a stable ref to pin. Keeping core, codec, and every
language on the same tag is what preserves the "one model, everywhere" promise
across ecosystems — a consumer never has to reconcile per-language versions.

## TypeScript — GitHub Packages (`npm.pkg.github.com`)

The `@bitspark`-scoped packages publish to GitHub Packages, a private registry
gated by org membership — *not* the public npm registry. Privacy comes from
GitHub Packages permissions, **not** from npm's `private` field (that field only
blocks `npm publish`, and must be absent for a package to publish at all).

- Publisher:
  `.github/workflows/publish-npm.yml`,
  on a published Release (or manual dispatch), authenticated by this repo's
  built-in `GITHUB_TOKEN` (`packages: write`) — the write side of the two-token
  split.
- Consumer (e.g. logos-contract, arche-core): an `.npmrc` pointing the `@bitspark`
  scope at GitHub Packages, authenticated by the read-only `BITSPARK_CI_TOKEN`
  (`read:packages`).

  ```ini
  # .npmrc
  @bitspark:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${BITSPARK_CI_TOKEN}
  ```
  ```jsonc
  // package.json
  "dependencies": { "@bitspark/ontos-core": "^0.1.1" }
  ```

Packages: `@bitspark/ontos-core` and `@bitspark/ontos-codec`. The codec is the
first package with an intra-repo dependency; it imports `@bitspark/ontos-core`
**by name**, and an npm-workspaces root ([`package.json`](../../package.json))
makes that name resolve to `core/ts` in-repo — so the source and the published
artifact carry the identical import. Each package ships **only** its compiled
`dist/` via a `files` allowlist: the repo-root `.gitignore` excludes `dist/`, so
without the allowlist a publish would ship a codeless package. The publish
workflow is idempotent per version. The operational detail — build order, the
no-auth `npm ci` in the vector runner, the consumer `.npmrc` — lives in the
[distribution guide](../distribution.md).

## Rust — git dependencies pinned to a tag

There is no public crates.io release. Consumers depend on the crates **by git
ref** against the private repo, authenticated over HTTPS with `BITSPARK_CI_TOKEN`
(`url.insteadOf`, the same single-token method as Go). Cargo resolves the
`ontos-codec → ontos-core` workspace `path` dependency inside the checked-out
repo, so **no registry and no manifest change is required**.

```toml
# consumer Cargo.toml
ontos-core  = { git = "https://github.com/Bitspark/ontos.git", tag = "v0.1.1" }
ontos-codec = { git = "https://github.com/Bitspark/ontos.git", tag = "v0.1.1" }
```

Optional future hardening: add `version = "0.1.1"` beside the in-repo `path` dep
so the crates could also feed a private cargo registry later. Not needed for git
consumption.

## Go — `GOPRIVATE` + git auth, pinned to a tag

Go has no registry to publish to; a module *is* its repo. Private consumption is
two consumer-side settings plus the shared tag:

```sh
go env -w GOPRIVATE=github.com/bitspark/*
# one token over HTTPS for git + packages:
git config --global url."https://x-access-token:${BITSPARK_CI_TOKEN}@github.com/".insteadOf "https://github.com/"
```
```go
import (
    core  "github.com/bitspark/ontos/core/go"
    codec "github.com/bitspark/ontos/codec/go"
)
```
```sh
go get github.com/bitspark/ontos/core/go@v0.1.1
```

`GOPRIVATE` keeps the module off the public proxy and checksum database and tells
`go get` to fetch it straight from GitHub over the consumer's git credentials.
The import path carries the `core/go` · `codec/go` suffix from the layer×language
layout ([0004](0004-repo-layout.md)); both packages live in the single root
module `github.com/bitspark/ontos`.

## What adopting workspaces cost

Wiring `@bitspark/ontos-codec`'s dependency by name required an npm-workspaces
root, which trades away the TS vector runner's former "no npm install, no build
step" property: the runner now does `npm ci` and builds `core/ts` into `dist/`
before replaying vectors (vectors.yml).
The codec and its tests still execute straight from `.ts` source via Node's
native type stripping — only the cross-package model import is resolved through
the workspace. This was judged worth it: the codec is the floor's canonical byte
encoding and must be consumable as a *published* package exactly like core, not
only as in-repo source. The codec previously carried `"private": true` (an
npm-level publish block, distinct from registry privacy); that flag is removed.
