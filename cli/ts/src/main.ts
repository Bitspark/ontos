#!/usr/bin/env node
/*
 * ontos CLI (ts) — the `ontos` byte-first inspector (docs/spec/ontos-cli.md).
 *
 *   ontos <command> [--format human|json] [--from-json <json|->]
 *                   [--json-profile total|readable] [<hex>]
 *
 * Bytes in, evidence out: input is canonical ontos-codec-v1 bytes given as a hex
 * string (positional, or `-`/omitted to read hex from stdin), OR JSON text via
 * `--from-json <json|->` — the one text→bytes path, mutually exclusive with a
 * positional `<hex>`. `--json-profile` selects the JSON profile of that input and of
 * the `--format json` value rendering: ontos-total-json/1 by default
 * (`{"atom":"<hex>"}` | `{"tuple":[…]}`), or ontos-readable-json/1, read from stdin
 * only. @bitspark/ontos-json reads and writes it; the value is built, not decoded,
 * so it is canonical by construction. All four commands (decode/inspect/read/canon)
 * accept either input source.
 *
 * This is one of three peer implementations (go/rs/ts), each built over its own
 * core. The contract — not any one binary — is the source of truth, and the
 * `--format json` output is BYTE-IDENTICAL across the three: compact (no insignificant
 * whitespace), fixed key order, lowercase hex, one object per line ending in "\n",
 * carrying only the stable fields. That is what the differential harness (ontos-internal#15) diffs.
 *
 * Node stdlib only (node:util parseArgs, node:process, node:fs), mirroring the
 * dependency-free cores. The model/codec/data and the JSON projections come from
 * @bitspark/ontos-{core,codec,data,json}; in the monorepo those names resolve to
 * core/ts, codec/ts, data/ts and projection/json/ts via npm workspaces, so source and
 * published build carry identical imports.
 */

import { parseArgs } from "node:util";
import process from "node:process";
import { readSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { decode, encode, DecodeError } from "@bitspark/ontos-codec";
import { type Value } from "@bitspark/ontos-core";
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
import * as total from "@bitspark/ontos-json/total";
import * as readable from "@bitspark/ontos-json/readable";

const CODEC_ID = "ontos-codec-v1";
const VERSION = "ontos 0.1.0";

const USAGE = `usage: ontos <command> [--format human|json] [--from-json <json|->]
                     [--json-profile total|readable] [<hex>]

commands:
  decode [<hex>]                       decode ontos-codec-v1 bytes -> the L0 value tree
  inspect [<hex>]                      decode + report codec, canonical?, value, recognized
  read [--all|--kind <k>] [<hex>]      recognize registered embeddings
  canon [--check|--emit] [<hex>]       check or emit the canonical bytes

options:
  -f, --format <human|json>   output format (default: human)
  --from-json <json|->        value as json text instead of <hex>; "-" reads JSON
                              from stdin
  --json-profile <total|readable>
                              the json profile of --from-json and of json value
                              output (default total: {"atom":"hex"}|{"tuple":[...]});
                              readable input only from stdin
  -h, --help                  print this help and exit
  -V, --version               print version and exit

input: hex string positional, or read from stdin when omitted or "-"; or json
text via --from-json (mutually exclusive with <hex>).`;

type Format = "human" | "json";
type Profile = "total" | "readable";

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

/*
 * JSON values through @bitspark/ontos-json. --json-profile selects the profile, the
 * same way in all four CLIs (ontos-cli.md "Value input" and "JSON profiles"):
 *   - total (the default) is ontos-total-json/1, through ./total. The --from-json
 *     text comes from an argument or from stdin. Bytes that are not UTF-8 are read as
 *     U+FFFD before the library sees them (totalText): that step is the CLI's total
 *     transport, because Node decodes argv that way before this code sees it. The
 *     library's reader is strict and never repairs text.
 *   - readable is ontos-readable-json/1, through ./readable. Its input is read from
 *     stdin only, as the exact bytes, with no lossy step: a replaced byte inside a
 *     string would read as a different value (ontos-readable-json.md §10.1).
 * A library refusal maps onto the CLI's codes: a limit is limit_exceeded (exit 1), and
 * any other refusal is invalid_json (exit 2). The same profile renders the value of
 * --format json output.
 */

/**
 * The total transport: a string (argv, or stdin decoded with U+FFFD) as UTF-8 bytes.
 * Buffer.from writes a lone surrogate as U+FFFD too, so the bytes are well-formed.
 * U+FFFD is never hex and never part of "atom" or "tuple", so such a text is always
 * refused, and the outcome never depends on how many U+FFFD replace a bad sequence.
 */
function totalText(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

/**
 * Read the `--from-json` text under the profile; `-` reads it from stdin. Nothing is
 * trimmed: the reader allows only RFC 8259 whitespace. A refusal throws
 * ProjectionError. (Readable text from an argument is refused before this.)
 */
function valueFromJsonSource(source: string, profile: Profile): Value {
  if (profile === "readable") {
    return readable.parseUtf8(readStdinBytes());
  }
  return total.parseUtf8(totalText(source === "-" ? readStdinText() : source));
}

/**
 * Map a library refusal onto the CLI's codes: a limit is limit_exceeded, exit 1, as a
 * decode limit; anything else is invalid_json, exit 2.
 */
function jsonFailure(err: total.ProjectionError): { error: string; exit: number } {
  return err.code === "limit_exceeded"
    ? { error: "limit_exceeded", exit: EXIT_NEGATIVE }
    : { error: "invalid_json", exit: EXIT_USAGE };
}

/**
 * The value of a `--format json` result, in the profile's preferred spelling. Under
 * the defaults the total writer accepts every value the CLI can hold (none is deeper
 * than 1024), and the readable writer refuses only an integer of more than 4300
 * digits: that refusal is emitted as the command's error line (limit_exceeded, exit 1).
 */
function renderValue(command: string, value: Value, profile: Profile): string {
  try {
    return profile === "readable" ? readable.renderString(value) : total.renderString(value);
  } catch (err) {
    if (err instanceof total.ProjectionError) {
      const { error, exit } = jsonFailure(err);
      emitLine({ ok: false, command, error });
      writeErr(`ontos: cannot render the value: ${err.message}\n`);
      process.exit(exit);
    }
    throw err;
  }
}

/** Sleeps the thread while a pipe is not ready (Atomics.wait does not spin). */
const NAP = new Int32Array(new SharedArrayBuffer(4));

/**
 * A wait for a pipe that is not ready: 1 ms, doubling to 32 ms while it stays not
 * ready, back to 1 ms once data moves (`reset`).
 */
function backoff(): { wait: () => void; reset: () => void } {
  let ms = 1;
  return {
    wait: () => {
      Atomics.wait(NAP, 0, 0, ms);
      ms = Math.min(ms * 2, 32);
    },
    reset: () => {
      ms = 1;
    },
  };
}

/**
 * Write `text` to fd 1 or 2 completely before returning. process.stdout.write is not
 * used: on a pipe it may leave part of a large write pending, and the process.exit
 * that ends every command then drops it (a 2 MB line arrived cut at 146176 bytes,
 * with exit 0). A reader that has gone away (EPIPE) ends the writing quietly.
 */
function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  const pause = backoff();
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
      pause.reset();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        pause.wait();
        continue;
      }
      if (code === "EPIPE") return;
      throw err;
    }
  }
}

const writeOut = (text: string): void => writeAll(1, text);
const writeErr = (text: string): void => writeAll(2, text);

/**
 * Read all of stdin as bytes (every input path reads stdin through here).
 * readFileSync(0) is not used: it throws EAGAIN when stdin is a non-blocking pipe
 * whose writer is slower than this reader and the input is larger than the pipe's
 * buffer. This loop waits for the data instead, with backoff; Atomics.wait sleeps the
 * thread, so the wait does not spin.
 */
function readStdinBytes(): Buffer {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(1 << 16);
  const pause = backoff();
  for (;;) {
    let n: number;
    try {
      n = readSync(0, chunk, 0, chunk.length, null);
      pause.reset();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        pause.wait();
        continue;
      }
      if (code === "EOF") break; // how Windows reports the end of a pipe
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/** All of stdin as UTF-8 text, with U+FFFD for each sequence that is not UTF-8. */
function readStdinText(): string {
  return readStdinBytes().toString("utf8");
}

/** Emit a compact JSON line (single line, "\n"-terminated) to stdout. */
function emitLine(obj: unknown): void {
  writeOut(`${JSON.stringify(obj)}\n`);
}

function dieUsage(message: string): never {
  writeErr(`ontos: ${message}\n`);
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
    return trimHexInput(positional);
  }
  return trimHexInput(readStdinText());
}

/**
 * Strip the whitespace allowed around hex input: space, tab, LF and CR (RFC 8259's
 * set, as `--from-json` allows), and nothing else (ontos-cli.md "Synopsis"). String
 * trim() is not used: it also strips a BOM, NBSP and every other Unicode space.
 */
function trimHexInput(text: string): string {
  return text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

/**
 * Resolve the command's one Value from exactly one input source, emitting the
 * command's error object and exiting on failure (so the return is the success path).
 *
 * - `--from-json` (fromJson !== undefined): read the text in the selected profile
 *   with @bitspark/ontos-json, building the Value directly. It is canonical by
 *   construction, so its bytes are simply `encode(value)`. A limit refusal is
 *   `limit_exceeded` (exit 1); any other refusal is `invalid_json` (exit 2). Readable
 *   text from an argument is `usage_error` (exit 2). Mutual exclusion with `<hex>` is
 *   enforced earlier (usage_error).
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
  profile: Profile,
): { value: Value; bytes: Uint8Array } {
  if (fromJson !== undefined) {
    // Readable input is read from stdin only: Node has already decoded an argument
    // lossily, and a replaced byte inside a string would read as another value
    // (ontos-readable-json.md §10.1).
    if (profile === "readable" && fromJson !== "-") {
      if (format === "json") {
        emitLine({ ok: false, command, error: "usage_error" });
      } else {
        writeErr("ontos: --json-profile readable reads --from-json from stdin only (--from-json -)\n");
      }
      process.exit(EXIT_USAGE);
    }
    let value: Value;
    try {
      value = valueFromJsonSource(fromJson, profile);
    } catch (err) {
      if (err instanceof total.ProjectionError) {
        // A limit is limit_exceeded (exit 1), exactly as a decode limit; any other
        // refusal is the stable invalid_json usage error (exit 2).
        const { error, exit } = jsonFailure(err);
        if (format === "json") {
          emitLine({ ok: false, command, error });
        } else {
          writeErr(`ontos: json input: ${err.message}\n`);
        }
        process.exit(exit);
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
      writeErr("ontos: invalid hex input\n");
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
        writeErr(`ontos: ${err.message}\n`);
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
  profile: Profile,
): never {
  const { value } = resolveValue("decode", format, fromJson, positional, profile);

  if (format === "json") {
    // The contract order: ok, command, codec, value. The value is spliced in as the
    // library wrote it (JSON.stringify of a parsed copy would not keep it byte for byte).
    const rendered = renderValue("decode", value, profile);
    writeOut(`{"ok":true,"command":"decode","codec":"${CODEC_ID}","value":${rendered}}\n`);
  } else {
    writeOut(`${value.toString()}\n`);
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
  profile: Profile,
): never {
  const { value, bytes } = resolveValue("inspect", format, fromJson, positional, profile);
  const canonical = isCanonical(value, bytes);
  const recognized = recognizedKinds(value);

  if (format === "json") {
    // Contract key order: ok, command, codec, canonical, value, recognized. The value
    // is spliced in as the library wrote it.
    const rendered = renderValue("inspect", value, profile);
    writeOut(
      `{"ok":true,"command":"inspect","codec":"${CODEC_ID}","canonical":${canonical},` +
        `"value":${rendered},"recognized":${JSON.stringify(recognized)}}\n`,
    );
  } else {
    writeOut(`${value.toString()}\n`);
    writeOut(`canonical: ${canonical ? "yes" : "no"}\n`);
    writeOut(`recognized: ${humanLabels(recognized)}\n`);
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
  profile: Profile,
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

  const { value } = resolveValue("read", format, fromJson, positional, profile);

  if (all) {
    const recognized = recognizedKinds(value);
    if (format === "json") {
      emitLine({ ok: true, command: "read", recognized });
    } else {
      // The "recognized: " prefix is present on BOTH inspect and read --all (the
      // tri-core human contract, ontos-internal#46) — TS previously omitted it here.
      writeOut(`recognized: ${humanLabels(recognized)}\n`);
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
    writeOut(`${k}: ${recognized ? "yes" : "no"}\n`);
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
  profile: Profile,
): never {
  if (check && emit) {
    dieUsage("canon takes at most one of --check or --emit");
  }

  const { value, bytes } = resolveValue("canon", format, fromJson, positional, profile);

  if (emit) {
    const hex = lowerHex(encode(value));
    if (format === "json") {
      emitLine({ ok: true, command: "canon", hex });
    } else {
      writeOut(`${hex}\n`);
    }
    process.exit(EXIT_OK);
  }

  // --check (or default): decode succeeded, so canonical is always true.
  const canonical = isCanonical(value, bytes);
  if (format === "json") {
    emitLine({ ok: true, command: "canon", canonical });
  } else {
    writeOut(`canonical: ${canonical ? "yes" : "no"}\n`);
  }
  process.exit(EXIT_OK);
}

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * `--from-json <text>` takes the next token whatever it is, as the other CLIs do: a
 * JSON text may begin with "-" (`-1`), which parseArgs would refuse as an ambiguous
 * option value. The pair becomes the equivalent `--from-json=<text>`.
 */
function joinFromJson(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--from-json" && i + 1 < argv.length) {
      out.push(`--from-json=${argv[i + 1]!}`);
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function main(argv: readonly string[]): never {
  let parsed;
  try {
    parsed = parseArgs({
      args: joinFromJson(argv),
      allowPositionals: true,
      strict: true,
      options: {
        format: { type: "string", short: "f" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        // The alternative text→bytes input source (mutually exclusive with <hex>).
        "from-json": { type: "string" },
        // The JSON profile of --from-json and of the --format json value.
        "json-profile": { type: "string" },
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
    writeOut(`${USAGE}\n`);
    process.exit(EXIT_OK);
  }
  if (values.version) {
    writeOut(`${VERSION}\n`);
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

  let profile: Profile = "total";
  const jsonProfile = values["json-profile"];
  if (jsonProfile !== undefined) {
    if (jsonProfile !== "total" && jsonProfile !== "readable") {
      dieUsage(`invalid --json-profile ${jsonProfile} (expected total|readable)`);
    }
    profile = jsonProfile;
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
        writeErr("ontos: --from-json and a positional <hex> are mutually exclusive\n");
      }
      process.exit(EXIT_USAGE);
    }
    dieUsage("--from-json and a positional <hex> are mutually exclusive");
  }

  if (command === "decode") {
    runDecode(format, fromJson, positionalHex, profile);
  }
  if (command === "inspect") {
    runInspect(format, fromJson, positionalHex, profile);
  }
  if (command === "read") {
    runRead(format, fromJson, positionalHex, values.all === true, values.kind, profile);
  }
  if (command === "canon") {
    runCanon(format, fromJson, positionalHex, values.check === true, values.emit === true, profile);
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
