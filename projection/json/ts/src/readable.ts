/*
 * ontos-readable-json/1 — the readable JSON form of ground values
 * (docs/spec/ontos-readable-json.md).
 *
 * The common ground values are ordinary JSON: null, booleans, strings, integers within
 * ±(2⁵³ − 1), arrays and text-keyed objects. Every other value goes through the reserved
 * envelope {"$ontos":[tag,…]}, with the tags bytes, int, decimal, map, set, compound and raw;
 * raw wraps the total form, so the profile is total over L0.
 *
 * Reading runs the total profile's stages 1 to 3 (./lexer) and interprets the JSON tree in
 * pre-order with an explicit stack (§4), optionally recording origins (§10.2). Writing
 * chooses each spelling in the frozen recognition order of §2.3 and checks the limits as the
 * reader's mirror (§9). Neither recurses on the host stack.
 *
 * A presentation, not the form of record: identity, hashing and signing use the codec bytes
 * of the recovered value, never this text.
 */

import { Atom, Tuple, atom, copyBytes, tuple, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import {
  DataError,
  readBool,
  readList,
  readMap,
  readSet,
  recognizeDecimal,
  recognizeInt,
  recognizeNull,
} from "@bitspark/ontos-data";

import { generalizedUtf8, interpretTotal, writeTotal, type Interpreted, type OriginNode } from "./form.js";
import {
  ARRAY,
  FALSE,
  NULL,
  NUMBER,
  OBJECT,
  STRING,
  TRUE,
  isUtf8,
  readJson,
  textOf,
  type JArray,
  type JNode,
  type JObject,
  type JString,
} from "./lexer.js";
import {
  Output,
  ProjectionError,
  READABLE_PROFILE,
  bytesKey,
  compareBytes,
  extend,
  firstExceeded,
  limitMessage,
  pathArray,
  resolveLimits,
  utf8,
  type LimitKind,
  type Limits,
  type PathLink,
  type PathSegment,
  type ProjectionErrorCode,
  type ResolvedLimits,
  type Span,
} from "./shared.js";

export { ProjectionError } from "./shared.js";
export type { Limits, LimitKind, PathSegment, Profile, ProjectionErrorCode, Span } from "./shared.js";

/** The profile id. */
export const PROFILE = READABLE_PROFILE;

/**
 * This profile's shipped defaults (§9): value depth 1024, JSON depth derived
 * (`3 · maxValueDepth + 4`, so 3076), integer digits 4300, everything else unbounded.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxTextBytes: Infinity,
  maxValueDepth: 1024,
  maxAtomBytes: Infinity,
  maxTupleArity: Infinity,
  maxIntegerDigits: 4300,
});

/** The derived JSON depth bound for a value depth bound `v`: compounds around a raw empty tuple. */
function deriveJsonDepth(maxValueDepth: number): number {
  return 3 * maxValueDepth + 4;
}

function limitsOf(limits: Partial<Limits> | undefined): ResolvedLimits {
  return resolveLimits(DEFAULT_LIMITS, limits, deriveJsonDepth);
}

/** Where one value node came from: the JSON path (§8.2) and span of the source that produced it. */
export interface Origin {
  readonly path: readonly PathSegment[];
  readonly span: Span;
}

/**
 * The origins of a value read (§10.2): for every node of the value, every atom and tuple of
 * the expanded tree, its origin. Value paths are tuple child indices from the root; after
 * sorting, a map entry's index is its position in codec order.
 */
export interface Origins extends Iterable<[valuePath: number[], origin: Origin]> {
  /** The origin of the value node at `valuePath`, or undefined when the value has no such node. */
  at(valuePath: readonly number[]): Origin | undefined;
  /** Every value node with its origin, in pre-order of the value. */
  entries(): IterableIterator<[valuePath: number[], origin: Origin]>;
  /** The number of value nodes. */
  readonly size: number;
}

/** A value with its origins. */
export interface Parsed {
  readonly value: Value;
  readonly origins: Origins;
}

/**
 * Reads `input`, the exact bytes of an ontos-readable-json/1 text, under `limits` (this
 * profile's DEFAULT_LIMITS overridden by the fields given). Returns the value, or throws a
 * ProjectionError.
 */
export function parseUtf8(input: Uint8Array, limits?: Partial<Limits>): Value {
  const resolved = limitsOf(limits);
  const root = readJson(copyBytes(input), resolved, READABLE_PROFILE);
  return interpret(root, resolved, null).value;
}

/** parseUtf8, also returning the origins of every value node (§10.2). */
export function parseUtf8WithOrigins(input: Uint8Array, limits?: Partial<Limits>): Parsed {
  const resolved = limitsOf(limits);
  const root = readJson(copyBytes(input), resolved, READABLE_PROFILE);
  const done = interpret(root, resolved, true);
  return { value: done.value, origins: new OriginsTree(done.origin!) };
}

/**
 * Reads a host string as parseUtf8 reads the string's generalized UTF-8 encoding, in which
 * a lone surrogate becomes three bytes `ED A0–BF 80–BF` and is refused with `invalid_utf8`
 * (total §10). Only for a string that never passed through a lossy decoding: a replaced
 * byte would read as U+FFFD, a different value accepted without complaint (§10.1).
 */
export function parseString(input: string, limits?: Partial<Limits>): Value {
  return parseUtf8(generalizedUtf8(input), limits);
}

/** Writes the preferred spelling of `value` as UTF-8 bytes (§2, §5), under `limits`. */
export function renderUtf8(value: Value, limits?: Partial<Limits>): Uint8Array {
  const resolved = limitsOf(limits);
  const out = new Output(resolved, READABLE_PROFILE);
  write(out, value, resolved);
  return out.result();
}

/** The UTF-8 decoding of renderUtf8. */
export function renderString(value: Value, limits?: Partial<Limits>): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(renderUtf8(value, limits));
}

// --- the value vocabulary -----------------------------------------------------------------

const L_NULL = atom(utf8("null"));
const L_BOOL = atom(utf8("bool"));
const L_TEXT = atom(utf8("utf8-text"));
const L_INT = atom(utf8("int"));
const L_LIST = atom(utf8("list"));
const L_MAP = atom(utf8("map"));
const L_SET = atom(utf8("set"));
const L_DECIMAL = atom(utf8("decimal"));
const NULL_VALUE = tuple([L_NULL]);
const TRUE_VALUE = tuple([L_BOOL, atom([1])]);
const FALSE_VALUE = tuple([L_BOOL, atom([0])]);

/** The window of bare integer literals: ±(2⁵³ − 1), whose magnitude has at most 16 digits. */
const MAX_SAFE_DIGITS = "9007199254740991";

const textValue = (bytes: Uint8Array): Value => tuple([L_TEXT, atom(bytes)]);

/**
 * Codec order of two utf8-text keys given as their UTF-8 bytes (§4.8): their encodings share
 * a prefix and continue with uvarint(length) ‖ bytes, so compare the uvarints, then the bytes.
 */
function compareTextKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return compareBytes(uvarint(a.length), uvarint(b.length));
  return compareBytes(a, b);
}

function uvarint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Uint8Array.from(out);
}

const TEXT_LABEL = utf8("utf8-text");

/**
 * The payload of a canonical utf8-text (ontos-data §5.2): a tuple of arity 2, the label
 * utf8-text, and an atom of well-formed UTF-8. Undefined for anything else. The same rule as
 * @bitspark/ontos-data's readText, checked on the bytes.
 */
function textPayload(v: Value): Uint8Array | undefined {
  if (!(v instanceof Tuple) || v.length !== 2) return undefined;
  const [label, payload] = v.items() as [Value, Value];
  if (!(label instanceof Atom) || !(payload instanceof Atom) || label.length !== TEXT_LABEL.length) return undefined;
  if (compareBytes(label.bytes(), TEXT_LABEL) !== 0) return undefined;
  const bytes = payload.bytes();
  return isUtf8(bytes) ? bytes : undefined;
}

/** Whether `digits` (ASCII, no sign, no leading zero) is at most 2⁵³ − 1. */
function inWindow(digits: string): boolean {
  return digits.length < MAX_SAFE_DIGITS.length || (digits.length === MAX_SAFE_DIGITS.length && digits <= MAX_SAFE_DIGITS);
}

/** Whether `s` is int-text: `0`, or an optional `-` and a non-zero digit followed by digits (§4.5). */
function isIntText(s: Uint8Array): boolean {
  let i = s[0] === 0x2d ? 1 : 0;
  if (i >= s.length) return false;
  if (s[i] === 0x30) return s.length === 1;
  if (s[i]! < 0x31 || s[i]! > 0x39) return false;
  for (i += 1; i < s.length; i += 1) if (s[i]! < 0x30 || s[i]! > 0x39) return false;
  return true;
}

/**
 * The int payload (ontos-data §5.1) of canonical decimal text, already checked by the
 * caller: a sign byte and the minimal big-endian magnitude. The text decides what the
 * integer is; BigInt only converts it.
 */
function intPayload(text: string): Uint8Array {
  const negative = text.charCodeAt(0) === 0x2d;
  const digits = negative ? text.slice(1) : text;
  if (digits === "0") return Uint8Array.of(0);
  if (digits.length <= 15) {
    // Below 10^15 < 2^53, a double holds the integer exactly.
    let n = Number(digits);
    let length = 0;
    for (let m = n; m > 0; m = Math.floor(m / 256)) length += 1;
    const out = new Uint8Array(1 + length);
    out[0] = negative ? 1 : 0;
    for (let i = length; i >= 1; i -= 1) {
      out[i] = n % 256;
      n = Math.floor(n / 256);
    }
    return out;
  }
  let hex = BigInt(digits).toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const out = new Uint8Array(1 + hex.length / 2);
  out[0] = negative ? 1 : 0;
  for (let i = 0; i < hex.length; i += 2) out[1 + i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

const intValue = (payload: Uint8Array): Value => tuple([L_INT, atom(payload)]);

// --- base64 (§4.7) --------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i += 1) B64_VALUE[B64.charCodeAt(i)] = i;

/** The bytes of canonical padded standard base64, or null when `s` is not canonical. */
function decodeBase64(s: Uint8Array): Uint8Array | null {
  const n = s.length;
  if (n % 4 !== 0) return null;
  const pad = n === 0 ? 0 : s[n - 1] !== 0x3d ? 0 : s[n - 2] !== 0x3d ? 1 : 2;
  const out = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n;
    const c0 = B64_VALUE[s[i]!]!;
    const c1 = B64_VALUE[s[i + 1]!]!;
    const c2 = last && pad === 2 ? 0 : B64_VALUE[s[i + 2]!]!;
    const c3 = last && pad >= 1 ? 0 : B64_VALUE[s[i + 3]!]!;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    // The unused bits of the last character are zero (RFC 4648 §3.5).
    if (last && pad === 2 && (c1 & 0x0f) !== 0) return null;
    if (last && pad === 1 && (c2 & 0x03) !== 0) return null;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (!(last && pad === 2)) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (!(last && pad >= 1)) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}

function encodeBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64[v >> 18]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
  }
  if (b.length - i === 1) {
    const v = b[i]! << 16;
    out += B64[v >> 18]! + B64[(v >> 12) & 63]! + "==";
  } else if (b.length - i === 2) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8);
    out += B64[v >> 18]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + "=";
  }
  return out;
}

// --- reading: stage 4 (§4) ------------------------------------------------------------------

const TAG_ARITY: ReadonlyMap<string, number> = new Map([
  ["bytes", 2],
  ["int", 2],
  ["decimal", 3],
  ["map", 2],
  ["set", 2],
  ["compound", 3],
  ["raw", 2],
]);

/** A JSON node to interpret, at a value depth and a path. */
interface Task {
  readonly node: JNode;
  readonly depth: number;
  readonly path: PathLink | null;
}

/** A node whose children are being interpreted, in document order. */
class Frame {
  readonly results: Interpreted[] = [];
  constructor(
    readonly children: Task[],
    /** Runs after each child's subtree completes; may refuse (a duplicate key or element). */
    readonly afterChild: ((index: number, result: Interpreted) => void) | null,
    readonly finish: (results: Interpreted[]) => Interpreted,
  ) {}
}

function uniform(value: Value, path: PathLink | null, start: number, end: number): OriginNode {
  // Scalars only (a decimal is the deepest, at two levels), so this recursion is bounded.
  const children = value instanceof Tuple ? value.items().map((child) => uniform(child, path, start, end)) : [];
  return { path, start, end, children };
}

/**
 * Interprets the JSON tree as a readable value (§4): every node checked in the order §4.2 to
 * §4.4 give, then its limit checks (§4.9), then its children in document order, each subtree
 * completing before the next begins. With `withOrigins`, records the origin of every value
 * node (§10.2).
 */
function interpret(root: JNode, limits: ResolvedLimits, withOrigins: true | null): Interpreted {
  const profile = READABLE_PROFILE;
  const refuse = (code: ProjectionErrorCode, node: JNode, path: PathLink | null, message: string): never => {
    throw new ProjectionError(profile, code, pathArray(path), { start: node.start, end: node.end }, message);
  };
  const limit = (node: JNode, path: PathLink | null, kind: LimitKind): never => {
    throw new ProjectionError(profile, "limit_exceeded", pathArray(path), { start: node.start, end: node.end },
      limitMessage(kind, limits), kind);
  };
  /** The value-side limits of a node's contribution, all but its atoms (§4.9 steps 1–3). */
  const check = (node: JNode, path: PathLink | null, deepest: number, arity: number, digits: number): void => {
    const kind = firstExceeded(limits, deepest, arity, digits);
    if (kind !== undefined) limit(node, path, kind);
  };
  /** §4.9 step 4: the longest atom the node contributes. */
  const checkAtoms = (node: JNode, path: PathLink | null, longest: number): void => {
    if (longest > limits.maxAtomBytes) limit(node, path, "atom_bytes");
  };
  const leaf = (value: Value, node: JNode, path: PathLink | null): Interpreted => ({
    value,
    origin: withOrigins && uniform(value, path, node.start, node.end),
  });
  /** The origin of a container's own tuple and its label atom, with its children's origins. */
  const own = (node: JNode, path: PathLink | null, children: (OriginNode | null)[]): OriginNode | null =>
    withOrigins && {
      path,
      start: node.start,
      end: node.end,
      children: [{ path, start: node.start, end: node.end, children: [] }, ...(children as OriginNode[])],
    };

  function visit(task: Task): Interpreted | Frame {
    const { node: x, depth: d, path: P } = task;
    switch (x.type) {
      case NULL:
        check(x, P, d + 1, 1, -1);
        checkAtoms(x, P, 4);
        return leaf(NULL_VALUE, x, P);
      case TRUE:
      case FALSE:
        check(x, P, d + 1, 2, -1);
        checkAtoms(x, P, 4);
        return leaf(x.type === TRUE ? TRUE_VALUE : FALSE_VALUE, x, P);
      case STRING:
        check(x, P, d + 1, 2, -1);
        checkAtoms(x, P, Math.max(9, x.bytes.length));
        return leaf(textValue(x.bytes), x, P);
      case NUMBER: {
        if (!x.integral) refuse("invalid_number", x, P, "a number literal has a fraction or an exponent");
        const digits = x.lexeme.charCodeAt(0) === 0x2d ? x.lexeme.slice(1) : x.lexeme;
        if (!inWindow(digits)) {
          refuse("unsafe_integer_literal", x, P, "a bare integer literal lies outside ±(2^53 − 1); use the int tag");
        }
        check(x, P, d + 1, 2, digits.length);
        const payload = intPayload(x.lexeme);
        checkAtoms(x, P, Math.max(3, payload.length));
        return leaf(intValue(payload), x, P);
      }
      case ARRAY: {
        check(x, P, d + 1, 1 + x.items.length, -1);
        checkAtoms(x, P, 4);
        const children = x.items.map((item, i): Task => ({ node: item, depth: d + 1, path: extend(P, i) }));
        return new Frame(children, null, (results) => ({
          value: tuple([L_LIST, ...results.map((r) => r.value)]),
          origin: own(x, P, results.map((r) => r.origin)),
        }));
      }
      case OBJECT:
        return x.members.some((m) => m.name === "$ontos") ? envelope(x, d, P) : object(x, d, P);
    }
  }

  function object(x: JObject, d: number, P: PathLink | null): Frame {
    const m = x.members.length;
    let longest = 3;
    if (m > 0) {
      longest = Math.max(longest, 9);
      for (const member of x.members) longest = Math.max(longest, member.nameBytes.length);
    }
    check(x, P, m > 0 ? d + 3 : d + 1, m > 0 ? Math.max(1 + m, 2) : 1, -1);
    checkAtoms(x, P, longest);
    const children = x.members.map((member): Task => ({ node: member.value, depth: d + 2, path: extend(P, member.name) }));
    return new Frame(children, null, (results) => {
      const entries = x.members.map((member, i) => ({ member, key: textValue(member.nameBytes), result: results[i]! }));
      entries.sort((a, b) => compareTextKeys(a.member.nameBytes, b.member.nameBytes));
      return {
        value: tuple([L_MAP, ...entries.map((e) => tuple([e.key, e.result.value]))]),
        origin: own(
          x,
          P,
          entries.map((e) => {
            const path = extend(P, e.member.name);
            return (
              withOrigins && {
                path,
                start: e.member.nameStart,
                end: e.member.value.end,
                children: [uniform(e.key, path, e.member.nameStart, e.member.nameEnd), e.result.origin!],
              }
            );
          }),
        ),
      };
    });
  }

  function envelope(x: JObject, d: number, P: PathLink | null): Interpreted | Frame {
    if (x.members.length !== 1) refuse("invalid_envelope", x, P, "an object with a member named $ontos has no other member");
    const y = x.members[0]!.value;
    const yP = extend(P, "$ontos");
    if (y.type !== ARRAY) refuse("invalid_envelope", y, yP, "the $ontos member's value is an array");
    const items = (y as JArray).items;
    if (items.length === 0) refuse("invalid_envelope", y, yP, "the $ontos array is not empty");
    const y0 = items[0]!;
    if (y0.type !== STRING) refuse("invalid_envelope", y0, extend(yP, 0), "the $ontos array starts with a tag name");
    const tag = textOf(y0 as JString);
    const arity = TAG_ARITY.get(tag);
    if (arity === undefined) refuse("unknown_tag", y0, extend(yP, 0), `unknown tag ${JSON.stringify(tag)}`);
    if (items.length !== arity) refuse("invalid_tag", y, yP, `the ${tag} tag has arity ${arity}`);
    const at = (i: number): JNode => items[i]!;
    const atPath = (i: number): PathLink => extend(yP, i);
    const wantString = (i: number): JString => {
      const node = at(i);
      if (node.type !== STRING) refuse("invalid_tag", node, atPath(i), `the ${tag} tag's element ${i} is a string`);
      return node as JString;
    };
    const wantArray = (i: number): JArray => {
      const node = at(i);
      if (node.type !== ARRAY) refuse("invalid_tag", node, atPath(i), `the ${tag} tag's element ${i} is an array`);
      return node as JArray;
    };
    const wantInteger = (i: number): string => {
      const node = wantString(i);
      if (!isIntText(node.bytes)) refuse("invalid_integer", node, atPath(i), "integer text is 0, or an optional - and digits without a leading zero");
      return textOf(node);
    };

    switch (tag) {
      case "bytes": {
        const node = wantString(1);
        const bytes = decodeBase64(node.bytes);
        if (bytes === null) refuse("invalid_base64", node, atPath(1), "bytes are canonical padded standard base64");
        check(x, P, d, -1, -1);
        checkAtoms(x, P, bytes!.length);
        return leaf(atom(bytes!), x, P);
      }
      case "int": {
        const text = wantInteger(1);
        check(x, P, d + 1, 2, text.length - (text.charCodeAt(0) === 0x2d ? 1 : 0));
        const payload = intPayload(text);
        checkAtoms(x, P, Math.max(3, payload.length));
        return leaf(intValue(payload), x, P);
      }
      case "decimal": {
        const mantissa = wantInteger(1);
        const exponent = wantInteger(2);
        if (mantissa === "0" && exponent !== "0") {
          refuse("noncanonical_decimal", at(2), atPath(2), "the decimal zero is exactly \"0\",\"0\"");
        }
        if (mantissa !== "0" && mantissa.endsWith("0")) {
          refuse("noncanonical_decimal", at(1), atPath(1), "a non-zero decimal mantissa does not end in 0");
        }
        const digitsOf = (s: string): number => s.length - (s.charCodeAt(0) === 0x2d ? 1 : 0);
        check(x, P, d + 2, 3, Math.max(digitsOf(mantissa), digitsOf(exponent)));
        const m = intPayload(mantissa);
        const e = intPayload(exponent);
        checkAtoms(x, P, Math.max(7, m.length, e.length));
        return leaf(tuple([L_DECIMAL, intValue(m), intValue(e)]), x, P);
      }
      case "map": {
        const entries = wantArray(1);
        const entriesPath = atPath(1);
        entries.items.forEach((entry, j) => {
          if (entry.type !== ARRAY || entry.items.length !== 2) {
            refuse("invalid_tag", entry, extend(entriesPath, j), "a map entry is an array of a key and a value");
          }
        });
        const m = entries.items.length;
        check(x, P, d + 1, m > 0 ? Math.max(1 + m, 2) : 1, -1);
        checkAtoms(x, P, 3);
        const children: Task[] = [];
        entries.items.forEach((entry, j) => {
          const entryPath = extend(entriesPath, j);
          const [key, value] = (entry as JArray).items;
          children.push({ node: key!, depth: d + 2, path: extend(entryPath, 0) });
          children.push({ node: value!, depth: d + 2, path: extend(entryPath, 1) });
        });
        const seen = new Set<string>();
        const keyBytes: Uint8Array[] = [];
        return new Frame(
          children,
          (index, result) => {
            if (index % 2 !== 0) return;
            const bytes = encode(result.value);
            const id = bytesKey(bytes);
            if (seen.has(id)) {
              const task = children[index]!;
              refuse("duplicate_map_key", task.node, task.path, "a map tag repeats a key");
            }
            seen.add(id);
            keyBytes.push(bytes);
          },
          (results) => {
            const sorted = entries.items.map((entry, j) => ({
              entry,
              j,
              keyBytes: keyBytes[j]!,
              key: results[2 * j]!,
              value: results[2 * j + 1]!,
            }));
            sorted.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
            return {
              value: tuple([L_MAP, ...sorted.map((e) => tuple([e.key.value, e.value.value]))]),
              origin: own(
                x,
                P,
                sorted.map(
                  (e) =>
                    withOrigins && {
                      path: extend(entriesPath, e.j),
                      start: e.entry.start,
                      end: e.entry.end,
                      children: [e.key.origin!, e.value.origin!],
                    },
                ),
              ),
            };
          },
        );
      }
      case "set": {
        const elements = wantArray(1);
        const elementsPath = atPath(1);
        check(x, P, d + 1, 1 + elements.items.length, -1);
        checkAtoms(x, P, 3);
        const children = elements.items.map((node, j): Task => ({ node, depth: d + 1, path: extend(elementsPath, j) }));
        const seen = new Set<string>();
        const encodings: Uint8Array[] = [];
        return new Frame(
          children,
          (index, result) => {
            const bytes = encode(result.value);
            const id = bytesKey(bytes);
            if (seen.has(id)) {
              const task = children[index]!;
              refuse("duplicate_set_element", task.node, task.path, "a set tag repeats an element");
            }
            seen.add(id);
            encodings.push(bytes);
          },
          (results) => {
            const sorted = results.map((result, j) => ({ result, bytes: encodings[j]! }));
            sorted.sort((a, b) => compareBytes(a.bytes, b.bytes));
            return {
              value: tuple([L_SET, ...sorted.map((e) => e.result.value)]),
              origin: own(x, P, sorted.map((e) => e.result.origin)),
            };
          },
        );
      }
      case "compound": {
        const labelNode = at(1);
        let label: Uint8Array;
        if (labelNode.type === STRING) {
          label = labelNode.bytes;
        } else {
          const labelPath = atPath(1);
          if (labelNode.type !== ARRAY || labelNode.items.length !== 2) {
            refuse("invalid_tag", labelNode, labelPath, "a compound label is a string or [\"bytes\", base64]");
          }
          const [name, data] = (labelNode as JArray).items as [JNode, JNode];
          if (name.type !== STRING || textOf(name) !== "bytes") {
            refuse("invalid_tag", name, extend(labelPath, 0), "a label array starts with \"bytes\"");
          }
          if (data.type !== STRING) refuse("invalid_tag", data, extend(labelPath, 1), "a label array's base64 is a string");
          const decoded = decodeBase64((data as JString).bytes);
          if (decoded === null) refuse("invalid_base64", data, extend(labelPath, 1), "a label's base64 is canonical padded standard base64");
          label = decoded!;
        }
        const args = wantArray(2);
        const argsPath = atPath(2);
        check(x, P, d + 1, 1 + args.items.length, -1);
        checkAtoms(x, P, label.length);
        const children = args.items.map((node, i): Task => ({ node, depth: d + 1, path: extend(argsPath, i) }));
        const labelAtom = atom(label);
        return new Frame(children, null, (results) => ({
          value: tuple([labelAtom, ...results.map((r) => r.value)]),
          origin: own(x, P, results.map((r) => r.origin)),
        }));
      }
      case "raw":
        // The total form of the whole subtree, at this node's value depth (§4.4).
        return interpretTotal(at(1), d, atPath(1), limits, profile, withOrigins);
    }
    throw new Error(`ontos-json: unhandled tag ${tag}`);
  }

  const stack: Frame[] = [];
  let pending: Interpreted | Frame = visit({ node: root, depth: 0, path: null });
  for (;;) {
    if (pending instanceof Frame) {
      stack.push(pending);
    } else {
      const top = stack[stack.length - 1];
      if (top === undefined) return pending;
      top.results.push(pending);
      top.afterChild?.(top.results.length - 1, pending);
    }
    const top = stack[stack.length - 1]!;
    if (top.results.length < top.children.length) {
      pending = visit(top.children[top.results.length]!);
    } else {
      stack.pop();
      pending = top.finish(top.results);
    }
  }
}

// --- origins (§10.2) ---------------------------------------------------------------------------

class OriginsTree implements Origins {
  readonly #root: OriginNode;
  #size = -1;

  constructor(root: OriginNode) {
    this.#root = root;
  }

  at(valuePath: readonly number[]): Origin | undefined {
    let node: OriginNode | undefined = this.#root;
    for (const index of valuePath) {
      node = Number.isInteger(index) && index >= 0 ? node.children[index] : undefined;
      if (node === undefined) return undefined;
    }
    return originOf(node);
  }

  *entries(): IterableIterator<[number[], Origin]> {
    // Pre-order with an explicit stack: each entry holds a node and its value path.
    const stack: [OriginNode, number[]][] = [[this.#root, []]];
    while (stack.length > 0) {
      const [node, path] = stack.pop()!;
      yield [path, originOf(node)];
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push([node.children[i]!, [...path, i]]);
    }
  }

  [Symbol.iterator](): IterableIterator<[number[], Origin]> {
    return this.entries();
  }

  get size(): number {
    if (this.#size < 0) {
      let count = 0;
      const stack = [this.#root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        count += 1;
        for (const child of node.children) stack.push(child);
      }
      this.#size = count;
    }
    return this.#size;
  }
}

function originOf(node: OriginNode): Origin {
  return Object.freeze({
    path: Object.freeze(pathArray(node.path)),
    span: Object.freeze({ start: node.start, end: node.end }),
  });
}

// --- writing (§2, §5, §9) -----------------------------------------------------------------------

/** One step of the writer: a value to spell, a value in total form (raw), literal text, or a bracket. */
type Work =
  | { readonly k: "value"; readonly v: Value; readonly d: number; readonly path: PathLink | null }
  | { readonly k: "total"; readonly v: Value; readonly d: number; readonly path: PathLink | null }
  | { readonly k: "text"; readonly text: string | Uint8Array; readonly path: PathLink | null }
  | { readonly k: "open"; readonly bracket: number; readonly path: PathLink | null }
  | { readonly k: "close"; readonly bracket: number; readonly path: PathLink | null };

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const ESCAPES: readonly string[] = (() => {
  const table: string[] = [];
  for (let c = 0; c < 0x20; c += 1) table.push("\\u00" + c.toString(16).padStart(2, "0"));
  table[0x08] = "\\b";
  table[0x09] = "\\t";
  table[0x0a] = "\\n";
  table[0x0c] = "\\f";
  table[0x0d] = "\\r";
  table[0x22] = '\\"';
  table[0x5c] = "\\\\";
  return table;
})();

/** The JSON string of well-formed UTF-8 `bytes`, escaped exactly as §5 states, as UTF-8. */
function jsonString(bytes: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const escape = ESCAPES[bytes[i]!];
    if (escape !== undefined) extra += escape.length - 1;
  }
  const out = new Uint8Array(bytes.length + extra + 2);
  let o = 0;
  out[o++] = 0x22;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    const escape = ESCAPES[b];
    if (escape === undefined) out[o++] = b;
    else for (let j = 0; j < escape.length; j += 1) out[o++] = escape.charCodeAt(j);
  }
  out[o] = 0x22;
  return out;
}

/** Whether a data recognizer accepts `v` (ontos-data §5); recognition is partial, so a DataError is "no". */
function recognized(recognize: () => unknown): boolean {
  try {
    recognize();
    return true;
  } catch (error) {
    if (error instanceof DataError) return false;
    throw error;
  }
}

/** The sign and magnitude of a canonical int's payload. */
function intParts(v: Tuple): { negative: boolean; magnitude: Uint8Array; payloadLength: number } {
  const payload = (v.at(1) as Atom).bytes();
  return { negative: payload[0] === 1, magnitude: payload.subarray(1), payloadLength: payload.length };
}

const LOG10_256 = 8 * Math.log10(2);

/**
 * The decimal digits of a magnitude, and its decimal text when the count is within
 * `maxDigits`. A magnitude whose least possible digit count already exceeds the bound is
 * not converted at all.
 */
function decimalOf(magnitude: Uint8Array, maxDigits: number): { digits: number; text: string } {
  if (magnitude.length === 0) return { digits: 1, text: "0" };
  // magnitude ≥ 256^(L−1), so it has at least ⌊(L−1)·log10 256⌋ + 1 digits.
  const atLeast = Math.floor((magnitude.length - 1) * LOG10_256 - 1e-9) + 1;
  if (atLeast > maxDigits) return { digits: atLeast, text: "" };
  if (magnitude.length <= 6) {
    // Below 2^48, a double holds the integer exactly.
    let n = 0;
    for (const b of magnitude) n = n * 256 + b;
    const text = String(n);
    return { digits: text.length, text };
  }
  let hex = "";
  for (const b of magnitude) hex += (b < 16 ? "0" : "") + b.toString(16);
  const text = BigInt("0x" + hex).toString(10);
  return { digits: text.length, text };
}

/** Whether a canonical int's magnitude lies within the window, so it is spelled as a bare literal. */
function magnitudeInWindow(magnitude: Uint8Array): boolean {
  if (magnitude.length > 7) return false;
  // A double is exact up to 2^53 − 1, and any larger integer rounds to at least 2^53.
  let n = 0;
  for (const b of magnitude) n = n * 256 + b;
  return n <= Number.MAX_SAFE_INTEGER;
}

/** The writer's view of a value: which spelling §2.3 chooses. */
function write(out: Output, root: Value, limits: ResolvedLimits): void {
  const refuse = (kind: LimitKind, path: PathLink | null): never => out.refuse(kind, path);
  /** The contribution of the node about to be written, as the reader would check it (§9). */
  const check = (path: PathLink | null, deepest: number, arity: number, digits: number, longestAtom: number): void => {
    const kind = firstExceeded(limits, deepest, arity, digits);
    if (kind !== undefined) refuse(kind, path);
    if (longestAtom > limits.maxAtomBytes) refuse("atom_bytes", path);
  };

  const work: Work[] = [{ k: "value", v: root, d: 0, path: null }];
  /** Queues `items` in order: the caller pushes the closing steps first, since the stack runs last-in first-out. */
  const queue = (items: Work[]): void => {
    for (let i = items.length - 1; i >= 0; i -= 1) work.push(items[i]!);
  };
  /** The children of an array at `path`, separated by commas, as value steps at depth `d`. */
  const elements = (values: readonly Value[], d: number, path: PathLink | null): Work[] => {
    const steps: Work[] = [];
    values.forEach((v, i) => {
      if (i > 0) steps.push({ k: "text", text: ",", path });
      steps.push({ k: "value", v, d, path: extend(path, i) });
    });
    return steps;
  };
  /** Opens `{"$ontos":["<tag>"` for a node at `path`; returns the tag array's path. */
  const openEnvelope = (tag: string, path: PathLink | null): PathLink => {
    out.open(OPEN_BRACE, path);
    out.ascii('"$ontos":', path);
    const tagPath = extend(path, "$ontos");
    out.open(OPEN_BRACKET, tagPath);
    out.ascii(`"${tag}"`, tagPath);
    return tagPath;
  };
  const closeEnvelope = (tagPath: PathLink, path: PathLink | null): Work[] => [
    { k: "close", bracket: CLOSE_BRACKET, path: tagPath },
    { k: "close", bracket: CLOSE_BRACE, path },
  ];

  while (work.length > 0) {
    const step = work.pop()!;
    if (step.k === "text") {
      if (typeof step.text === "string") out.ascii(step.text, step.path);
      else out.bytes(step.text, step.path);
      continue;
    }
    if (step.k === "open") {
      out.open(step.bracket, step.path);
      continue;
    }
    if (step.k === "close") {
      out.close(step.bracket, step.path);
      continue;
    }
    if (step.k === "total") {
      writeTotal(out, step.v, step.d, step.path, limits);
      continue;
    }
    const { v, d, path } = step;

    // 2. Atoms: the bytes tag.
    if (v instanceof Atom) {
      check(path, d, -1, -1, v.length);
      const tagPath = openEnvelope("bytes", path);
      out.ascii(`,"${encodeBase64(v.bytes())}"`, tagPath);
      out.close(CLOSE_BRACKET, tagPath);
      out.close(CLOSE_BRACE, path);
      continue;
    }
    if (!(v instanceof Tuple)) throw new TypeError("ontos-json: expected an ontos Value");
    const items = v.items();
    const head = items[0];

    // 4. Tuple() and tuples whose first child is a tuple: the raw tag.
    if (!(head instanceof Atom)) {
      const tagPath = openEnvelope("raw", path);
      out.ascii(",", tagPath);
      queue([{ k: "total", v, d, path: extend(tagPath, 1) }, ...closeEnvelope(tagPath, path)]);
      continue;
    }

    // 1. The eight ontos/data kinds, by their canonical forms.
    const label = head.bytes();
    const name = label.length <= 9 ? bytesKey(label) : "";
    if (name === "null" && recognized(() => recognizeNull(v))) {
      check(path, d + 1, 1, -1, 4);
      out.ascii("null", path);
      continue;
    }
    if (name === "bool") {
      let flag = false;
      if (recognized(() => (flag = readBool(v)))) {
        check(path, d + 1, 2, -1, 4);
        out.ascii(flag ? "true" : "false", path);
        continue;
      }
    }
    const text = name === "utf8-text" ? textPayload(v) : undefined;
    if (text !== undefined) {
      const payload = text;
      check(path, d + 1, 2, -1, Math.max(9, payload.length));
      out.bytes(jsonString(payload), path);
      continue;
    }
    if (name === "int" && recognized(() => recognizeInt(v))) {
      const { negative, magnitude, payloadLength } = intParts(v);
      const kind = firstExceeded(limits, d + 1, 2, -1);
      if (kind !== undefined) refuse(kind, path);
      const { digits, text } = decimalOf(magnitude, limits.maxIntegerDigits);
      check(path, d + 1, 2, digits, Math.max(3, payloadLength));
      const decimal = (negative ? "-" : "") + text;
      if (magnitudeInWindow(magnitude)) {
        out.ascii(decimal, path);
      } else {
        const tagPath = openEnvelope("int", path);
        out.ascii(`,"${decimal}"`, tagPath);
        out.close(CLOSE_BRACKET, tagPath);
        out.close(CLOSE_BRACE, path);
      }
      continue;
    }
    if (name === "list" && recognized(() => readList(v))) {
      check(path, d + 1, 1 + items.length - 1, -1, 4);
      out.open(OPEN_BRACKET, path);
      queue([...elements(items.slice(1), d + 1, path), { k: "close", bracket: CLOSE_BRACKET, path }]);
      continue;
    }
    if (name === "map") {
      let entries: [Value, Value][] = [];
      if (recognized(() => (entries = readMap(v)))) {
        const m = entries.length;
        const arity = m > 0 ? Math.max(1 + m, 2) : 1;
        // Text keys other than $ontos: an object, members in codec order (the map's own order).
        const keys: Uint8Array[] = [];
        for (const [key] of entries) {
          const bytes = textPayload(key);
          if (bytes === undefined || (bytes.length === 6 && bytesKey(bytes) === "$ontos")) break;
          keys.push(bytes);
        }
        if (keys.length === m) {
          let longest = 3;
          if (m > 0) for (const key of keys) longest = Math.max(longest, 9, key.length);
          check(path, m > 0 ? d + 3 : d + 1, arity, -1, longest);
          out.open(OPEN_BRACE, path);
          const steps: Work[] = [];
          entries.forEach(([, value], i) => {
            const key = keys[i]!;
            if (i > 0) steps.push({ k: "text", text: ",", path });
            steps.push({ k: "text", text: jsonString(key), path });
            steps.push({ k: "text", text: ":", path });
            steps.push({ k: "value", v: value, d: d + 2, path: extend(path, key) });
          });
          queue([...steps, { k: "close", bracket: CLOSE_BRACE, path }]);
        } else {
          check(path, d + 1, arity, -1, 3);
          const tagPath = openEnvelope("map", path);
          out.ascii(",", tagPath);
          const entriesPath = extend(tagPath, 1);
          out.open(OPEN_BRACKET, entriesPath);
          const steps: Work[] = [];
          entries.forEach(([key, value], j) => {
            const entryPath = extend(entriesPath, j);
            if (j > 0) steps.push({ k: "text", text: ",", path: entriesPath });
            steps.push({ k: "open", bracket: OPEN_BRACKET, path: entryPath });
            steps.push({ k: "value", v: key, d: d + 2, path: extend(entryPath, 0) });
            steps.push({ k: "text", text: ",", path: entryPath });
            steps.push({ k: "value", v: value, d: d + 2, path: extend(entryPath, 1) });
            steps.push({ k: "close", bracket: CLOSE_BRACKET, path: entryPath });
          });
          queue([
            ...steps,
            { k: "close", bracket: CLOSE_BRACKET, path: entriesPath },
            ...closeEnvelope(tagPath, path),
          ]);
        }
        continue;
      }
    }
    if (name === "set" && recognized(() => readSet(v))) {
      check(path, d + 1, items.length, -1, 3);
      const tagPath = openEnvelope("set", path);
      out.ascii(",", tagPath);
      const elementsPath = extend(tagPath, 1);
      out.open(OPEN_BRACKET, elementsPath);
      queue([
        ...elements(items.slice(1), d + 1, elementsPath),
        { k: "close", bracket: CLOSE_BRACKET, path: elementsPath },
        ...closeEnvelope(tagPath, path),
      ]);
      continue;
    }
    if (name === "decimal" && recognized(() => recognizeDecimal(v))) {
      const m = intParts(items[1] as Tuple);
      const e = intParts(items[2] as Tuple);
      const kind = firstExceeded(limits, d + 2, 3, -1);
      if (kind !== undefined) refuse(kind, path);
      const md = decimalOf(m.magnitude, limits.maxIntegerDigits);
      const ed = decimalOf(e.magnitude, limits.maxIntegerDigits);
      check(path, d + 2, 3, Math.max(md.digits, ed.digits), Math.max(7, m.payloadLength, e.payloadLength));
      const tagPath = openEnvelope("decimal", path);
      out.ascii(`,"${m.negative ? "-" : ""}${md.text}","${e.negative ? "-" : ""}${ed.text}"`, tagPath);
      out.close(CLOSE_BRACKET, tagPath);
      out.close(CLOSE_BRACE, path);
      continue;
    }

    // 3. Compounds: every other tuple whose first child is an atom.
    check(path, d + 1, items.length, -1, label.length);
    const tagPath = openEnvelope("compound", path);
    out.ascii(",", tagPath);
    if (isUtf8(label)) {
      out.bytes(jsonString(label), tagPath);
    } else {
      const labelPath = extend(tagPath, 1);
      out.open(OPEN_BRACKET, labelPath);
      out.ascii(`"bytes","${encodeBase64(label)}"`, labelPath);
      out.close(CLOSE_BRACKET, labelPath);
    }
    out.ascii(",", tagPath);
    const argsPath = extend(tagPath, 2);
    out.open(OPEN_BRACKET, argsPath);
    queue([
      ...elements(items.slice(1), d + 1, argsPath),
      { k: "close", bracket: CLOSE_BRACKET, path: argsPath },
      ...closeEnvelope(tagPath, path),
    ]);
  }
}
