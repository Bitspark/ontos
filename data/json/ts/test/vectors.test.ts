/*
 * The cross-impl lock: vectors/data-json.json is the frozen byte-contract for
 * ontos-data-json/1. These tests project each valid doc with `project` and assert the
 * resulting bytes against the locked digests — the inner ontos-codec-v1 digest of the
 * projected value, and the era-2 domain-separated digest of the structural wrap
 * Tuple(Atom(tag), value). Reject cases assert the path-named rejection verbatim.
 * Drift here is a real cross-language conformance break.
 *
 * This mirrors data/json/go/datajson_test.go case-for-case, deliberately: the two
 * faces are peers, so their suites should fail on the same inputs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atom, tuple, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import {
  encodeBool,
  encodeInt,
  encodeList,
  encodeMap,
  encodeNull,
  encodeText,
} from "@bitspark/ontos-data";

import { LimitError, MAX_DEPTH, ProjectionError, era2Preimage, project } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// data/json/ts/test -> repo root is four levels up.
const vectorPath = join(here, "..", "..", "..", "..", "vectors", "data-json.json");

interface RejectExpect {
  path: string;
  reason: string;
}
interface Era2Expect {
  tag: string;
  tagAtomBytesHex: string;
  digest: string;
}
interface VectorCase {
  desc: string;
  value: {
    doc?: unknown;
    docSource?: string;
    corpusKey?: string;
    expect: {
      codecSha256?: string;
      era2?: Era2Expect;
      reject?: RejectExpect;
    };
  };
}

function loadVectors(): { valid: VectorCase[]; reject: VectorCase[] } {
  const vf = JSON.parse(readFileSync(vectorPath, "utf8")) as {
    valid: VectorCase[];
    reject: VectorCase[];
  };
  assert.ok(vf.valid?.length, "empty vector file: no valid cases");
  assert.ok(vf.reject?.length, "empty vector file: no reject cases");
  return vf;
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * `project` takes SOURCE TEXT, while a valid case carries `doc` as a live JSON value,
 * so the doc is re-serialized here. That is lossless only while every integer in the
 * corpus is exactly representable as a JS number — the vector note calls the valid
 * docs "pure int/string/bool/object/array", and today the largest magnitude is 14.
 *
 * This guard makes that a CHECKED precondition rather than an assumption: a future
 * vector carrying an integer past 2^53 fails here loudly, instead of silently
 * projecting a corrupted literal and reporting a digest mismatch that looks like an
 * implementation bug. (The Go peer sidesteps this entirely by reading `doc` as
 * json.RawMessage; TS has no equivalent through JSON.parse.)
 */
function assertLosslessRoundTrip(node: unknown, path: string): void {
  if (typeof node === "number") {
    assert.ok(
      Number.isSafeInteger(node),
      `${path}: vector integer ${node} is not a safe JS integer — this test's ` +
        `JSON.stringify round-trip would corrupt it; read the doc as raw source instead`,
    );
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertLosslessRoundTrip(child, `${path}[${i}]`));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) assertLosslessRoundTrip(v, `${path}.${k}`);
  }
}

test("vectors: valid documents project to the locked digests", () => {
  for (const c of loadVectors().valid) {
    const key = c.value.corpusKey ?? c.desc;
    assertLosslessRoundTrip(c.value.doc, "$");

    const v = project(JSON.stringify(c.value.doc));

    // (b) inner ontos-codec-v1 digest of the projected value.
    assert.equal(
      sha256Hex(encode(v)),
      c.value.expect.codecSha256,
      `${key}: inner codecSha256 mismatch`,
    );

    // (c) era-2 domain-separated digest: SHA-256(encode(Tuple(Atom(tag), value))).
    const era2 = c.value.expect.era2!;
    assert.equal(
      Buffer.from(new TextEncoder().encode(era2.tag)).toString("hex"),
      era2.tagAtomBytesHex,
      `${key}: era-2 tag atom bytes mismatch`,
    );
    const want = era2.digest.replace(/^sha256:/, "");
    assert.equal(sha256Hex(encode(era2Preimage(era2.tag, v))), want, `${key}: era-2 digest mismatch`);
  }
});

test("vectors: reject cases fail path-named with the pinned reason", () => {
  for (const [i, c] of loadVectors().reject.entries()) {
    const key = c.value.corpusKey ?? `reject${i}`;
    const src = c.value.docSource!;
    assert.throws(
      () => project(src),
      (e: unknown) => {
        assert.ok(e instanceof ProjectionError, `${key}: error type ${String(e)}`);
        assert.equal(e.path, c.value.expect.reject!.path, `${key}: reject path`);
        assert.equal(e.reason, c.value.expect.reject!.reason, `${key}: reject reason`);
        return true;
      },
      `${key}: expected rejection for ${src}`,
    );
  }
});

/*
 * Proves each projection arm composes the frozen data primitive rather than
 * re-deriving a byte form: for every input the projected value's codec bytes must
 * equal the bytes of the primitive it is supposed to delegate to. This guards the
 * arms the two-family corpus does not exercise directly (null, bool, negative and big
 * integers, empty containers).
 */
test("arms compose the frozen data primitives byte-for-byte", () => {
  const hex = (v: Value): string => Buffer.from(encode(v)).toString("hex");
  const cases: Array<[name: string, input: string, want: Value]> = [
    ["null", `null`, encodeNull()],
    ["true", `true`, encodeBool(true)],
    ["false", `false`, encodeBool(false)],
    ["text", `"soil"`, encodeText("soil")],
    ["empty-text", `""`, encodeText("")],
    ["zero", `0`, encodeInt(0n)],
    ["negative", `-14`, encodeInt(-14n)],
    [
      "bigint-beyond-int64",
      `170141183460469231731687303715884105728`,
      encodeInt(170141183460469231731687303715884105728n),
    ],
    ["empty-array", `[]`, encodeList([])],
    ["empty-object", `{}`, encodeMap([])],
    [
      "nested",
      `{"b":[true,null],"a":"x"}`,
      encodeMap([
        [encodeText("a"), encodeText("x")],
        [encodeText("b"), encodeList([encodeBool(true), encodeNull()])],
      ]),
    ],
  ];
  for (const [name, input, want] of cases) {
    assert.equal(hex(project(input)), hex(want), `${name}: projected bytes`);
  }
});

/*
 * The reserved decimal arm rejects by literal FORM, not numeric value: 1.0 and 1e3
 * are whole numbers yet reject like 3.14, and the reason is the pinned spec wording.
 * Path threading through arrays/objects is asserted too.
 */
test("reserved decimal arm rejects by literal form, path-named", () => {
  const reason = (lit: string): string =>
    `non-integer number literal ${JSON.stringify(lit)} — fraction/exponent rejected under ` +
    `ontos-data-json/1 (reserved decimal arm ungraduated)`;

  const cases: Array<[name: string, input: string, path: string, lit: string]> = [
    ["fraction", `1.5`, "$", "1.5"],
    ["whole-with-dot", `1.0`, "$", "1.0"],
    ["exponent-lower", `1e3`, "$", "1e3"],
    ["exponent-upper", `2E2`, "$", "2E2"],
    ["in-array", `[1, 2.5]`, "$[1]", "2.5"],
    ["in-object", `{"threshold": 3.14}`, "$.threshold", "3.14"],
  ];
  for (const [name, input, path, lit] of cases) {
    assert.throws(
      () => project(input),
      (e: unknown) => {
        assert.ok(e instanceof ProjectionError, `${name}: error type`);
        assert.equal(e.path, path, `${name}: path`);
        assert.equal(e.reason, reason(lit), `${name}: reason`);
        return true;
      },
      `${name}: expected rejection`,
    );
  }
});

test("project reads exactly one document — trailing data rejected", () => {
  // `01` belongs here, not with the malformed inputs, and the reason is worth stating:
  // JSON forbids a leading zero followed by digits, so the reader takes `0` as a
  // COMPLETE document and `1` becomes trailing data. Verified against the Go peer,
  // which classifies it identically — a divergence here would be a silent parity
  // break, since both faces would still "reject" and only the reason would differ.
  for (const input of [`{} {}`, `1 2`, `true false`, `[] junk`, `01`]) {
    assert.throws(
      () => project(input),
      (e: unknown) => {
        assert.ok(e instanceof ProjectionError, `${input}: error type`);
        assert.equal(e.path, "$");
        assert.equal(e.reason, "trailing data after JSON document");
        return true;
      },
      `${input}: expected trailing-data rejection`,
    );
  }
});

test("empty input is rejected distinctly from malformed input", () => {
  for (const input of ["", "   ", "\n\t "]) {
    assert.throws(
      () => project(input),
      (e: unknown) =>
        e instanceof ProjectionError &&
        e.path === "$" &&
        e.reason === "empty input: expected one JSON document",
      `${JSON.stringify(input)}: expected empty-input rejection`,
    );
  }
});

/*
 * The literal-preserving reader is the reason this package does not call JSON.parse.
 * These cases would all be indistinguishable after JSON.parse, so they are the direct
 * test of that decision rather than of the projection arms.
 */
test("number literals are classified by source form, not by parsed value", () => {
  // Accepted: integer literals, including forms JSON.parse would widen to float.
  assert.doesNotThrow(() => project(`1000`));
  assert.doesNotThrow(() => project(`-0`));
  // Rejected: the same VALUES written in decimal-arm form.
  for (const input of [`1000.0`, `1e3`, `1E3`, `1.0e3`, `-0.0`]) {
    assert.throws(() => project(input), ProjectionError, `${input} must reject`);
  }
  // Arbitrary precision survives: beyond 2^53 the literal is read exactly.
  const big = "9007199254740993"; // 2^53 + 1, not representable as a JS number
  assert.equal(
    Buffer.from(encode(project(big))).toString("hex"),
    Buffer.from(encode(encodeInt(9007199254740993n))).toString("hex"),
    "integer past 2^53 must survive the reader exactly",
  );
});

/*
 * Only the CLASSIFICATION is asserted (root path + the `invalid JSON: ` prefix), not
 * the trailing detail. vectors/data-json.json pins no syntax-error wording, so the
 * two faces are required to agree on WHICH bucket an input falls in, not on the
 * prose (both readers happen to word it `<detail> at offset <n>` since ontos-internal#216, but
 * that stays unpinned). Each input below was checked against the Go peer and lands
 * in this bucket there too.
 */
test("malformed JSON is rejected at the root, not thrown raw", () => {
  for (const input of [`{`, `[1,]`, `{"a":}`, `tru`, `"unterminated`, `+1`, `.5`, `1.`]) {
    assert.throws(
      () => project(input),
      (e: unknown) =>
        e instanceof ProjectionError && e.path === "$" && e.reason.startsWith("invalid JSON: "),
      `${JSON.stringify(input)}: expected root-named invalid-JSON rejection`,
    );
  }
});

test("duplicate object keys collapse last-wins, matching the Go peer", () => {
  const hex = (v: Value): string => Buffer.from(encode(v)).toString("hex");
  assert.equal(
    hex(project(`{"a":1,"a":2}`)),
    hex(encodeMap([[encodeText("a"), encodeInt(2n)]])),
    "last occurrence of a duplicate key wins",
  );
});

/*
 * The ontos-data.md §4.1 fidelity law (ontos-internal#216): a string with no UTF-8 encoding — an
 * unpaired \uXXXX surrogate — is REJECTED path-named with the vector-pinned reason,
 * never silently coerced to U+FFFD (which would succeed with a DIFFERENT admissible
 * datum, invisible to every caller of an identity-digest projection). Cases mirror
 * data/json/go's TestUTF8FidelityReject one-for-one, except the raw-invalid-byte
 * form: that class cannot exist in a JS string and is pinned by Go unit tests.
 */
test("utf-8 fidelity: unpaired surrogates reject path-named with the pinned reason", () => {
  const reason = (unit: number, index: number): string =>
    `unpaired surrogate 0x${unit.toString(16)} at UTF-16 index ${index} — the string has ` +
    `no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ` +
    `ontos-data.md §4.1 fidelity law)`;
  const cases: Array<[name: string, input: string, path: string, want: string]> = [
    ["lone-high-at-root", `"\ud800"`, "$", reason(0xd800, 0)],
    ["lone-low-at-root", `"\udc00"`, "$", reason(0xdc00, 0)],
    ["high-then-high", `"\ud800\ud801"`, "$", reason(0xd800, 0)],
    ["in-object-value", `{"note": "x\udfff"}`, "$.note", reason(0xdfff, 1)],
    ["in-array", `["ok", "\ud800abc"]`, "$[1]", reason(0xd800, 0)],
    // soil- is 5 UTF-16 units, the PAIRED emoji escape combines to one code point
    // of 2 units, the hyphen 1 — so the lone surrogate sits at index 8.
    ["utf16-index-counts-code-units", `"soil-\ud83d\ude00-\ud800"`, "$", reason(0xd800, 8)],
    // A defective KEY rejects at the member path. This face interpolates the lone
    // code unit into the path; the Go peer interpolates its WTF-8 bytes —
    // representation-bound, so the key case is unpinnable in the shared vectors.
    ["in-object-key", `{"a\ud800": 1}`, "$.a\ud800", reason(0xd800, 1)],
  ];
  for (const [name, input, path, want] of cases) {
    assert.throws(
      () => project(input),
      (e: unknown) => {
        assert.ok(e instanceof ProjectionError, `${name}: error type ${String(e)}`);
        assert.equal(e.path, path, `${name}: path`);
        assert.equal(e.reason, want, `${name}: reason`);
        return true;
      },
      `${name}: expected fidelity rejection for ${input}`,
    );
  }

  // The accepting side of the same rule, byte-for-byte: a PAIRED surrogate escape
  // is one code point, and an AUTHENTIC U+FFFD (present in the input) is an
  // ordinary character — neither is a fidelity defect.
  const hex = (v: Value): string => Buffer.from(encode(v)).toString("hex");
  assert.equal(
    hex(project(`"\ud83d\ude00"`)),
    hex(encodeText("\u{1F600}")),
    "paired surrogate escapes combine and accept",
  );
  assert.equal(
    hex(project(`"\ufffd"`)),
    hex(encodeText("�")),
    "authentic U+FFFD accepts",
  );
});

/*
 * The resource-limit posture (ontos-internal#236): the spec's floor (512) must be accepted;
 * above this face's ceiling the reader throws the LIMIT class — a LimitError,
 * deliberately NOT a ProjectionError — fast, instead of escaping as a bare V8
 * RangeError (measured at depth 10k before this bound existed). Mirrors
 * data/json/go's TestDepthLimit.
 */
test("nesting depth: the floor accepts, past the ceiling is the LIMIT class", () => {
  const deep = (n: number): string => "[".repeat(n) + "1" + "]".repeat(n);
  project(deep(512)); // the spec floor
  project(deep(MAX_DEPTH)); // this face's stated ceiling
  // Siblings at one level must NOT accumulate depth.
  project("[" + Array.from({ length: 1000 }, () => "[1]").join(",") + "]");
  for (const n of [MAX_DEPTH + 1, 100_000]) {
    assert.throws(
      () => project(deep(n)),
      (e: unknown) => {
        assert.ok(e instanceof LimitError, `depth ${n}: got ${String(e)}`);
        assert.ok(!(e instanceof ProjectionError), "the limit class must be DISTINCT");
        assert.equal(e.limit, MAX_DEPTH, `depth ${n}: limit`);
        return true;
      },
    );
  }
  // Deep OBJECTS are bounded by the same counter.
  const deepObj = '{"a":'.repeat(MAX_DEPTH + 1) + "1" + "}".repeat(MAX_DEPTH + 1);
  assert.throws(() => project(deepObj), (e: unknown) => e instanceof LimitError);
});
