# `limit-policy`: the generated decode-limit tests

`tools/limit-policy/gen.mjs` is a small, dependency-free Node ESM **maintainer tool**. It
generates the corpus behind two generated tests of decode-limit reporting
([ontos-codec §4.2](../../docs/spec/ontos-codec.md), Testing;
[design record 0009](../../docs/design/0009-generated-limit-policy-tests.md);
[issue 13](https://github.com/Bitspark/ontos/issues/13)). Each face's own limits test
replays that corpus through its library decoder. No CLI and no adapter process is
involved.

## The two tests

| test | what the corpus gives | what every face must do |
| --- | --- | --- |
| **agreement-zone differential** | a small valid encoding, exactly one bound (`lowered`) set to a value, every other bound absent or at least the value's need, and the one expected outcome | produce that outcome: accept when the lowered bound is at least the value's need, else `limit_exceeded` with that bound's kind |
| **metamorphic** | a valid value, nothing else | decode it under the shipped defaults (it must accept), measure the decoded value's depth, longest atom and widest tuple, accept with every bound at exactly its need, and report a bound's kind when that bound is lowered below its need (to `need − 1` and to 0, the others at their defaults or at their needs) |

Inside the zone, an outcome is a function of the input and the settings alone. No other
bound can fire, no byte-contract code can (the input is valid), and `native_width` cannot
(every length and arity is tiny). So faces that each produce the one expectation also
agree with each other. Outside the zone, §4.2's observational rule allows faces to differ,
which is why no case sets two bounds below their needs, uses a malformed input, or comes
near a native width.

Each judgment requires exactly the expected outcome. An acceptance must re-encode to the
input bytes, and a rejection must be a decode error with code `limit_exceeded` and the
expected kind. Anything else fails the test: another error, a missing or different kind,
or a different datum. A crash fails the test process. A hang fails the run through
`go test`'s timeout and the CI job timeouts.

The faces' tests, and how to run one alone:

| face | tests | alone |
| --- | --- | --- |
| Go | `TestLimitPolicyDifferential`, `TestLimitPolicyMetamorphic` in `codec/go/limits_test.go` | `go test -run '^TestLimitPolicy' -v ./codec/go` |
| Rust | `limit_policy_differential`, `limit_policy_metamorphic` in `codec/rs/tests/vectors.rs` | `cargo test -p bitspark-ontos-codec --test vectors limit_policy -- --nocapture` |
| TypeScript | `limit policy: …` in `codec/ts/test/limits.test.ts` | `node --test --test-name-pattern '^limit policy' codec/ts/test/limits.test.ts` |
| Python | `LimitPolicyTests` in `codec/py/test/test_limits.py` | `python3 codec/py/test/test_limits.py -k LimitPolicy` |

Each test prints how many cases it judged, broken down by outcome. Go prints with `-v`,
and Rust with `--nocapture`.

## Where it runs

- **`scripts/check.sh test`** replays the committed corpus,
  [`vectors/codec-limits.generated.json`](../../vectors/codec-limits.generated.json), in
  all four faces. That includes Rust on wasm32 (a 32-bit `usize`) and Go `GOARCH=386`,
  the targets where native widths differ.
- **`scripts/check.sh vectors`** regenerates the committed corpus from its pinned seed and
  fails if the file has drifted.
- **`scripts/check.sh fuzz`** generates a fresh corpus (`--seed fresh`, or `FUZZ_SEED`)
  and replays it through the same four tests, Go at both widths. The tests read the corpus
  that `ONTOS_LIMIT_POLICY_CORPUS` names.

`scripts/check.ps1` mirrors all three.

## Running the generator

```sh
node tools/limit-policy/gen.mjs                       # rewrite the committed corpus (pinned seed 13)
node tools/limit-policy/gen.mjs --seed fresh --out /tmp/c.json
node tools/limit-policy/gen.mjs --seed 0x2a --differential 4000 --metamorphic 800 --out /tmp/c.json
ONTOS_LIMIT_POLICY_CORPUS=/tmp/c.json go test -count=1 -run '^TestLimitPolicy' -v ./codec/go
```

- `--seed <u64>|fresh`: `fresh` derives a seed from `$GITHUB_SHA` when it is set, else
  from the clock. The effective seed is always printed, and replaying it gives the same
  corpus.
- `--differential <N>` and `--metamorphic <N>`: the two section sizes. The defaults, 384
  and 128, are the committed corpus's. Each section has its own random stream, so changing
  one count leaves the other section unchanged.
- `--out <path>|-`: where to write. The default is the committed file.

Give `ONTOS_LIMIT_POLICY_CORPUS` an absolute path, because each face's test runs from its
own directory.

## Why to trust the corpus

The generator encodes with its own encoder, so it depends on no face. It computes each
value's needs from the tree it built and again from the bytes, with an independent reader.
It refuses to write a case in four situations:

- the two computations disagree;
- the bytes are not exactly one value;
- a setting leaves the zone (another bound below its need, a bound past `2^31 − 1`, or an
  input over 1024 bytes);
- the corpus leaves an outcome unexercised.

The committed file is a generated artifact. Its oracle is the zone's rule, which the
generator applies and checks.

## It is verified to fail

Before this landed, each of these was put into a face's decoder, and the new tests caught
it:

- Go's atom bound off by one (`>=` for `>`);
- Rust's arity bound reported as `atom_bytes`;
- TypeScript's depth bound off by one;
- Python skipping the arity check at arity 1.

The restored decoders pass. Fresh seeds at 4000 differential cases and 800 metamorphic
values each also found no divergence (design record 0009, §5).
