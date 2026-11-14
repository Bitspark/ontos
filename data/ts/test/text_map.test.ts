import test from "node:test";
import assert from "node:assert/strict";
import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import { DataError, encodeMap, encodeText, encodeTextMap, readTextMap } from "../src/index.ts";

const error = (code: string) => (err: unknown) => err instanceof DataError && err.code === code;
const label = atom(new TextEncoder().encode("map"));

test("text map uses the existing frozen bytes and codec key order, not string order", () => {
  const first = atom(Uint8Array.of(0xff));
  const second = tuple([]);
  const entries: Array<[string, Value]> = [["aa", second], ["b", first]];
  const value = encodeTextMap(entries);
  // Independently spelled from codec-v1: map, then the shorter key 'b', then 'aa'.
  assert.equal(Buffer.from(encode(value)).toString("hex"),
    "010300036d6170010201020009757466382d746578740001620001ff010201020009757466382d74657874000261610100");
  assert.deepEqual(readTextMap(value).map(([key]) => key), ["b", "aa"]);
  assert.equal(readTextMap(value)[0]![1], first);
  assert.equal(readTextMap(value)[1]![1], second);
  entries.reverse();
  assert.ok(equals(value, encodeTextMap(entries)));
  assert.deepEqual(readTextMap(encodeTextMap([])), []);
});

test("text map retains arbitrary children and all scalar strings without normalization or property semantics", () => {
  const opaque = tuple([atom(new TextEncoder().encode("int")), atom(Uint8Array.of(0xff))]);
  const keys = ["", "__proto__", "constructor", "\0", "é", "e\u0301", "😀", "\u{10ffff}"];
  const value = encodeTextMap(keys.map((key) => [key, opaque]));
  const read = readTextMap(value);
  assert.equal(read.length, keys.length);
  assert.deepEqual(new Set(read.map(([key]) => key)), new Set(keys));
  for (const [, child] of read) assert.equal(child, opaque);
});

test("text map refuses duplicate intent, invalid Unicode and malformed native entries", () => {
  const child = tuple([]);
  assert.throws(() => encodeTextMap([["x", child], ["x", child]]), error("duplicate_key"));
  for (const key of ["\ud800", "\udc00", "a\ud800z"]) {
    assert.throws(() => encodeTextMap([[key, child]]), error("invalid_utf8"));
  }
  for (const malformed of [null, {}, "", [null], [[1, child]], [["x"]], [["x", child, child]], new Array(1)]) {
    assert.throws(() => encodeTextMap(malformed as never), error("malformed_entry"));
  }
});

test("text map reader rejects malformed maps, non-text keys and invalid UTF-8 without repair", () => {
  const child = tuple([]);
  const a = encodeText("a");
  const b = encodeText("b");
  const malformed = [
    atom(new Uint8Array()), tuple([]), tuple([label, tuple([a])]),
    tuple([label, tuple([b, child]), tuple([a, child])]),
    tuple([label, tuple([a, child]), tuple([a, child])]),
    encodeMap([[atom(new Uint8Array()), child]]),
    encodeMap([[tuple([atom(new TextEncoder().encode("utf8-text")), atom(Uint8Array.of(0xff))]), child]]),
  ];
  for (const value of malformed) assert.throws(() => readTextMap(value), DataError);
});
