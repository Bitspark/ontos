#!/usr/bin/env node
/*
 * ontos CLI (ts) — the `ontos` byte-first inspector (docs/spec/ontos-cli.md).
 *
 *   ontos <command> [--format human|json] [<hex>]
 *
 * Bytes in, evidence out: input is canonical ontos-codec-v1 bytes given as a hex
 * string (positional, or `-`/omitted to read hex from stdin), OR the authoring
 * notation via `--from-json <json|->` (the inverse of `--format json` value
 * rendering) — the one text→bytes path, mutually exclusive with a positional
 * `<hex>`. The from-json value is built directly with the core constructors, so it
 * is canonical by construction (no bytes are decoded). All four commands
 * (decode/inspect/read/canon) accept either input source.
 *
 * This is one of three peer implementations (go/rs/ts), each built over its own
 * core. The contract — not any one binary — is the source of truth, and the
 * `--format json` output is BYTE-IDENTICAL across the three: compact (no insignificant
 * whitespace), fixed key order, lowercase hex, one object per line ending in "\n",
 * carrying only the stable fields. That is what the differential harness (ontos-internal#15) diffs.
 *
 * Node stdlib only (node:util parseArgs, node:process, node:fs), mirroring the
 * dependency-free cores. The model/codec come from @bitspark/ontos-core and
 * @bitspark/ontos-codec; in the monorepo those names resolve to core/ts and codec/ts
 * via npm workspaces, so source and published build carry identical imports.
 */

import { parseArgs } from "node:util";
import process from "node:process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { decode, encode, DecodeError } from "@bitspark/ontos-codec";
import { Atom, Tuple, type Value } from "@bitspark/ontos-core";
import {
  recognizeInt,
  readText,
  readBool,
  readList,
  readMap,
  readSet,
  recognizeDecimal,
  readNull,
  DataError,
} from "@bitspark/ontos-data";

const CODEC_ID = "ontos-codec-v1";
const VERSION = "ontos 0.1.0";

const USAGE = `usage: ontos <command> [--format human|json] [--from-json <json|->] [<hex>]

commands:
  decode [<hex>]                       decode ontos-codec-v1 bytes -> the L0 value tree
  inspect [<hex>]                      decode + report codec, canonical?, value, recognized
  read [--all|--kind <k>] [<hex>]      recognize registered embeddings
  canon [--check|--emit] [<hex>]       check or emit the canonical bytes

options:
  -f, --format <human|json>   output format (default: human)
  --from-json <json|->        value as authoring notation ({"atom":"hex"}|{"tuple":[...]})
                              instead of <hex>; "-" reads JSON from stdin
  -h, --help                  print this help and exit
  -V, --version               print version and exit

input: hex string positional, or read from stdin when omitted or "-"; or the
authoring notation via --from-json (mutually exclusive with <hex>).`;

type Format = "human" | "json";

/**
 * The registered embedding labels, in the fixed order the contract pins for the
 * `recognized` array (inspect / read --all). A value matches AT MOST one label,
 * by its kind; the array is this order filtered to the kinds that recognize it.
 *
 * Exported so a test can pin it against the data module's exported `LABELS` (the CLI
 * keeps its own copy by deliberate design — see ontos-internal#49). The list otherwise has no
 * out-of-process surface, so exporting it is test-only plumbing, not a CLI API.
 */
export const KINDS = ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"] as const;
type Kind = (typeof KINDS)[number];

/**
 * Each kind's recognizer; matched iff it does NOT throw DataError. `int`/`decimal` use
 * the structural `recognizeInt`/`recognizeDecimal` (NOT `read*`): a canonical value
 * beyond a binding's host integer width is still recognized — the materialization limit
 * is not a recognition miss (ontos-data.md §5.1/§5.9), so all cores agree here.
 */
const RECOGNIZERS: Record<Kind, (v: Value) => unknown> = {
  int: recognizeInt,
  "utf8-text": readText,
  bool: readBool,
  list: readList,
  map: readMap,
  set: readSet,
  decimal: recognizeDecimal,
  null: readNull,
};

/** Exit codes per the contract: 0 success, 1 negative result, 2 usage error. */
const EXIT_OK = 0;
const EXIT_NEGATIVE = 1;
const EXIT_USAGE = 2;

function lowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The authoring notation already used by vectors/: {atom:hex} | {tuple:[...]}. */
type Authoring = { atom: string } | { tuple: Authoring[] };

function toAuthoring(value: Value): Authoring {
  if (value instanceof Atom) {
    return { atom: lowerHex(value.bytes()) };
  }
  if (value instanceof Tuple) {
    return { tuple: value.items().map(toAuthoring) };
  }
  // Unreachable: Value is Atom | Tuple. Present so the function is total.
  throw new TypeError("expected an ontos Value");
}

/**
 * A malformed `--from-json` input: either not parseable JSON, or parseable but not
 * the {atom:hex}|{tuple:[…]} authoring shape. Both collapse to the single stable
 * `invalid_json` error code, so the three CLIs agree on output even if their raw-JSON
 * tokenizers differ on exotic syntax (ontos-cli.md "Value input").
 */
class AuthoringError extends Error {}

/**
 * Parse the authoring notation into a core Value — the exact inverse of toAuthoring
 * (and of the `--format json` value rendering). A value is a JSON object with EXACTLY
 * ONE of "atom" (even-length lowercase hex, "" = empty atom) or "tuple" (a JSON array
 * of values). Anything else throws AuthoringError → the stable `invalid_json` code.
 *
 * Validation mirrors tools/vector/gen.mjs parseAuthoring and the cores' toJSON: the
 * post-parse structural check is identical across go/rs/ts, so any malformed input
 * yields the same result regardless of each language's JSON tokenizer.
 */
function fromAuthoring(node: unknown): Value {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new AuthoringError("value must be an object");
  }
  const obj = node as Record<string, unknown>;
  const hasAtom = Object.prototype.hasOwnProperty.call(obj, "atom");
  const hasTuple = Object.prototype.hasOwnProperty.call(obj, "tuple");
  // Exactly one of atom|tuple, and NO extra keys.
  if (hasAtom === hasTuple) {
    throw new AuthoringError('value must have exactly one of "atom" or "tuple"');
  }
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new AuthoringError("value object has extra keys");
  }
  if (hasAtom) {
    return new Atom(atomBytes(obj.atom));
  }
  if (!Array.isArray(obj.tuple)) {
    throw new AuthoringError('"tuple" must be an array');
  }
  return new Tuple(obj.tuple.map(fromAuthoring));
}

/** Decode an authoring atom string: must be even-length LOWERCASE hex ("" allowed). */
function atomBytes(hex: unknown): Uint8Array {
  if (typeof hex !== "string") {
    throw new AuthoringError('"atom" must be a string');
  }
  if (hex.length % 2 !== 0) {
    throw new AuthoringError('"atom" must be even-length hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = lowerHexNibble(hex.charCodeAt(i * 2));
    const lo = lowerHexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new AuthoringError('"atom" must be lowercase hex');
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Hex nibble for an authoring atom: 0-9 and LOWERCASE a-f only (uppercase rejected). */
function lowerHexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  return -1;
}

/**
 * Build a Value from the `--from-json` source: JSON.parse, then the SAME structural
 * validation as every core. `-` reads the JSON from stdin (mirroring how hex does).
 * Any malformed input throws AuthoringError → `invalid_json`.
 */
function valueFromJsonSource(source: string): Value {
  const text = source === "-" ? readFileSync(0, "utf8") : source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuthoringError("malformed JSON");
  }
  return fromAuthoring(parsed);
}

/** Emit a compact JSON line (single line, "\n"-terminated) to stdout. */
function emitLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function dieUsage(message: string): never {
  process.stderr.write(`ontos: ${message}\n`);
  process.exit(EXIT_USAGE);
}

/** Parse a hex string to bytes. Returns null on odd length or any non-hex char. */
function parseHex(input: string): Uint8Array | null {
  if (input.length % 2 !== 0) return null;
  const out = new Uint8Array(input.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = hexNibble(input.charCodeAt(i * 2));
    const lo = hexNibble(input.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F
  return -1;
}

/** Resolve the hex input: positional arg, or stdin when absent or "-". */
function resolveInput(positional: string | undefined): string {
  if (positional !== undefined && positional !== "-") {
    return positional.trim();
  }
  // fd 0 = stdin. Read synchronously and strip surrounding whitespace.
  return readFileSync(0, "utf8").trim();
}

/**
 * Resolve the command's one Value from exactly one input source, emitting the
 * command's error object and exiting on failure (so the return is the success path).
 *
 * - `--from-json` (fromJson !== undefined): parse + validate the authoring notation,
 *   build the Value directly. It is canonical by construction, so its bytes are
 *   simply `encode(value)`. A malformed/non-authoring input is `invalid_json`
 *   (exit 2). Mutual exclusion with `<hex>` is enforced earlier (usage_error).
 * - otherwise: the positional `<hex>` or stdin, hex-decoded then codec-decoded.
 *   Invalid hex => `invalid_hex` (usage error, exit 2); a DecodeError => the codec's
 *   stable code (negative result, exit 1).
 *
 * Returns the Value and the input bytes (what `canonical`/`canon` re-encode against).
 */
function resolveValue(
  command: string,
  format: Format,
  fromJson: string | undefined,
  positional: string | undefined,
): { value: Value; bytes: Uint8Array } {
  if (fromJson !== undefined) {
    let value: Value;
    try {
      value = valueFromJsonSource(fromJson);
    } catch (err) {
      if (err instanceof AuthoringError) {
        if (format === "json") {
          emitLine({ ok: false, command, error: "invalid_json" });
        } else {
          process.stderr.write(`ontos: ${err.message}\n`);
        }
        process.exit(EXIT_USAGE);
      }
      throw err;
    }
    // Built, not decoded: canonical by construction. bytes = its sole encoding.
    return { value, bytes: encode(value) };
  }

  const hex = resolveInput(positional);
  const bytes = parseHex(hex);
  if (bytes === null) {
    if (format === "json") {
      emitLine({ ok: false, command, error: "invalid_hex" });
    } else {
      process.stderr.write("ontos: invalid hex input\n");
    }
    process.exit(EXIT_USAGE);
  }

  try {
    return { value: decode(bytes), bytes };
  } catch (err) {
    if (err instanceof DecodeError) {
      if (format === "json") {
        emitLine({ ok: false, command, error: err.code });
      } else {
        process.stderr.write(`ontos: ${err.message}\n`);
      }
      process.exit(EXIT_NEGATIVE);
    }
    throw err;
  }
}

function runDecode(
  format: Format,
  fromJson: string | undefined,
  positional: string | undefined,
): never {
  const { value } = resolveValue("decode", format, fromJson, positional);

  if (format === "json") {
    // Construct the object key-by-key in the contract order: ok, command, codec, value.
    emitLine({ ok: true, command: "decode", codec: CODEC_ID, value: toAuthoring(value) });
  } else {
    process.stdout.write(`${value.toString()}\n`);
  }
  process.exit(EXIT_OK);
}

/** Whether the top-level value is a well-formed instance of `kind`. */
function recognizes(value: Value, kind: Kind): boolean {
  try {
    RECOGNIZERS[kind](value);
    return true;
  } catch (err) {
    if (err instanceof DataError) return false;
    throw err;
  }
}

/** The recognized labels in the fixed contract order, filtered to matches. */
function recognizedKinds(value: Value): Kind[] {
  return KINDS.filter((kind) => recognizes(value, kind));
}

/**
 * The canonical `human`-format rendering of the recognized labels, shared by
 * `inspect` and `read --all`: the labels joined by ", " (comma-space), or "none"
 * when empty. This is the tri-core human-output contract (docs/spec/ontos-cli.md
 * "Human format", ontos-internal#46), enforced byte-for-byte across go/rs/ts by the
 * conformance harness --human-roundtrip mode, so it must match the go/rs cores
 * exactly (including the "recognized: " prefix on BOTH commands).
 */
function humanLabels(labels: readonly Kind[]): string {
  return labels.length > 0 ? labels.join(", ") : "none";
}

/** Canonical iff re-encoding the decoded value reproduces the input bytes. */
function isCanonical(value: Value, input: Uint8Array): boolean {
  const reencoded = encode(value);
  if (reencoded.length !== input.length) return false;
  for (let i = 0; i < reencoded.length; i += 1) {
    if (reencoded[i] !== input[i]) return false;
  }
  return true;
}

/** `ontos inspect [<hex>]` — decode + codec id, canonical?, value, recognized. */
function runInspect(
  format: Format,
  fromJson: string | undefined,
  positional: string | undefined,
): never {
  const { value, bytes } = resolveValue("inspect", format, fromJson, positional);
  const canonical = isCanonical(value, bytes);
  const recognized = recognizedKinds(value);

  if (format === "json") {
    // Contract key order: ok, command, codec, canonical, value, recognized.
    emitLine({
      ok: true,
      command: "inspect",
      codec: CODEC_ID,
      canonical,
      value: toAuthoring(value),
      recognized,
    });
  } else {
    process.stdout.write(`${value.toString()}\n`);
    process.stdout.write(`canonical: ${canonical ? "yes" : "no"}\n`);
    process.stdout.write(`recognized: ${humanLabels(recognized)}\n`);
  }
  process.exit(EXIT_OK);
}

/** `ontos read [--all|--kind <kind>] [<hex>]` — recognize registered embeddings. */
function runRead(
  format: Format,
  fromJson: string | undefined,
  positional: string | undefined,
  all: boolean,
  kind: string | undefined,
): never {
  if (all && kind !== undefined) {
    dieUsage("read takes at most one of --all or --kind");
  }
  if (!all && kind === undefined) {
    dieUsage("read requires --all or --kind <int|utf8-text|bool|list|map|set|decimal|null>");
  }
  if (kind !== undefined && !isKind(kind)) {
    dieUsage(`unknown --kind ${kind} (expected int|utf8-text|bool|list|map|set|decimal|null)`);
  }

  const { value } = resolveValue("read", format, fromJson, positional);

  if (all) {
    const recognized = recognizedKinds(value);
    if (format === "json") {
      emitLine({ ok: true, command: "read", recognized });
    } else {
      // The "recognized: " prefix is present on BOTH inspect and read --all (the
      // tri-core human contract, ontos-internal#46) — TS previously omitted it here.
      process.stdout.write(`recognized: ${humanLabels(recognized)}\n`);
    }
    process.exit(EXIT_OK);
  }

  // Single --kind probe: exit 0 if recognized, else 1.
  const k = kind as Kind;
  const recognized = recognizes(value, k);
  if (format === "json") {
    emitLine({ ok: true, command: "read", kind: k, recognized });
  } else {
    // Canonical human form: `<kind>: yes|no` (docs/spec/ontos-cli.md "Human format")
    // — names the probed kind, matching go/rs byte-for-byte (TS previously printed a
    // bare yes|no).
    process.stdout.write(`${k}: ${recognized ? "yes" : "no"}\n`);
  }
  process.exit(recognized ? EXIT_OK : EXIT_NEGATIVE);
}

/** `ontos canon [--check|--emit] [<hex>]` — check or emit the canonical bytes. */
function runCanon(
  format: Format,
  fromJson: string | undefined,
  positional: string | undefined,
  check: boolean,
  emit: boolean,
): never {
  if (check && emit) {
    dieUsage("canon takes at most one of --check or --emit");
  }

  const { value, bytes } = resolveValue("canon", format, fromJson, positional);

  if (emit) {
    const hex = lowerHex(encode(value));
    if (format === "json") {
      emitLine({ ok: true, command: "canon", hex });
    } else {
      process.stdout.write(`${hex}\n`);
    }
    process.exit(EXIT_OK);
  }

  // --check (or default): decode succeeded, so canonical is always true.
  const canonical = isCanonical(value, bytes);
  if (format === "json") {
    emitLine({ ok: true, command: "canon", canonical });
  } else {
    process.stdout.write(`canonical: ${canonical ? "yes" : "no"}\n`);
  }
  process.exit(EXIT_OK);
}

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

function main(argv: readonly string[]): never {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        format: { type: "string", short: "f" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        // The alternative text→bytes input source (mutually exclusive with <hex>).
        "from-json": { type: "string" },
        // Command-specific flags (validated per command in the runners).
        all: { type: "boolean" },
        kind: { type: "string" },
        check: { type: "boolean" },
        emit: { type: "boolean" },
      },
    });
  } catch (err) {
    dieUsage(err instanceof Error ? err.message : "bad arguments");
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT_OK);
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT_OK);
  }

  const command = positionals[0];
  if (command === undefined) {
    dieUsage(`missing command\n${USAGE}`);
  }

  let format: Format = "human";
  if (values.format !== undefined) {
    if (values.format !== "human" && values.format !== "json") {
      dieUsage(`invalid --format ${values.format} (expected human|json)`);
    }
    format = values.format;
  }

  const rest = positionals.slice(1);
  if (rest.length > 1) {
    dieUsage(`unexpected extra arguments after <hex>`);
  }
  const positionalHex = rest[0];

  // The input source is exactly one of <hex> or --from-json. Supplying both is a
  // usage_error (exit 2), emitted in the per-command shape so the harness sees it on
  // stdout (mirroring how invalid_hex — also a usage-class error — is emitted).
  const fromJson = values["from-json"];
  if (fromJson !== undefined && positionalHex !== undefined) {
    if (
      command === "decode" ||
      command === "inspect" ||
      command === "read" ||
      command === "canon"
    ) {
      if (format === "json") {
        emitLine({ ok: false, command, error: "usage_error" });
      } else {
        process.stderr.write("ontos: --from-json and a positional <hex> are mutually exclusive\n");
      }
      process.exit(EXIT_USAGE);
    }
    dieUsage("--from-json and a positional <hex> are mutually exclusive");
  }

  if (command === "decode") {
    runDecode(format, fromJson, positionalHex);
  }
  if (command === "inspect") {
    runInspect(format, fromJson, positionalHex);
  }
  if (command === "read") {
    runRead(format, fromJson, positionalHex, values.all === true, values.kind);
  }
  if (command === "canon") {
    runCanon(format, fromJson, positionalHex, values.check === true, values.emit === true);
  }

  dieUsage(`unknown command: ${command}\n${USAGE}`);
}

// Run the CLI only when this module is the program entry point (`node .../main.js …`),
// not when it is imported (e.g. a test importing `KINDS`). argv[1] is the executed
// script's path; pathToFileURL normalizes it to the same file:// form as import.meta.url
// so the comparison is correct on every platform (Windows paths included).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
