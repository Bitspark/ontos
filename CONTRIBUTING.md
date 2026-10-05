# Contributing

ontos is small on purpose, and most of what a contributor needs to know follows from
that. Read this page before opening a pull request.

## The rule that declines the most changes

**ontos carries values and never meaning.** Its floor, L0, is one carrier,
`Value = Atom(bytes) | Tuple(Value*)`, with structural identity and nothing else: no
scalars, no variables, no schema ([docs/spec/ontos-core.md](docs/spec/ontos-core.md)).
A change belongs here only if it can be stated without saying what a value *means*. If
explaining it needs the vocabulary of truth, authority, storage, time or validation, it
belongs in a layer above this one.

The layers above L0 inside ontos are conservative extensions. L1, the compound reading,
and L2, the registered embeddings (`int`, `utf8-text`, `bool`, `list`, `map`, `set`,
`decimal`, `null`), add readings that project totally back to L0 values. They fix one
canonical *spelling* for each datum, and they never define an equality of their own:
equality is L0's, everywhere. A change that cannot be expressed as L0 values is a fork,
not a layer. The [design records](docs/design/) show the criterion applied.

The core, the codec and the embeddings have **no runtime dependency outside this
repository**: each language uses its standard library. The one exception is the deixis projection under
[projection/deixis/](projection/deixis/), which depends on deixis and lives in its own Go
module and Rust crate so that nobody who imports the core gets deixis with it. A change
that adds a dependency needs a reason in the pull request.

## Frozen means frozen

- **L0 is frozen.** The value set and its identity do not change.
- **`ontos-codec-v1` is frozen.** Consumers sign and hash over its bytes, so a change to
  the byte mapping would break every signature and every hash above it. A change to the
  encoding is a new codec version with its own name (`ontos-codec-v2`) and an explicit
  migration, never an edit to v1 ([docs/spec/ontos-codec.md](docs/spec/ontos-codec.md) §7).
  A fix that brings an implementation back into line with the specification is welcome.
- **The v1 embeddings are frozen**, by the same reasoning: their canonical forms are bytes
  that consumers have already signed.

## Four languages, one byte string

A behavior change exists in **every language that carries the part it touches**, or it
does not land: all four (Go, Rust, TypeScript and Python) for `core/`, `codec/`, `data/`
and `cli/`, and the languages present in the directory for the rest. Go, Rust and
TypeScript are the published libraries; Python is a stdlib-only implementation that
validates the claim that no language is favored. The four are held byte for byte to one
corpus in `vectors/`, and the differential harness drives all four CLIs over it and fails
on any byte that differs. A change that makes the implementations disagree is not a failing test; it is the
bug this repository exists to prevent.

**Changing a vector is a bigger act than changing code.** The corpus is a published oracle
that other implementations check themselves against. A new case is welcome. A case is
computed from the specification, never copied from an implementation's output, and
changing what an existing case *means* needs to be argued in the pull request. The map and
set vectors are generated from a hand-written source by `tools/vector/gen.mjs`; regenerate
them rather than editing the output.

## The specification decides

The normative surface is [docs/spec/](docs/spec/): the value model, the codec, the compound
reading, the embeddings, the JSON projection, the conformance protocol and the CLI
contract. When code and specification disagree, the specification is right until a pull
request changes it, and a behavior the specification does not state starts as a change to
the specification.

## Landing a change

- `main` takes no direct push. A change is a branch, a pull request and green checks, and
  it lands as a squash merge. Prefix the title with the part it touches: `core:`,
  `codec:`, `data:`, `cli:`, `tooling:`, `vectors:`, `CI:` or `Docs:`.
- Run the checks before you push. `scripts/check.sh <target>` (`scripts/check.ps1` on
  Windows) runs the checks CI runs, one target per concern: `lint`, `test`, `vectors`,
  `conformance`, `producer` and `fuzz`, or `all` for everything but `fuzz`. Each CI job
  calls the same script with one of those targets.
- The toolchains are Go (the version in `go.mod`), Rust (pinned by `rust-toolchain.toml`),
  Node 24 and Python 3.13.
- A vulnerability is reported the way [SECURITY.md](SECURITY.md) says, never in an issue.

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the license this repository carries.
