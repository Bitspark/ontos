/*
 * ontos canonical binary codec — ontos-codec-v1 (frozen).
 *
 *   Atom(bytes)   = 0x00 || uvarint(len(bytes)) || bytes
 *   Tuple(values) = 0x01 || uvarint(arity)      || encode(each child)
 *
 * uvarint is unsigned LEB128 in shortest/canonical form over the u64 domain
 * [0, 2^64 - 1] (ontos-codec.md §3.1 / §4). The decoder rejects unknown tags,
 * trailing bytes, non-canonical uvarints, uvarints outside the u64 domain
 * (uvarint_overflow), and inputs exceeding the configured/native limits
 * (limit_exceeded, whose DecodeError.limitKind names the bound; §4.2).
 *
 * This codec is kept beside the model (it depends on ontos-core, never the
 * reverse). The byte mapping is frozen (any change ships as a new version).
 * Conformance is pinned by vectors/codec.json (codec: ontos-codec-v1).
 *
 * This imports the model from "@bitspark/ontos-core". In the monorepo that name
 * resolves to core/ts via npm workspaces, so the source and the published build
 * carry the identical import (see docs/design/0006-distribution.md).
 */

import { Atom, Tuple, atom, tuple, type BytesLike, type Value, copyBytes, bytesEqual } from "@bitspark/ontos-core";

const TAG_ATOM = 0x00;
const TAG_TUPLE = 0x01;
const DEFAULT_MAX_DEPTH = 1024;

// uvarint integer domain (spec: ontos-codec.md §3.1 / §4): unsigned values in
// [0, 2^64 - 1]. A canonical uvarint is shortest-form and at most 10 bytes.
const MAX_UVARINT_BYTES = 10;
const UVARINT_CEILING = 1n << 64n; // 2^64: exclusive upper bound of the u64 domain.
// A valid u64 above this cannot be materialized as a JS number without precision
// loss, so it is rejected as limit_exceeded (a resource-limit class).
const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);

export interface DecodeOptions {
  readonly maxDepth?: number;
  readonly maxAtomBytes?: number;
  readonly maxTupleArity?: number;
}

/**
 * Rejection categories (ontos-codec.md §4). The five byte-contract codes
 * (`unexpected_eof`, `trailing_bytes`, `unknown_tag`, `non_canonical_uvarint`,
 * `uvarint_overflow`) are normative and pinned by vectors/codec.json.
 * `limit_exceeded` is not: it reports that decoding stopped at an operational
 * bound, says nothing about whether the input is a valid encoding, and carries a
 * `limitKind` naming the bound (§4.2).
 */
export type DecodeErrorCode =
  | "unexpected_eof"
  | "trailing_bytes"
  | "unknown_tag"
  | "non_canonical_uvarint"
  | "uvarint_overflow"
  | "limit_exceeded";

/**
 * The operational bounds a `limit_exceeded` can name (ontos-codec.md §4.2). The
 * vocabulary is append-only: a name never changes meaning, but a later version may
 * add names, which is why {@link DecodeLimitKind} the type is open.
 */
export const DecodeLimitKind = {
  /** The value about to be read is nested deeper than `maxDepth` (the root is depth 0). */
  DecodeDepth: "decode_depth",
  /** A declared atom byte length exceeds `maxAtomBytes`. */
  AtomBytes: "atom_bytes",
  /** A declared tuple arity exceeds `maxTupleArity`. */
  TupleArity: "tuple_arity",
  /** A valid uvarint length or arity exceeds `Number.MAX_SAFE_INTEGER` (2^53 - 1). */
  NativeWidth: "native_width",
} as const;

/**
 * A limit kind. Open on purpose: treat a string outside {@link DecodeLimitKind} as
 * the generic `limit_exceeded`, never as malformed input.
 */
export type DecodeLimitKind = (typeof DecodeLimitKind)[keyof typeof DecodeLimitKind] | (string & {});

export class DecodeError extends Error {
  readonly code: DecodeErrorCode;
  /**
   * The bound that stopped decoding, present only when `code` is
   * `limit_exceeded` (a non-limit error has no `limitKind` property at all). It is
   * observational: it names the check that stopped this decode, and another
   * implementation may name a different bound for the same input (§4.2). An absent
   * or unrecognized kind carries no more than the generic `limit_exceeded`.
   */
  declare readonly limitKind?: DecodeLimitKind;
  constructor(code: DecodeErrorCode, message: string, limitKind?: DecodeLimitKind) {
    super(message);
    this.name = "DecodeError";
    this.code = code;
    if (limitKind !== undefined) this.limitKind = limitKind;
  }
}

export function encode(value: Value): Uint8Array {
  // Two passes over an explicit stack (ontos-internal#343), so depth is never a JS-stack property, and one
  // output buffer (ontos-internal#362), so nothing is allocated per value except Atom#bytes()'s defensive
  // copy. Pass 1 visits the values in pre-order, which is the order they are written, records
  // them, and sums the exact output size from the lengths alone. Pass 2 writes them in that
  // order. The bytes are the ones the per-piece encoder produced, value for value.
  const order: Value[] = [];
  const stack: Value[] = [value];
  let size = 0;
  while (stack.length > 0) {
    const v = stack.pop()!;
    order.push(v);
    if (v instanceof Atom) {
      const n = v.length;
      size += 1 + uvarintLength(n) + n;
    } else {
      const items = v.items();
      size += 1 + uvarintLength(items.length);
      for (let i = items.length - 1; i >= 0; i -= 1) stack.push(items[i]!);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const v of order) {
    if (v instanceof Atom) {
      const b = v.bytes();
      out[at++] = TAG_ATOM;
      at = writeUvarint(out, at, b.length);
      out.set(b, at);
      at += b.length;
    } else {
      out[at++] = TAG_TUPLE;
      at = writeUvarint(out, at, v.length);
    }
  }
  return out;
}

// The shortest-form uvarint of a safe integer, in plain arithmetic: no BigInt (ontos-internal#362). Every
// length and arity this encoder writes is a safe integer, so this covers all of them. Division
// and remainder by 128 are exact for safe integers, which bitwise operators (32-bit) are not.
function uvarintLength(n: number): number {
  let len = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 0x80);
    len += 1;
  }
  return len;
}

function writeUvarint(out: Uint8Array, at: number, n: number): number {
  while (n >= 0x80) {
    out[at++] = (n % 0x80) | 0x80;
    n = Math.floor(n / 0x80);
  }
  out[at++] = n;
  return at;
}

export function decode(input: BytesLike, options: DecodeOptions = {}): Value {
  const bytes = copyBytes(input);
  const state = { pos: 0 };
  const limits = normalizeDecodeOptions(options);
  const value = readValue(bytes, state, 0, limits);
  if (state.pos !== bytes.length) {
    throw new DecodeError("trailing_bytes", `trailing bytes at offset ${state.pos}`);
  }
  return value;
}

export function encodeUvarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`uvarint requires a non-negative safe integer, got ${n}`);
  }
  const out = new Uint8Array(uvarintLength(n));
  writeUvarint(out, 0, n);
  return out;
}

// Shortest-form LEB128 encoding of a bigint in the u64 domain. Shared by the
// public encoder and the decoder's canonicality check so both agree byte-for-byte.
function encodeUvarintBig(value: bigint): Uint8Array {
  if (value < 0n || value >= UVARINT_CEILING) {
    throw new RangeError(`uvarint requires a value in [0, 2^64 - 1], got ${value}`);
  }
  let v = value;
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

// With an explicit stack of open tuples (ontos-internal#343), never one call per level. Each value's header is
// read and checked in the recursive walk's order (depth, then tag, then length or arity, with the
// same errors at the same offsets), and a completed value is handed to its parent, closing every
// tuple it fills.
function readValue(
  bytes: Uint8Array,
  state: { pos: number },
  depth: number,
  limits: Required<DecodeOptions>,
): Value {
  const open: { items: Value[]; arity: number }[] = [];
  for (;;) {
    const level = depth + open.length;
    if (level > limits.maxDepth) {
      throw new DecodeError(
        "limit_exceeded",
        `maximum decode depth exceeded: ${limits.maxDepth}`,
        DecodeLimitKind.DecodeDepth,
      );
    }
    if (state.pos >= bytes.length) {
      throw new DecodeError("unexpected_eof", "unexpected end of input while reading tag");
    }

    const offset = state.pos;
    const tag = bytes[state.pos];
    state.pos += 1;

    let done: Value;
    if (tag === TAG_ATOM) {
      const length = readUvarint(bytes, state);
      if (length > limits.maxAtomBytes) {
        throw new DecodeError(
          "limit_exceeded",
          `atom byte length ${length} exceeds limit ${limits.maxAtomBytes}`,
          DecodeLimitKind.AtomBytes,
        );
      }
      if (state.pos + length > bytes.length) {
        throw new DecodeError("unexpected_eof", "unexpected end of input while reading atom bytes");
      }
      const start = state.pos;
      state.pos += length;
      done = atom(bytes.subarray(start, state.pos));
    } else if (tag === TAG_TUPLE) {
      const arity = readUvarint(bytes, state);
      if (arity > limits.maxTupleArity) {
        throw new DecodeError(
          "limit_exceeded",
          `tuple arity ${arity} exceeds limit ${limits.maxTupleArity}`,
          DecodeLimitKind.TupleArity,
        );
      }
      // Every encoded value is at least two bytes (tag + zero uvarint), so an arity
      // larger than half the remaining bytes is impossible. Guards malformed input.
      const maxPossibleChildren = Math.floor((bytes.length - state.pos) / 2);
      if (arity > maxPossibleChildren) {
        throw new DecodeError("unexpected_eof", "unexpected end of input while reading tuple items");
      }
      if (arity > 0) {
        open.push({ items: [], arity });
        continue;
      }
      done = tuple([]);
    } else {
      throw new DecodeError(
        "unknown_tag",
        `unknown value tag 0x${(tag ?? 0).toString(16).padStart(2, "0")} at offset ${offset}`,
      );
    }

    for (;;) {
      const top = open[open.length - 1];
      if (top === undefined) return done;
      top.items.push(done);
      if (top.items.length < top.arity) break;
      open.pop();
      done = tuple(top.items);
    }
  }
}

function readUvarint(bytes: Uint8Array, state: { pos: number }): number {
  const start = state.pos;
  // Accumulate in bigint so the full u64 domain [0, 2^64 - 1] is representable
  // during decode without precision loss (spec: ontos-codec.md §3.1 / §4).
  let result = 0n;
  let shift = 0n;
  let length = 0;

  while (true) {
    if (state.pos >= bytes.length) {
      throw new DecodeError("unexpected_eof", "unexpected end of input while reading uvarint");
    }
    const byte = bytes[state.pos] ?? 0;
    state.pos += 1;
    length += 1;
    result |= BigInt(byte & 0x7f) << shift;
    // Any decoded value at or above 2^64 is outside the u64 domain. This catches
    // a 10th byte whose high bits push the value past the 64-bit ceiling.
    if (result >= UVARINT_CEILING) {
      throw new DecodeError("uvarint_overflow", `uvarint exceeds the u64 domain at offset ${start}`);
    }
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    // A canonical uvarint is at most 10 bytes; an 11th continuation byte can only
    // encode a value >= 2^64, so it is a u64-domain overflow.
    if (length >= MAX_UVARINT_BYTES) {
      throw new DecodeError("uvarint_overflow", `uvarint exceeds 10 bytes at offset ${start}`);
    }
  }

  const canonical = encodeUvarintBig(result);
  const actual = bytes.subarray(start, state.pos);
  if (!bytesEqual(canonical, actual)) {
    throw new DecodeError("non_canonical_uvarint", `non-canonical uvarint at offset ${start}`);
  }

  // result is a valid u64. If it exceeds this implementation's native
  // materialization width (Number.MAX_SAFE_INTEGER) it is a RESOURCE-LIMIT
  // failure (limit_exceeded), NOT an overflow of the u64 domain.
  if (result > MAX_SAFE_INTEGER_BIG) {
    throw new DecodeError(
      "limit_exceeded",
      `uvarint ${result} exceeds Number.MAX_SAFE_INTEGER at offset ${start}`,
      DecodeLimitKind.NativeWidth,
    );
  }

  // Safe to materialize as a JS number: guarded by the limit check above.
  return Number(result);
}

function normalizeDecodeOptions(options: DecodeOptions): Required<DecodeOptions> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxAtomBytes = options.maxAtomBytes ?? Number.MAX_SAFE_INTEGER;
  const maxTupleArity = options.maxTupleArity ?? Number.MAX_SAFE_INTEGER;
  for (const [name, value] of [
    ["maxDepth", maxDepth],
    ["maxAtomBytes", maxAtomBytes],
    ["maxTupleArity", maxTupleArity],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  return { maxDepth, maxAtomBytes, maxTupleArity };
}

