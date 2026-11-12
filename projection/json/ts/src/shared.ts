/*
 * What both JSON profiles share: the limits record, the refusal (ProjectionError), typed
 * paths, the value-side limit checks of a node's contribution, and the writer's output
 * buffer, which checks max_json_depth and max_text_bytes in the order of the bytes it emits.
 *
 * Internal to @bitspark/ontos-json: the entry points ./total and ./readable re-export what
 * a caller needs. See docs/spec/ontos-total-json.md §8–§10 and ontos-readable-json.md §8–§10.
 */

export const TOTAL_PROFILE = "ontos-total-json/1";
export const READABLE_PROFILE = "ontos-readable-json/1";

/** A profile id (total §1, readable §1). */
export type Profile = typeof TOTAL_PROFILE | typeof READABLE_PROFILE;

/**
 * One segment of a typed path (total §8.2): a member name, as its decoded string, for a
 * step into an object, and an index, a non-negative integer, for a step into an array. A
 * member named "0" is the string "0", never the number 0.
 */
export type PathSegment = string | number;

/** A zero-based, half-open span of UTF-8 bytes of the input (total §8.3). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** The refusal codes of both profiles (total §8.4, readable §8). */
export type ProjectionErrorCode =
  | "limit_exceeded"
  | "invalid_utf8"
  | "byte_order_mark"
  | "invalid_json"
  | "invalid_unicode_escape"
  | "duplicate_member"
  | "trailing_data"
  | "invalid_total_form"
  | "invalid_hex"
  | "invalid_number"
  | "unsafe_integer_literal"
  | "invalid_envelope"
  | "unknown_tag"
  | "invalid_tag"
  | "invalid_integer"
  | "noncanonical_decimal"
  | "invalid_base64"
  | "duplicate_map_key"
  | "duplicate_set_element";

/**
 * The limit kinds (total §9.1, readable §9). `decode_depth`, `atom_bytes` and
 * `tuple_arity` are the codec's (ontos-codec §4.2); the others are the projection's.
 */
export type LimitKind =
  | "text_bytes"
  | "json_depth"
  | "decode_depth"
  | "atom_bytes"
  | "tuple_arity"
  | "integer_digits";

/**
 * The refusal of a reader or a writer (total §8.1, §10). `profile`, `code`, `path`, `span`
 * and `kind` are normative; `message` is not, and nobody may parse it.
 *
 * - `span` is present on every reader refusal and absent on a writer refusal, which has no
 *   input text (total §9.3).
 * - `kind` is present exactly when `code` is `limit_exceeded`.
 * - A writer refusal's `path` is informative: the path, in the output, of the JSON node
 *   being written.
 */
export class ProjectionError extends Error {
  readonly profile: Profile;
  readonly code: ProjectionErrorCode;
  readonly path: readonly PathSegment[];
  declare readonly span?: Span;
  declare readonly kind?: LimitKind;

  constructor(
    profile: Profile,
    code: ProjectionErrorCode,
    path: readonly PathSegment[],
    span: Span | undefined,
    message: string,
    kind?: LimitKind,
  ) {
    super(message);
    this.name = "ProjectionError";
    this.profile = profile;
    this.code = code;
    this.path = Object.freeze(Array.from(path));
    if (span !== undefined) this.span = Object.freeze({ start: span.start, end: span.end });
    if (kind !== undefined) this.kind = kind;
  }
}

/**
 * The bounds of total §9.1 and readable §9, in one record shared by both profiles.
 *
 * Every bound is a non-negative safe integer or `Infinity` (unbounded). `maxJsonDepth` has
 * a third setting, **derived**, which is a missing field: it is then derived from the
 * effective `maxValueDepth`, `2v + 2` under the total profile and `3v + 4` under the
 * readable one (total §9.2, readable §9). Each profile's `DEFAULT_LIMITS` leaves it out.
 */
export interface Limits {
  /** Bytes of the input (reader) or of the output (writer); kind `text_bytes`. */
  readonly maxTextBytes: number;
  /** Arrays and objects open at once; kind `json_depth`. Missing: derived. */
  readonly maxJsonDepth?: number;
  /** Value depth, the root at 0 (the codec's height); kind `decode_depth`. */
  readonly maxValueDepth: number;
  /** The byte length of any atom; kind `atom_bytes`. */
  readonly maxAtomBytes: number;
  /** The arity of any tuple; kind `tuple_arity`. */
  readonly maxTupleArity: number;
  /** Decimal digits of an integer's magnitude (readable only); kind `integer_digits`. */
  readonly maxIntegerDigits: number;
}

/** Every bound resolved, `maxJsonDepth` included. */
export interface ResolvedLimits {
  readonly maxTextBytes: number;
  readonly maxJsonDepth: number;
  readonly maxValueDepth: number;
  readonly maxAtomBytes: number;
  readonly maxTupleArity: number;
  readonly maxIntegerDigits: number;
}

const LIMIT_FIELDS = [
  "maxTextBytes",
  "maxJsonDepth",
  "maxValueDepth",
  "maxAtomBytes",
  "maxTupleArity",
  "maxIntegerDigits",
] as const;

function checkBound(name: string, value: unknown): number {
  if (typeof value !== "number" || !(value === Infinity || (Number.isSafeInteger(value) && value >= 0))) {
    // A bound the face cannot represent exactly is a caller error, not a refusal (total §10).
    throw new RangeError(
      `ontos-json: limits.${name} must be a non-negative safe integer or Infinity, got ${describe(value)}`,
    );
  }
  return value;
}

/**
 * The effective limits of one call: `defaults` overridden by exactly the fields `partial`
 * gives (total §10). A field given as `undefined` counts as left out. `maxJsonDepth`, when
 * left out, is derived from the effective `maxValueDepth` by `derive`.
 */
export function resolveLimits(
  defaults: Limits,
  partial: Partial<Limits> | undefined,
  derive: (maxValueDepth: number) => number,
): ResolvedLimits {
  if (partial !== undefined && (typeof partial !== "object" || partial === null)) {
    throw new TypeError("ontos-json: limits must be an object");
  }
  const given = (partial ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(`ontos-json: unknown limits field ${JSON.stringify(key)}`);
    }
  }
  const pick = (name: (typeof LIMIT_FIELDS)[number]): number | undefined => {
    const own = given[name];
    if (own !== undefined) return checkBound(name, own);
    const fallback = (defaults as unknown as Record<string, unknown>)[name];
    return fallback === undefined ? undefined : checkBound(name, fallback);
  };
  const maxValueDepth = pick("maxValueDepth")!;
  const explicitJsonDepth = pick("maxJsonDepth");
  return {
    maxTextBytes: pick("maxTextBytes")!,
    maxJsonDepth: explicitJsonDepth ?? (maxValueDepth === Infinity ? Infinity : derive(maxValueDepth)),
    maxValueDepth,
    maxAtomBytes: pick("maxAtomBytes")!,
    maxTupleArity: pick("maxTupleArity")!,
    maxIntegerDigits: pick("maxIntegerDigits")!,
  };
}

function describe(value: unknown): string {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof value
    : String(value);
}

// --- paths -------------------------------------------------------------------------------

/**
 * A path as a linked list from the leaf up, so that a step into a child costs one small
 * object, and the array is built only when a refusal or an origin needs it.
 */
export interface PathLink {
  readonly up: PathLink | null;
  readonly seg: PathSegment;
}

export function extend(up: PathLink | null, seg: PathSegment): PathLink {
  return { up, seg };
}

export function pathArray(link: PathLink | null): PathSegment[] {
  const out: PathSegment[] = [];
  for (let at = link; at !== null; at = at.up) out.push(at.seg);
  return out.reverse();
}

// --- the value-side limit checks of a node's contribution ---------------------------------

/**
 * What a JSON node contributes to the value (readable §4.9, total §4.4): the depth of the
 * deepest value it produces itself, the largest arity among its tuples (-1: none), and the
 * most digits among the integers it carries (-1: none). Its atoms are checked separately,
 * after the integers have been converted.
 */
export function firstExceeded(
  limits: ResolvedLimits,
  deepest: number,
  arity: number,
  digits: number,
): LimitKind | undefined {
  if (deepest > limits.maxValueDepth) return "decode_depth";
  if (arity > limits.maxTupleArity) return "tuple_arity";
  if (digits > limits.maxIntegerDigits) return "integer_digits";
  return undefined;
}

export function limitMessage(kind: LimitKind, limits: ResolvedLimits): string {
  switch (kind) {
    case "text_bytes":
      return `the text is longer than max_text_bytes (${limits.maxTextBytes})`;
    case "json_depth":
      return `more than max_json_depth (${limits.maxJsonDepth}) arrays and objects are open at once`;
    case "decode_depth":
      return `a value lies deeper than max_value_depth (${limits.maxValueDepth})`;
    case "atom_bytes":
      return `an atom is longer than max_atom_bytes (${limits.maxAtomBytes})`;
    case "tuple_arity":
      return `a tuple has more children than max_tuple_arity (${limits.maxTupleArity})`;
    case "integer_digits":
      return `an integer has more digits than max_integer_digits (${limits.maxIntegerDigits})`;
  }
}

// --- the writer's output buffer ------------------------------------------------------------

/**
 * The output of a writer. It counts the bytes and the open brackets as they are emitted:
 * an opening bracket first checks max_json_depth, and the first byte beyond max_text_bytes
 * refuses with `text_bytes` (total §9.3). The caller checks a node's contribution before
 * the node's first byte, so the three checks run in the order the spec fixes.
 */
export class Output {
  #buf = new Uint8Array(256);
  #len = 0;
  #depth = 0;
  readonly #limits: ResolvedLimits;
  readonly #profile: Profile;

  constructor(limits: ResolvedLimits, profile: Profile) {
    this.#limits = limits;
    this.#profile = profile;
  }

  refuse(kind: LimitKind, path: PathLink | null): never {
    throw new ProjectionError(
      this.#profile,
      "limit_exceeded",
      pathArray(path),
      undefined,
      `cannot write: ${limitMessage(kind, this.#limits)}`,
      kind,
    );
  }

  #reserve(count: number, path: PathLink | null): void {
    if (this.#len + count > this.#limits.maxTextBytes) this.refuse("text_bytes", path);
    if (this.#len + count > this.#buf.length) {
      let size = this.#buf.length * 2;
      while (size < this.#len + count) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.#buf.subarray(0, this.#len));
      this.#buf = grown;
    }
  }

  /** ASCII text, one byte per UTF-16 unit. */
  ascii(text: string, path: PathLink | null): void {
    this.#reserve(text.length, path);
    const buf = this.#buf;
    let at = this.#len;
    for (let i = 0; i < text.length; i += 1) buf[at++] = text.charCodeAt(i);
    this.#len = at;
  }

  byte(b: number, path: PathLink | null): void {
    this.#reserve(1, path);
    this.#buf[this.#len++] = b;
  }

  bytes(b: Uint8Array, path: PathLink | null): void {
    this.#reserve(b.length, path);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  /** An opening bracket: max_json_depth, then the byte's count. */
  open(bracket: number, path: PathLink | null): void {
    if (this.#depth + 1 > this.#limits.maxJsonDepth) this.refuse("json_depth", path);
    this.#depth += 1;
    this.byte(bracket, path);
  }

  close(bracket: number, path: PathLink | null): void {
    this.#depth -= 1;
    this.byte(bracket, path);
  }

  result(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

// --- bytes ---------------------------------------------------------------------------------

const HEX = "0123456789abcdef";

export function toLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return out;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const min = Math.min(left.length, right.length);
  for (let i = 0; i < min; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** A string that two equal byte strings, and only they, share: a Map/Set key. */
export function bytesKey(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

const textEncoder = new TextEncoder();
export function utf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}
