/*
 * The hex input's surrounding whitespace and UTF-8 rule (docs/spec/ontos-cli.md
 * "Synopsis"): space, tab, LF and CR are stripped, and nothing else is (String trim()
 * also stripped a BOM and every Unicode space); bytes that are not UTF-8 fail as
 * invalid_hex with the JSON line.
 *
 * Requires the CLI to be built first: `npm run -w @bitspark/ontos-cli build`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "main.js");

function run(args: string[], input: string | Buffer = ""): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, [bin, ...args], { input, encoding: "utf8" });
  if (res.error) throw res.error;
  return { stdout: res.stdout, status: res.status };
}

const invalid = { stdout: '{"ok":false,"command":"canon","error":"invalid_hex"}\n', status: 2 };

test("hex input strips only space, tab, LF and CR", () => {
  for (const input of ["\ufeff000100", "000100\u00a0", "000100\f", "\v000100", "000100\u001c", "00 0100"]) {
    assert.deepEqual(run(["canon", "--emit", "--format", "json", input]), invalid, `argument ${JSON.stringify(input)}`);
    assert.deepEqual(run(["canon", "--emit", "--format", "json"], input), invalid, `stdin ${JSON.stringify(input)}`);
  }
  for (const input of [" \t\r\n000100\r\n", "000100\n"]) {
    assert.deepEqual(run(["canon", "--emit", input]), { stdout: "000100\n", status: 0 });
    assert.deepEqual(run(["canon", "--emit"], input), { stdout: "000100\n", status: 0 });
  }
});

test("hex input that is not UTF-8 is invalid_hex", () => {
  for (const input of [Buffer.from([0xff]), Buffer.from("000100\xff", "latin1")]) {
    assert.deepEqual(run(["canon", "--emit", "--format", "json"], input), invalid);
  }
});
