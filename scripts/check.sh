#!/usr/bin/env bash
# Local CI mirror (ontos-internal#70). Runs the SAME checks the GitHub workflows run, one
# command per concern, against the CURRENT checkout (this worktree, not main):
#
#   test         rust + go + ts + py unit/vector tests   (.github/workflows/ci.yml)
#   lint         gofmt+vet · cargo fmt+clippy · tsc      (.github/workflows/ci.yml)
#   conformance  build the CLIs FRESH, run the harness over all 4 impls
#                (.github/workflows/ci.yml)
#   fuzz         go native FuzzDecode + FuzzData + the 4-CLI differential bout
#                (.github/workflows/ci.yml)
#   vectors      regenerate map/set vectors, assert no drift (.github/workflows/ci.yml)
#   all          lint + test + vectors + conformance (NOT fuzz — run that separately)
#
# `conformance` rebuilds every CLI before running the differential harness, so a stale
# repo-root binary can never produce a false divergence (ontos-internal#69). This script mirrors
# the workflows; keep the two in sync. Windows: use scripts/check.ps1 (the rust/go
# binaries carry a .exe suffix there).
set -euo pipefail

# Run against the CURRENT working tree's root (unlike worktree.sh, which targets the
# primary checkout) — `check` validates whatever checkout you are developing in.
cd "$(git rev-parse --show-toplevel)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/check.sh {test|lint|conformance|producer|fuzz|vectors|all}
  test         rust + go (incl. nested modules) + ts + py unit/vector tests
  lint         check.sh/.ps1 parity, project-name spelling, gofmt+vet (incl. nested modules), cargo fmt+clippy, tsc --noEmit (discovered)
  conformance  build the CLIs fresh, run the differential harness over all 4 impls (all 3 modes)
  producer     producer-conformance: a HOST value -> L2, all 4 languages (ontos-data.md 4.1)
  fuzz         go native FuzzDecode + FuzzData (FUZZTIME=, default 25s) + the 4-CLI differential bout
  vectors      regenerate the map/set vectors and assert no drift
  all          lint + test + vectors + conformance + producer (fuzz is separate — it is generative)
EOF
  exit 2
}

step() { printf '\n=== %s ===\n' "$1"; }

# Nested go modules are INVISIBLE to `go test ./...` and `go vet ./...` — both walk the MAIN
# module only, so a package with its own go.mod is never compiled, never checked, and the run
# still goes green (ontos-internal#304). The test and lint targets below sweep them explicitly.
#
# DISCOVERED, not enumerated — sets $go_mods. git ls-files finds every nested module at any
# depth, tracked or new; unlike CI's `find` it also skips the gitignored .worktrees/, which
# exists only in a local checkout. The count floor is the positive control: a sweep that finds
# nothing reds the run instead of passing vacuously.
go_nested_mods() {
  mapfile -t go_mods < <(git ls-files --cached --others --exclude-standard -- '*/go.mod' | xargs -n1 dirname | sort -u)
  echo "nested go modules discovered: ${#go_mods[@]}"
  [ "${#go_mods[@]}" -ge 1 ] || { echo "nested go module sweep found none — the sweep is dead, not clean"; exit 1; }
}

# Resolving a nested module can fail for a reason that is not the contributor's fault:
# projection/deixis/go requires github.com/bitspark/deixis, and CI injects
# credentials that someone outside the org does not have. Hard-failing them on a dependency
# they cannot fetch would make `check` useless locally; skipping QUIETLY is how ontos-internal#304 happened
# in the first place. So skip loudly — an unchecked module is a GAP in the signal, not a pass.
go_nested_ok() {
  ( cd "$1" && go list -deps ./... ) >/dev/null 2>&1 && return 0
  echo "  !! SKIPPED: $1 — dependencies do not resolve (offline?)."
  echo "  !! This module was NOT checked by your run: a gap in your signal, NOT a pass."
  echo "  !! CI resolves it from the network and checks it there."
  return 1
}

# Build the TS workspace (core -> codec -> data -> data/json -> projection/deixis -> cli)
# into dist/. `npm ci` relinks the @bitspark/* workspace symlinks the imports resolve
# through (a stale node_modules missing them breaks the cli build — ontos-internal#57), so every
# ts concern starts from it. Every dependency it installs comes from npmjs; no token is needed.
ts_build() {
  npm ci
  # DISCOVERED via the root `workspaces` array — the set's single source of truth,
  # already in dependency order (core -> codec -> data -> data/json -> projection/deixis
  # -> cli). A
  # hand-kept build list silently skips a NEW package (ontos-internal#237: lint's copy of
  # this list missed data/json/ts, so PR CI never typechecked it).
  npm run build --workspaces --if-present
}

do_test() {
  step "rust (cargo test --workspace)"; cargo test --workspace --locked
  # The codec on a 32-bit target (ontos-internal#352). CI fetches a pinned wasmtime; locally this
  # runs only when wasmtime and the wasm32-wasip1 target are already installed, and says
  # so when they are not. Mirrors .github/workflows/ci.yml.
  if command -v wasmtime >/dev/null 2>&1 && rustup target list --installed | grep -qx wasm32-wasip1; then
    step "rust codec on wasm32 (32-bit usize) under wasmtime"
    CARGO_TARGET_WASM32_WASIP1_RUNNER="wasmtime run --dir=$PWD::$PWD" \
      cargo test -p bitspark-ontos-codec --target wasm32-wasip1 --locked
  else
    step "rust codec on wasm32: SKIPPED here (needs wasmtime on PATH and \`rustup target add wasm32-wasip1\`; CI runs it)"
  fi
  step "go (go test -cover ./...)";     go test -cover ./...
  # Executes the 32-bit build (ontos-internal#352). CI can only compile it until the fleet can exec
  # i386 (bitagent-ci); a host without IA32 support fails here with
  # "exec format error", which is that same gap, not a codec failure.
  step "go codec, 32-bit build (GOARCH=386)"; GOARCH=386 go test -count=1 ./codec/go/
  # The line above walks the MAIN module only (ontos-internal#304). `-count=1` matters here
  # specifically: projection/deixis/go reads its corpus from ABOVE its own module root, so
  # those files are not in the test cache key and a stale PASS would otherwise stand.
  # Mirrors .github/workflows/ci.yml; keep the two in sync.
  go_nested_mods
  for m in "${go_mods[@]}"; do
    step "go nested module $m (go test -count=1 -cover)"
    go_nested_ok "$m" || continue
    ( cd "$m" && go test -count=1 -cover ./... )
  done
  step "ts (node --test)";              ts_build
  # DISCOVERED, not enumerated — an enumerated directory list silently skips a NEW
  # ts test dir (ontos-internal#217: data/json/ts landed in ontos-internal#215 only because all three
  # sites were touched by hand). git ls-files sweeps every */ts/test/*.test.ts at
  # any depth, tracked or new (--others); cli/ts alone is excluded — its suite runs
  # separately by design (below, and as CI's own cli job). The count floor is the
  # positive control: an empty or shrunken sweep reds the run instead of passing.
  # Mirrors scripts/check.ps1 and .github/workflows/ci.yml; keep the three in sync.
  mapfile -t ts_tests < <(git ls-files --cached --others --exclude-standard -- '*/ts/test/*.test.ts' ':!cli/*' | sort)
  printf '%s\n' "${ts_tests[@]}"
  [ "${#ts_tests[@]}" -ge 4 ] || { echo "ts test discovery: only ${#ts_tests[@]} file(s), expected >= 4 — glob rot?"; exit 1; }
  node --test --experimental-test-coverage "${ts_tests[@]}"
  # Plus the cli/ts in-process tests (CI runs these in its separate cli job) — a superset.
  node --test cli/ts/test/*.test.ts
  step "py (unittest, stdlib only)"
  # DISCOVERED at any depth, not lane-enumerated — the file glob was fixed once
  # (a new test file inside a listed lane), but the LANE list itself was still
  # hand-kept, so a NEW py lane (e.g. data/json/py, ontos-internal#218's gated half) would
  # be silently skipped (ontos-internal#237). git ls-files sweeps every */py/test/test_*.py
  # at any depth, tracked or new; the count floor is the positive control.
  # Mirrors .github/workflows/ci.yml and scripts/check.ps1; keep the three in sync.
  mapfile -t py_tests < <(git ls-files --cached --others --exclude-standard -- '*/py/test/test_*.py' | sort)
  printf '%s\n' "${py_tests[@]}"
  [ "${#py_tests[@]}" -ge 5 ] || { echo "py test discovery: only ${#py_tests[@]} file(s), expected >= 5 — glob rot?"; exit 1; }
  for f in "${py_tests[@]}"; do
    echo "--- $f"
    python3 "$f"
  done
}

do_producer() {
  step "producer-conformance (host value -> L2, all four languages)"
  # The byte harness starts from a value that already exists at L0 and can never
  # construct a HOST value, so this leg is what covers ontos-data.md 4.1. Adapters are
  # built first: a `go run` per case made a 23s run take 7 minutes.
  local exe=""
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe";; esac
  go build -o "target/producer-adapter-go${exe}" ./tools/producer-conformance/adapters/go
  cargo build -q -p ontos-producer-adapter
  ts_build
  node tools/producer-conformance/run.mjs
}

do_lint() {
  # FIRST on purpose: if the twins have diverged, everything below is a report about
  # a tool the other platform does not have. ONE script shared with the
  # `check-script parity` job in .github/workflows/ci.yml, so the CI gate and this
  # pre-flight cannot drift.
  step "check-script parity (scripts/check.sh = scripts/check.ps1)"
  node scripts/check-parity.mjs
  # Bitspark's naming rule (Bitspark/.github NAMING.md): a project is written as its
  # repository is named. Vendored unchanged with its repository list; .namingignore
  # holds the verbatim records it must not respell. Mirrors the `check-script parity`
  # job in .github/workflows/ci.yml and scripts/check.ps1; keep the three in sync.
  step "project-name spelling (scripts/naming.mjs)"
  node scripts/naming.mjs
  step "go (gofmt -l + vet)"
  gofmt -l . | tee /dev/stderr | (! read)
  go vet ./...
  # `gofmt -l .` above is FILE-based and already covers nested modules; `go vet` is
  # MODULE-scoped and does not (ontos-internal#304). Same sweep and count floor as do_test.
  # Mirrors .github/workflows/ci.yml; keep the two in sync.
  go_nested_mods
  for m in "${go_mods[@]}"; do
    step "go nested module $m (go vet)"
    go_nested_ok "$m" || continue
    ( cd "$m" && go vet ./... )
  done
  step "rust (cargo fmt --check + clippy -D warnings)"
  cargo fmt --all --check
  cargo clippy --workspace --all-targets -- -D warnings
  step "ts (tsc --noEmit, every workspace, discovered)"; ts_build
  # DISCOVERED, not enumerated — the hand-kept 4-package list this replaces missed
  # data/json/ts entirely (ontos-internal#237), so its first real typecheck ran inside
  # publish-npm, after the immutable tag. The count floor is the positive control.
  # Mirrors .github/workflows/ci.yml and scripts/check.ps1; keep the three in sync.
  mapfile -t ws < <(node -p "require('./package.json').workspaces.join('\n')")
  printf '%s\n' "${ws[@]}"
  [ "${#ws[@]}" -ge 5 ] || { echo "workspace discovery: only ${#ws[@]} entries, expected >= 5 — list rot?"; exit 1; }
  for w in "${ws[@]}"; do npx -w "$w" tsc -p tsconfig.json --noEmit; done
}

do_conformance() {
  step "build the go/rs/ts CLIs FRESH (ontos-internal#69: never reuse a stale binary)"
  cargo build -p ontos-cli --locked
  go build -o ontos-go ./cli/go/cmd/ontos
  ts_build
  step "cli/ts in-process tests"; node --test cli/ts/test/*.test.ts
  step "cli/py in-process tests"; python3 cli/py/test/test_cli.py
  step "differential conformance harness, 4 impls (decode + human + author->bytes)"
  node tools/conformance/run.mjs \
    --impl ontos-rs=./target/debug/ontos \
    --impl ontos-go=./ontos-go \
    --impl "ontos-ts=node ./cli/ts/dist/src/main.js" \
    --impl "ontos-py=python3 cli/py/main.py" \
    --vectors vectors/codec.json --vectors vectors/data.json \
    --decode-roundtrip --human-roundtrip --from-json-roundtrip
}

do_fuzz() {
  local t="${FUZZTIME:-25s}"
  step "go codec fuzz (FuzzDecode, ${t})"; go test -run '^$' -fuzz '^FuzzDecode$' -fuzztime "$t" ./codec/go
  step "go data fuzz (FuzzData, ${t})";    go test -run '^$' -fuzz '^FuzzData$'   -fuzztime "$t" ./data/go

  # The 4-CLI differential fuzz bout (ontos-internal#127): build all four CLIs FRESH (ontos-internal#69), then
  # drive a seeded ephemeral corpus through go/rs/ts/py via the bout wrapper
  # (tools/fuzz/bout.mjs), which excludes impl-local limit_exceeded cases (ontos-codec
  # §3/§4, ontos-internal#138) before handing the filtered corpus to the unchanged conformance
  # runner. FUZZ_COUNT overrides the case count (default 300); FUZZ_SEED pins the seed for
  # a reproducible local run (default: derived from $GITHUB_SHA when set, else time-based —
  # the generator prints the effective seed either way).
  step "build the go/rs/ts CLIs FRESH for the differential bout (ontos-internal#69)"
  cargo build -p ontos-cli --locked
  go build -o ontos-go ./cli/go/cmd/ontos
  ts_build
  step "bout wrapper regression test (limit_exceeded skip + oracle intact, ontos-internal#138)"
  node --test tools/fuzz/bout.test.mjs
  step "4-CLI differential fuzz bout (decode + human over a generated corpus)"
  local count="${FUZZ_COUNT:-300}"
  local seed_arg=()
  [ -n "${FUZZ_SEED:-}" ] && seed_arg=(--seed "$FUZZ_SEED")
  node tools/fuzz/gen.mjs --count "$count" "${seed_arg[@]}" --out fuzz-corpus.json
  node tools/fuzz/bout.mjs \
    --impl ontos-rs=./target/debug/ontos \
    --impl ontos-go=./ontos-go \
    --impl "ontos-ts=node ./cli/ts/dist/src/main.js" \
    --impl "ontos-py=python3 cli/py/main.py" \
    --vectors fuzz-corpus.json \
    --decode-roundtrip --human-roundtrip
  rm -f fuzz-corpus.json
}


do_vectors() {
  step "regenerate map/set vectors + assert no drift"; ts_build
  node tools/vector/gen.mjs
  git diff --exit-code vectors/data.generated.json \
    || { echo "vectors/data.generated.json drifted — re-run scripts/check.sh vectors and commit"; exit 1; }
  step "lint: a case NAME asserting a relation must belong to a kind that carries it (ontos-internal#288)"
  node tools/vector/lint-relations.mjs
}

cmd="${1:-}"
case "${cmd,,}" in
  test)        do_test ;;
  lint)        do_lint ;;
  conformance) do_conformance ;;
  producer)    do_producer ;;
  fuzz)        do_fuzz ;;
  vectors)     do_vectors ;;
  all)         do_lint; do_test; do_vectors; do_conformance; do_producer ;;
  *)           usage ;;
esac

echo
echo "check: ${1} OK"
