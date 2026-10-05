# Local CI mirror (ontos-internal#70), Windows/PowerShell sibling of scripts/check.sh. Runs the
# SAME checks the GitHub workflows run, one command per concern, against the CURRENT
# checkout (this worktree, not main):
#
#   test         rust + go + ts + py unit/vector tests    (.github/workflows/ci.yml)
#   lint         gofmt+vet, cargo fmt+clippy, tsc         (.github/workflows/ci.yml)
#   conformance  build the CLIs FRESH, run the harness over all 4 impls
#                (.github/workflows/ci.yml)
#   fuzz         go native FuzzDecode + FuzzData + the 4-CLI differential bout
#                (.github/workflows/ci.yml)
#   vectors      regenerate map/set vectors, assert no drift (.github/workflows/ci.yml)
#   all          lint + test + vectors + conformance (NOT fuzz — run that separately)
#
# `conformance` rebuilds every CLI before running the differential harness, so a stale
# repo-root binary can never produce a false divergence (ontos-internal#69). On Windows the
# rust/go binaries carry a .exe suffix (handled here); CI is Linux (scripts/check.sh).
# This mirrors the workflows; keep the two in sync.
[CmdletBinding()]
param([Parameter(Position = 0)][string]$Cmd)
$ErrorActionPreference = "Stop"

# Run a native command (inside a scriptblock) and fail the script on any non-zero exit.
# A scriptblock is used — not a splatted [string[]] — so flags like `-w` are parsed as
# the command's own arguments, never bound to this function's parameters.
function Invoke-Checked([scriptblock]$Block) {
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "FAILED ($LASTEXITCODE): $Block" }
}

function Step([string]$msg) { Write-Host "`n=== $msg ===" }

# Nested go modules are INVISIBLE to `go test ./...` and `go vet ./...` — both walk the MAIN
# module only, so a package with its own go.mod is never compiled, never checked, and the run
# still goes green (ontos-internal#304). The test and lint targets below sweep them explicitly.
#
# DISCOVERED, not enumerated. git ls-files finds every nested module at any depth, tracked or
# new; unlike CI's `find` it also skips the gitignored .worktrees/, which exists only in a
# local checkout. The count floor is the positive control: a sweep that finds nothing throws
# instead of passing vacuously.
function Get-GoNestedModule {
  $mods = @(git ls-files --cached --others --exclude-standard -- '*/go.mod' |
            ForEach-Object { (Split-Path $_ -Parent) -replace '\\', '/' } | Sort-Object -Unique)
  Write-Host "nested go modules discovered: $($mods.Count)"
  if ($mods.Count -lt 1) { throw "nested go module sweep found none — the sweep is dead, not clean" }
  return $mods
}

# Resolving a nested module can fail for a reason that is not the contributor's fault:
# projection/deixis/go requires github.com/bitspark/deixis, and CI injects
# credentials that someone outside the org does not have. Hard-failing them on a dependency
# they cannot fetch would make `check` useless locally; skipping QUIETLY is how ontos-internal#304 happened
# in the first place. So skip loudly — an unchecked module is a GAP in the signal, not a pass.
function Test-GoNestedResolves([string]$Dir) {
  Push-Location $Dir
  try { go list -deps ./... 2>&1 | Out-Null; $ok = ($LASTEXITCODE -eq 0) } finally { Pop-Location }
  if (-not $ok) {
    Write-Host "  !! SKIPPED: $Dir — dependencies do not resolve (offline?)."
    Write-Host "  !! This module was NOT checked by your run: a gap in your signal, NOT a pass."
    Write-Host "  !! CI resolves it from the network and checks it there."
  }
  return $ok
}

function Show-Usage {
  Write-Error @"
usage: scripts/check.ps1 {test|lint|conformance|producer|fuzz|vectors|all}
  test         rust + go (incl. nested modules) + ts + py unit/vector tests
  lint         check.sh/.ps1 parity, project-name spelling, gofmt+vet (incl. nested modules), cargo fmt+clippy, tsc --noEmit (discovered)
  conformance  build the CLIs fresh, run the differential harness over all 4 impls (all 3 modes)
  producer     producer-conformance: a HOST value -> L2, all 4 languages (ontos-data.md 4.1)
  fuzz         go native FuzzDecode + FuzzData (`$env:FUZZTIME, default 25s) + the 4-CLI differential bout
  vectors      regenerate the map/set vectors and assert no drift
  all          lint + test + vectors + conformance + producer (fuzz is separate — it is generative)
"@
  exit 2
}

# Run against the CURRENT working tree's root (unlike worktree.ps1, which targets the
# primary checkout) — `check` validates whatever checkout you are developing in.
Set-Location (git rev-parse --show-toplevel)

# Build the TS workspace (core -> codec -> data -> data/json -> projection/deixis -> cli)
# into dist/. `npm ci` relinks the @bitspark/* workspace symlinks the imports resolve
# through (a stale node_modules missing them breaks the cli build — ontos-internal#57), so every
# ts concern starts from it. Every dependency it installs comes from npmjs; no token is needed.
function Invoke-TsBuild {
  Invoke-Checked { npm ci }
  # DISCOVERED via the root `workspaces` array — the set's single source of truth,
  # already in dependency order (core -> codec -> data -> data/json -> projection/deixis
  # -> cli). A
  # hand-kept build list silently skips a NEW package (ontos-internal#237: lint's copy of
  # this list missed data/json/ts, so PR CI never typechecked it).
  Invoke-Checked { npm run build --workspaces --if-present }
}

function Invoke-Test {
  Step "rust (cargo test --workspace)"; Invoke-Checked { cargo test --workspace --locked }
  # The codec on a 32-bit target (ontos-internal#352) runs in CI and in scripts/check.sh, not here:
  # WASI cannot preopen a Windows drive path, so the vector tests, which read files by
  # their absolute CARGO_MANIFEST_DIR path, cannot find them under wasmtime on Windows.
  Step "rust codec on wasm32: SKIPPED on Windows (WASI cannot map a drive path; run scripts/check.sh on Linux, or see CI)"
  Step "go (go test -cover ./...)";     Invoke-Checked { go test -cover ./... }
  # Executes the 32-bit build (ontos-internal#352); Windows runs i386 natively. CI can only compile
  # it until the fleet can exec i386 (bitagent-ci).
  Step "go codec, 32-bit build (GOARCH=386)"
  $prevGoarch = $env:GOARCH; $env:GOARCH = '386'
  try { Invoke-Checked { go test -count=1 ./codec/go/ } } finally { $env:GOARCH = $prevGoarch }
  # The line above walks the MAIN module only (ontos-internal#304). `-count=1` matters here
  # specifically: projection/deixis/go reads its corpus from ABOVE its own module root, so
  # those files are not in the test cache key and a stale PASS would otherwise stand.
  # Mirrors scripts/check.sh and .github/workflows/ci.yml; keep the three in sync.
  foreach ($m in @(Get-GoNestedModule)) {
    Step "go nested module $m (go test -count=1 -cover)"
    if (-not (Test-GoNestedResolves $m)) { continue }
    Push-Location $m
    try { Invoke-Checked { go test -count=1 -cover ./... } } finally { Pop-Location }
  }
  Step "ts (node --test)";              Invoke-TsBuild
  # DISCOVERED, not enumerated — an enumerated directory list silently skips a NEW
  # ts test dir (ontos-internal#217: data/json/ts landed in ontos-internal#215 only because all three
  # sites were touched by hand). git ls-files sweeps every */ts/test/*.test.ts at
  # any depth, tracked or new (--others); cli/ts alone is excluded — its suite runs
  # separately by design (below, and as CI's own cli job). The count floor is the
  # positive control: an empty or shrunken sweep reds the run instead of passing.
  # Mirrors scripts/check.sh and .github/workflows/ci.yml; keep the three in sync.
  $tsTests = @(git ls-files --cached --others --exclude-standard -- '*/ts/test/*.test.ts' ':!cli/*' | Sort-Object)
  $tsTests | ForEach-Object { Write-Host $_ }
  if ($tsTests.Count -lt 4) { throw "ts test discovery: only $($tsTests.Count) file(s), expected >= 4 — glob rot?" }
  Invoke-Checked { node --test --experimental-test-coverage @tsTests }
  # Plus the cli/ts in-process tests (CI runs these in its separate `cli` job) — a superset.
  Invoke-Checked { node --test cli/ts/test/*.test.ts }
  Step "py (unittest, stdlib only)"
  # DISCOVERED at any depth, not lane-enumerated — the file glob was fixed once
  # (a new test file inside a listed lane), but the LANE list itself was still
  # hand-kept, so a NEW py lane (e.g. data/json/py, ontos-internal#218's gated half) would
  # be silently skipped (ontos-internal#237). git ls-files sweeps every */py/test/test_*.py
  # at any depth, tracked or new; the count floor is the positive control.
  # Mirrors scripts/check.sh and .github/workflows/ci.yml; keep the three in sync.
  $pyTests = @(git ls-files --cached --others --exclude-standard -- '*/py/test/test_*.py' | Sort-Object)
  $pyTests | ForEach-Object { Write-Host $_ }
  if ($pyTests.Count -lt 5) { throw "py test discovery: only $($pyTests.Count) file(s), expected >= 5 — glob rot?" }
  foreach ($f in $pyTests) {
    Write-Host "--- $f"
    Invoke-Checked { python $f }
  }
}

function Invoke-Producer {
  Step "producer-conformance (host value -> L2, all four languages)"
  # The byte harness starts from a value that already exists at L0 and can never
  # construct a HOST value, so this leg is what covers ontos-data.md 4.1. Adapters are
  # built first: a `go run` per case made a 23s run take 7 minutes.
  #
  # Mirrors do_producer in scripts/check.sh; keep the two in sync. This script had NO
  # producer leg at all until ontos-internal#306 -- `all` exited 0 on Windows having never
  # exercised 4.1, while CI ran the job regardless. Neither usage block advertised the
  # target, so the asymmetry was invisible to anyone diffing the two by eye.
  Invoke-Checked { go build -o target/producer-adapter-go.exe ./tools/producer-conformance/adapters/go }
  Invoke-Checked { cargo build -q -p ontos-producer-adapter }
  Invoke-TsBuild
  Invoke-Checked { node tools/producer-conformance/run.mjs }
}

function Invoke-Lint {
  # FIRST on purpose: if the twins have diverged, everything below is a report about
  # a tool the other platform does not have. ONE script shared with the
  # `check-script parity` job in .github/workflows/ci.yml, so the CI gate and this
  # pre-flight cannot drift.
  Step "check-script parity (scripts/check.sh = scripts/check.ps1)"
  Invoke-Checked { node scripts/check-parity.mjs }
  # Bitspark's naming rule (Bitspark/.github NAMING.md): a project is written as its
  # repository is named. Vendored unchanged with its repository list; .namingignore
  # holds the verbatim records it must not respell. Mirrors the `check-script parity`
  # job in .github/workflows/ci.yml and scripts/check.sh; keep the three in sync.
  Step "project-name spelling (scripts/naming.mjs)"
  Invoke-Checked { node scripts/naming.mjs }
  Step "go (gofmt -l + vet)"
  $dirty = gofmt -l .
  if ($LASTEXITCODE -ne 0) { throw "gofmt failed ($LASTEXITCODE)" } # fail closed if gofmt itself errors
  if ($dirty) { throw "gofmt: not formatted:`n$($dirty -join "`n")" }
  Invoke-Checked { go vet ./... }
  # `gofmt -l .` above is FILE-based and already covers nested modules; `go vet` is
  # MODULE-scoped and does not (ontos-internal#304). Same sweep and count floor as Invoke-Test.
  # Mirrors scripts/check.sh and .github/workflows/ci.yml; keep the three in sync.
  foreach ($m in @(Get-GoNestedModule)) {
    Step "go nested module $m (go vet)"
    if (-not (Test-GoNestedResolves $m)) { continue }
    Push-Location $m
    try { Invoke-Checked { go vet ./... } } finally { Pop-Location }
  }
  Step "rust (cargo fmt --check + clippy -D warnings)"
  Invoke-Checked { cargo fmt --all --check }
  Invoke-Checked { cargo clippy --workspace --all-targets -- -D warnings }
  Step "ts (tsc --noEmit, every workspace, discovered)"; Invoke-TsBuild
  # DISCOVERED, not enumerated — the hand-kept 4-package list this replaces missed
  # data/json/ts entirely (ontos-internal#237), so its first real typecheck ran inside
  # publish-npm, after the immutable tag. The count floor is the positive control.
  # Mirrors .github/workflows/ci.yml and scripts/check.sh; keep the three in sync.
  $ws = @((Get-Content package.json -Raw | ConvertFrom-Json).workspaces)
  $ws | ForEach-Object { Write-Host $_ }
  if ($ws.Count -lt 5) { throw "workspace discovery: only $($ws.Count) entries, expected >= 5 — list rot?" }
  foreach ($w in $ws) { Invoke-Checked { npx -w $w tsc -p tsconfig.json --noEmit } }
}

function Invoke-Conformance {
  Step "build the go/rs/ts CLIs FRESH (ontos-internal#69: never reuse a stale binary)"
  Invoke-Checked { cargo build -p ontos-cli --locked }
  Invoke-Checked { go build -o ontos-go.exe ./cli/go/cmd/ontos }
  Invoke-TsBuild
  Step "cli/ts in-process tests"; Invoke-Checked { node --test cli/ts/test/*.test.ts }
  Step "cli/py in-process tests"; Invoke-Checked { python cli/py/test/test_cli.py }
  Step "differential conformance harness, 4 impls (decode + human + author->bytes)"
  Invoke-Checked {
    node tools/conformance/run.mjs `
      --impl ontos-rs=./target/debug/ontos.exe `
      --impl ontos-go=./ontos-go.exe `
      --impl "ontos-ts=node ./cli/ts/dist/src/main.js" `
      --impl "ontos-py=python cli/py/main.py" `
      --vectors vectors/codec.json --vectors vectors/data.json `
      --decode-roundtrip --human-roundtrip --from-json-roundtrip
  }
}

function Invoke-Fuzz {
  $t = if ($env:FUZZTIME) { $env:FUZZTIME } else { "25s" }
  Step "go codec fuzz (FuzzDecode, $t)"; Invoke-Checked { go test -run '^$' -fuzz '^FuzzDecode$' -fuzztime $t ./codec/go }
  Step "go data fuzz (FuzzData, $t)";    Invoke-Checked { go test -run '^$' -fuzz '^FuzzData$'   -fuzztime $t ./data/go }

  # The 4-CLI differential fuzz bout (ontos-internal#127): build all four CLIs FRESH (ontos-internal#69), then
  # drive a seeded ephemeral corpus through go/rs/ts/py via the bout wrapper
  # (tools/fuzz/bout.mjs), which excludes impl-local limit_exceeded cases (ontos-codec
  # §3/§4, ontos-internal#138) before handing the filtered corpus to the unchanged conformance
  # runner. $env:FUZZ_COUNT overrides the case count (default 300); $env:FUZZ_SEED pins the
  # seed for a reproducible local run (default: derived from $env:GITHUB_SHA when set, else
  # time-based — the generator prints the effective seed either way).
  Step "build the go/rs/ts CLIs FRESH for the differential bout (ontos-internal#69)"
  Invoke-Checked { cargo build -p ontos-cli --locked }
  Invoke-Checked { go build -o ontos-go.exe ./cli/go/cmd/ontos }
  Invoke-TsBuild
  Step "bout wrapper regression test (limit_exceeded skip + oracle intact, ontos-internal#138)"
  Invoke-Checked { node --test tools/fuzz/bout.test.mjs }
  Step "4-CLI differential fuzz bout (decode + human over a generated corpus)"
  $count = if ($env:FUZZ_COUNT) { $env:FUZZ_COUNT } else { "300" }
  if ($env:FUZZ_SEED) {
    Invoke-Checked { node tools/fuzz/gen.mjs --count $count --seed $env:FUZZ_SEED --out fuzz-corpus.json }
  } else {
    Invoke-Checked { node tools/fuzz/gen.mjs --count $count --out fuzz-corpus.json }
  }
  Invoke-Checked {
    node tools/fuzz/bout.mjs `
      --impl ontos-rs=./target/debug/ontos.exe `
      --impl ontos-go=./ontos-go.exe `
      --impl "ontos-ts=node ./cli/ts/dist/src/main.js" `
      --impl "ontos-py=python cli/py/main.py" `
      --vectors fuzz-corpus.json `
      --decode-roundtrip --human-roundtrip
  }
  Remove-Item -Force -ErrorAction SilentlyContinue fuzz-corpus.json
}

function Invoke-Vectors {
  Step "regenerate map/set vectors + assert no drift"; Invoke-TsBuild
  Invoke-Checked { node tools/vector/gen.mjs }
  # Relax native-error handling locally so a nonzero `git diff --exit-code` (= drift) is
  # reported with the hint below, not a generic exception under
  # $PSNativeCommandUseErrorActionPreference = $true.
  & { $ErrorActionPreference = 'Continue'; git diff --exit-code vectors/data.generated.json }
  if ($LASTEXITCODE -ne 0) {
    throw "vectors/data.generated.json drifted — re-run scripts/check.ps1 vectors and commit"
  }

  Step "lint: a case NAME asserting a relation must belong to a kind that carries it (ontos-internal#288)"
  Invoke-Checked { node tools/vector/lint-relations.mjs }
}


switch ("$Cmd".ToLower()) {
  "test" { Invoke-Test }
  "lint" { Invoke-Lint }
  "conformance" { Invoke-Conformance }
  "producer" { Invoke-Producer }
  "fuzz" { Invoke-Fuzz }
  "vectors" { Invoke-Vectors }
  "all" { Invoke-Lint; Invoke-Test; Invoke-Vectors; Invoke-Conformance; Invoke-Producer }
  default { Show-Usage }
}

Write-Host "`ncheck: $Cmd OK"
