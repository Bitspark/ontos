/*
 * duplicateKeys: "reject" — the opt-in source-admission policy (ontos-internal#322), driven by
 * the `duplicateKeys` section of vectors/data-json.json. Mirrors the Go and Rust suites
 * case-for-case: the strict mode refuses each repeat at the pinned member with the
 * pinned key, as the DuplicateKeyError class (never a plain ProjectionError reason the
 * /1 vectors pin, never a LimitError); the default mode accepts the same document and
 * projects it to the bytes of its hand-written last-wins equivalent; duplicate-free
 * documents project byte-identically in both modes; and every locked valid/reject case
 * keeps its outcome through the strict mode.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { encode } from "@bitspark/ontos-codec";

import {
  DuplicateKeyError,
  LimitError,
  MAX_DEPTH,
  ProjectionError,
  project,
  type ProjectOptions,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(here, "..", "..", "..", "..", "vectors", "data-json.json");

interface DupCase {
  desc: string;
  value: {
    docSource: string;
    expect?: {
      reject: { path: string; key: string };
      lastWinsEquivalent: string;
    };
  };
}
interface LockedCase {
  value: {
    doc?: unknown;
    docSource?: string;
    corpusKey?: string;
    expect: { codecSha256?: string; reject?: { path: string; reason: string } };
  };
}

function loadVectors(): {
  valid: LockedCase[];
  reject: LockedCase[];
  duplicateKeys: { reject: DupCase[]; accept: DupCase[] };
} {
  const vf = JSON.parse(readFileSync(vectorPath, "utf8"));
  assert.ok(vf.duplicateKeys?.reject?.length, "empty duplicateKeys.reject");
  assert.ok(vf.duplicateKeys?.accept?.length, "empty duplicateKeys.accept");
  return vf;
}

const STRICT: ProjectOptions = { duplicateKeys: "reject" };
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytesWith = (src: string, opts: ProjectOptions): string => hexOf(encode(project(src, opts)));
const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

test("duplicateKeys vectors: strict refuses at the pinned member; default is last-wins", () => {
  for (const [i, c] of loadVectors().duplicateKeys.reject.entries()) {
    const src = c.value.docSource;
    const expect = c.value.expect!;
    assert.throws(
      () => project(src, STRICT),
      (e: unknown) => {
        assert.ok(e instanceof DuplicateKeyError, `reject${i}: class`);
        assert.ok(e instanceof ProjectionError, `reject${i}: is a source-admission refusal`);
        assert.ok(!(e instanceof LimitError), `reject${i}: never the limit class`);
        assert.equal(e.path, expect.reject.path, `reject${i}: path`);
        assert.equal(e.key, expect.reject.key, `reject${i}: key`);
        assert.ok(e.message.includes(e.path), `reject${i}: message carries the path`);
        return true;
      },
      `reject${i}: strict must refuse ${src}`,
    );
    const collapsed = bytesWith(expect.lastWinsEquivalent, {});
    assert.equal(bytesWith(src, {}), collapsed, `reject${i}: default mode is last-wins`);
    assert.equal(
      bytesWith(expect.lastWinsEquivalent, STRICT),
      collapsed,
      `reject${i}: strict accepts the collapsed equivalent identically`,
    );
  }
});

test("duplicateKeys vectors: duplicate-free documents project identically in both modes", () => {
  for (const [i, c] of loadVectors().duplicateKeys.accept.entries()) {
    const src = c.value.docSource;
    assert.equal(bytesWith(src, STRICT), bytesWith(src, {}), `accept${i}: ${src}`);
  }
});

test("strict mode preserves every locked valid digest and reject outcome", () => {
  const vf = loadVectors();
  for (const c of vf.valid) {
    const v = project(JSON.stringify(c.value.doc), STRICT);
    assert.equal(sha256Hex(encode(v)), c.value.expect.codecSha256, `${c.value.corpusKey}: strict digest`);
  }
  for (const [i, c] of vf.reject.entries()) {
    assert.throws(
      () => project(c.value.docSource!, STRICT),
      (e: unknown) => {
        assert.ok(e instanceof ProjectionError && !(e instanceof DuplicateKeyError), `reject${i}: class`);
        assert.equal(e.path, c.value.expect.reject!.path, `reject${i}: path`);
        assert.equal(e.reason, c.value.expect.reject!.reason, `reject${i}: reason`);
        return true;
      },
    );
  }
});

test("strict mode class boundaries: reader precedes the walk; limit stays the limit", () => {
  const both = '{"a": 1, "a": 2, "b": 1.5}';
  assert.throws(() => project(both, STRICT), (e: unknown) => e instanceof DuplicateKeyError && e.path === "$.a");
  assert.throws(
    () => project(both),
    (e: unknown) => e instanceof ProjectionError && !(e instanceof DuplicateKeyError) && e.path === "$.b",
  );

  const deep = '{"a":'.repeat(MAX_DEPTH + 1) + "1" + "}".repeat(MAX_DEPTH + 1);
  assert.throws(() => project(deep, STRICT), (e: unknown) => e instanceof LimitError);

  const lone = '{"\\ud800": 1, "\\ud800": 2}';
  assert.throws(() => project(lone, STRICT), (e: unknown) => e instanceof DuplicateKeyError);
  assert.throws(() => project(lone), (e: unknown) => e instanceof ProjectionError && !(e instanceof DuplicateKeyError));

  // The empty options object and the omitted argument are both last-wins.
  project('{"k": 1, "k": 2}');
  project('{"k": 1, "k": 2}', {});
  project('{"k": 1, "k": 2}', { duplicateKeys: "last-wins" });
});
