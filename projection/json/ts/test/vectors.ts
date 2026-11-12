/*
 * Replays projection/json/vectors/{total,readable}.json against one profile's entry point,
 * case by case, as the vectors README's "How a face replays a case" states:
 *
 *   1. a refused input refuses with exactly that code, path, span and kind;
 *   2. an accepted input reads to a value with exactly those codec bytes, and with exactly
 *      those origins where the case pins them;
 *   3. the value writes exactly that output, or refuses with that code and kind;
 *   4. the laws: the output reads back to the value, which writes the output again.
 *
 * Every case with a UTF-8 `input` is also read through the host-string reader, which must
 * agree with the byte reader exactly. Each case's fields are checked independently.
 *
 * ONTOS_JSON_PROJECTION_VECTORS names another directory of total.json and readable.json in the
 * same format, which is how scripts/check.sh fuzz replays a fresh generated corpus.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode } from "@bitspark/ontos-codec";
import type { Value } from "@bitspark/ontos-core";

const here = dirname(fileURLToPath(import.meta.url));
// projection/json/ts/test -> projection/json/vectors, or the directory that
// ONTOS_JSON_PROJECTION_VECTORS names: how scripts/check.sh fuzz replays a generated corpus
// (tools/json-projection/README.md).
const vectorsDir = process.env.ONTOS_JSON_PROJECTION_VECTORS || join(here, "..", "..", "vectors");

type Runs<T> = T | { runs: [T extends string ? string : unknown[], number][] };

interface Case {
  name: string;
  group: string;
  input?: Runs<string>;
  input_hex?: Runs<string>;
  limits?: Record<string, number>;
  value_hex?: Runs<string>;
  output?: Runs<string>;
  refusal?: { code: string; path: Runs<unknown[]>; span: [number, number]; kind?: string };
  render_refusal?: { code: string; kind?: string };
  origins?: [number[], unknown[], [number, number]][];
}

interface VectorFile {
  profile: string;
  cases: Case[];
}

/** What a profile's entry point offers; parseUtf8WithOrigins is the readable profile's. */
export interface ProfileModule {
  PROFILE: string;
  parseUtf8(input: Uint8Array, limits?: object): Value;
  parseString(input: string, limits?: object): Value;
  renderUtf8(value: Value, limits?: object): Uint8Array;
  renderString(value: Value, limits?: object): string;
  parseUtf8WithOrigins?(input: Uint8Array, limits?: object): {
    value: Value;
    origins: Iterable<[number[], { path: readonly unknown[]; span: { start: number; end: number } }]>;
  };
  ProjectionError: new (...args: never[]) => Error;
}

function expand<T>(field: Runs<T>): T {
  if (field !== null && typeof field === "object" && "runs" in field) {
    const runs = (field as { runs: [unknown, number][] }).runs;
    if (typeof runs[0]?.[0] === "string") {
      return runs.map(([piece, count]) => (piece as string).repeat(count)).join("") as T;
    }
    const out: unknown[] = [];
    for (const [piece, count] of runs) for (let i = 0; i < count; i += 1) out.push(...(piece as unknown[]));
    return out as T;
  }
  return field as T;
}

function fromHex(hex: string): Uint8Array {
  assert.ok(/^(?:[0-9a-f]{2})*$/.test(hex), "vector hex is even-length lowercase");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const LIMIT_NAMES: Record<string, string> = {
  max_text_bytes: "maxTextBytes",
  max_json_depth: "maxJsonDepth",
  max_value_depth: "maxValueDepth",
  max_atom_bytes: "maxAtomBytes",
  max_tuple_arity: "maxTupleArity",
  max_integer_digits: "maxIntegerDigits",
};

function limitsOf(c: Case): Record<string, number> | undefined {
  if (c.limits === undefined) return undefined;
  const out: Record<string, number> = {};
  for (const [name, bound] of Object.entries(c.limits)) {
    const camel = LIMIT_NAMES[name];
    assert.ok(camel !== undefined, `unknown limit ${name} in case ${c.name}`);
    out[camel] = bound;
  }
  return out;
}

/** Decodes the vector's codec bytes; deeper than the codec's default depth when a case needs it. */
function valueOf(hex: string): Value {
  return decode(fromHex(hex), { maxDepth: 1 << 20 });
}

const utf8 = new TextEncoder();

function assertRefusal(
  module: ProfileModule,
  profile: string,
  run: () => unknown,
  want: { code: string; path?: unknown[]; span?: [number, number]; kind?: string },
  label: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `${label}: expected the refusal ${want.code}, got a result`);
  if (!(thrown instanceof module.ProjectionError)) throw thrown;
  const e = thrown as unknown as {
    profile: string;
    code: string;
    path: readonly unknown[];
    span?: { start: number; end: number };
    kind?: string;
  };
  assert.equal(e.profile, profile, `${label}: profile`);
  assert.equal(e.code, want.code, `${label}: code (message: ${(thrown as Error).message})`);
  if (want.path !== undefined) assert.deepEqual(e.path, want.path, `${label}: path`);
  if (want.span !== undefined) {
    assert.deepEqual(e.span === undefined ? undefined : [e.span.start, e.span.end], want.span, `${label}: span`);
  } else {
    assert.equal(e.span, undefined, `${label}: a writer refusal has no span`);
  }
  if (want.kind !== undefined) assert.equal(e.kind, want.kind, `${label}: kind`);
  else assert.ok(!("kind" in e), `${label}: no kind outside limit_exceeded`);
}

/** Registers one test per case of `file`, and a last test that reports the counts. */
export function replay(file: "total" | "readable", module: ProfileModule): void {
  const vectors = JSON.parse(readFileSync(join(vectorsDir, `${file}.json`), "utf8")) as VectorFile;
  const counts = { cases: 0, refusals: 0, reads: 0, origins: 0, writes: 0, renderRefusals: 0, laws: 0, hostStrings: 0 };
  const passed = new Set<string>();

  test(`${file}.json: profile`, () => {
    assert.equal(vectors.profile, module.PROFILE);
    assert.ok(vectors.cases.length > 0);
  });

  for (const c of vectors.cases) {
    test(`${file}.json: ${c.name} (${c.group})`, () => {
      const limits = limitsOf(c);
      const input = c.input_hex === undefined ? undefined : fromHex(expand(c.input_hex));
      let exercised = false;

      // 1. A refused input.
      if (c.refusal !== undefined) {
        assert.ok(input !== undefined, "a refusal case has input_hex");
        const want = { ...c.refusal, path: expand(c.refusal.path) };
        assertRefusal(module, vectors.profile, () => module.parseUtf8(input!, limits), want, "read");
        counts.refusals += 1;
        exercised = true;
      }

      // 2. An accepted input.
      if (input !== undefined && c.value_hex !== undefined) {
        const value = module.parseUtf8(input, limits);
        assert.equal(toHex(encode(value)), expand(c.value_hex), "read: codec bytes of the value");
        counts.reads += 1;
        exercised = true;
        if (c.origins !== undefined) {
          assert.ok(module.parseUtf8WithOrigins !== undefined, "origins need parseUtf8WithOrigins");
          const parsed = module.parseUtf8WithOrigins!(input, limits);
          assert.equal(toHex(encode(parsed.value)), expand(c.value_hex), "origins: codec bytes of the value");
          const got = Array.from(parsed.origins, ([valuePath, origin]) => [
            valuePath,
            Array.from(origin.path),
            [origin.span.start, origin.span.end],
          ]);
          assert.deepEqual(got, c.origins, "origins, in pre-order");
          counts.origins += 1;
        }
      }

      // The host-string reader agrees with the byte reader on every UTF-8 input.
      if (c.input !== undefined && input !== undefined) {
        const text = expand(c.input);
        assert.deepEqual(utf8.encode(text), input, "input and input_hex agree");
        if (c.refusal !== undefined) {
          const want = { ...c.refusal, path: expand(c.refusal.path) };
          assertRefusal(module, vectors.profile, () => module.parseString(text, limits), want, "parseString");
        } else if (c.value_hex !== undefined) {
          assert.equal(toHex(encode(module.parseString(text, limits))), expand(c.value_hex), "parseString");
        }
        counts.hostStrings += 1;
      }

      // 3. Writing.
      if (c.output !== undefined || c.render_refusal !== undefined) {
        assert.ok(c.value_hex !== undefined, "a writing case has value_hex");
        const value = valueOf(expand(c.value_hex!));
        if (c.output !== undefined) {
          const output = expand(c.output);
          assert.deepEqual(module.renderUtf8(value, limits), utf8.encode(output), "write: the preferred output");
          assert.equal(module.renderString(value, limits), output, "renderString");
          counts.writes += 1;

          // 4. The laws: the output reads back to the value, which writes the output again.
          const back = module.parseUtf8(utf8.encode(output), limits);
          assert.equal(toHex(encode(back)), expand(c.value_hex!), "law: R(W(v)) = v");
          assert.deepEqual(module.renderUtf8(back, limits), utf8.encode(output), "law: W(R(j)) = j");
          counts.laws += 1;
        } else {
          assertRefusal(module, vectors.profile, () => module.renderUtf8(value, limits), c.render_refusal!, "write");
          counts.renderRefusals += 1;
        }
        exercised = true;
      }

      assert.ok(exercised, "the case pins something this replay checks");
      counts.cases += 1;
      passed.add(c.name);
    });
  }

  test(`${file}.json: every case passed`, (t) => {
    t.diagnostic(`${join(vectorsDir, `${file}.json`)}: ${counts.cases}/${vectors.cases.length} cases passed ` + JSON.stringify(counts));
    assert.equal(new Set(vectors.cases.map((c) => c.name)).size, vectors.cases.length, "case names are unique");
    assert.equal(passed.size, vectors.cases.length);
  });
}
