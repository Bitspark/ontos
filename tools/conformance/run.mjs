#!/usr/bin/env node
/*
 * ontos-conformance — the differential conformance runner for the `ontos` CLI.
 *
 * WHAT THIS IS. The `ontos` CLI ships in three peer implementations (go · rs · ts),
 * each built over its own core, all implementing the SAME contract
 * (docs/spec/ontos-cli.md). "No favored language" is only a real property if it is
 * ENFORCED: this runner drives every implementation over a shared corpus of vector
 * hexes and asserts their machine output is BYTE-IDENTICAL. It is the executable form
 * of docs/spec/ontos-conformance.md — agreement as a checked theorem, not a hope.
 *
 * It is an out-of-process, black-box check: it knows nothing about any core's
 * internals. It speaks only the CLI contract — the `--format json` JSON Lines output
 * (ontos-cli.md "JSON Lines output schema"), which is byte-comparable by design
 * (compact, fixed key order, lowercase hex, `\n`-terminated). That is exactly why a
 * FOURTH implementation in any language can prove its conformance by being added as
 * another `--impl` here, with NO in-process test code ported: pass the contract's
 * bytes, agree on the contract's bytes.
 *
 * WHAT IT DOES. For every (hex, command) pair drawn from the vector corpus, it runs
 * each implementation and captures stdout and the process exit code. It compares all
 * implementations BYTE-FOR-BYTE on stdout AND on the exit code: stdout is the
 * conformance protocol (the JSON Lines object), and the exit code is part of the CLI
 * contract too (ontos-cli.md "Exit codes"), so an implementation that emits the right
 * bytes but the wrong code is a real non-conformance. (stderr is NOT compared — human
 * diagnostics carry no determinism guarantee.) Any disagreement is a divergence,
 * reported with the command, the hex, and each implementation's output and exit code.
 *
 * THREE CHECK MODES. The default is the bytes-in DECODE mode just described
 * (hex -> JSON Lines). A second, opt-in AUTHOR->BYTES mode (--from-json-roundtrip)
 * inverts the protocol: it drives `<impl> canon --emit --from-json <value-json>` over
 * each vector's authoring `value` and asserts both a DIFFERENTIAL property — all impls
 * emit byte-identical stdout + exit code — AND an ORACLE property — the emitted hex
 * equals that vector case's pinned `.hex`. This pins the full round-trip
 * "author -> canonical bytes" as a checked, tri-core theorem: the JSON the CLI emits in
 * decode mode (ontos-cli.md "Value rendering") is the exact notation it parses here, and
 * the bytes it parses to are the same frozen bytes the vector decode side started from.
 * A third, opt-in HUMAN mode (--human-roundtrip) re-runs the same (hex, command) corpus
 * but with `--format human` and asserts the impls' stdout + exit code are byte-identical.
 * `--format human` USED to carry "no determinism guarantee" (ontos-cli.md); ontos-internal#46
 * makes the recognized-line rendering canonical and tri-core-enforced, and this mode is
 * what enforces it — turning human output into a checked parity property, not a hope.
 * (stderr is still not compared.) Pass --decode-roundtrip, --from-json-roundtrip, and/or
 * --human-roundtrip to select modes; with no mode flag the default decode mode runs
 * (back-compatible). The passes are independent and any divergence in any of them fails
 * the run.
 *
 * THE CORPUS. By default the hexes are the `.hex` field of every element in the
 * "encode" array of BOTH vectors/codec.json and vectors/data.json (override/extend
 * with --vectors). The default commands are the five standard inspector verbs:
 *   decode · inspect · read --all · canon --check · canon --emit
 * In decode mode each emits exactly one JSON Lines object; in human mode each emits a
 * small fixed block of human lines. The same command corpus drives both modes.
 *
 * CLI:
 *   node tools/conformance/run.mjs \
 *     --impl <name>=<command> [--impl <name>=<command> ...] \
 *     [--vectors <path> ...] [--commands "<csv>"] \
 *     [--decode-roundtrip] [--from-json-roundtrip] [--human-roundtrip]
 *
 *   --impl NAME=COMMAND   (repeatable, >=1 required) An implementation to drive.
 *                         COMMAND is whitespace-split into an argv array, e.g.
 *                         "ontos-ts=node ./cli/ts/dist/src/main.js" becomes the prefix
 *                         ["node","./cli/ts/dist/src/main.js"]. The runner then appends
 *                         the subcommand tokens, then "--format" "json", then the hex,
 *                         and execs via child_process.spawnSync with NO shell (a real
 *                         argv array — no quoting, no shell metacharacter hazards).
 *   --vectors PATH        (repeatable) A vector JSON file; its "encode" array is read
 *                         and every .hex collected. Defaults to BOTH
 *                         vectors/codec.json and vectors/data.json (resolved relative
 *                         to the repo root, i.e. tools/conformance/../..).
 *   --commands "a,b,..."  Override the command list with a comma-separated string;
 *                         each entry is itself whitespace-split into subcommand tokens
 *                         (so "read --all" is one entry of two tokens). Defaults to the
 *                         five standard verbs above.
 *   --decode-roundtrip    Run the default DECODE check mode (hex -> JSON Lines). Implied
 *                         when no mode flag is given; naming it lets you run it ALONGSIDE
 *                         --from-json-roundtrip in one invocation.
 *   --from-json-roundtrip Run the AUTHOR->BYTES check mode: for every vector encode case
 *                         (which carries both an authoring `value` and the canonical
 *                         `hex`), drive `<impl> canon --emit --format json --from-json
 *                         <compact-value-json>` for each impl. The value-json is the
 *                         single compact-JSON argv token (no shell). Assert (a) all impls
 *                         agree byte-for-byte on stdout + exit code, and (b) the emitted
 *                         hex equals the vector's pinned `.hex`.
 *   --human-roundtrip     Run the HUMAN check mode: the SAME (hex, command) corpus as
 *                         decode mode but with "--format human", asserting all impls agree
 *                         byte-for-byte on stdout + exit code. This enforces the canonical
 *                         human rendering (ontos-internal#46) — purely differential, no oracle
 *                         (human output is a tri-core identity property, not pinned in the
 *                         vectors).
 *
 * ASSUMPTION — NO SPACES IN PATHS. Because both --impl COMMAND and each --commands
 * entry are tokenized by splitting on whitespace, neither an implementation's argv
 * (its program path + flags) nor a command entry may contain a path with embedded
 * spaces. The standard impls (./target/debug/ontos, ./ontos-go, node + a dist path)
 * have none. If you ever need a spaced path, this tool is the wrong layer — keep the
 * binaries on a space-free path.
 *
 * EXIT CODES:
 *   0  every check passed — in decode/human mode every (hex × command) is byte-identical
 *      across all impls; in author->bytes mode every case is byte-identical across all
 *      impls AND every emitted hex equals the vector's pinned hex.
 *   1  at least one divergence (the tool ran; the answer is "they disagree" — a
 *      differential mismatch, or an emitted hex that does not equal the pinned hex).
 *   2  usage error — no --impl, an unreadable/ill-formed vectors file, or an
 *      implementation binary that cannot be spawned (the tool could not run).
 *
 * This is dependency-free maintainer tooling (node: builtins only, no new deps),
 * matching tools/vector/gen.mjs house style. Run from the repo root after building
 * the three compiled CLIs; see tools/conformance/README.md.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const DEFAULT_VECTORS = [
  join(REPO_ROOT, "vectors", "codec.json"),
  join(REPO_ROOT, "vectors", "data.json"),
];

const DEFAULT_COMMANDS = ["decode", "inspect", "read --all", "canon --check", "canon --emit"];

// The registered embedding labels, in the contract's fixed order (ontos-data.md §5).
// The HUMAN mode additionally drives `read --kind <label>` for each so the per-kind
// human line (`<kind>: yes|no`, ontos-internal#46) is enforced for every label — these are NOT
// in DEFAULT_COMMANDS because the decode (JSON) mode already covers the per-value
// recognition verdict via `read --all`'s JSON `recognized` array, so a per-kind JSON
// sweep would be redundant. (The vectors carry no `recognized` field of their own;
// recognition is observed only through the CLI's output.)
const KIND_LABELS = ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"];
const HUMAN_KIND_COMMANDS = KIND_LABELS.map((k) => ["read", "--kind", k]);

/** A usage error: the tool could not run. Carries exit code 2. */
class UsageError extends Error {}

// --- argument parsing --------------------------------------------------------
// --impl NAME=COMMAND (repeatable), --vectors PATH (repeatable), --commands CSV.
function parseArgs(argv) {
  const impls = []; // { name, argv: string[] }
  const vectors = [];
  let commands = null;
  let decodeRoundtrip = false;
  let fromJsonRoundtrip = false;
  let humanRoundtrip = false;

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
      impls.push({ name, argv: cmdArgv });
    } else if (arg === "--vectors") {
      vectors.push(takeValue("--vectors"));
    } else if (arg === "--commands") {
      commands = takeValue("--commands")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.split(/\s+/).filter(Boolean));
      if (commands.length === 0) throw new UsageError("--commands must list at least one command");
    } else if (arg === "--decode-roundtrip") {
      decodeRoundtrip = true;
    } else if (arg === "--from-json-roundtrip") {
      fromJsonRoundtrip = true;
    } else if (arg === "--human-roundtrip") {
      humanRoundtrip = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (impls.length === 0) throw new UsageError("at least one --impl NAME=COMMAND is required");

  // Modes: each may be selected independently. With NO mode flag the default decode
  // mode runs (back-compatible). Naming --decode-roundtrip lets it run alongside the
  // other modes in one invocation.
  const noModeFlag = !decodeRoundtrip && !fromJsonRoundtrip && !humanRoundtrip;

  return {
    impls,
    vectors: vectors.length > 0 ? vectors : DEFAULT_VECTORS,
    commands: commands ?? DEFAULT_COMMANDS.map((c) => c.split(/\s+/)),
    decodeRoundtrip: decodeRoundtrip || noModeFlag,
    fromJsonRoundtrip,
    humanRoundtrip,
  };
}

function printUsage() {
  process.stderr.write(
    "usage: node tools/conformance/run.mjs \\\n" +
      "         --impl <name>=<command> [--impl <name>=<command> ...] \\\n" +
      "         [--vectors <path> ...] [--commands \"<csv>\"] \\\n" +
      "         [--decode-roundtrip] [--from-json-roundtrip] [--human-roundtrip]\n",
  );
}

// --- vectors -> hex corpus ---------------------------------------------------
// Read each vectors file's "encode" array and collect every .hex, preserving file
// order and de-duplicating (the same hex compared twice proves nothing extra).
function collectHexes(paths) {
  const seen = new Set();
  const hexes = [];
  for (const p of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new UsageError(`cannot read vectors file ${p}: ${err.message}`);
    }
    if (!parsed || !Array.isArray(parsed.encode)) {
      throw new UsageError(`vectors file ${p} has no "encode" array`);
    }
    parsed.encode.forEach((c, i) => {
      if (typeof c.hex !== "string") {
        throw new UsageError(`vectors file ${p}: encode[${i}] has no string "hex"`);
      }
      if (!seen.has(c.hex)) {
        seen.add(c.hex);
        hexes.push(c.hex);
      }
    });
  }
  if (hexes.length === 0) throw new UsageError("no hexes found in the given vectors file(s)");
  return hexes;
}

// --- vectors -> author->bytes case corpus ------------------------------------
// For the --from-json-roundtrip mode, read each vectors file's "encode" array and
// collect every { value, hex } pair: `value` is the authoring JSON ({atom}/{tuple})
// that the CLI parses with --from-json, and `hex` is the canonical bytes that emit
// must reproduce. The compact `valueJson` is precomputed once (JSON.stringify of the
// already-compact value object yields exactly the {atom:hex}|{tuple:[…]} notation the
// CLI's --format json rendering emits — this is its exact inverse) so it can be passed
// as a single argv token with no shell. Dedup on (valueJson, hex): the same case
// compared twice proves nothing extra.
function collectEncodeCases(paths) {
  const seen = new Set();
  const cases = [];
  for (const p of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new UsageError(`cannot read vectors file ${p}: ${err.message}`);
    }
    if (!parsed || !Array.isArray(parsed.encode)) {
      throw new UsageError(`vectors file ${p} has no "encode" array`);
    }
    parsed.encode.forEach((c, i) => {
      if (typeof c.hex !== "string") {
        throw new UsageError(`vectors file ${p}: encode[${i}] has no string "hex"`);
      }
      if (c.value === undefined) {
        throw new UsageError(`vectors file ${p}: encode[${i}] has no "value" (authoring JSON)`);
      }
      const valueJson = JSON.stringify(c.value);
      const key = `${valueJson} ${c.hex}`;
      if (!seen.has(key)) {
        seen.add(key);
        cases.push({ name: c.name ?? `encode[${i}]`, valueJson, hex: c.hex });
      }
    });
  }
  if (cases.length === 0) throw new UsageError("no encode cases found in the given vectors file(s)");
  return cases;
}

// --- run one impl for one (command, hex) -------------------------------------
// argv = implPrefix ++ subcommandTokens ++ ["--format", format, hex]. No shell.
// `format` is "json" (decode mode) or "human" (human mode) — the same corpus drives
// both, differing only in the rendering the contract pins.
function runImpl(impl, commandTokens, hex, format = "json") {
  const [program, ...rest] = impl.argv;
  const args = [...rest, ...commandTokens, "--format", format, hex];
  const res = spawnSync(program, args, { encoding: "utf8" });
  if (res.error) {
    // ENOENT etc. — the binary cannot be spawned at all. The tool could not run.
    throw new UsageError(`cannot spawn impl ${JSON.stringify(impl.name)} (${program}): ${res.error.message}`);
  }
  return { stdout: res.stdout ?? "", status: res.status };
}

// --- run one impl for one author->bytes case ---------------------------------
// argv = implPrefix ++ ["canon","--emit","--format","json","--from-json", valueJson].
// valueJson is one compact-JSON argv token (no shell). No bytes are decoded; the impl
// builds the Value from the authoring notation and emits its canonical hex.
function runImplFromJson(impl, valueJson) {
  const [program, ...rest] = impl.argv;
  const args = [...rest, "canon", "--emit", "--format", "json", "--from-json", valueJson];
  const res = spawnSync(program, args, { encoding: "utf8" });
  if (res.error) {
    throw new UsageError(`cannot spawn impl ${JSON.stringify(impl.name)} (${program}): ${res.error.message}`);
  }
  return { stdout: res.stdout ?? "", status: res.status };
}

// Extract the `hex` field from a `canon --emit --format json` stdout line, i.e.
// {"ok":true,"command":"canon","hex":"01.."}. Returns null if the line is not a
// successful emit object (so the oracle check can flag it rather than crash).
function emittedHex(stdout) {
  try {
    const obj = JSON.parse(stdout.trim());
    if (obj && obj.ok === true && typeof obj.hex === "string") return obj.hex;
  } catch {
    // fall through — not parseable as the expected emit object.
  }
  return null;
}

// A usage error escaping a check loop is fatal: report and exit 2.
function abortOnUsage(err) {
  if (err instanceof UsageError) {
    process.stderr.write(`ontos-conformance: usage error — ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

// --- differential (hex, command) modes: decode (json) + human ----------------
// For every (hex, command) drive each impl at `format` and compare stdout + exit
// code. Shared by the DECODE mode (format "json" — hex -> JSON Lines) and the HUMAN
// mode (format "human" — the canonical human rendering, ontos-internal#46): both are purely
// differential over the same corpus, differing only in the rendering the contract
// pins. Returns { divergences, summary }; each divergence carries { mode, label,
// perImpl }. `mode` labels the divergence block; `summaryVerb` names it in the
// summary line.
function runDifferentialMode(impls, hexes, commands, format, mode, summaryVerb) {
  const divergences = [];
  for (const hex of hexes) {
    for (const commandTokens of commands) {
      const command = commandTokens.join(" ");
      let perImpl;
      try {
        perImpl = impls.map((impl) => ({ impl, ...runImpl(impl, commandTokens, hex, format) }));
      } catch (err) {
        abortOnUsage(err);
      }

      // Compare ALL impls against the first, byte-for-byte on stdout AND on the
      // process exit code. stdout is the conformance protocol (the JSON Lines object
      // in decode mode, the human block in human mode); the exit code is part of the
      // CLI contract too (ontos-cli.md "Exit codes"), so an impl that emits the right
      // bytes but the wrong code is a real non-conformance and must be flagged.
      const ref = perImpl[0];
      const agree = perImpl.every((r) => r.stdout === ref.stdout && r.status === ref.status);
      if (!agree) {
        divergences.push({
          mode,
          label: `${command} ${hex}`,
          perImpl: perImpl.map((r) => ({ name: r.impl.name, stdout: r.stdout, status: r.status })),
        });
      }
    }
  }
  const summary =
    `${summaryVerb}: ${hexes.length} hexes x ${commands.length} commands x ${impls.length} impls`;
  return { divergences, summary };
}

function runDecodeMode(impls, hexes, commands) {
  return runDifferentialMode(impls, hexes, commands, "json", "decode", "decode");
}

function runHumanMode(impls, hexes, commands) {
  // The human mode drives the shared command corpus PLUS a per-kind `read --kind <label>`
  // sweep, so the canonical `<kind>: yes|no` line is enforced for every registered label.
  const humanCommands = [...commands, ...HUMAN_KIND_COMMANDS];
  return runDifferentialMode(impls, hexes, humanCommands, "human", "human", "human");
}

// --- author->bytes mode: --from-json canon --emit, differential + oracle -----
// For every vector encode case { valueJson, hex } drive each impl's
// `canon --emit --format json --from-json <valueJson>` and assert BOTH:
//   (a) DIFFERENTIAL — all impls agree byte-for-byte on stdout + exit code;
//   (b) ORACLE — the emitted hex equals the vector's pinned hex.
// (b) is checked against the reference impl's emitted hex (sound because (a) already
// pins all impls to the same bytes — an oracle miss is then a single tri-core fact).
function runFromJsonMode(impls, cases) {
  const divergences = [];
  for (const c of cases) {
    let perImpl;
    try {
      perImpl = impls.map((impl) => ({ impl, ...runImplFromJson(impl, c.valueJson) }));
    } catch (err) {
      abortOnUsage(err);
    }

    const ref = perImpl[0];
    const agree = perImpl.every((r) => r.stdout === ref.stdout && r.status === ref.status);
    if (!agree) {
      divergences.push({
        mode: "from-json (differential)",
        label: `${c.name} ${c.valueJson}`,
        perImpl: perImpl.map((r) => ({ name: r.impl.name, stdout: r.stdout, status: r.status })),
      });
      // Skip the oracle check for a divergent case: with no agreed bytes, "the emitted
      // hex" is ill-defined; the differential finding already names the case to fix.
      continue;
    }

    // Oracle: the agreed emitted hex must equal the vector's pinned hex.
    const got = emittedHex(ref.stdout);
    if (got !== c.hex) {
      divergences.push({
        mode: "from-json (oracle)",
        label: `${c.name} ${c.valueJson}`,
        oracle: { expected: c.hex, got: got ?? `<no hex in: ${ref.stdout.replace(/\n$/, "")}>` },
        perImpl: perImpl.map((r) => ({ name: r.impl.name, stdout: r.stdout, status: r.status })),
      });
    }
  }
  const summary = `from-json: ${cases.length} encode cases x ${impls.length} impls (author->bytes)`;
  return { divergences, summary };
}

// --- main --------------------------------------------------------------------
function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`ontos-conformance: usage error — ${err.message}\n`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }

  const { impls, commands, decodeRoundtrip, fromJsonRoundtrip, humanRoundtrip } = config;
  const resolvedVectors = config.vectors.map((p) => resolve(p));

  const divergences = [];
  const summaries = [];

  // Both the decode and human modes drive the same (hex, command) corpus, so the hex
  // list is collected once and reused.
  let hexes = null;
  if (decodeRoundtrip || humanRoundtrip) {
    try {
      hexes = collectHexes(resolvedVectors);
    } catch (err) {
      abortOnUsage(err);
    }
  }

  if (decodeRoundtrip) {
    const r = runDecodeMode(impls, hexes, commands);
    divergences.push(...r.divergences);
    summaries.push(r.summary);
  }

  if (humanRoundtrip) {
    const r = runHumanMode(impls, hexes, commands);
    divergences.push(...r.divergences);
    summaries.push(r.summary);
  }

  if (fromJsonRoundtrip) {
    let cases;
    try {
      cases = collectEncodeCases(resolvedVectors);
    } catch (err) {
      abortOnUsage(err);
    }
    const r = runFromJsonMode(impls, cases);
    divergences.push(...r.divergences);
    summaries.push(r.summary);
  }

  // --- report ----------------------------------------------------------------
  for (const d of divergences) {
    process.stdout.write(`DIVERGENCE [${d.mode}: ${d.label}]\n`);
    if (d.oracle) {
      process.stdout.write(`  emit != pinned hex: expected ${d.oracle.expected}, got ${d.oracle.got}\n`);
    }
    for (const r of d.perImpl) {
      // stdout is one JSON Lines object terminated by \n; trim the trailing newline
      // so the report stays one block per impl.
      process.stdout.write(`  ${r.name} (exit ${r.status}): ${r.stdout.replace(/\n$/, "")}\n`);
    }
  }

  const implNames = impls.map((m) => m.name).join(", ");
  const scope = summaries.join(" + ");

  if (divergences.length > 0) {
    process.stdout.write(
      `ontos-conformance: FAIL — ${divergences.length} divergence(s) over ${scope} ` +
        `(${implNames}).\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `ontos-conformance: checked ${scope} (${implNames}) — all byte-identical` +
      (fromJsonRoundtrip ? " and every emit == pinned hex" : "") +
      "\n",
  );
  process.exit(0);
}

main();
