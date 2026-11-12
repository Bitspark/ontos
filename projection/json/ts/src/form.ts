/*
 * The total form's interpreter and writer (ontos-total-json §4.4, §5, §9.3), shared by the
 * total profile and the readable profile's raw arm (ontos-readable-json §4.4). Internal to
 * @bitspark/ontos-json. Neither function recurses on the host stack.
 */

import { Atom, Tuple, atom, tuple, type Value } from "@bitspark/ontos-core";

import { OBJECT, STRING, ARRAY, type JNode, type JObject } from "./lexer.js";
import {
  Output,
  ProjectionError,
  extend,
  limitMessage,
  pathArray,
  toLowerHex,
  type LimitKind,
  type PathLink,
  type Profile,
  type ResolvedLimits,
} from "./shared.js";

/** One node of the origins tree: where a value node came from, and its children's origins. */
export interface OriginNode {
  readonly path: PathLink | null;
  readonly start: number;
  readonly end: number;
  readonly children: OriginNode[];
}

/** A finished subtree, with its origins when they are asked for. */
export interface Interpreted {
  readonly value: Value;
  readonly origin: OriginNode | null;
}

/**
 * The generalized UTF-8 encoding of a host string: well-formed UTF-8 for its scalar values,
 * and `ED A0–BF 80–BF` for each lone surrogate (total §10).
 */
export function generalizedUtf8(input: string): Uint8Array {
  if (typeof input !== "string") throw new TypeError("ontos-json: expected a string");
  const out = new Uint8Array(input.length * 3);
  let at = 0;
  for (let i = 0; i < input.length; i += 1) {
    let c = input.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const d = input.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out[at++] = c;
    else if (c < 0x800) {
      out[at++] = 0xc0 | (c >> 6);
      out[at++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[at++] = 0xe0 | (c >> 12);
      out[at++] = 0x80 | ((c >> 6) & 0x3f);
      out[at++] = 0x80 | (c & 0x3f);
    } else {
      out[at++] = 0xf0 | (c >> 18);
      out[at++] = 0x80 | ((c >> 12) & 0x3f);
      out[at++] = 0x80 | ((c >> 6) & 0x3f);
      out[at++] = 0x80 | (c & 0x3f);
    }
  }
  return out.slice(0, at);
}

/** A total-form tuple whose elements are being interpreted. */
interface TupleFrame {
  readonly node: JObject;
  readonly path: PathLink | null;
  readonly depth: number;
  readonly elements: JNode[];
  readonly values: Value[];
  readonly origins: OriginNode[] | null;
}

/**
 * Interprets `root` as a total-form value at value depth `depth` and path `path` (§4.4),
 * in pre-order, with an explicit stack. With `withOrigins`, every total-form object is the
 * origin of the atom or tuple it spells (readable §10.2, the raw arm).
 */
export function interpretTotal(
  root: JNode,
  depth: number,
  path: PathLink | null,
  limits: ResolvedLimits,
  profile: Profile,
  withOrigins: true | null,
): Interpreted {
  type Refuse = (node: JNode, nodePath: PathLink | null, code: "invalid_total_form" | "invalid_hex", message: string) => never;
  const at: Refuse = (node, nodePath, code, message) => {
    throw new ProjectionError(profile, code, pathArray(nodePath), { start: node.start, end: node.end }, message);
  };
  const limit: (node: JNode, nodePath: PathLink | null, kind: LimitKind) => never = (node, nodePath, kind) => {
    throw new ProjectionError(profile, "limit_exceeded", pathArray(nodePath), { start: node.start, end: node.end },
      limitMessage(kind, limits), kind);
  };

  const stack: TupleFrame[] = [];
  let node = root;
  let nodePath = path;
  let d = depth;
  for (;;) {
    // Interpret `node`: either an atom (a finished subtree) or a tuple (a new frame).
    let done: Interpreted | undefined;
    if (node.type !== OBJECT) at(node, nodePath, "invalid_total_form", "a total-form value is an object");
    const object = node as JObject;
    if (object.members.length !== 1) {
      at(node, nodePath, "invalid_total_form", "a total-form object has exactly one member, atom or tuple");
    }
    const member = object.members[0]!;
    const y = member.value;
    const yPath = extend(nodePath, member.name);
    if (member.name === "atom") {
      if (y.type !== STRING) at(y, yPath, "invalid_total_form", "an atom's member value is a string");
      const hex = y.bytes;
      if (hex.length % 2 !== 0) at(y, yPath, "invalid_hex", "atom hex has an odd number of digits");
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 1) {
        const c = hex[i]!;
        const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
        if (v < 0) at(y, yPath, "invalid_hex", "atom hex is lowercase 0-9 a-f only");
        if (i % 2 === 0) bytes[i >> 1] = v << 4;
        else bytes[i >> 1]! |= v;
      }
      if (d > limits.maxValueDepth) limit(node, nodePath, "decode_depth");
      if (bytes.length > limits.maxAtomBytes) limit(node, nodePath, "atom_bytes");
      done = {
        value: atom(bytes),
        origin: withOrigins && { path: nodePath, start: node.start, end: node.end, children: [] },
      };
    } else if (member.name === "tuple") {
      if (y.type !== ARRAY) at(y, yPath, "invalid_total_form", "a tuple's member value is an array");
      if (d > limits.maxValueDepth) limit(node, nodePath, "decode_depth");
      if (y.items.length > limits.maxTupleArity) limit(node, nodePath, "tuple_arity");
      stack.push({ node: object, path: nodePath, depth: d, elements: y.items, values: [], origins: withOrigins && [] });
    } else {
      at(node, nodePath, "invalid_total_form", "a total-form object's member is atom or tuple");
    }

    // Hand finished subtrees up, closing each tuple whose elements are all done; descend
    // into the next element otherwise.
    for (;;) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) return done!;
      if (done !== undefined) {
        frame.values.push(done.value);
        frame.origins?.push(done.origin!);
        done = undefined;
      }
      const i = frame.values.length;
      if (i < frame.elements.length) {
        node = frame.elements[i]!;
        nodePath = extend(extend(frame.path, "tuple"), i);
        d = frame.depth + 1;
        break;
      }
      stack.pop();
      done = {
        value: tuple(frame.values),
        origin: frame.origins && { path: frame.path, start: frame.node.start, end: frame.node.end, children: frame.origins },
      };
    }
  }
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/**
 * Writes `value` in total form at value depth `depth` and output path `path` (§5), checking
 * the limits as the reader would (§9.3): before each node's first byte its contribution
 * (`decode_depth`, `tuple_arity`, `atom_bytes`), then each opening bracket's depth, then
 * each byte's count. Shared with the readable profile's raw arm.
 */
export function writeTotal(out: Output, value: Value, depth: number, path: PathLink | null, limits: ResolvedLimits): void {
  // An explicit stack of the tuples being written: their children and the next index.
  const stack: { items: readonly Value[]; next: number; depth: number; path: PathLink | null }[] = [];
  let v: Value | undefined = value;
  let d = depth;
  let p = path;
  for (;;) {
    if (v !== undefined) {
      if (d > limits.maxValueDepth) out.refuse("decode_depth", p);
      if (v instanceof Atom) {
        if (v.length > limits.maxAtomBytes) out.refuse("atom_bytes", p);
        out.open(OPEN_BRACE, p);
        out.ascii('"atom":"', p);
        out.ascii(toLowerHex(v.bytes()), p);
        out.ascii('"', p);
        out.close(CLOSE_BRACE, p);
      } else if (v instanceof Tuple) {
        if (v.length > limits.maxTupleArity) out.refuse("tuple_arity", p);
        out.open(OPEN_BRACE, p);
        out.ascii('"tuple":', p);
        out.open(OPEN_BRACKET, extend(p, "tuple"));
        stack.push({ items: v.items(), next: 0, depth: d, path: p });
      } else {
        throw new TypeError("ontos-json: expected an ontos Value");
      }
      v = undefined;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) return;
    const arrayPath = extend(frame.path, "tuple");
    if (frame.next < frame.items.length) {
      if (frame.next > 0) out.ascii(",", arrayPath);
      v = frame.items[frame.next]!;
      p = extend(arrayPath, frame.next);
      d = frame.depth + 1;
      frame.next += 1;
      continue;
    }
    out.close(CLOSE_BRACKET, arrayPath);
    out.close(CLOSE_BRACE, frame.path);
    stack.pop();
  }
}
