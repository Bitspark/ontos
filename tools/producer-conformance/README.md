# `producer-conformance` — the host-value → L2 differential runner

`tools/producer-conformance/run.mjs` is a small, dependency-free Node ESM
**maintainer tool**. It is the sibling of [`tools/conformance`](../conformance/), and
it exists because that one cannot see this step.

## The gap it closes

[`tools/conformance`](../conformance/) has two input modes and **both start from a
value that already exists at L0** — raw hex, or the authoring notation
(`{"atom":"<hex>"}` / `{"tuple":[…]}`). It can construct an **L0 value**; it can never
construct a **host value**: a Go `string`, a Python `int`, a TypeScript `number`, a
Rust `&str`.

```text
host value  ──[ producer ]──>  L2 value  ──[ codec ]──>  bytes
            ^^^^^^^^^^^^^^^                ^^^^^^^^^^^^^^^^^^^
              THIS TOOL                    tools/conformance + vectors/
```

So the `host value → L2` step sat below the byte harness's floor **by construction** —
which is why four implementations disagreed under a green CI (ontos-internal#196). The step was
never asked about. This tool asks.

It cannot be replaced by adding vectors: a vector is a value or a byte string, and the
thing that differs here is *what each language's producer does with a host value it
should not accept*.

## What it asserts

Per case, each applicable language builds the host value **natively** from a recipe
(see [PROTOCOL.md](PROTOCOL.md)), runs its blessed producer, and reports canonical
bytes or a classified rejection. Then:

| assertion | what it catches |
|---|---|
| **oracle** | a portable case's bytes equal the **frozen** hex of the `vectors/data.json` entry it cites — expectations are never minted here, so the runner cannot bless its own drift |
| **differential** | every applicable implementation agrees with every other — two impls can both match a stale oracle, but they cannot both match it *and* disagree |
| **§4.1 laws 1/2** | **no implementation may return `ok` for an inadmissible host value**, whatever bytes it carries |
| **§4.1 law 3** | no implementation may leak a non-profile error (reported as `UNCLASSIFIED:<Type>`) |

`unsupported` is **not** a failure. It is how a language reports that the host value is
unconstructible in it — Rust cannot build an invalid `&str`, Go has no UTF-16 string, a
Python `str` cannot hold arbitrary bytes. *Mechanisms may differ; outcome classes may
not.* What no implementation may do is **succeed with a different datum** — the one
failure no downstream reader can ever catch, because the distinguishing fact is the
source value and it is gone by then.

## Running it

```sh
scripts/check.sh producer          # builds the adapters, then runs the suite
node tools/producer-conformance/run.mjs            # all four languages
node tools/producer-conformance/run.mjs ts py      # a subset
```

**Build the adapters first** — `scripts/check.sh producer` does it for you. A `go run`
per case turned a 23-second suite into a 7-minute one.

## It is verified to FAIL

A suite that only ever passes is indistinguishable from one that tests nothing, so both
failure paths were exercised against deliberately broken adapters before this landed:

- an adapter emitting wrong bytes → **19 failures**, reporting both the oracle mismatch
  and the divergence, with the diff
- an adapter returning `ok` for a lone surrogate — *literally TypeScript's behaviour
  before ontos-internal#202* → caught as a §4.1 law-1/2 violation

Both exit non-zero; the restored adapters exit zero. So this suite would have caught
the defects that motivated it.

## Corpus

[`vectors/producer-v1/cases.json`](../../vectors/producer-v1/cases.json). Three
profiles:

- **`portable`** — representable everywhere; all impls must produce the cited frozen bytes
- **`portable-differential`** — representable everywhere and all impls must agree, but no
  frozen vector exists to cite. Weaker on purpose, and labelled so: it catches divergence,
  not a wrong-but-unanimous answer. Prefer `portable` whenever an entry exists.
- **`host`** — pins language-specific *admission*. The outcome class is fixed; the
  mechanism is not.

Text is carried as **arrays of numbers** (Unicode scalar values, or UTF-16 code units),
never as JSON strings — a JSON string cannot portably transport a lone surrogate or
invalid UTF-8, so a string-carried recipe would be silently repaired in transit by
whichever parser touched it. That is the same class of defect this corpus exists to
detect.
