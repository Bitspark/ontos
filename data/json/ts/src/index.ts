/*
 * ontos-data-json/1 — the named, TOTAL projection of a domain-JSON document to an
 * ontos/data value (docs/spec/ontos-data-json.md). TypeScript face; peer of
 * data/json/go.
 *
 * This is the first-class, importable realization of that projection, driven by the
 * cross-impl conformance lock in vectors/data-json.json. Consumers that need the
 * ontos reading of a JSON value — e.g. domain-separated identity digests — call
 * `project` directly instead of re-implementing the walk; a re-implementation is the
 * preimage-drift class this package exists to remove.
 *
 * The projection is total over the accepted JSON forms and composes the frozen
 * ontos/data primitives (it never re-derives a byte form):
 *
 *   JSON object            -> data map        (encodeMap)
 *   JSON array             -> data list       (encodeList)
 *   JSON string            -> utf8-text       (encodeText)
 *   JSON integer literal   -> int             (encodeInt, arbitrary precision)
 *   JSON true / false      -> bool            (encodeBool)
 *   JSON null              -> null()          (encodeNull)
 *
 * A JSON number carrying a fraction or exponent (1.5, 1e3, 1.0) falls in the RESERVED
 * decimal arm, which ontos-data-json/1 does not graduate: `project` rejects it
 * path-named rather than coercing to a float or a decimal. Acceptance is by the
 * literal FORM, not the numeric value — 1.0 and 1e3 reject even though they are whole
 * numbers.
 *
 * `project` reads exactly one JSON document; trailing data after it is rejected.
 *
 * WHY THIS FILE PARSES JSON ITSELF, instead of calling JSON.parse
 * --------------------------------------------------------------
 * Acceptance is decided on the number LITERAL, and `JSON.parse` destroys exactly that
 * distinction: it yields a `number`, after which 1e3, 1000.0 and 1000 are one value.
 * vectors/data-json.json says so in its own note, and carries reject cases as RAW
 * SOURCE (`docSource`) for this reason. The literal is preserved by a small
 * recursive-descent reader below, which accepts exactly RFC 8259 and nothing more.
 * The reader also preserves string FIDELITY: a lone `\uXXXX` surrogate survives as a
 * code unit instead of becoming U+FFFD, so the projection can reject it path-named
 * (ontos-internal#216, the ontos-data.md §4.1 fidelity law). The Go peer parses its own raw source
 * for both of the same reasons; the shared rejection reason is pinned by the vectors.
 */

import { atom, tuple, type Value } from "@bitspark/ontos-core";
import {
  DataError,
  encodeBool,
  encodeInt,
  encodeList,
  encodeMap,
  encodeNull,
  encodeText,
} from "@bitspark/ontos-data";

/**
 * A projection failure carrying the JSONPath of the offending node (`$` for the root,
 * `$.key` for an object member, `$[i]` for an array element) and a stable,
 * spec-worded reason.
 *
 * The reason strings are part of the ontos-data-json/1 conformance surface —
 * vectors/data-json.json pins them — so they are formatted here to match the lock
 * byte-for-byte, including the em-dash in the decimal-arm rejection.
 */
/**
 * The document exceeded this face's nesting-depth ceiling — an IMPLEMENTATION
 * BOUND (ontos-data-json/1 resource-limit posture, ontos-internal#236), deliberately a
 * DISTINCT type from `ProjectionError`: a depth limit does not say the document
 * is inadmissible under /1 (another conformant face with a higher ceiling may
 * accept it), so conflating the classes would put the limit into the profile's
 * semantics. The spec's floor is 512; this face's ceiling is `MAX_DEPTH`.
 * Before this bound, a hostile `[[[[…` document escaped as a bare V8
 * `RangeError` — off the ProjectionError surface entirely (measured at depth
 * 10k). Mirrors ontos-codec's decode-limit class.
 */
export class LimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `nesting depth exceeds this face's limit (${limit}) — implementation bound, ` +
        `not a rejection of the document under ontos-data-json/1`,
    );
    this.name = "LimitError";
    this.limit = limit;
  }
}

/**
 * This face's nesting-depth ceiling: the deepest object/array nesting `project`
 * reads before throwing a `LimitError`. Conformance requires accepting at least
 * the spec's floor of 512; the ceiling itself is per-face and never pinned by
 * vectors (stacks differ — the Go face states 10000, the Rust face 512).
 * 1024 is measured, not guessed: this face's recursive reader overflows V8's
 * default stack between depth 3000 and 4000 in compiled JS (earlier under
 * type-stripped execution), so the ceiling sits at a ~3x margin below the
 * cliff. A stated ceiling above the real one would be the ontos-internal#236 crash with a
 * conformance claim on top.
 */
export const MAX_DEPTH = 1024;

export class ProjectionError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "ProjectionError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * The strict-mode refusal (ontos-internal#322): under `duplicateKeys: "reject"` the object
 * at the parent of `path` repeated the member `key`. A SOURCE-ADMISSION class — the
 * document was refused, not a resource bound hit — so it extends `ProjectionError`
 * (a consumer that already catches that class catches this one) while staying
 * distinguishable by `instanceof`, and it is never a `LimitError`. The reader stops
 * at the FIRST repeat it meets in source order; `path` names that member (e.g.
 * `$.items[1].id`) and `key` is the name as decoded. The `reason` wording is NOT
 * pinned by the vectors — only the refusal, its path and its key are.
 */
export class DuplicateKeyError extends ProjectionError {
  readonly key: string;

  constructor(path: string, key: string) {
    super(
      path,
      `duplicate object key ${JSON.stringify(key)} — rejected under duplicateKeys: reject ` +
        `(the ontos-data-json/1 default is last-wins)`,
    );
    this.name = "DuplicateKeyError";
    this.key = key;
  }
}

/**
 * How `project` treats a JSON object that repeats a member name
 * (ontos-data-json.md §"The projection", *Duplicate object keys*).
 *
 * - `"last-wins"` (the default): repeated members collapse to the LAST occurrence at
 *   the reader, before any ontos/data value is built.
 * - `"reject"`: refuse the document at the first repeated member with a
 *   `DuplicateKeyError`. A stricter SOURCE-ADMISSION policy over the same mapping,
 *   not a different reading: every document it accepts projects to exactly the
 *   value (and bytes) the default emits for it. Names collide on their exact
 *   decoded content — an escaped and a literal spelling of the same name are one
 *   name; two names that differ in code units are two names, even when canonically
 *   equivalent (no Unicode normalization, ontos-data §5.2).
 */
export type DuplicateKeys = "last-wins" | "reject";

/** Options for `project`. The empty object is the default behavior. */
export interface ProjectOptions {
  duplicateKeys?: DuplicateKeys;
}

// ---------------------------------------------------------------------------
// JSON reading — literal-preserving, RFC 8259 exact.
// ---------------------------------------------------------------------------

/**
 * A JSON number kept as its source literal, never as a JS `number`.
 *
 * Fields are declared and assigned explicitly rather than via a TypeScript parameter
 * property: these tests run straight from .ts under Node's strip-only type stripping,
 * which rejects parameter properties (they emit code, not just types).
 */
class NumberLiteral {
  readonly literal: string;

  constructor(literal: string) {
    this.literal = literal;
  }
}

/** The reader's tree. Objects are Maps so duplicate keys collapse last-wins. */
type JsonNode =
  | null
  | boolean
  | string
  | NumberLiteral
  | JsonNode[]
  | Map<string, JsonNode>;

/** Thrown by the reader; converted to a `$`-rooted ProjectionError by `project`. */
class SyntaxErrorAt extends Error {}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** One step of the reader's JSONPath: an object member or an array index. */
type PathSeg = { key: string } | { index: number };

class Reader {
  private i = 0;
  private depth = 0;
  private readonly s: string;
  // `duplicateKeys: "reject"`: refuse a repeated object member instead of collapsing
  // it. `path` is maintained only in strict mode, so the refusal can name the member;
  // the default reader does not pay for it.
  private readonly strict: boolean;
  private readonly path: PathSeg[] = [];

  constructor(s: string, strict = false) {
    this.s = s;
    this.strict = strict;
  }

  /**
   * The JSONPath of member `key` under the current object, in the same `$.key` /
   * `$[i]` spelling the projection walk uses for its rejections.
   */
  private memberPath(key: string): string {
    let out = "$";
    for (const seg of this.path) out += "key" in seg ? `.${seg.key}` : `[${seg.index}]`;
    return `${out}.${key}`;
  }

  /** Reads one complete JSON value, then requires end-of-input. */
  readDocument(): JsonNode {
    this.skipWhitespace();
    if (this.i >= this.s.length) {
      throw new ProjectionError("$", "empty input: expected one JSON document");
    }
    const node = this.readValue();
    this.skipWhitespace();
    if (this.i < this.s.length) {
      throw new ProjectionError("$", "trailing data after JSON document");
    }
    return node;
  }

  private skipWhitespace(): void {
    while (this.i < this.s.length && WHITESPACE.has(this.s.charCodeAt(this.i))) this.i++;
  }

  private fail(msg: string): never {
    throw new SyntaxErrorAt(`${msg} at offset ${this.i}`);
  }

  private literal(word: string, value: JsonNode): JsonNode {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return value;
    }
    this.fail(`invalid literal`);
  }

  private readValue(): JsonNode {
    if (this.i >= this.s.length) this.fail("unexpected end of input");
    const c = this.s[this.i]!;
    switch (c) {
      case "{":
        return this.readObject();
      case "[":
        return this.readArray();
      case '"':
        return this.readString();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return this.readNumber();
        this.fail(`unexpected character ${JSON.stringify(c)}`);
    }
  }

  // The reader is recursive, so this counter is what keeps a hostile document
  // from running the stack out from under every caller (ontos-internal#236).
  private push(): void {
    if (++this.depth > MAX_DEPTH) throw new LimitError(MAX_DEPTH);
  }

  private readObject(): Map<string, JsonNode> {
    this.push();
    this.i++; // '{'
    const out = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.s[this.i] === "}") {
      this.i++;
      this.depth--;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.s[this.i] !== '"') this.fail("expected object key");
      const key = this.readString();
      if (this.strict) {
        // Exact decoded content: readString has already resolved escapes, so "a" and
        // "\u0061" meet here as the same string; no normalization.
        if (out.has(key)) throw new DuplicateKeyError(this.memberPath(key), key);
        this.path.push({ key });
      }
      this.skipWhitespace();
      if (this.s[this.i] !== ":") this.fail("expected ':' after object key");
      this.i++;
      this.skipWhitespace();
      // Last-wins on duplicate keys in the default mode, matching the Go and Rust peers.
      const val = this.readValue();
      if (this.strict) this.path.pop();
      out.set(key, val);
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        this.depth--;
        return out;
      }
      this.fail("expected ',' or '}' in object");
    }
  }

  private readArray(): JsonNode[] {
    this.push();
    this.i++; // '['
    const out: JsonNode[] = [];
    this.skipWhitespace();
    if (this.s[this.i] === "]") {
      this.i++;
      this.depth--;
      return out;
    }
    for (let index = 0; ; index++) {
      this.skipWhitespace();
      if (this.strict) this.path.push({ index });
      out.push(this.readValue());
      if (this.strict) this.path.pop();
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        this.depth--;
        return out;
      }
      this.fail("expected ',' or ']' in array");
    }
  }

  private readString(): string {
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unterminated string");
      const c = this.s[this.i]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        this.i++;
        out += this.readEscape();
        continue;
      }
      // RFC 8259: raw control characters below U+0020 must be escaped.
      if (this.s.charCodeAt(this.i) < 0x20) this.fail("unescaped control character in string");
      out += c;
      this.i++;
    }
  }

  private readEscape(): string {
    if (this.i >= this.s.length) this.fail("unterminated escape");
    const c = this.s[this.i]!;
    this.i++;
    switch (c) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid \\u escape");
        this.i += 4;
        // Emitted as a code unit. A lone surrogate therefore SURVIVES into the
        // string, where `projectNode` rejects it path-named with the pinned
        // fidelity reason (ontos-internal#216). See `unpairedSurrogateAt`.
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        this.fail(`invalid escape \\${c}`);
    }
  }

  /** Captures the number literal verbatim, per the RFC 8259 grammar. */
  private readNumber(): NumberLiteral {
    const start = this.i;
    if (this.s[this.i] === "-") this.i++;
    // int: 0 | [1-9][0-9]*  — a leading zero may not be followed by digits.
    if (this.s[this.i] === "0") {
      this.i++;
    } else if (this.isDigit(this.s[this.i])) {
      while (this.isDigit(this.s[this.i])) this.i++;
    } else {
      this.fail("expected digit in number");
    }
    // frac
    if (this.s[this.i] === ".") {
      this.i++;
      if (!this.isDigit(this.s[this.i])) this.fail("expected digit after '.' in number");
      while (this.isDigit(this.s[this.i])) this.i++;
    }
    // exp
    const e = this.s[this.i];
    if (e === "e" || e === "E") {
      this.i++;
      const sign = this.s[this.i];
      if (sign === "+" || sign === "-") this.i++;
      if (!this.isDigit(this.s[this.i])) this.fail("expected digit in number exponent");
      while (this.isDigit(this.s[this.i])) this.i++;
    }
    return new NumberLiteral(this.s.slice(start, this.i));
  }

  private isDigit(c: string | undefined): boolean {
    return c !== undefined && c >= "0" && c <= "9";
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/**
 * Orders keys by their UTF-8 bytes, matching Go's `sort.Strings`.
 *
 * This is purely for DETERMINISTIC error paths when a document has more than one
 * offending node; it does not affect the emitted bytes, because `encodeMap` re-sorts
 * entries canonically by encoded key. JS's default sort compares UTF-16 code units,
 * which disagrees with Go for supplementary-plane keys — hence the explicit compare,
 * so both faces name the same offending node first.
 */
function compareUtf8(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Go's `%q` for a number literal: ASCII-only, so JSON quoting agrees exactly. */
function quote(literal: string): string {
  return JSON.stringify(literal);
}

/**
 * Finds the UTF-16 index of the first unpaired surrogate in `s`, or -1.
 *
 * Such a string has NO UTF-8 encoding, so it denotes no `utf8-text` value; the
 * projection rejects it path-named (ontos-internal#216) rather than letting any layer coerce it
 * to U+FFFD — a producer succeeding with a DIFFERENT admissible datum is exactly
 * what the ontos-data.md §4.1 fidelity law forbids, and it is invisible to every
 * caller of an identity-digest projection. The Go peer enforces the same law from
 * its raw-source reader; vectors/data-json.json pins the shared reason.
 */
function unpairedSurrogateAt(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // a valid pair — skip its low half
        continue;
      }
      return i;
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) return i;
  }
  return -1;
}

/** The pinned fidelity rejection — byte-for-byte identical in the Go peer. */
function fidelityReason(unit: number, index: number): string {
  return (
    `unpaired surrogate 0x${unit.toString(16)} at UTF-16 index ${index} — the string has ` +
    `no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ` +
    `ontos-data.md §4.1 fidelity law)`
  );
}

/** Reads a string node as utf8-text, rejecting path-named where no reading exists. */
function projectText(s: string, path: string): Value {
  const at = unpairedSurrogateAt(s);
  if (at >= 0) throw new ProjectionError(path, fidelityReason(s.charCodeAt(at), at));
  // Backstop: encodeText re-checks the same law at the primitive layer.
  try {
    return encodeText(s);
  } catch (e) {
    if (e instanceof DataError) throw new ProjectionError(path, e.message);
    throw e;
  }
}

function projectNumber(literal: string, path: string): Value {
  if (/[.eE]/.test(literal)) {
    throw new ProjectionError(
      path,
      `non-integer number literal ${quote(literal)} — fraction/exponent rejected under ` +
        `ontos-data-json/1 (reserved decimal arm ungraduated)`,
    );
  }
  let n: bigint;
  try {
    n = BigInt(literal);
  } catch {
    // A literal without . e or E that BigInt cannot parse should not occur for
    // well-formed JSON, but fail loudly rather than emit an unlocked shape.
    throw new ProjectionError(path, `malformed integer literal ${quote(literal)}`);
  }
  return encodeInt(n);
}

function projectNode(node: JsonNode, path: string): Value {
  if (node === null) return encodeNull();
  if (typeof node === "boolean") return encodeBool(node);

  if (typeof node === "string") return projectText(node, path);

  if (node instanceof NumberLiteral) return projectNumber(node.literal, path);

  if (Array.isArray(node)) {
    const elements: Value[] = [];
    for (let i = 0; i < node.length; i++) {
      elements.push(projectNode(node[i]!, `${path}[${i}]`));
    }
    return encodeList(elements);
  }

  // Object. Keys are walked in sorted order for deterministic error paths; duplicate
  // keys already collapsed last-wins in the reader, so the map is duplicate-free
  // before encodeMap ever sees it.
  const keys = [...node.keys()].sort(compareUtf8);
  const entries: Array<readonly [Value, Value]> = [];
  for (const k of keys) {
    const childPath = `${path}.${k}`;
    const child = projectNode(node.get(k)!, childPath);
    entries.push([projectText(k, childPath), child] as const);
  }
  return encodeMap(entries);
}

/**
 * Reads a single domain-JSON document and returns its ontos-data-json/1 value.
 *
 * @param raw the JSON document SOURCE TEXT. It is source, not a parsed value, because
 *   acceptance is decided on the number literal — see the header note.
 * @param options `duplicateKeys: "reject"` refuses a document that repeats an object
 *   member (a `DuplicateKeyError`); the default collapses it last-wins. Every other
 *   outcome — the accepted value and its bytes, the path-named rejections, the
 *   `LimitError` class — is identical between the two modes.
 * @throws {ProjectionError} on any rejected form, carrying the JSONPath of the
 *   offending node.
 */
export function project(raw: string, options: ProjectOptions = {}): Value {
  let tree: JsonNode;
  try {
    tree = new Reader(raw, options.duplicateKeys === "reject").readDocument();
  } catch (e) {
    if (e instanceof ProjectionError) throw e;
    if (e instanceof LimitError) throw e; // the limit class passes through as itself (ontos-internal#236)
    if (e instanceof SyntaxErrorAt) throw new ProjectionError("$", `invalid JSON: ${e.message}`);
    throw e;
  }
  return projectNode(tree, "$");
}

/**
 * Wraps a projected value in the era-2 domain-separated preimage
 * `Tuple(Atom(tag), value)`, the shape whose ontos-codec-v1 digest the vectors pin as
 * `era2.digest`. Provided so consumers do not hand-build the wrap and drift.
 */
export function era2Preimage(tag: string, value: Value): Value {
  return tuple([atom(utf8.encode(tag)), value]);
}
