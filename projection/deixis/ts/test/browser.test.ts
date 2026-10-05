/*
 * Browser compatibility, pinned statically over the RUNTIME CLOSURE.
 *
 * ontos-internal#323 asks for a face a browser bundle can use "without Node-only runtime
 * dependencies". No bundler runs in this repo (dependency-free ethos), so the evidence is
 * a static guard rather than a Vite build: this package's source, and the published
 * entry point of every runtime dependency it declares (`@bitspark/ontos-core`,
 * `@bitspark/deixis-core`, `@bitspark/deixis-pos` — resolved exactly as a consumer's
 * bundler would, through package.json `exports`), must reference nothing that only Node
 * provides. A `node:` import, a bare Node builtin, `require`, `Buffer` or `process` in
 * any of them would make a browser bundle fail or polyfill silently.
 *
 * Node-only APIs are allowed in the TESTS (this file reads files, after all); the guard
 * is over `src/` and the dependencies' shipped code, which is what a consumer bundles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const require = createRequire(import.meta.url);

const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "module",
  "net", "os", "path", "process", "stream", "url", "util", "worker_threads", "zlib",
];

/**
 * Code only: a comment that SAYS "no Buffer" is not a Buffer. Block and line comments are
 * dropped before scanning (a `//` inside a string literal would only truncate that line's
 * scan, never invent a hit, so the guard errs toward strictness).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Import/require specifiers that only Node resolves. */
function nodeOnlySpecifiers(source: string): string[] {
  const hits: string[] = [];
  const spec = /(?:from|import|require\s*\()\s*["']([^"']+)["']/g;
  for (const m of stripComments(source).matchAll(spec)) {
    const s = m[1]!;
    if (s.startsWith("node:") || NODE_BUILTINS.includes(s)) hits.push(s);
  }
  return hits;
}

/** Node globals a browser does not have. */
function nodeGlobals(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  if (/\bBuffer\b/.test(code)) hits.push("Buffer");
  if (/\bprocess\./.test(code)) hits.push("process");
  if (/\brequire\s*\(/.test(code)) hits.push("require()");
  if (/\b__dirname\b|\b__filename\b/.test(code)) hits.push("__dirname/__filename");
  return hits;
}

test("src/ imports nothing from node: and touches no Node global", () => {
  const source = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
  assert.deepEqual(nodeOnlySpecifiers(source), []);
  assert.deepEqual(nodeGlobals(source), []);
  // Positive control: the guard sees imports at all, and sees the three it expects.
  const specs = [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(specs.sort(), ["@bitspark/deixis-core", "@bitspark/deixis-pos", "@bitspark/ontos-core"]);
});

test("every declared runtime dependency ships a Node-free entry point", () => {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const deps = Object.keys(manifest.dependencies);
  assert.deepEqual(deps.sort(), ["@bitspark/deixis-core", "@bitspark/deixis-pos", "@bitspark/ontos-core"]);
  // The codec is a DEV dependency only: the byte-composition tests need it, a browser
  // consumer of the bridge does not, and ordinary ontos consumers must not acquire
  // deixis by importing core — the dependency direction is one-way.
  assert.ok(!("@bitspark/ontos-codec" in manifest.dependencies));
  assert.ok(!("@bitspark/deixis-core" in (require("@bitspark/ontos-core/package.json").dependencies ?? {})));

  for (const dep of deps) {
    // Resolve the entry a bundler would take (package.json `exports` → "."), then read
    // the shipped JavaScript — not the TypeScript source.
    const entry = require.resolve(dep);
    assert.match(entry, /\.js$/, `${dep} resolves to ${entry}`);
    const shipped = readFileSync(entry, "utf8");
    assert.deepEqual(nodeOnlySpecifiers(shipped), [], `${dep}: Node-only import in ${entry}`);
    assert.deepEqual(nodeGlobals(shipped), [], `${dep}: Node global in ${entry}`);
  }
});

test("the guard itself catches what it is meant to catch (positive control)", () => {
  assert.deepEqual(nodeOnlySpecifiers(`import { readFileSync } from "node:fs";`), ["node:fs"]);
  assert.deepEqual(nodeOnlySpecifiers(`const fs = require("fs");`), ["fs"]);
  assert.deepEqual(nodeGlobals(`Buffer.from(x).toString("hex")`), ["Buffer"]);
  assert.deepEqual(nodeGlobals(`process.env.X`), ["process"]);
  // …and ignores prose: a comment mentioning Buffer or node:fs is not a dependency.
  assert.deepEqual(nodeGlobals(`/* there is no Buffer here */ const x = 1; // nor process.env`), []);
  assert.deepEqual(nodeOnlySpecifiers(`// import { x } from "node:fs";\nimport { y } from "@bitspark/ontos-core";`), []);
  // A string containing "//" (a URL) does not hide code AFTER it on another line.
  assert.deepEqual(nodeGlobals(`const u = "https://x";\nBuffer.alloc(1)`), ["Buffer"]);
});
