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
 * (stderr is still not compared.) A fourth, opt-in READING mode (--input-reading)
 * judges how each impl READS an input text (ontos-cli.md "Value input"): it runs a file
 * of texts — malformed, oddly spaced, escaped, too deep, not UTF-8 — each with the
 * outcome the contract gives it, through argv and through stdin, and asserts every
 * impl's stdout + exit code equal that outcome. Pass --decode-roundtrip,
 * --from-json-roundtrip, --human-roundtrip and/or --input-reading to select modes;
 * with no mode flag the default decode mode runs (back-compatible). The passes are
 * independent and any divergence in any of them fails the run.
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
 *     [--decode-roundtrip] [--from-json-roundtrip] [--human-roundtrip] \
 *     [--input-reading [--reading-cases <path>] [--verbose]]
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
 *   --input-reading       Run the READING check mode over the cases file (default
 *                         tools/conformance/input-reading.json). Each case is an input
 *                         text (a --from-json text, or with "source": "hex" the hex
 *                         input) and its expected outcome: canonical hex, or an error
 *                         code. For each case, each impl runs `canon --emit --format json`
 *                         on the text through argv (when the text fits) and through stdin
 *                         (`-`); stdout and the exit code must equal the expected line and
 *                         the contract's exit code. For an accepted text, `decode` (json
 *                         and human) of the text must also equal `decode` of the expected
 *                         hex, whole and byte for byte, in each impl and across impls.
 *   --reading-cases PATH  Read the READING cases from PATH instead.
 *   --verbose             With --input-reading: print each case's per-impl outcome.
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
 *      impls AND every emitted hex equals the vector's pinned hex; in reading mode every
 *      impl gave every case its expected outcome.
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
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const DEFAULT_VECTORS = [
  join(REPO_ROOT, "vectors", "codec.json"),
  join(REPO_ROOT, "vectors", "data.json"),
];

const DEFAULT_COMMANDS = ["decode", "inspect", "read --all", "canon --check", "canon --emit"];

const DEFAULT_READING_CASES = join(HERE, "input-reading.json");

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
  let inputReading = false;
  let readingCases = null;
  let verbose = false;

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
    } else if (arg === "--input-reading") {
      inputReading = true;
    } else if (arg === "--reading-cases") {
      readingCases = takeValue("--reading-cases");
    } else if (arg === "--verbose") {
      verbose = true;
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
  const noModeFlag = !decodeRoundtrip && !fromJsonRoundtrip && !humanRoundtrip && !inputReading;

  return {
    impls,
    vectors: vectors.length > 0 ? vectors : DEFAULT_VECTORS,
    commands: commands ?? DEFAULT_COMMANDS.map((c) => c.split(/\s+/)),
    decodeRoundtrip: decodeRoundtrip || noModeFlag,
    fromJsonRoundtrip,
    humanRoundtrip,
    inputReading,
    readingCases: readingCases ?? DEFAULT_READING_CASES,
    verbose,
  };
}

function printUsage() {
  process.stderr.write(
    "usage: node tools/conformance/run.mjs \\\n" +
      "         --impl <name>=<command> [--impl <name>=<command> ...] \\\n" +
      "         [--vectors <path> ...] [--commands \"<csv>\"] \\\n" +
      "         [--decode-roundtrip] [--from-json-roundtrip] [--human-roundtrip] \\\n" +
      "         [--input-reading [--reading-cases <path>] [--verbose]]\n",
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
        kind: "pinned-hex",
        oracle: { expected: c.hex, got: got ?? `<no hex in: ${ref.stdout.replace(/\n$/, "")}>` },
        perImpl: perImpl.map((r) => ({ name: r.impl.name, stdout: r.stdout, status: r.status })),
      });
    }
  }
  const summary = `from-json: ${cases.length} encode cases x ${impls.length} impls (author->bytes)`;
  return { divergences, summary };
}


// --- reading mode: how each impl reads its input text ------------------------
// The cases file (DEFAULT_READING_CASES) holds texts the authoring-value modes above
// cannot express — malformed, oddly spaced, escaped, too deep, not UTF-8 — each with
// the outcome docs/spec/ontos-cli.md gives it ("Value input"). A case's text is a
// --from-json text by default, or with "source": "hex" the hex input. Every impl runs
// `canon --emit --format json` on it, and the judgment is an ORACLE: every impl must
// give exactly the expected stdout line and the contract's exit code, so a fault
// shared by all four impls still fails the run.

// The contract's exit code for each outcome (ontos-cli.md "Exit codes"): success 0;
// a decode error, or limit_exceeded, 1; invalid_json and invalid_hex 2, the usage class.
const READING_EXIT = {
  ok: 0,
  limit_exceeded: 1,
  unexpected_eof: 1,
  trailing_bytes: 1,
  unknown_tag: 1,
  non_canonical_uvarint: 1,
  uvarint_overflow: 1,
  invalid_json: 2,
  invalid_hex: 2,
};

// A text whose argument would be longer than this runs through stdin only. Windows
// caps a whole command line at 32767 UTF-16 units, and its quoting can escape every
// '"' and '\' and adds two quotes, so the length that counts is the escaped one
// (argvLength); the same rule applies on every platform, so every platform runs the
// same set.
const ARGV_MAX = 16384;
const argvLength = (text) => text.length + 2 + (text.match(/["\\]/g)?.length ?? 0);

// Node passes arguments only as strings, so a text that is not UTF-8 reaches an impl's
// argv through this trampoline: python3 decodes the hex arguments and execs the impl
// with the raw bytes. POSIX only — Windows argv is UTF-16 and cannot hold such bytes.
const ARGV_BYTES = process.platform !== "win32";
const TRAMPOLINE = "import os, sys; a = [bytes.fromhex(x) for x in sys.argv[1:]]; os.execvp(a[0], a)";
const PYTHON = process.env.PYTHON ?? "python3";

// Expand a piece list: a string, or an array of strings and [string, count] pairs.
function expandPieces(spec, where) {
  if (typeof spec === "string") return spec;
  if (!Array.isArray(spec)) throw new UsageError(`${where}: expected a string or a list of pieces`);
  return spec
    .map((p) => {
      if (typeof p === "string") return p;
      if (Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && Number.isInteger(p[1]) && p[1] >= 0) {
        return p[0].repeat(p[1]);
      }
      throw new UsageError(`${where}: a piece must be a string or a [string, count] pair`);
    })
    .join("");
}

function collectReadingCases(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read reading cases ${path}: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new UsageError(`reading cases ${path} has no "cases" array`);
  }
  return parsed.cases.map((c, i) => {
    const where = `${path}: cases[${i}]`;
    if (typeof c.name !== "string") throw new UsageError(`${where} has no string "name"`);
    const source = c.source ?? "json";
    if (source !== "json" && source !== "hex") throw new UsageError(`${where}.source must be "json" or "hex"`);
    if ((c.text === undefined) === (c.bytes === undefined)) {
      throw new UsageError(`${where} needs exactly one of "text" or "bytes"`);
    }
    let input;
    let text = null; // the argument as a string, when the input is one
    if (c.text !== undefined) {
      text = expandPieces(c.text, `${where}.text`);
      input = Buffer.from(text, "utf8");
    } else {
      if (typeof c.bytes !== "string" || !/^([0-9a-f]{2})*$/.test(c.bytes)) {
        throw new UsageError(`${where}.bytes must be lowercase hex`);
      }
      input = Buffer.from(c.bytes, "hex");
    }
    if (c.chunked !== undefined && typeof c.chunked !== "boolean") {
      throw new UsageError(`${where}.chunked must be true or false`);
    }
    const via = c.via ?? ["argv", "stdin"];
    if (!Array.isArray(via) || via.length === 0 || via.some((v) => v !== "argv" && v !== "stdin")) {
      throw new UsageError(`${where}.via must list "argv" and/or "stdin"`);
    }
    // A text with NUL cannot be an argument; a long one would not fit a command line.
    const length = text !== null ? argvLength(text) : input.length + 2;
    const argvFits = !input.includes(0) && length <= ARGV_MAX && (text !== null || ARGV_BYTES);
    const sources = via.filter((v) => v === "stdin" || argvFits);
    const e = c.expect ?? {};
    let expect;
    if (e.hex !== undefined && e.error === undefined) {
      expect = { hex: expandPieces(e.hex, `${where}.expect.hex`) };
    } else if (e.error !== undefined && e.hex === undefined && Object.hasOwn(READING_EXIT, e.error) && e.error !== "ok") {
      expect = { error: e.error };
    } else {
      throw new UsageError(`${where}.expect must be {"hex": …} or {"error": <a contract error code>}`);
    }
    return { name: c.name, source, input, text, sources, expect, chunked: c.chunked === true };
  });
}

// The py lane must read stdin as bytes. Python decodes sys.stdin through the
// locale: with surrogateescape under C or C.UTF-8 (where this usually runs), strictly
// under en_US.UTF-8, where a lane that read text crashed on a byte that is not
// UTF-8. Strict here judges the stricter of the two on every runner; it changes
// nothing for an impl that is not Python (and python's stderr stays backslashreplace).
const READING_ENV = { ...process.env, PYTHONIOENCODING: "utf-8:strict" };

// Long output is cut down for a divergence report.
const shorten = (s) => (s.length > 200 ? `${s.slice(0, 200)}… (${s.length} chars)` : s);

// A "chunked" case's stdin is written 64 KiB at a time with a 2 ms pause between
// chunks, so the impl reads faster than the pipe fills and meets an empty
// non-blocking pipe mid-input (the EAGAIN that crashed ts's readFileSync(0)).
const CHUNK = 1 << 16;
const CHUNK_PAUSE_MS = 2;

async function writeChunked(stream, input) {
  for (let off = 0; off < input.length; off += CHUNK) {
    if (stream.destroyed) return;
    stream.write(input.subarray(off, off + CHUNK));
    await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
  }
  stream.end();
}

// Run one impl with `args` after its prefix and `input` on stdin, never through a
// shell. An argument given as a Buffer goes through the bytes trampoline.
function runAsync(impl, args, input, chunked = false) {
  let [program, ...argv] = [...impl.argv, ...args];
  if (argv.some((a) => Buffer.isBuffer(a))) {
    argv = ["-I", "-c", TRAMPOLINE, ...[program, ...argv].map((a) => Buffer.from(a).toString("hex"))];
    program = PYTHON;
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, argv, { stdio: ["pipe", "pipe", "ignore"], env: READING_ENV });
    const out = [];
    child.stdout.on("data", (d) => out.push(d));
    child.on("error", (err) =>
      rejectRun(new UsageError(`cannot spawn impl ${JSON.stringify(impl.name)} (${program}): ${err.message}`)),
    );
    child.on("close", (status, signal) =>
      resolveRun({ stdout: Buffer.concat(out).toString("utf8"), status: status ?? `signal ${signal}` }),
    );
    child.stdin.on("error", () => {}); // an impl may exit before reading all of it
    if (chunked) writeChunked(child.stdin, input);
    else child.stdin.end(input);
  });
}

// One case: `canon --emit` through each source (oracle), then, for an accepted
// text, decode of the text against decode of the expected hex.
async function runReadingCase(impls, c) {
  const divergences = [];
  const report = [];
  const expectedLine = c.expect.hex !== undefined
    ? `{"ok":true,"command":"canon","hex":"${c.expect.hex}"}\n`
    : `{"ok":false,"command":"canon","error":"${c.expect.error}"}\n`;
  const expectedExit = READING_EXIT[c.expect.hex !== undefined ? "ok" : c.expect.error];
  const flag = c.source === "json" ? ["--from-json"] : [];

  for (const via of c.sources) {
    const arg = via === "stdin" ? "-" : c.text ?? c.input;
    const args = ["canon", "--emit", "--format", "json", ...flag, arg];
    const input = via === "stdin" ? c.input : Buffer.alloc(0);
    const chunked = via === "stdin" && c.chunked;
    const perImpl = await Promise.all(
      impls.map(async (impl) => ({ impl, ...(await runAsync(impl, args, input, chunked)) })),
    );
    report.push({ via, perImpl });
    if (!perImpl.every((r) => r.stdout === expectedLine && r.status === expectedExit)) {
      divergences.push({
        mode: `reading (${c.source} through ${via})`,
        label: c.name,
        kind: "outcome",
        expected: `${shorten(expectedLine.replace(/\n$/, ""))} with exit ${expectedExit}`,
        perImpl: perImpl.map((r) => ({ name: r.impl.name, stdout: shorten(r.stdout), status: r.status })),
      });
    }
  }

  if (c.expect.hex !== undefined) {
    // The value read from the text is the value its canonical bytes decode to, in
    // each impl (so no impl accepts a value its own default decoder refuses), and
    // every impl prints all of it, byte for byte the same: a large value's output
    // must arrive whole (ts once cut a 2 MB line short with exit 0).
    for (const format of ["json", "human"]) {
      const perImpl = await Promise.all(
        impls.map(async (impl) => {
          const viaJson = await runAsync(impl, ["decode", "--format", format, ...flag, "-"], c.input, c.chunked);
          const viaHex = await runAsync(impl, ["decode", "--format", format], Buffer.from(c.expect.hex), c.chunked);
          return { impl, viaJson, viaHex };
        }),
      );
      const ref = perImpl[0].viaJson;
      const agree = perImpl.every(
        (r) => r.viaJson.status === 0 && r.viaHex.status === 0 && r.viaJson.stdout === r.viaHex.stdout &&
          r.viaJson.stdout === ref.stdout,
      );
      if (!agree) {
        const short = (s) => shorten(s.replace(/\n$/, ""));
        divergences.push({
          mode: `reading (decode --format ${format})`,
          label: c.name,
          perImpl: perImpl.map((r) => ({
            name: r.impl.name,
            stdout: `the text: ${short(r.viaJson.stdout)} | its hex (exit ${r.viaHex.status}): ${short(r.viaHex.stdout)}`,
            status: r.viaJson.status,
          })),
        });
      }
    }
  }
  return { divergences, report };
}

async function runReadingMode(impls, cases, verbose) {
  const divergences = [];
  // A few cases at a time; results are reported in file order.
  const results = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next;
      next += 1;
      results[i] = await runReadingCase(impls, cases[i]);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  results.forEach((r, i) => {
    divergences.push(...r.divergences);
    if (verbose) {
      for (const { via, perImpl } of r.report) {
        const outcome = (x) => {
          try {
            const o = JSON.parse(x.stdout);
            return o.ok ? `hex ${o.hex.length > 12 ? `${o.hex.slice(0, 12)}…` : o.hex}` : o.error;
          } catch {
            return x.stdout === "" ? "(no output)" : "(not a JSON line)";
          }
        };
        process.stdout.write(
          `reading: ${cases[i].name} [${via}] — ` +
            perImpl.map((x) => `${x.impl.name}: exit ${x.status} ${outcome(x)}`).join(" | ") + "\n",
        );
      }
    }
  });
  const runs = cases.reduce((n, c) => n + c.sources.length, 0);
  const unrun = cases.filter((c) => c.sources.length === 0).map((c) => c.name);
  if (unrun.length > 0) {
    // Only an argv-only text that is not UTF-8, on Windows (argv is UTF-16 there).
    process.stdout.write(`reading: not run on this platform: ${unrun.join("; ")}\n`);
  }
  const summary =
    `reading: ${cases.length} texts, ${runs} runs through argv or stdin, x ${impls.length} impls (outcome oracle)`;
  return { divergences, summary };
}

// --- main --------------------------------------------------------------------
async function main() {
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

  const { impls, commands, decodeRoundtrip, fromJsonRoundtrip, humanRoundtrip, inputReading } = config;
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

  if (inputReading) {
    let r;
    try {
      r = await runReadingMode(impls, collectReadingCases(resolve(config.readingCases)), config.verbose);
    } catch (err) {
      abortOnUsage(err);
    }
    divergences.push(...r.divergences);
    summaries.push(r.summary);
  }

  // --- report ----------------------------------------------------------------
  for (const d of divergences) {
    process.stdout.write(`DIVERGENCE [${d.mode}: ${d.label}]\n`);
    if (d.kind === "outcome") {
      process.stdout.write(`  expected ${d.expected}\n`);
    } else if (d.kind === "pinned-hex") {
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
      (inputReading ? " and every input text read as the contract says" : "") +
      "\n",
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`ontos-conformance: ${err.stack ?? err}\n`);
  process.exit(2);
});
