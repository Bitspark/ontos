# Generated limit-policy tests: an agreement-zone differential and a metamorphic relation

**Status: decided, 11 November 2026, while implementing
[ontos issue 13](https://github.com/Bitspark/ontos/issues/13) under the owner's standing
delegation of design decisions. The ontos coordinator reviews it with the change.** The
generator, the corpus, the four faces' tests, the `scripts/check.sh` wiring and the
specification text land together.

## 1. The request

Decode-limit reporting ([ontos-codec §4.2](../spec/ontos-codec.md)) is conformance-tested
by the 13 fixed cases of [`vectors/codec-limits.json`](../../vectors/codec-limits.json),
which every face replays. Issue 13 asks for two kinds of **generated** tests on top of
them. Both stay separate from the byte-result differential fuzz bout, whose
`limit_exceeded` exemption stays as it is.

1. **A policy-reporting differential** inside an *agreement zone*, where the outcome is a
   function of the input and the explicit settings alone. Every face must report the same
   `limit_kind` there. `native_width` stays out of the zone, because it depends on the
   target.
2. **Metamorphic tests on valid inputs.** Take a value a face accepts under permissive
   settings, lower exactly one bound below what the value needs, and expect that bound's
   kind.

A crash, a hang or malformed output fails the run in either mode.

## 2. The agreement zone

A value **needs** three numbers from the decoder's bounds:

| need | definition | bound | kind |
| --- | --- | --- | --- |
| depth | the depth of its deepest value, the root at 0 (codec §4.1) | `maxDepth` | `decode_depth` |
| atom | the byte length of its longest atom, 0 when it has none | `maxAtomBytes` | `atom_bytes` |
| arity | the arity of its widest tuple, 0 when it has none | `maxTupleArity` | `tuple_arity` |

A case is **inside the zone** when:

- its input is a valid canonical `ontos-codec-v1` encoding, at most 1024 bytes, whose
  lengths and arities are at most a few hundred;
- exactly one bound, the *lowered* one, is set to a stated value `L`;
- every other bound is absent, which means the shipped default (depth 1024, the other two
  unbounded), or is set explicitly to at least the value's need for it.

Inside the zone the outcome is

```text
accept                                   when L >= need(lowered)
limit_exceeded with kind(lowered)        when L <  need(lowered)
```

and nothing else is allowed:

- No byte-contract code can fire, because the input is valid.
- No other bound can fire, because each fires only when a depth, length or arity exceeds
  it, and none does.
- `native_width` cannot fire. The narrowest native ceiling is `2^31 − 1`, Go's `int` on a
  32-bit build. Rust's 32-bit `usize` ends at `2^32 − 1`, and TypeScript's ceiling is
  `2^53 − 1`. Every length and arity in the zone is far below all of them.
- So a decoder of a valid input reads every value unless the lowered bound stops it. When
  `L < need`, that bound's check meets the value that exceeds it and fires, and its kind
  is the only one that can be reported. When `L >= need`, no check fires.
- The order of a face's checks, which §4.2 leaves observational, cannot matter, because
  only one check can fire.
- A failure that is not a bound, such as a host recursion limit, an allocation failure or
  an internal fault, is a defect (§4.2), and the run fails.

Setting two bounds below their needs, using a malformed input, or using a length near a
native width each leaves the zone. There §4.2's observational rule allows faces to
differ, so none of those appears in the generated cases.

## 3. Decisions

1. **The faces are driven by a seeded corpus that each face's own limits test replays,
   not by adapter processes.** The four tests that already replay `codec-limits.json`
   gain two tests each:
   - Go: `TestLimitPolicyDifferential` and `TestLimitPolicyMetamorphic` in
     `codec/go/limits_test.go`.
   - Rust: `limit_policy_differential` and `limit_policy_metamorphic` in
     `codec/rs/tests/vectors.rs`.
   - TypeScript: `limit policy: differential, …` and `limit policy: metamorphic, …` in
     `codec/ts/test/limits.test.ts`.
   - Python: `LimitPolicyTests` in `codec/py/test/test_limits.py`.

   The reasons:
   - **It runs on the 32-bit targets.** `scripts/check.sh test` already runs these files
     as Rust on `wasm32-wasip1`, with a 32-bit `usize`, and as Go with `GOARCH=386`. Those
     are exactly the targets where native widths differ, and target-independence is the
     claim the zone makes. Adapter processes would run on the CI host only.
   - **The issue names this drive point.** It asks to "drive it through the library-level
     adapters that replay `codec-limits.json`, not the CLI". Those are these four tests.
   - **Nothing new to build or ship.** There is no new binary, no new workspace crate and no
     protocol to version. A new crate would have to join the private-crate list in
     `.github/workflows/release.yml`. producer-conformance needs adapter processes
     because each language must build a *host value* natively from a recipe. Here the
     input is bytes and three integers, which every face's test already reads from a
     vector file.
   - **The differential is pinned to an oracle, which is stronger than comparing
     outputs.** Inside the zone the expected outcome is computable (§2), so each case
     carries it, and every face is judged against it. Faces that each produce one
     expectation agree with each other. Unlike a comparison of the faces' outputs with
     one another, this also catches an error all four share.

   The costs, accepted:
   - A divergence shows up as failures in separate test logs rather than as one
     side-by-side table. Each failure names the case, the settings, and the expected and
     observed code and kind, and the corpus seed reproduces it.
   - In-process tests have no per-case timeout. A hang still fails the run: through
     `go test`'s default ten-minute timeout, and through the CI job timeouts for Rust,
     TypeScript and Python. A crash fails its test process.
   - The judgment counts every other outcome as **malformed output**, and the run fails on
     it: another error type, `limit_exceeded` without the kind or with another kind, a
     rejection where acceptance is expected, or an acceptance whose value does not
     re-encode to the input bytes.

2. **The generator is [`tools/limit-policy/gen.mjs`](../../tools/limit-policy/gen.mjs).**
   It is dependency-free Node, a pure function of a seed and two counts, and uses the same
   64-bit LCG as `tools/fuzz/gen.mjs`.
   - It encodes with its own encoder, so it depends on no face.
   - **Shapes.** Random small trees, an atom whose length needs a two-byte uvarint
     (128–200), a tuple whose arity does (128–140), and spines of tuples up to 30 levels
     deep (80 in the metamorphic section).
   - **The lowered bound** is weighted toward the boundary: `need − 1`, `need`, below,
     above, and 0. **The other bounds** are absent, exactly at their need, or above it.
   - **Self-checked.** It computes each value's needs from the tree it built and again from
     the bytes, with an independent reader. It refuses to write a case when the two
     disagree, when the bytes are not exactly one value, when a setting leaves the zone,
     or when a corpus would leave an outcome unexercised.

3. **The committed corpus is
   [`vectors/codec-limits.generated.json`](../../vectors/codec-limits.generated.json).**
   - It is written from the pinned seed 13 with 384 differential cases and 128
     metamorphic values, about 156 KB, one case per line.
   - Its `differential` cases have `codec-limits.json`'s shape (`name`, `hex`, `limits`,
     `expect`) plus `lowered`, so each face judges both files with one function.
   - Its `metamorphic` entries are values only (`name`, `hex`).
   - It records its seed and counts.
   - It is a generated artifact, not a hand-authored oracle. The oracle is §2's rule,
     which the generator applies and checks.

4. **The metamorphic relation is derived inside each face, from that face's own
   behavior.** For each value, the face:
   - decodes it under the shipped defaults, which must accept it, with a value that
     re-encodes to the same bytes;
   - computes the decoded value's three needs with its own walk;
   - expects acceptance with every bound at exactly its need;
   - for each bound whose need is at least 1, lowers it to `need − 1` and to 0, with the
     other bounds at their defaults or at their needs, and expects that bound's kind.

   No expectation comes from the corpus. The values include the empty atom and the empty
   tuple, atoms of 127 and 128 bytes, a 128-wide tuple, and chains up to and including
   1024 levels, which is the shipped depth default. Every input is valid. On a malformed
   input, loosening a limit can correctly reveal a later normative rejection, so the
   relation does not hold there.

5. **It reaches CI through existing `scripts/check.sh` targets.** `scripts/check.ps1` mirrors
   each one.
   - `vectors` regenerates the corpus from its pinned seed and fails if it has drifted.
     The regeneration re-runs the self-check on every committed case.
   - `test` replays the committed corpus in all four faces, including Rust on wasm32 and
     Go `GOARCH=386`. No wiring change was needed, because the tests live in files that
     target already runs.
   - `fuzz` generates a **fresh** corpus and replays it through the same four tests. The
     seed follows the bout's rules: `FUZZ_SEED` pins it, else it derives from
     `GITHUB_SHA`, else from the clock, and the generator prints it. The tests read the
     corpus that `ONTOS_LIMIT_POLICY_CORPUS` names. Go runs at both widths. Rust's wasm32
     leg stays in `test`, because the `fuzz` job has no wasmtime.
   - Each test prints how many cases it judged, broken down by outcome.

6. **Unchanged.**
   - The judgment of `tools/fuzz/bout.mjs` and `tools/conformance/run.mjs`, and the bout's
     equality-only `limit_exceeded` exemption.
   - The CLIs and their output.
   - The 13 cases of `codec-limits.json`. Each face now judges them with the shared
     function, which adds the re-encoding check on acceptance.
   - Every decoder.
   - `native_width`, which each face still tests in its own suite.

## 4. Why not the alternatives

- **Adapter processes like `tools/producer-conformance`.** These would give a
  side-by-side report and a per-case timeout. They would also cost:
  - four new programs and their build steps;
  - a Rust crate, and with it a workflow edit;
  - a batch protocol, since one process per case is slow, which producer-conformance's
    README records: a `go run` per case turned 23 seconds into 7 minutes;
  - and above all, no 32-bit coverage.
- **Each face generating its own cases from a shared seed.** That needs four generators
  that agree bit for bit. A generator divergence would look exactly like a decoder
  divergence.
- **A mode of the fuzz bout.** The bout compares CLI output, and the CLIs report the code
  only, by design (codec §4.2 Testing). Its judgment must not change.

## 5. Evidence at landing

- **Counts.** On the committed corpus, every face judges 384 differential cases (accept
  184, `decode_depth` 45, `atom_bytes` 99, `tuple_arity` 56). For the metamorphic
  relation it judges 128 values with 1288 decodes (accept 256, `decode_depth` 296,
  `atom_bytes` 434, `tuple_arity` 302). This holds for Go at 64 and 32 bits, Rust on
  x86_64 and on wasm32, TypeScript and Python.
- **Sweep.** Before landing, fresh seeds 100–159 and 1000–1079 ran at 4000 differential
  cases and 800 metamorphic values each, through Go at 64 and 32 bits, Rust on x86_64,
  TypeScript and Python. No face diverged inside the zone.
- **Negative controls.** Each was put into a face's decoder, and the new tests caught it:
  - Go's atom bound off by one;
  - Rust's arity bound reported as `atom_bytes`;
  - TypeScript's depth bound off by one;
  - Python skipping the arity check at arity 1.
