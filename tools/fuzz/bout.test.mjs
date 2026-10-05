#!/usr/bin/env node
/*
 * Regression tests for the differential fuzz BOUT wrapper (tools/fuzz/bout.mjs, ontos
 * ontos-internal#138). The bout must EXEMPT the one spec-named impl-local code (`limit_exceeded`,
 * docs/spec/ontos-codec.md §3/§4) from the byte-for-byte judgment WITHOUT weakening the
 * oracle: every other code disagreement, and any success-payload disagreement, must
 * still fail loudly.
 *
 * These tests drive bout.mjs against FAKE impls (small node scripts that emit
 * contract-shaped JSON / human output scripted per (impl, hex) from a scenario file), so
 * exact divergence scenarios are constructed deterministically with no CLI build. This
 * keeps the assertion on the bout's OWN comparison layer, independent of any core.
 *
 * Run: node --test tools/fuzz/bout.test.mjs   (dependency-free; node: builtins only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUT = join(HERE, "bout.mjs");

// A fake `ontos` CLI: emits a scripted response for the (impl, hex) pair from the
// scenario JSON in $BOUT_TEST_SCENARIO. The bout/runner build argv as
// `<prefix...> <subcmd...> --format <fmt> <hex>`; this impl's prefix carries --name=<n>.
const FAKE_IMPL = `
import { readFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync(process.env.BOUT_TEST_SCENARIO, "utf8"));
const argv = process.argv.slice(2);
const nameArg = argv.find((a) => a.startsWith("--name="));
const implName = nameArg ? nameArg.slice("--name=".length) : "unknown";
const rest = argv.filter((a) => !a.startsWith("--name="));
const fmtIdx = rest.indexOf("--format");
const format = fmtIdx >= 0 ? rest[fmtIdx + 1] : "json";
const hex = rest[rest.length - 1];
const known = new Set(["read", "canon", "inspect", "decode"]);
const command = known.has(rest[0]) ? rest[0] : "decode";
const resp = (scenario[implName] ?? {})[hex] ?? { ok: true };
if (resp.hang) {
  // Never exits on its own, so only the bout's probe timeout can end it (ontos-internal#353).
  setInterval(() => {}, 60000);
} else if (resp.raw !== undefined) {
  // Exactly these stdout bytes and this exit code: a crash, a panic or garbage (ontos-internal#353).
  process.stdout.write(resp.raw);
  process.exit(resp.exit ?? 0);
} else if (resp.ok === false) {
  if (format === "json") process.stdout.write(JSON.stringify({ ok: false, command, error: resp.error }) + "\\n");
  else process.stdout.write("ontos: " + implName + ": " + resp.error + "\\n");
  process.exit(1);
} else {
  const payload = resp.payload ?? "<tuple/>";
  if (format === "json") process.stdout.write(JSON.stringify({ ok: true, command, value: payload }) + "\\n");
  else process.stdout.write(payload + "\\n");
  process.exit(0);
}
`;

const IMPLS = ["ontos-rs", "ontos-go", "ontos-ts", "ontos-py"];

// Set up a temp dir with the fake impl + a scenario file + a corpus, run bout.mjs, and
// return { status, stdout, stderr }. `cases` is an array of { name, hex }; `env` adds
// to the bout's environment.
function runBout(scenario, cases, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bout-test-"));
  try {
    const fakePath = join(dir, "fake-impl.mjs");
    const scenarioPath = join(dir, "scenario.json");
    const corpusPath = join(dir, "corpus.json");
    writeFileSync(fakePath, FAKE_IMPL);
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    writeFileSync(corpusPath, JSON.stringify({ codec: "ontos-codec-v1", encode: cases }));

    // Use bare `node` (resolved from PATH) for the impl prefix, exactly as the real
    // workflow invokes ontos-ts ("node ./cli/ts/dist/src/main.js"): the runner
    // whitespace-splits each --impl COMMAND, so the program token must be space-free
    // (process.execPath is "C:\\Program Files\\nodejs\\node.exe" on Windows — it is not).
    const args = [BOUT];
    for (const name of IMPLS) {
      args.push("--impl", `${name}=node ${fakePath} --name=${name}`);
    }
    args.push("--vectors", corpusPath, "--decode-roundtrip", "--human-roundtrip");

    const res = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, ...env, BOUT_TEST_SCENARIO: scenarioPath },
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a limit_exceeded code-difference is SKIPPED, not flagged (the ontos-internal#138 false divergence)", () => {
  // The exact ontos-internal#138 shape: ts hits its Number-width resource guard (limit_exceeded) while
  // rs/go/py reach EOF first. All four REJECT; they differ only on the code. Per
  // ontos-codec §3/§4 this is spec-sanctioned and must be skipped — with a clean case
  // alongside it that the bout DOES compare.
  const hexLimit = "010101ffffffffffffff7f"; // huge declared length, truncated
  const hexClean = "0100"; // empty tuple — all agree
  const scenario = {
    "ontos-rs": { [hexLimit]: { ok: false, error: "unexpected_eof" } },
    "ontos-go": { [hexLimit]: { ok: false, error: "unexpected_eof" } },
    "ontos-ts": { [hexLimit]: { ok: false, error: "limit_exceeded" } },
    "ontos-py": { [hexLimit]: { ok: false, error: "unexpected_eof" } },
  };
  const r = runBout(scenario, [
    { name: "offending-limit", hex: hexLimit },
    { name: "clean", hex: hexClean },
  ]);
  assert.equal(r.status, 0, `bout must PASS (the limit_exceeded case is skipped). stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /1 skipped at an impl-local resource limit/, "the skip must be logged and counted");
  assert.match(r.stderr, /ontos-ts=limit_exceeded/, "the skip log must name the impl + code that triggered it");
  assert.match(r.stdout, /all byte-identical/, "the remaining (clean) case must be compared and agree");
});

test("a NON-limit_exceeded code disagreement still FAILS loudly (oracle not weakened)", () => {
  // ts says unknown_tag, the others say unexpected_eof — no limit_exceeded anywhere, so
  // this is a genuine cross-core divergence and MUST still red the bout.
  const hex = "020099";
  const scenario = {
    "ontos-rs": { [hex]: { ok: false, error: "unexpected_eof" } },
    "ontos-go": { [hex]: { ok: false, error: "unexpected_eof" } },
    "ontos-ts": { [hex]: { ok: false, error: "unknown_tag" } },
    "ontos-py": { [hex]: { ok: false, error: "unexpected_eof" } },
  };
  const r = runBout(scenario, [{ name: "genuine-code-divergence", hex }]);
  assert.equal(r.status, 1, `bout must FAIL on a non-limit_exceeded code divergence. stdout:\n${r.stdout}`);
  assert.match(r.stdout, /DIVERGENCE/, "the genuine divergence must be reported");
  assert.match(r.stderr, /0 skipped at an impl-local resource limit/, "no case is at a resource limit here");
});

test("a SUCCESS-vs-SUCCESS payload disagreement still FAILS loudly (oracle not weakened)", () => {
  // All four decode successfully but ts emits a different value payload — a real
  // success-output divergence that must still red the bout.
  const hex = "0003414243";
  const scenario = {
    "ontos-rs": { [hex]: { ok: true, payload: "<atom>414243</atom>" } },
    "ontos-go": { [hex]: { ok: true, payload: "<atom>414243</atom>" } },
    "ontos-ts": { [hex]: { ok: true, payload: "<atom>DIFFERENT</atom>" } },
    "ontos-py": { [hex]: { ok: true, payload: "<atom>414243</atom>" } },
  };
  const r = runBout(scenario, [{ name: "genuine-success-divergence", hex }]);
  assert.equal(r.status, 1, `bout must FAIL on a success-payload divergence. stdout:\n${r.stdout}`);
  assert.match(r.stdout, /DIVERGENCE/, "the success divergence must be reported");
});

test("a limit_exceeded case does NOT mask a genuine divergence on a DIFFERENT hex", () => {
  // One hex trips limit_exceeded (skipped); a different hex has a genuine code divergence
  // (kept + flagged). The skip is per-hex and must not swallow the real failure.
  const hexLimit = "010101ffffffffffffff7f";
  const hexDiverge = "020099";
  const scenario = {
    "ontos-rs": { [hexLimit]: { ok: false, error: "unexpected_eof" }, [hexDiverge]: { ok: false, error: "unexpected_eof" } },
    "ontos-go": { [hexLimit]: { ok: false, error: "unexpected_eof" }, [hexDiverge]: { ok: false, error: "unexpected_eof" } },
    "ontos-ts": { [hexLimit]: { ok: false, error: "limit_exceeded" }, [hexDiverge]: { ok: false, error: "unknown_tag" } },
    "ontos-py": { [hexLimit]: { ok: false, error: "unexpected_eof" }, [hexDiverge]: { ok: false, error: "unexpected_eof" } },
  };
  const r = runBout(scenario, [
    { name: "skipped-limit", hex: hexLimit },
    { name: "kept-divergence", hex: hexDiverge },
  ]);
  assert.equal(r.status, 1, `the genuine divergence on a different hex must still FAIL. stdout:\n${r.stdout}`);
  assert.match(r.stderr, /1 skipped at an impl-local resource limit/, "the limit_exceeded hex is still skipped + logged");
  assert.match(r.stdout, /DIVERGENCE/, "the genuine divergence on the other hex must still be flagged");
});

// ── ontos-internal#353: a skip exempts an input from EQUALITY, never from SAFETY ─────────────────────
//
// Each case below puts one broken run beside a limit_exceeded on the same hex. Before
// ontos-internal#353 the hex was skipped, the broken run was never looked at, and the bout passed.

const HEX_LIMIT = "010101ffffffffffffff7f";

// A clean hex rides along, as in the ontos-internal#138 test: a corpus whose every case is skipped leaves
// the runner nothing to judge, and it exits 2 for that alone.
const LIMIT_AND_CLEAN = [
  { name: "limit", hex: HEX_LIMIT },
  { name: "clean", hex: "0100" },
];

// ts reports the impl-local limit and go/py reject cleanly; ontos-rs does `rsRun`.
function limitBeside(rsRun) {
  return {
    "ontos-rs": { [HEX_LIMIT]: rsRun },
    "ontos-go": { [HEX_LIMIT]: { ok: false, error: "unexpected_eof" } },
    "ontos-ts": { [HEX_LIMIT]: { ok: false, error: "limit_exceeded" } },
    "ontos-py": { [HEX_LIMIT]: { ok: false, error: "unexpected_eof" } },
  };
}

test("a crash with empty stdout beside a limit_exceeded FAILS (ontos-internal#353, the issue's case)", () => {
  // Exit 1 with nothing on stdout: what an escaped host exception looks like from outside.
  const r = runBout(limitBeside({ raw: "", exit: 1 }), LIMIT_AND_CLEAN);
  assert.equal(r.status, 1, `a crashed impl must fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /FAULT ontos-rs on 010101ffffffffffffff7f: exited 1 without exactly one/);
  assert.match(r.stderr, /1 skipped at an impl-local resource limit/, "the equality skip itself is unchanged");
  assert.match(r.stderr, /ontos-rs=FAULT/, "the skip log names the faulted impl");
});

test("an undocumented exit code (a panic) beside a limit_exceeded FAILS (ontos-internal#353)", () => {
  const r = runBout(limitBeside({ raw: "", exit: 101 }), LIMIT_AND_CLEAN);
  assert.equal(r.status, 1, `a panicked impl must fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /FAULT ontos-rs on \S+: exited 101, which is not a documented exit code/);
});

test("non-compact JSON beside a limit_exceeded FAILS (ontos-internal#353)", () => {
  const raw = '{"ok": false, "command": "decode", "error": "unexpected_eof"}\n';
  const r = runBout(limitBeside({ raw, exit: 1 }), LIMIT_AND_CLEAN);
  assert.equal(r.status, 1, `malformed output must fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /FAULT ontos-rs on \S+: stdout is not compact JSON/);
});

test("a rejection object that exits 0 beside a limit_exceeded FAILS (ontos-internal#353)", () => {
  const raw = '{"ok":false,"command":"decode","error":"unexpected_eof"}\n';
  const r = runBout(limitBeside({ raw, exit: 0 }), LIMIT_AND_CLEAN);
  assert.equal(r.status, 1, `ok:false with exit 0 must fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /FAULT ontos-rs on \S+: reported ok:false \(unexpected_eof\) but exited 0/);
});

test("a hang beside a limit_exceeded FAILS at the probe timeout (ontos-internal#353)", () => {
  const r = runBout(limitBeside({ hang: true }), LIMIT_AND_CLEAN, {
    ONTOS_FUZZ_PROBE_TIMEOUT_MS: "3000",
  });
  assert.equal(r.status, 1, `a hung impl must fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /FAULT ontos-rs on \S+: timed out after 3000 ms/);
});

test("every impl crashing the same way on a KEPT hex FAILS, though the runner sees equal bytes (ontos-internal#353)", () => {
  // No limit anywhere, so the hex is kept and judged by the runner, which compares stdout
  // and exit codes: four empty stdouts and four exit 1s are byte-identical, so the runner
  // alone passes. The probe is what catches it.
  const hex = "0100";
  const crash = { [hex]: { raw: "", exit: 1 } };
  const scenario = { "ontos-rs": crash, "ontos-go": crash, "ontos-ts": crash, "ontos-py": crash };
  const r = runBout(scenario, [{ name: "all-crash", hex }]);
  assert.equal(r.status, 1, `identical crashes must still fail the bout. stderr:\n${r.stderr}`);
  assert.match(r.stdout, /all byte-identical/, "the runner alone passes this input, which is the hole");
  assert.match(r.stderr, /4 impl fault\(s\)/);
});

test("well-behaved impls beside a limit_exceeded still PASS (ontos-internal#353 control)", () => {
  // The same scenario shape as the cases above with every run well formed, so the new
  // check is shown to fire on the broken run and not on the shape.
  const r = runBout(limitBeside({ ok: false, error: "unexpected_eof" }), LIMIT_AND_CLEAN);
  assert.equal(r.status, 0, `well-formed runs must pass. stderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /FAULT/);
});
