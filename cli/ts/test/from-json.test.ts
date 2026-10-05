/*
 * Drives THIS CLI (the built dist binary) over the `--from-json` authoring-notation
 * input path (docs/spec/ontos-cli.md "Value input"). Black-box, out-of-process via
 * child_process — exactly how the differential harness and a real user invoke it.
 *
 * The core contract: `--from-json <value>` is the exact inverse of the `--format json`
 * value rendering, so for EVERY pinned vector (vectors/{codec,data}.json `encode`
 * array, each `{ value: <authoring-json>, hex }`):
 *
 *     canon --emit --from-json <value>   prints exactly <hex>
 *
 * That is the round-trip that makes `--from-json` trustworthy: author a value, get its
 * canonical bytes. We also pin the reject grammar (malformed / non-authoring JSON ->
 * invalid_json exit 2) and the mutual exclusion with a positional <hex> (usage_error
 * exit 2).
 *
 * Requires the CLI to be built first: `npm run -w @bitspark/ontos-cli build`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LABELS } from "@bitspark/ontos-data";
// The CLI's own kinds list. Importing the source (type-stripped) does NOT run the CLI:
// main() is guarded to the program-entry case (see main.ts), so this only pulls in the
// KINDS constant.
import { KINDS } from "../src/main.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const vectorsDir = join(here, "..", "..", "..", "vectors");
const bin = join(cliRoot, "dist", "src", "main.js");

assert.ok(
  existsSync(bin),
  `CLI not built: ${bin} is missing — run \`npm run -w @bitspark/ontos-cli build\` first`,
);

/** Run the built CLI with the given argv (no shell), optional stdin. */
function run(args: string[], input?: string): { stdout: string; status: number } {
  const res = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  if (res.error) throw res.error;
  return { stdout: res.stdout ?? "", status: res.status ?? 0 };
}

/** `canon --emit --format json` over a --from-json value, parsed back to its hex. */
function emitHex(valueJson: unknown): { hex: string; status: number; line: string } {
  const { stdout, status } = run([
    "canon",
    "--emit",
    "--format",
    "json",
    "--from-json",
    JSON.stringify(valueJson),
  ]);
  const line = stdout.replace(/\n$/, "");
  let hex = "";
  try {
    const obj = JSON.parse(line);
    if (obj && obj.ok === true && typeof obj.hex === "string") hex = obj.hex;
  } catch {
    /* leave hex empty; the assertion will surface the raw line */
  }
  return { hex, status, line };
}

function readVectors(name: string): { encode: { name: string; value: unknown; hex: string }[] } {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

for (const file of ["codec.json", "data.json"]) {
  test(`canon --emit --from-json round-trips every ${file} encode vector`, () => {
    const doc = readVectors(file);
    assert.ok(doc.encode.length > 0, `${file}: no encode cases`);
    for (const c of doc.encode) {
      const { hex, status, line } = emitHex(c.value);
      assert.equal(status, 0, `${file} ${c.name}: exit 0 expected, got line ${line}`);
      assert.equal(hex, c.hex, `${file} ${c.name}: emitted hex must equal pinned hex`);
    }
  });
}

// --- reject grammar: malformed / non-authoring JSON -> invalid_json, exit 2 ---
const REJECTS: { name: string; json: string }[] = [
  { name: "odd-length atom", json: '{"atom":"0"}' },
  { name: "uppercase atom", json: '{"atom":"AB"}' },
  { name: "non-hex atom", json: '{"atom":"zz"}' },
  { name: "non-string atom", json: '{"atom":5}' },
  { name: "extra/unknown key", json: '{"foo":1}' },
  { name: "both atom and tuple", json: '{"atom":"00","tuple":[]}' },
  { name: "extra key alongside atom", json: '{"atom":"00","x":1}' },
  { name: "non-array tuple", json: '{"tuple":"x"}' },
  { name: "value is not an object (number)", json: "5" },
  { name: "value is not an object (array)", json: "[]" },
  { name: "value is null", json: "null" },
  { name: "malformed JSON (open brace)", json: "{" },
  { name: "nested malformed child", json: '{"tuple":[{"atom":"0"}]}' },
];

test("malformed / non-authoring --from-json yields invalid_json exit 2 (json)", () => {
  for (const { name, json } of REJECTS) {
    const { stdout, status } = run(["canon", "--emit", "--format", "json", "--from-json", json]);
    assert.equal(status, 2, `${name}: exit 2 expected`);
    assert.equal(
      stdout,
      '{"ok":false,"command":"canon","error":"invalid_json"}\n',
      `${name}: invalid_json line expected`,
    );
  }
});

test("invalid_json is emitted per-command for every command", () => {
  for (const command of ["decode", "inspect", "canon"]) {
    const { stdout, status } = run([command, "--format", "json", "--from-json", "{"]);
    assert.equal(status, 2, `${command}: exit 2 expected`);
    assert.equal(
      stdout,
      `{"ok":false,"command":"${command}","error":"invalid_json"}\n`,
      `${command}: invalid_json line expected`,
    );
  }
  // read needs --all (otherwise it is a usage error before input resolution).
  const r = run(["read", "--all", "--format", "json", "--from-json", "{"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '{"ok":false,"command":"read","error":"invalid_json"}\n');
});

// --- mutual exclusion: --from-json together with a positional <hex> ----------
test("--from-json with a positional <hex> is usage_error exit 2", () => {
  const { stdout, status } = run([
    "canon",
    "--emit",
    "--format",
    "json",
    "--from-json",
    '{"atom":""}',
    "0000",
  ]);
  assert.equal(status, 2, "exit 2 expected for both inputs");
  assert.equal(stdout, '{"ok":false,"command":"canon","error":"usage_error"}\n');
});

// The `-` stdin sentinel is a positional too: combining it with --from-json is the
// same usage_error (ontos-internal#45) — `-` still names a bytes source. The JSON-only
// conformance harness is blind to `-` (no vector value is `-`), so it is pinned here.
test("--from-json with a `-` positional is usage_error exit 2", () => {
  // Pass empty stdin so a regression to "accept" would not block reading fd 0.
  for (const args of [
    ["canon", "--emit", "--format", "json", "--from-json", '{"atom":"00"}', "-"],
    ["canon", "--emit", "--format", "json", "-", "--from-json", '{"atom":"00"}'],
  ]) {
    const { stdout, status } = run(args, "");
    assert.equal(status, 2, `exit 2 expected for ${args.join(" ")}`);
    assert.equal(stdout, '{"ok":false,"command":"canon","error":"usage_error"}\n');
  }
});

// --- the CLI's kinds list must not drift from data's exported LABELS (ontos-internal#49) ---
test("CLI KINDS equals data LABELS, same order", () => {
  // The CLI keeps its own KINDS by deliberate design (it does not depend on the data
  // module exporting the labels). But the order is part of the `recognized` JSON
  // contract the tri-core harness pins, so silent drift would be a real parity bug.
  // This makes the deliberate duplication safe. Do NOT reopen ontos-internal#49.
  assert.deepEqual([...KINDS], [...LABELS], "CLI KINDS drifted from data LABELS");
});

// --- the marquee path + stdin -------------------------------------------------
test("marquee: canon --emit --from-json builds canonical bytes (human format)", () => {
  const { stdout, status } = run([
    "canon",
    "--emit",
    "--from-json",
    '{"tuple":[{"atom":"696e74"},{"atom":"00"}]}',
  ]);
  assert.equal(status, 0);
  assert.equal(stdout, "01020003696e74000100\n");
});

test("--from-json - reads the authoring JSON from stdin", () => {
  const { stdout, status } = run(
    ["canon", "--emit", "--format", "json", "--from-json", "-"],
    '{"atom":"61"}\n',
  );
  assert.equal(status, 0);
  assert.equal(stdout, '{"ok":true,"command":"canon","hex":"000161"}\n');
});
