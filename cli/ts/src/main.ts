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
 * A malformed `--from-json` input: a fault in the JSON text, or JSON that is not
 * the {atom:hex}|{tuple:[…]} authoring shape. Both are the single stable
 * `invalid_json` error code (ontos-cli.md "Value input").
 */
class AuthoringError extends Error {}

/**
 * A `--from-json` text with more than JSON_NESTING_CAP nested arrays and objects:
 * the stable `limit_exceeded` code, exit 1, as a decode limit.
 */
class JsonTooDeep extends Error {}

/*
 * Reading --from-json, in two stages, the same way in all four CLIs
 * (ontos-cli.md "Value input"):
 *   1. readJson reads the text as RFC 8259 JSON, left to right and without
 *      recursion: only space/tab/LF/CR as whitespace, nothing after the value,
 *      escapes decoded, lone-surrogate escapes refused, and at most
 *      JSON_NESTING_CAP open arrays and objects. The first fault ends the reading:
 *      a 2051st level is JsonTooDeep, anything else AuthoringError.
 *   2. authoringValue checks the JSON value against the authoring shape and builds
 *      the core Value, again without recursion. Repeated member names keep their
 *      last value.
 * Node decodes argv and the utf8 stdin read with U+FFFD for each sequence that is
 * not UTF-8, which is the contract's rule; U+FFFD is never hex and never part of a
 * member name.
 */

/**
 * The most arrays and objects the text may have open at once: 2·1024 + 2. The
 * deepest value the codec's default decoder accepts is nested 1024 deep (root at
 * depth 0, ontos-codec.md §4.1); when that deepest value is an empty tuple, its 1025
 * tuples take two levels each (`{"tuple":[`). Anything deeper in an authoring text
 * is a value the decoder would refuse.
 */
const JSON_NESTING_CAP = 2 * 1024 + 2;

/**
 * A value of the generic JSON tree stage 1 builds. Numbers, true, false and null
 * are only ever refused by the shape check, so they share one kind. An object keeps
 * one value per distinct name: a repeated name keeps its last value.
 */
type JsonNode =
  | { kind: "scalar" }
  | { kind: "string"; text: string }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "object"; members: Map<string, JsonNode> };

/** An open array or object; `key` is the member name the next value belongs to. */
type OpenContainer =
  | { kind: "array"; node: { kind: "array"; items: JsonNode[] } }
  | { kind: "object"; node: { kind: "object"; members: Map<string, JsonNode> }; key: string };

/** Stage 1: read the whole text as one JSON value. */
function readJson(text: string): JsonNode {
  let pos = 0;
  const fault = (what: string): never => {
    throw new AuthoringError(`malformed JSON at offset ${pos}: ${what}`);
  };
  const peek = (): number => (pos < text.length ? text.charCodeAt(pos) : -1);
  // RFC 8259 whitespace: space, tab, LF and CR, nothing else.
  const ws = (): void => {
    for (;;) {
      const c = peek();
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      pos += 1;
    }
  };
  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
  const digits = (): void => {
    while (isDigit(peek())) pos += 1;
  };
  const literal = (word: string): JsonNode => {
    if (!text.startsWith(word, pos)) fault(`expected ${word}`);
    pos += word.length;
    return { kind: "scalar" };
  };
  // The RFC 8259 number grammar; the value is never used, so any length is fine.
  const number = (): JsonNode => {
    if (peek() === 0x2d) pos += 1; // -
    if (peek() === 0x30) {
      pos += 1;
    } else if (peek() >= 0x31 && peek() <= 0x39) {
      digits();
    } else {
      fault("expected a digit");
    }
    if (peek() === 0x2e) {
      pos += 1; // .
      if (!isDigit(peek())) fault("expected a digit after '.'");
      digits();
    }
    if (peek() === 0x65 || peek() === 0x45) {
      pos += 1; // e E
      if (peek() === 0x2b || peek() === 0x2d) pos += 1; // + -
      if (!isDigit(peek())) fault("expected a digit in the exponent");
      digits();
    }
    return { kind: "scalar" };
  };
  const hex4 = (): number => {
    let v = 0;
    for (let i = 0; i < 4; i += 1) {
      const c = peek();
      let d: number;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      else return fault("expected four hex digits");
      v = v * 16 + d;
      pos += 1;
    }
    return v;
  };
  // A string (the cursor is on its opening quote), decoded. A control character
  // must be escaped; a \u escape of a surrogate must be a high one followed at once
  // by an escaped low one.
  const string = (): string => {
    pos += 1;
    let out = "";
    for (;;) {
      const start = pos;
      for (;;) {
        const c = peek();
        if (c < 0x20 || c === 0x22 || c === 0x5c) break; // also the end (-1)
        pos += 1;
      }
      out += text.slice(start, pos);
      const c = peek();
      if (c === 0x22) {
        pos += 1;
        return out;
      }
      if (c !== 0x5c) return fault(c < 0 ? "unterminated string" : "unescaped control character");
      pos += 1;
      const e = peek();
      pos += 1;
      switch (e) {
        case 0x22: out += '"'; break;
        case 0x5c: out += "\\"; break;
        case 0x2f: out += "/"; break;
        case 0x62: out += "\b"; break;
        case 0x66: out += "\f"; break;
        case 0x6e: out += "\n"; break;
        case 0x72: out += "\r"; break;
        case 0x74: out += "\t"; break;
        case 0x75: {
          const first = hex4();
          if (first >= 0xd800 && first <= 0xdbff) {
            if (!text.startsWith("\\u", pos)) fault("lone high surrogate");
            pos += 2;
            const second = hex4();
            if (second < 0xdc00 || second > 0xdfff) fault("lone high surrogate");
            out += String.fromCharCode(first, second);
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            fault("lone low surrogate");
          } else {
            out += String.fromCharCode(first);
          }
          break;
        }
        default:
          pos -= 1;
          fault("unknown escape");
      }
    }
  };
  const memberName = (): string => {
    ws();
    if (peek() !== 0x22) fault("expected a member name");
    const name = string();
    ws();
    if (peek() !== 0x3a) fault("expected ':'");
    pos += 1;
    return name;
  };

  const stack: OpenContainer[] = [];
  ws();
  for (;;) {
    // A value starts at the cursor.
    let value: JsonNode;
    const c = peek();
    if (c === 0x7b || c === 0x5b) {
      if (stack.length === JSON_NESTING_CAP) throw new JsonTooDeep("more than 2050 nested arrays and objects");
      pos += 1;
      ws();
      if (c === 0x5b) {
        const node = { kind: "array" as const, items: [] as JsonNode[] };
        if (peek() === 0x5d) {
          pos += 1;
          value = node;
        } else {
          stack.push({ kind: "array", node });
          ws();
          continue;
        }
      } else {
        const node = { kind: "object" as const, members: new Map<string, JsonNode>() };
        if (peek() === 0x7d) {
          pos += 1;
          value = node;
        } else {
          stack.push({ kind: "object", node, key: memberName() });
          ws();
          continue;
        }
      }
    } else if (c === 0x22) {
      value = { kind: "string", text: string() };
    } else if (c === 0x74) {
      value = literal("true");
    } else if (c === 0x66) {
      value = literal("false");
    } else if (c === 0x6e) {
      value = literal("null");
    } else if (c === 0x2d || isDigit(c)) {
      value = number();
    } else {
      return fault("expected a value");
    }

    // `value` is complete: hand it to the innermost open container, closing each
    // container whose end follows.
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        ws();
        if (pos !== text.length) fault("data after the value");
        return value;
      }
      if (top.kind === "array") top.node.items.push(value);
      else top.node.members.set(top.key, value);
      ws();
      const d = peek();
      if (d === 0x2c) {
        pos += 1;
        if (top.kind === "object") top.key = memberName();
        ws();
        break;
      }
      if ((top.kind === "array" && d === 0x5d) || (top.kind === "object" && d === 0x7d)) {
        pos += 1;
        value = top.node;
        stack.pop();
        continue;
      }
      return fault("expected ',' or the container's end");
    }
  }
}

/**
 * Stage 2: check a JSON value against the authoring notation — the exact inverse of
 * toAuthoring (and of the `--format json` value rendering) — and build the core
 * Value, walking the tree with an explicit stack. A value is a JSON object with
 * EXACTLY ONE member (after repeated names keep their last value): "atom" (even-length
 * lowercase hex, "" = empty atom) or "tuple" (a JSON array of values). Anything else
 * throws AuthoringError → `invalid_json`.
 */
function authoringValue(root: JsonNode): Value {
  const first = authoringNode(root);
  if (!Array.isArray(first)) return first;
  // Each open tuple: its children, the next one to check, and those built so far.
  const stack: { items: JsonNode[]; next: number; built: Value[] }[] = [
    { items: first, next: 0, built: [] },
  ];
  for (;;) {
    const top = stack[stack.length - 1]!;
    const child = top.items[top.next];
    if (child === undefined) {
      const tuple = new Tuple(top.built);
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent === undefined) return tuple;
      parent.built.push(tuple);
      continue;
    }
    top.next += 1;
    const node = authoringNode(child);
    if (Array.isArray(node)) stack.push({ items: node, next: 0, built: [] });
    else top.built.push(node);
  }
}

/** Check one authoring node: an atom comes back as its Value, a tuple as its children. */
function authoringNode(node: JsonNode): Value | JsonNode[] {
  if (node.kind !== "object") {
    throw new AuthoringError("value must be an object");
  }
  if (node.members.size !== 1) {
    throw new AuthoringError('value must have exactly one member, "atom" or "tuple"');
  }
  const atomPayload = node.members.get("atom");
  if (atomPayload !== undefined) {
    if (atomPayload.kind !== "string") throw new AuthoringError('"atom" must be a string');
    return new Atom(atomBytes(atomPayload.text));
  }
  const tuplePayload = node.members.get("tuple");
  if (tuplePayload === undefined) {
    throw new AuthoringError('value must have exactly one member, "atom" or "tuple"');
  }
  if (tuplePayload.kind !== "array") throw new AuthoringError('"tuple" must be an array');
  return tuplePayload.items;
}

/** Decode an authoring atom string: must be even-length LOWERCASE hex ("" allowed). */
function atomBytes(hex: string): Uint8Array {
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
 * Build a Value from the `--from-json` source: stage 1, then stage 2. `-` reads the
 * JSON from stdin. Nothing is trimmed: the reader allows only RFC 8259 whitespace.
 */
function valueFromJsonSource(source: string): Value {
  const text = source === "-" ? readFileSync(0, "utf8") : source;
  return authoringValue(readJson(text));
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
 * - `--from-json` (fromJson !== undefined): read the text and check the authoring
 *   shape, building the Value directly. It is canonical by construction, so its
 *   bytes are simply `encode(value)`. A text nested deeper than JSON_NESTING_CAP is
 *   `limit_exceeded` (exit 1); any other fault or non-authoring shape is
 *   `invalid_json` (exit 2). Mutual exclusion with `<hex>` is enforced earlier
 *   (usage_error).
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
      if (err instanceof JsonTooDeep) {
        // Deeper than any value the default decoder accepts: limit_exceeded, exit 1,
        // exactly as a decode limit (ontos-cli.md "Value input").
        if (format === "json") {
          emitLine({ ok: false, command, error: "limit_exceeded" });
        } else {
          process.stderr.write(`ontos: json input too deep: ${err.message}\n`);
        }
        process.exit(EXIT_NEGATIVE);
      }
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
