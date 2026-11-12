/*
 * Stages 1 to 3 of reading, shared by both JSON profiles (ontos-total-json §4.1–§4.3):
 *
 *   1. Size: the input is at most max_text_bytes long.
 *   2. Text: the input is well-formed UTF-8 (Unicode §3.9, Table 3-7), refused at the first
 *      ill-formed offset with the span of the maximal subpart there.
 *   3. JSON: one RFC 8259 text under the strict reading, procedure for procedure as §4.3
 *      states it, building a tree whose nodes carry their spans.
 *
 * Each stage runs to completion before the next begins. Nothing here recurses: arrays and
 * objects are read with an explicit stack, since max_json_depth reaches 3076 under the
 * readable defaults and is unbounded when the caller asks (total §9.2). The input is read
 * as bytes; JSON.parse is never involved.
 */

import {
  ProjectionError,
  extend,
  limitMessage,
  pathArray,
  type PathLink,
  type Profile,
  type ProjectionErrorCode,
  type ResolvedLimits,
} from "./shared.js";

// --- the JSON tree -----------------------------------------------------------------------

export const OBJECT = 0;
export const ARRAY = 1;
export const STRING = 2;
export const NUMBER = 3;
export const TRUE = 4;
export const FALSE = 5;
export const NULL = 6;

/** Every node carries its span: from the opening to the closing bracket or quotation mark, or the lexeme. */
export interface JObject {
  readonly type: typeof OBJECT;
  readonly start: number;
  end: number;
  readonly members: JMember[];
}
export interface JMember {
  /** The decoded name. */
  readonly name: string;
  /** Its UTF-8 bytes. */
  readonly nameBytes: Uint8Array;
  /** The name's token: its opening to its closing quotation mark. */
  readonly nameStart: number;
  readonly nameEnd: number;
  value: JNode;
}
export interface JArray {
  readonly type: typeof ARRAY;
  readonly start: number;
  end: number;
  readonly items: JNode[];
}
export interface JString {
  readonly type: typeof STRING;
  readonly start: number;
  readonly end: number;
  /** The UTF-8 bytes of the decoded content: a sequence of scalar values, by stage 3. */
  readonly bytes: Uint8Array;
}
export interface JNumber {
  readonly type: typeof NUMBER;
  readonly start: number;
  readonly end: number;
  /** The lexeme, ASCII. */
  readonly lexeme: string;
  /** Whether the lexeme has a fraction or an exponent. */
  readonly integral: boolean;
}
export interface JLiteral {
  readonly type: typeof TRUE | typeof FALSE | typeof NULL;
  readonly start: number;
  readonly end: number;
}
export type JNode = JObject | JArray | JString | JNumber | JLiteral;

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** The decoded content of a string node, as a host string (well-formed: stage 3 refuses lone surrogates). */
export function textOf(node: JString): string {
  return decoder.decode(node.bytes);
}

// --- stage 2: UTF-8 ----------------------------------------------------------------------

/**
 * The first ill-formed offset of `b` and the length of the maximal subpart there
 * (total §4.2), or undefined when `b` is well-formed UTF-8.
 */
export function utf8Fault(b: Uint8Array): { at: number; length: number } | undefined {
  const n = b.length;
  let p = 0;
  while (p < n) {
    const c = b[p]!;
    if (c < 0x80) {
      p += 1;
      continue;
    }
    // Table 3-7: the lead byte fixes the sequence length and the range of the second byte.
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c === 0xe0) (need = 2), (lo = 0xa0);
    else if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) need = 2;
    else if (c === 0xed) (need = 2), (hi = 0x9f);
    else if (c === 0xf0) (need = 3), (lo = 0x90);
    else if (c >= 0xf1 && c <= 0xf3) need = 3;
    else if (c === 0xf4) (need = 3), (hi = 0x8f);
    else return { at: p, length: 1 };
    let q = p + 1;
    for (let i = 0; i < need; i += 1, q += 1) {
      const lower = i === 0 ? lo : 0x80;
      const upper = i === 0 ? hi : 0xbf;
      if (q >= n || b[q]! < lower || b[q]! > upper) return { at: p, length: q - p };
    }
    p = q;
  }
  return undefined;
}

/** Whether `b` is well-formed UTF-8. */
export function isUtf8(b: Uint8Array): boolean {
  return utf8Fault(b) === undefined;
}

/** The length of the UTF-8 sequence that the lead byte `c` starts, in well-formed input. */
function charLength(c: number): number {
  return c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
}

// --- stages 1 to 3 -----------------------------------------------------------------------

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isDigit(c: number | undefined): boolean {
  return c !== undefined && c >= 0x30 && c <= 0x39;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** A container being read: its node, its path, and for an object the names seen so far. */
interface Open {
  readonly node: JObject | JArray;
  readonly path: PathLink | null;
  readonly names: Set<string> | null;
}

/**
 * Runs stages 1 to 3 over `b` and returns the JSON tree, or throws the first refusal.
 * The caller owns `b` (a private copy): nothing else may change it while this runs.
 */
export function readJson(b: Uint8Array, limits: ResolvedLimits, profile: Profile): JNode {
  const n = b.length;
  const refuse = (code: ProjectionErrorCode, path: PathLink | null, start: number, end: number, message: string): never => {
    throw new ProjectionError(profile, code, pathArray(path), { start, end }, message);
  };

  // Stage 1: size.
  if (n > limits.maxTextBytes) {
    throw new ProjectionError(
      profile,
      "limit_exceeded",
      [],
      { start: limits.maxTextBytes, end: n },
      limitMessage("text_bytes", limits),
      "text_bytes",
    );
  }

  // Stage 2: the whole input is well-formed UTF-8.
  const fault = utf8Fault(b);
  if (fault !== undefined) {
    refuse("invalid_utf8", null, fault.at, fault.at + fault.length, `ill-formed UTF-8 at byte ${fault.at}`);
  }

  // Stage 3: the strict reading.
  let p = 0;
  // A growable scratch buffer for decoding strings with escapes; never longer than the source.
  let scratch = new Uint8Array(64);

  /** The span of the character at p, or [n, n) at the end. */
  const charEnd = (at: number): number => (at >= n ? n : at + charLength(b[at]!));
  const unexpected = (path: PathLink | null, what: string): never => {
    if (p >= n) refuse("invalid_json", path, n, n, `the text ends where ${what} was required`);
    return refuse("invalid_json", path, p, charEnd(p), `unexpected character at byte ${p}: ${what} was required`);
  };
  const skipWs = (): void => {
    while (p < n && isWs(b[p]!)) p += 1;
  };

  // Text, step 1.
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    refuse("byte_order_mark", null, 0, 3, "the text begins with a byte order mark");
  }

  /** Reads a string at p (on its opening quotation mark); refusals carry `path`. */
  const readString = (path: PathLink | null): JString => {
    const start = p;
    p += 1;
    let len = 0;
    const put = (byte: number): void => {
      if (len === scratch.length) {
        const grown = new Uint8Array(scratch.length * 2);
        grown.set(scratch);
        scratch = grown;
      }
      scratch[len++] = byte;
    };
    const putScalar = (c: number): void => {
      if (c < 0x80) put(c);
      else if (c < 0x800) {
        put(0xc0 | (c >> 6));
        put(0x80 | (c & 0x3f));
      } else if (c < 0x10000) {
        put(0xe0 | (c >> 12));
        put(0x80 | ((c >> 6) & 0x3f));
        put(0x80 | (c & 0x3f));
      } else {
        put(0xf0 | (c >> 18));
        put(0x80 | ((c >> 12) & 0x3f));
        put(0x80 | ((c >> 6) & 0x3f));
        put(0x80 | (c & 0x3f));
      }
    };
    /** Four hex digits at q, or -1 when they are not all there (no refusal). */
    const quad = (q: number): number => {
      if (q + 4 > n) return -1;
      let v = 0;
      for (let i = 0; i < 4; i += 1) {
        const h = hexValue(b[q + i]!);
        if (h < 0) return -1;
        v = (v << 4) | h;
      }
      return v;
    };
    for (;;) {
      if (p >= n) refuse("invalid_json", path, n, n, "the text ends inside a string");
      const c = b[p]!;
      if (c === QUOTE) {
        p += 1;
        break;
      }
      if (c < 0x20) refuse("invalid_json", path, p, p + 1, `unescaped control character in a string at byte ${p}`);
      if (c !== BACKSLASH) {
        const end = p + charLength(c);
        for (; p < end; p += 1) put(b[p]!);
        continue;
      }
      // An escape.
      if (p + 1 >= n) refuse("invalid_json", path, n, n, "the text ends inside an escape");
      const e = b[p + 1]!;
      let simple = -1;
      switch (e) {
        case 0x22: simple = 0x22; break; // \"
        case 0x5c: simple = 0x5c; break; // \\
        case 0x2f: simple = 0x2f; break; // \/
        case 0x62: simple = 0x08; break; // \b
        case 0x66: simple = 0x0c; break; // \f
        case 0x6e: simple = 0x0a; break; // \n
        case 0x72: simple = 0x0d; break; // \r
        case 0x74: simple = 0x09; break; // \t
      }
      if (simple >= 0) {
        put(simple);
        p += 2;
        continue;
      }
      if (e !== 0x75) {
        refuse("invalid_json", path, p, p + 1 + charLength(e), `invalid escape at byte ${p}`);
      }
      // \u and four hexadecimal digits, each checked in turn.
      let code = 0;
      for (let i = 0; i < 4; i += 1) {
        const q = p + 2 + i;
        if (q >= n) refuse("invalid_json", path, n, n, "the text ends inside a \\u escape");
        const h = hexValue(b[q]!);
        if (h < 0) refuse("invalid_json", path, q, charEnd(q), `a \\u escape needs four hexadecimal digits, at byte ${q}`);
        code = (code << 4) | h;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = p + 6 + 1 < n && b[p + 6] === BACKSLASH && b[p + 7] === 0x75 ? quad(p + 8) : -1;
        if (low < 0xdc00 || low > 0xdfff) {
          refuse("invalid_unicode_escape", path, p, p + 6, `a high surrogate escape at byte ${p} is not followed by a low one`);
        }
        putScalar(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
        p += 12;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        refuse("invalid_unicode_escape", path, p, p + 6, `a lone low surrogate escape at byte ${p}`);
      }
      putScalar(code);
      p += 6;
    }
    return { type: STRING, start, end: p, bytes: scratch.slice(0, len) };
  };

  const readLiteral = (path: PathLink | null, word: string, type: JLiteral["type"]): JLiteral => {
    const start = p;
    for (let i = 0; i < word.length; i += 1) {
      if (p >= n || b[p] !== word.charCodeAt(i)) unexpected(path, `the literal ${word}`);
      p += 1;
    }
    return { type, start, end: p };
  };

  const readNumber = (path: PathLink | null): JNumber => {
    const start = p;
    let integral = true;
    if (b[p] === 0x2d) {
      p += 1;
      if (!isDigit(b[p])) unexpected(path, "a digit");
    }
    if (b[p] === 0x30) p += 1;
    else while (isDigit(b[p])) p += 1;
    if (b[p] === 0x2e) {
      integral = false;
      p += 1;
      if (!isDigit(b[p])) unexpected(path, "a digit after the decimal point");
      while (isDigit(b[p])) p += 1;
    }
    if (b[p] === 0x65 || b[p] === 0x45) {
      integral = false;
      p += 1;
      if (b[p] === 0x2b || b[p] === 0x2d) p += 1;
      if (!isDigit(b[p])) unexpected(path, "a digit in the exponent");
      while (isDigit(b[p])) p += 1;
    }
    return { type: NUMBER, start, end: p, lexeme: decoder.decode(b.subarray(start, p)), integral };
  };

  const stack: Open[] = [];
  let path: PathLink | null = null; // the path of the value about to be read
  let root: JNode | undefined;

  // Text, step 2: skip whitespace and read one value at path [] and depth 0.
  skipWs();
  value: for (;;) {
    // A value, at `path`, enclosed by stack.length open arrays and objects.
    let done: JNode;
    if (p >= n) refuse("invalid_json", path, n, n, "the text ends where a value was required");
    const c = b[p]!;
    if (c === 0x7b || c === 0x5b) {
      if (stack.length + 1 > limits.maxJsonDepth) {
        throw new ProjectionError(profile, "limit_exceeded", pathArray(path), { start: p, end: p + 1 },
          limitMessage("json_depth", limits), "json_depth");
      }
      const start = p;
      p += 1;
      skipWs();
      if (c === 0x7b) {
        const node: JObject = { type: OBJECT, start, end: -1, members: [] };
        if (p < n && b[p] === 0x7d) {
          p += 1;
          node.end = p;
          done = node;
        } else {
          const open: Open = { node, path, names: new Set() };
          stack.push(open);
          path = beginMember(open);
          continue value;
        }
      } else {
        const node: JArray = { type: ARRAY, start, end: -1, items: [] };
        if (p < n && b[p] === 0x5d) {
          p += 1;
          node.end = p;
          done = node;
        } else {
          stack.push({ node, path, names: null });
          path = extend(path, 0);
          continue value;
        }
      }
    } else if (c === QUOTE) {
      done = readString(path);
    } else if (c === 0x74) {
      done = readLiteral(path, "true", TRUE);
    } else if (c === 0x66) {
      done = readLiteral(path, "false", FALSE);
    } else if (c === 0x6e) {
      done = readLiteral(path, "null", NULL);
    } else if (c === 0x2d || isDigit(c)) {
      done = readNumber(path);
    } else {
      refuse("invalid_json", path, p, charEnd(p), `unexpected character at byte ${p}: a value was required`);
    }

    // Hand the finished value to the open containers, closing each one it completes.
    for (;;) {
      const open = stack[stack.length - 1];
      if (open === undefined) {
        root = done!;
        break value;
      }
      skipWs();
      if (open.node.type === ARRAY) {
        const node = open.node;
        node.items.push(done!);
        if (p < n && b[p] === 0x2c) {
          p += 1;
          skipWs();
          path = extend(open.path, node.items.length);
          continue value;
        }
        if (p < n && b[p] === 0x5d) {
          p += 1;
          node.end = p;
          stack.pop();
          path = open.path;
          done = node;
          continue;
        }
        unexpected(open.path, "',' or ']'");
      } else {
        const node = open.node;
        node.members[node.members.length - 1]!.value = done!;
        if (p < n && b[p] === 0x2c) {
          p += 1;
          skipWs();
          path = beginMember(open);
          continue value;
        }
        if (p < n && b[p] === 0x7d) {
          p += 1;
          node.end = p;
          stack.pop();
          path = open.path;
          done = node;
          continue;
        }
        unexpected(open.path, "',' or '}'");
      }
    }
  }

  // Text, step 3.
  skipWs();
  if (p < n) refuse("trailing_data", null, p, n, `trailing data after the value, at byte ${p}`);
  return root!;

  /**
   * Steps 1 to 4 of a member, up to its value: the name, the duplicate check, the colon.
   * Returns the path of the member's value.
   */
  function beginMember(open: Open): PathLink {
    const object = open.node as JObject;
    if (p >= n || b[p] !== QUOTE) unexpected(open.path, "a member name");
    const token = readString(open.path);
    const name = textOf(token);
    const memberPath = extend(open.path, name);
    if (open.names!.has(name)) {
      refuse("duplicate_member", memberPath, token.start, token.end, `repeated member name ${JSON.stringify(name)}`);
    }
    open.names!.add(name);
    skipWs();
    if (p >= n || b[p] !== 0x3a) unexpected(memberPath, "':'");
    p += 1;
    skipWs();
    object.members.push({ name, nameBytes: token.bytes, nameStart: token.start, nameEnd: token.end, value: PLACEHOLDER });
    return memberPath;
  }
}

const PLACEHOLDER: JLiteral = { type: NULL, start: -1, end: -1 };

