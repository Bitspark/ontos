#!/usr/bin/env node
/*
 * ontos-fuzz-bout — the differential fuzz BOUT wrapper (ontos-internal#138).
 *
 * WHAT THIS IS. The differential fuzz bout (ontos-internal#127) drives a seeded ephemeral
 * corpus (tools/fuzz/gen.mjs) through all four `ontos` CLIs (go · rs · ts · py) via
 * the conformance runner (tools/conformance/run.mjs), failing loudly on any byte-level
 * disagreement. That runner is THE PROTOCOL — its byte-for-byte judgment semantics are
 * frozen (ontos-conformance.md) and MUST NOT change. This wrapper sits in FRONT of it
 * for the GENERATIVE bout only: it filters the ephemeral corpus down to the cases that
 * actually live inside the codec's cross-core agreement domain, then hands that filtered
 * corpus to the UNCHANGED runner. The required `vectors` job (which runs the frozen
 * corpora through run.mjs directly) never goes through this wrapper and is untouched.
 *
 * THE BUG IT FIXES (ontos-internal#138). The frozen vectors deliberately stay inside the
 * resource-limit-agreement zone, so run.mjs's byte-for-byte judgment is exactly right
 * there. The GENERATIVE corpus steps outside it: a generated input can declare a length
 * past one impl's native materialization ceiling (e.g. ontos-ts's Number-based reader,
 * safe to 2^53-1) while another impl reaches EOF first. Both correctly REJECT; they
 * differ only on the rejection CODE — ts says `limit_exceeded`, rs/go/py say
 * `unexpected_eof`. Per docs/spec/ontos-codec.md §3 (lines 97-105) and §4 (lines
 * 121-124), `limit_exceeded` is "implementation-local … operational policy, NOT part of
 * the byte contract" — "two cores with different length ceilings do not thereby disagree
 * about which byte strings are valid encodings." So a code-difference involving
 * `limit_exceeded` is spec-SANCTIONED divergence, not a conformance failure, and the
 * bout must not flag it.
 *
 * THE RULE (precise — the oracle is NOT weakened). For each hex in the generated corpus
 * the wrapper runs every impl once in JSON decode mode and reads the machine `error`
 * code. A hex is EXCLUDED from the judged corpus iff ANY impl reports the single code
 * `limit_exceeded` for it — the one code the spec names as impl-local. Every other code
 * (`unexpected_eof`, `unknown_tag`, `non_canonical_uvarint`, `uvarint_overflow`,
 * `trailing_bytes`), every success, and every success-vs-failure or non-limit_exceeded
 * code disagreement stays in the corpus and is judged byte-for-byte by the unchanged
 * runner. The exemption is exactly one code wide.
 *
 * WHY DECODE-MODE JSON IS THE CANONICAL PROBE. `limit_exceeded` is a DECODE-time
 * rejection: every inspector verb (decode/inspect/read/canon) decodes the input first,
 * so a hex that trips the limit under `decode` trips it under every verb and in both the
 * decode (json) and human passes. JSON is the only mode that exposes the code as a
 * stable machine field — human mode renders an impl-specific message (e.g. ts's "uvarint
 * … exceeds Number.MAX_SAFE_INTEGER"), which carries no determinism guarantee and no
 * shared token. So one JSON `decode` probe per (hex × impl) is the cheapest sound signal,
 * and it governs the skip for BOTH the decode and human judging passes.
 *
 * EXCLUDED FROM EQUALITY, NEVER FROM SAFETY (ontos-internal#353). The exemption above is about
 * which rejection CODE fires; it says nothing about whether every impl behaved. So the
 * probe also checks each impl's run against the CLI contract (ontos-cli.md "JSON Lines
 * output schema", "Exit codes"): it must exit with a documented code (0, 1, 2), not be
 * killed or time out, and print exactly one compact, `\n`-terminated result object
 * whose `ok` agrees with the exit code. A crash, a panic, an escaped host exception, a
 * hang or garbage output on ANY probed hex fails the bout, whether that hex is skipped
 * or kept. Before ontos-internal#353 a skipped hex was dropped from every check, so one impl crashing
 * where another said `limit_exceeded` was never seen. A kept hex was covered only by
 * the runner's equality, which passes when every impl crashes the same way.
 *
 * NEVER SILENTLY DROP. The skipped count is logged to stderr in the bout summary
 * ("N cases × K impls compared, M skipped at an impl-local resource limit (ontos-codec
 * §3/§4)"), with each skipped hex named, so coverage stays honest.
 *
 * CLI (a thin pass-through to run.mjs — same --impl / mode surface):
 *   node tools/fuzz/bout.mjs \
 *     --impl <name>=<command> [--impl ...] \
 *     --vectors <corpus.json> \
 *     [--decode-roundtrip] [--human-roundtrip]
 *
 *   --impl NAME=COMMAND   (repeatable, >=1 required) Same shape run.mjs accepts; the
 *                         wrapper both probes with it and forwards it verbatim.
 *   --vectors PATH        (repeatable, >=1 required here) The generated corpus file(s).
 *                         Unlike run.mjs this is REQUIRED — the wrapper is for the
 *                         generative bout, never the frozen vectors.
 *   --decode-roundtrip,   Forwarded UNCHANGED to run.mjs. (--from-json-roundtrip is
 *   --human-roundtrip       intentionally NOT supported: the generated corpus has no
 *                           pinned authoring `value`, exactly as gen.mjs documents.)
 *
 * EXIT CODES (inherited from run.mjs, so a CI failure is identical to today):
 *   0  filtered corpus is byte-identical across all impls in every selected mode.
 *   1  at least one genuine (non-limit_exceeded) divergence — the oracle still fires —
 *      or at least one impl FAULT on a probed hex (ontos-internal#353).
 *   2  usage error (bad args, unreadable corpus, an impl that cannot be spawned).
 *
 * Dependency-free maintainer tooling (node: builtins only), matching gen.mjs / run.mjs
 * house style. The filtered corpus is written to an ephemeral temp file and removed.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const RUNNER = join(REPO_ROOT, "tools", "conformance", "run.mjs");

// The single spec-named impl-local code (docs/spec/ontos-codec.md §3/§4). This is the
// ONLY code whose presence exempts a generated case from the byte-for-byte judgment.
const IMPL_LOCAL_CODE = "limit_exceeded";

// The CLI's documented exit codes (ontos-cli.md "Exit codes"). Anything else is a fault.
const DOCUMENTED_EXIT_CODES = new Set([0, 1, 2]);

// A probe decodes one short generated hex, so a minute is far past any honest run. The
// environment override exists for the regression test, which cannot wait a minute.
const PROBE_TIMEOUT_MS = Number(process.env.ONTOS_FUZZ_PROBE_TIMEOUT_MS) || 60_000;

// Well past any honest decode line; overflowing it is reported as a fault, not a crash.
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

class UsageError extends Error {}

// --- argument parsing --------------------------------------------------------
// Mirrors run.mjs's surface for the flags the bout uses, so the workflow line reads
// the same. --vectors is REQUIRED here (the wrapper is for the generated corpus only).
function parseArgs(argv) {
  const impls = []; // { name, argv: string[], spec }
  const vectors = [];
  const forward = []; // mode flags forwarded verbatim to run.mjs

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (flag) => {
      if (i + 1 >= argv.length) throw new UsageError(`${flag} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--impl") {
      const spec = takeValue("--impl");
      const eq = spec.indexOf("=");
      if (eq <= 0) throw new UsageError(`--impl must be NAME=COMMAND, got ${JSON.stringify(spec)}`);
      const name = spec.slice(0, eq);
      const command = spec.slice(eq + 1).trim();
      const cmdArgv = command.split(/\s+/).filter(Boolean);
      if (cmdArgv.length === 0) throw new UsageError(`--impl ${name}= has an empty COMMAND`);
      if (impls.some((m) => m.name === name)) throw new UsageError(`duplicate --impl name ${JSON.stringify(name)}`);
      impls.push({ name, argv: cmdArgv, spec });
    } else if (arg === "--vectors") {
      vectors.push(takeValue("--vectors"));
    } else if (arg === "--decode-roundtrip" || arg === "--human-roundtrip") {
      forward.push(arg);
    } else if (arg === "--from-json-roundtrip") {
      // The generated corpus carries no pinned authoring `value`; from-json is vector-only.
      throw new UsageError("--from-json-roundtrip is not supported by the bout (generated corpus has no pinned value)");
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (impls.length === 0) throw new UsageError("at least one --impl NAME=COMMAND is required");
  if (vectors.length === 0) throw new UsageError("at least one --vectors PATH is required");

  return { impls, vectors, forward };
}

function printUsage() {
  process.stderr.write(
    "usage: node tools/fuzz/bout.mjs \\\n" +
      "         --impl <name>=<command> [--impl ...] \\\n" +
      "         --vectors <corpus.json> [--vectors ...] \\\n" +
      "         [--decode-roundtrip] [--human-roundtrip]\n",
  );
}

// --- corpus IO ---------------------------------------------------------------
// Read one corpus file's "encode" array (the { name, hex } cases gen.mjs emits). The
// wrapper preserves the whole file shape and only rewrites the "encode" array, so any
// future field run.mjs reads survives the filter.
function readCorpus(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read corpus file ${path}: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.encode)) {
    throw new UsageError(`corpus file ${path} has no "encode" array`);
  }
  parsed.encode.forEach((c, i) => {
    if (typeof c.hex !== "string") {
      throw new UsageError(`corpus file ${path}: encode[${i}] has no string "hex"`);
    }
  });
  return parsed;
}

// --- the decode-mode probe ---------------------------------------------------
// Run one impl's `decode --format json <hex>` and return { code, fault }. `code` is the
// machine `error` code of a well-formed rejection, or null for a well-formed success.
// `fault` is null when the run kept the CLI contract, and otherwise says how it broke it
// (ontos-internal#353); a faulted run has no code. No shell: argv = implPrefix ++
// ["decode","--format","json", hex] (exactly run.mjs's decode call).
function probe(impl, hex) {
  const [program, ...rest] = impl.argv;
  const args = [...rest, "decode", "--format", "json", hex];
  const res = spawnSync(program, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  const fault = (why) => ({ code: null, fault: why });
  if (res.error) {
    if (res.error.code === "ETIMEDOUT") return fault(`timed out after ${PROBE_TIMEOUT_MS} ms`);
    if (res.error.code === "ENOBUFS") return fault(`wrote more than ${PROBE_MAX_BUFFER} bytes to stdout`);
    throw new UsageError(`cannot spawn impl ${JSON.stringify(impl.name)} (${program}): ${res.error.message}`);
  }
  if (res.signal) return fault(`killed by signal ${res.signal}`);
  if (!DOCUMENTED_EXIT_CODES.has(res.status)) {
    return fault(`exited ${res.status}, which is not a documented exit code (0, 1, 2)`);
  }
  const stdout = res.stdout ?? "";
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : null;
  if (line === null || line.includes("\n")) {
    return fault(
      `exited ${res.status} without exactly one \\n-terminated line on stdout (${JSON.stringify(stdout.slice(0, 120))})`,
    );
  }
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return fault(`stdout is not JSON (${JSON.stringify(line.slice(0, 120))})`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || typeof obj.ok !== "boolean") {
    return fault(`stdout is not a result object (${JSON.stringify(line.slice(0, 120))})`);
  }
  if (JSON.stringify(obj) !== line) {
    return fault(`stdout is not compact JSON (${JSON.stringify(line.slice(0, 120))})`);
  }
  if (obj.ok) {
    return res.status === 0 ? { code: null, fault: null } : fault(`reported ok:true but exited ${res.status}`);
  }
  if (typeof obj.error !== "string" || obj.error === "") return fault("reported ok:false without an error code");
  if (res.status === 0) return fault(`reported ok:false (${obj.error}) but exited 0`);
  return { code: obj.error, fault: null };
}

// Decide whether a hex must be excluded: true iff ANY impl reports IMPL_LOCAL_CODE for it.
// Returns { skip, codes, faults }: codes maps impl name -> observed code (for the log),
// and faults lists every impl whose run broke the CLI contract, which skip never excuses.
function classify(impls, hex) {
  let skip = false;
  const codes = {};
  const faults = [];
  for (const impl of impls) {
    const { code, fault } = probe(impl, hex);
    codes[impl.name] = fault === null ? code : "FAULT";
    if (fault !== null) faults.push({ impl: impl.name, fault });
    if (code === IMPL_LOCAL_CODE) skip = true;
  }
  return { skip, codes, faults };
}

function shortenHex(hex) {
  return hex.length > 80 ? `${hex.slice(0, 80)}…(${hex.length / 2}B)` : hex;
}

// --- main --------------------------------------------------------------------
function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`ontos-fuzz-bout: usage error — ${err.message}\n`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }

  const { impls, vectors, forward } = config;

  // Read every corpus file, probe each (distinct) hex once per impl, and partition the
  // cases into kept vs skipped. Dedup the probe by hex (the same bytes classify the same
  // way), but keep every original case so the filtered corpus is shape-faithful.
  const probeCache = new Map(); // hex -> { skip, codes }
  const skippedHexes = []; // { hex, codes } for the honest-coverage log
  const faults = []; // { hex, impl, fault }: contract breaks, reported and failed (ontos-internal#353)
  const filteredFiles = []; // resolved temp paths handed to the runner
  const tmpRoot = mkdtempSync(join(tmpdir(), "ontos-fuzz-bout-"));

  let totalCases = 0;
  try {
    vectors.forEach((vpath, vi) => {
      const corpus = readCorpus(resolve(vpath));
      const kept = [];
      for (const c of corpus.encode) {
        totalCases += 1;
        let verdict = probeCache.get(c.hex);
        if (verdict === undefined) {
          try {
            verdict = classify(impls, c.hex);
          } catch (err) {
            if (err instanceof UsageError) {
              process.stderr.write(`ontos-fuzz-bout: usage error — ${err.message}\n`);
              process.exit(2);
            }
            throw err;
          }
          probeCache.set(c.hex, verdict);
          if (verdict.skip) skippedHexes.push({ hex: c.hex, codes: verdict.codes });
          for (const f of verdict.faults) faults.push({ hex: c.hex, ...f });
        }
        if (!verdict.skip) kept.push(c);
      }
      const filtered = { ...corpus, count: kept.length, encode: kept };
      const outPath = join(tmpRoot, `filtered-${vi}.json`);
      writeFileSync(outPath, JSON.stringify(filtered, null, 2) + "\n");
      filteredFiles.push(outPath);
    });

    // Honest coverage log (stderr — stdout stays the runner's). Name each skipped hex
    // and the codes that triggered the skip, so a reviewer can see exactly what left the
    // judged corpus and why.
    const keptCount = totalCases - skippedHexes.length;
    process.stderr.write(
      `ontos-fuzz-bout: ${keptCount} cases × ${impls.length} impls compared, ` +
        `${skippedHexes.length} skipped at an impl-local resource limit ` +
        `(${IMPL_LOCAL_CODE}, ontos-codec §3/§4).\n`,
    );
    for (const s of skippedHexes) {
      const where = Object.entries(s.codes)
        .map(([name, code]) => `${name}=${code ?? "ok"}`)
        .join(" ");
      process.stderr.write(`ontos-fuzz-bout:   SKIP ${shortenHex(s.hex)} [${where}]\n`);
    }
    // A fault fails the bout whether or not its hex was skipped. The runner still runs, so
    // the report shows any divergence on the kept cases as well.
    for (const f of faults) {
      process.stderr.write(`ontos-fuzz-bout: FAULT ${f.impl} on ${shortenHex(f.hex)}: ${f.fault}\n`);
    }
    if (faults.length > 0) {
      process.stderr.write(
        `ontos-fuzz-bout: ${faults.length} impl fault(s) — a broken run is a failure even where ` +
          `another impl reports ${IMPL_LOCAL_CODE} (ontos-internal#353).\n`,
      );
    }

    // Hand the filtered corpus to the UNCHANGED runner. Its judgment is the protocol; we
    // only narrowed the input set to the codec's agreement domain. Forward the mode flags
    // verbatim and inherit the runner's stdout/stderr and exit code, so a genuine
    // divergence reds the build exactly as before.
    const runnerArgs = [RUNNER];
    for (const impl of impls) runnerArgs.push("--impl", impl.spec);
    for (const f of filteredFiles) runnerArgs.push("--vectors", f);
    runnerArgs.push(...forward);

    const res = spawnSync(process.execPath, runnerArgs, { stdio: "inherit" });
    if (res.error) {
      process.stderr.write(`ontos-fuzz-bout: cannot spawn the conformance runner: ${res.error.message}\n`);
      process.exit(2);
    }
    const runnerStatus = res.status === null ? 1 : res.status;
    process.exitCode = runnerStatus !== 0 ? runnerStatus : faults.length > 0 ? 1 : 0;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
