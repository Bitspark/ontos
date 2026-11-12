/*
 * The API of §10 of both pages, beyond what the vectors pin: the host-string readers and
 * lone surrogates, Partial<Limits> and the derived JSON depth, bounds a face cannot
 * represent, the shared error type, the origins lookup, and depths far beyond the defaults
 * read and written without native recursion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import { encodeInt, encodeList, encodeText } from "@bitspark/ontos-data";

import * as total from "../dist/src/total.js";
import * as readable from "../dist/src/readable.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (v: Value): string => Array.from(encode(v), (b) => b.toString(16).padStart(2, "0")).join("");

function refusal(run: () => unknown): total.ProjectionError {
  try {
    run();
  } catch (error) {
    if (error instanceof total.ProjectionError) return error;
    throw error;
  }
  assert.fail("expected a ProjectionError");
}

const shape = (e: total.ProjectionError) => ({
  profile: e.profile,
  code: e.code,
  path: [...e.path],
  span: e.span === undefined ? undefined : [e.span.start, e.span.end],
  kind: e.kind,
});

test("one error type, shared by both profiles", () => {
  assert.equal(total.ProjectionError, readable.ProjectionError);
  const e = refusal(() => readable.parseUtf8(utf8("[1,]")));
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ProjectionError");
  assert.deepEqual(shape(e), { profile: "ontos-readable-json/1", code: "invalid_json", path: [1], span: [3, 4], kind: undefined });
  assert.ok(!("kind" in e), "no kind outside limit_exceeded");
  assert.ok(Object.isFrozen(e.path) && Object.isFrozen(e.span));
});

test("the profile ids", () => {
  assert.equal(total.PROFILE, "ontos-total-json/1");
  assert.equal(readable.PROFILE, "ontos-readable-json/1");
});

test("the shipped defaults: frozen, with maxJsonDepth left out (derived)", () => {
  assert.deepEqual(total.DEFAULT_LIMITS, {
    maxTextBytes: Infinity,
    maxValueDepth: 1024,
    maxAtomBytes: Infinity,
    maxTupleArity: Infinity,
    maxIntegerDigits: Infinity,
  });
  assert.deepEqual(readable.DEFAULT_LIMITS, {
    maxTextBytes: Infinity,
    maxValueDepth: 1024,
    maxAtomBytes: Infinity,
    maxTupleArity: Infinity,
    maxIntegerDigits: 4300,
  });
  assert.ok(Object.isFrozen(total.DEFAULT_LIMITS) && Object.isFrozen(readable.DEFAULT_LIMITS));
  assert.ok(!("maxJsonDepth" in total.DEFAULT_LIMITS) && !("maxJsonDepth" in readable.DEFAULT_LIMITS));
});

test("Partial<Limits>: maxJsonDepth is derived from the effective maxValueDepth (22 total, 34 readable at 10)", () => {
  const nest = (k: number) => utf8("[".repeat(k) + "]".repeat(k));
  // total: 22 levels pass stage 3 and fail the shape; 23 are refused at the 23rd bracket.
  assert.equal(refusal(() => total.parseUtf8(nest(22), { maxValueDepth: 10 })).code, "invalid_total_form");
  assert.deepEqual(shape(refusal(() => total.parseUtf8(nest(23), { maxValueDepth: 10 }))).span, [22, 23]);
  assert.equal(refusal(() => total.parseUtf8(nest(23), { maxValueDepth: 10 })).kind, "json_depth");
  // readable: 34 levels pass stage 3 and are too deep as a value; 35 are refused in stage 3.
  assert.equal(refusal(() => readable.parseUtf8(nest(34), { maxValueDepth: 10 })).kind, "decode_depth");
  assert.equal(refusal(() => readable.parseUtf8(nest(35), { maxValueDepth: 10 })).kind, "json_depth");
  // An explicit maxJsonDepth wins over the derived one, and moves the refusal to stage 4.
  const deep = utf8('{"tuple":[{"tuple":[{"tuple":[]}]}]}');
  assert.equal(refusal(() => total.parseUtf8(deep, { maxValueDepth: 1 })).kind, "json_depth");
  assert.equal(refusal(() => total.parseUtf8(deep, { maxValueDepth: 1, maxJsonDepth: 100 })).kind, "decode_depth");
  // A field given as undefined counts as left out.
  assert.equal(hex(total.parseUtf8(deep, { maxJsonDepth: undefined } as never)), "010101010100");
});

test("a bound the face cannot represent is a caller error, not a refusal", () => {
  const text = utf8('{"atom":""}');
  for (const bad of [-1, 1.5, NaN, 2 ** 60, -Infinity, "3"]) {
    assert.throws(() => total.parseUtf8(text, { maxValueDepth: bad as number }), RangeError, String(bad));
  }
  assert.throws(() => total.parseUtf8(text, { max_value_depth: 3 } as never), TypeError);
  assert.throws(() => readable.renderUtf8(atom([]), null as never), TypeError);
  // Infinity is unbounded, everywhere.
  assert.equal(hex(total.parseUtf8(text, { maxValueDepth: Infinity, maxTextBytes: Infinity })), "0000");
});

test("parseString reads the generalized UTF-8 encoding: a lone surrogate is invalid_utf8 at its UTF-8 offset", () => {
  // A lone high surrogate inside a string, after a two-byte character: offset 1 + 2.
  assert.deepEqual(shape(refusal(() => readable.parseString('"é\uD800"'))), {
    profile: "ontos-readable-json/1",
    code: "invalid_utf8",
    path: [],
    span: [3, 4],
    kind: undefined,
  });
  // A lone low surrogate at the start, before anything else is read.
  assert.deepEqual(shape(refusal(() => total.parseString("\uDC00{\"atom\":\"\"}"))).span, [0, 1]);
  // A surrogate pair is one scalar value: four bytes, read as itself.
  assert.equal(hex(readable.parseString('"😀"')), hex(encodeText("😀")));
  // Stage 1 counts the generalized encoding: the lone surrogate is three bytes.
  const size = refusal(() => readable.parseString('"\uD800"', { maxTextBytes: 3 }));
  assert.deepEqual([size.code, size.kind, size.span?.start, size.span?.end], ["limit_exceeded", "text_bytes", 3, 5]);
  // The byte reader never repairs: the same bytes as a byte string refuse alike.
  assert.deepEqual(shape(refusal(() => readable.parseUtf8(Uint8Array.of(0x22, 0xed, 0xa0, 0x80, 0x22)))).span, [1, 2]);
});

test("renderString is the UTF-8 decoding of renderUtf8, U+FEFF and non-BMP text included", () => {
  const v = encodeText("﻿a😀 ");
  assert.equal(readable.renderString(v), '"﻿a😀 "');
  assert.deepEqual(readable.renderUtf8(v), utf8('"﻿a😀 "'));
  assert.equal(total.renderString(atom([0xab])), '{"atom":"ab"}');
});

test("paths keep member names and indexes apart: the member \"0\" is a string", () => {
  const e = refusal(() => readable.parseUtf8(utf8('{"0":[1.5]}')));
  assert.deepEqual(e.path, ["0", 0]);
  assert.equal(typeof e.path[0], "string");
  assert.equal(typeof e.path[1], "number");
});

test("a writer refusal has no span; its path is the output path of the node being written", () => {
  const v = encodeList([encodeList([encodeText("toolong")])]);
  const e = refusal(() => readable.renderUtf8(v, { maxAtomBytes: 5 }));
  assert.deepEqual(shape(e), { profile: "ontos-readable-json/1", code: "limit_exceeded", path: [0, 0], span: undefined, kind: "atom_bytes" });
  assert.ok(!("span" in e));
  const t = refusal(() => total.renderUtf8(tuple([tuple([atom([1, 2])])]), { maxAtomBytes: 1 }));
  assert.deepEqual(t.path, ["tuple", 0, "tuple", 0]);
});

test("origins: lookup by value path, size, and pre-order enumeration", () => {
  const text = utf8('{"b":[true,"x"],"a":null}');
  const { value, origins } = readable.parseUtf8WithOrigins(text);
  assert.equal(hex(value), hex(readable.parseUtf8(text)));
  // Codec order puts "a" (entry 1) before "b" (entry 2).
  assert.deepEqual(origins.at([]), { path: [], span: { start: 0, end: 25 } });
  assert.deepEqual(origins.at([1]), { path: ["a"], span: { start: 16, end: 24 } });
  assert.deepEqual(origins.at([1, 0, 1]), { path: ["a"], span: { start: 16, end: 19 } });
  assert.deepEqual(origins.at([2, 1, 2]), { path: ["b", 1], span: { start: 11, end: 14 } });
  assert.equal(origins.at([9]), undefined);
  assert.equal(origins.at([-1]), undefined);
  assert.equal(origins.at([0, 0]), undefined, "an atom has no children");
  const all = [...origins];
  assert.equal(origins.size, all.length);
  assert.deepEqual(all.map(([path]) => path.join(".")).slice(0, 4), ["", "0", "1", "1.0"]);
  assert.deepEqual([...origins.entries()], all);
});

test("depth far beyond the defaults, read and written without native recursion", () => {
  const k = 200_000;
  const unbounded = { maxValueDepth: Infinity };
  // readable: nested lists, JSON depth k.
  const lists = utf8("[".repeat(k) + "]".repeat(k));
  const v = readable.parseUtf8(lists, unbounded);
  assert.deepEqual(readable.renderUtf8(v, unbounded), lists);
  const { origins } = readable.parseUtf8WithOrigins(lists, unbounded);
  assert.equal(origins.size, 2 * k);
  // total: nested tuples, JSON depth 2k + 2.
  const tuples = utf8('{"tuple":['.repeat(k) + '{"tuple":[]}' + "]}".repeat(k));
  const t = total.parseUtf8(tuples, unbounded);
  assert.deepEqual(total.renderUtf8(t, unbounded), tuples);
  // readable, through the raw arm.
  const raw = utf8('{"$ontos":["raw",' + '{"tuple":[{"tuple":[]},'.repeat(k) + '{"tuple":[]}' + "]}".repeat(k) + "]}");
  assert.deepEqual(readable.renderUtf8(readable.parseUtf8(raw, unbounded), unbounded), raw);
});

test("integers at any magnitude: bigint conversion, max_integer_digits, and no conversion of a hopeless magnitude", () => {
  const big = 10n ** 5000n + 7n;
  const tagged = utf8(`{"$ontos":["int","-${big}"]}`);
  const e = refusal(() => readable.parseUtf8(tagged));
  assert.deepEqual([e.code, e.kind, e.span?.start, e.span?.end], ["limit_exceeded", "integer_digits", 0, tagged.length]);
  const raised = { maxIntegerDigits: 5001 };
  const v = readable.parseUtf8(tagged, raised);
  assert.equal(hex(v), hex(encodeInt(-big)));
  assert.deepEqual(readable.renderUtf8(v, raised), tagged);
  assert.equal(refusal(() => readable.renderUtf8(v)).kind, "integer_digits");
  // A magnitude of a million bytes is refused under the defaults without converting it.
  const payload = new Uint8Array(1_000_001).fill(0xff);
  payload[0] = 0;
  const huge = tuple([atom(utf8("int")), atom(payload)]);
  const started = Date.now();
  assert.equal(refusal(() => readable.renderUtf8(huge)).kind, "integer_digits");
  assert.ok(Date.now() - started < 1000, "refused without a quadratic conversion");
  // The window edges, both ways.
  assert.equal(readable.renderString(encodeInt(9007199254740991n)), "9007199254740991");
  assert.equal(readable.renderString(encodeInt(-9007199254740992n)), '{"$ontos":["int","-9007199254740992"]}');
});

test("the input is copied before it is read, and any view of it reads alike", () => {
  const buffer = utf8('xx{"atom":"00"}yy').buffer;
  const view = new Uint8Array(buffer, 2, 13);
  assert.equal(hex(total.parseUtf8(view)), "000100");
});

test("width: 200,000 object members and 130,000 elements, read and written without spreading them into a call", () => {
  // Past V8's limit on the arguments of one call (about 125,000 with the default stack).
  const n = 200_000;
  const object = utf8("{" + Array.from({ length: n }, (_, i) => `"k${i}":${i}`).join(",") + "}");
  const v = readable.parseUtf8(object);
  const written = readable.renderUtf8(v);
  assert.equal(written.length, object.length, "the same members, in codec order");
  assert.deepEqual(readable.renderUtf8(readable.parseUtf8(written)), written);
  const m = 130_000;
  const list = utf8("[" + Array.from({ length: m }, (_, i) => String(i)).join(",") + "]");
  assert.deepEqual(readable.renderUtf8(readable.parseUtf8(list)), list);
  const set = utf8('{"$ontos":["set",[' + Array.from({ length: m }, (_, i) => String(i)).join(",") + "]]}");
  assert.equal(readable.parseUtf8WithOrigins(set).origins.size, 2 + 3 * m);
  const tuples = utf8('{"tuple":[' + Array.from({ length: m }, () => '{"atom":""}').join(",") + "]}");
  assert.deepEqual(total.renderUtf8(total.parseUtf8(tuples)), tuples);
});
