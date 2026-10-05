#!/usr/bin/env node
/*
 * producer-conformance — the host-value -> L2 differential runner.
 *
 * The byte harness (tools/conformance) starts from a value that ALREADY EXISTS at
 * L0: it takes hex, or the authoring notation. It can construct an L0 value and
 * never a HOST value, so the `host value -> L2` step sits below its floor by
 * construction. That is why four implementations disagreed under a green CI
 * (ontos-internal#196): the step was never asked about.
 *
 * This runner asks. For each case it drives every applicable adapter, which builds
 * the host value NATIVELY (see PROTOCOL.md) and reports bytes or a classified
 * rejection, then asserts two things:
 *
 *   ORACLE       a portable case's bytes equal the FROZEN hex of the vectors/data.json
 *                entry it cites. Expectations are not minted here — they are the
 *                already-CI-enforced corpus, so this runner cannot bless its own drift.
 *
 *   DIFFERENTIAL every applicable adapter agrees with every other. Two impls can both
 *                match a stale oracle; they cannot both match it AND disagree.
 *
 * And for host-profile cases, the law that matters most (ontos-data.md §4.1):
 *
 *   NO ADAPTER MAY RETURN `ok` FOR AN INADMISSIBLE HOST VALUE.
 *
 * `unsupported` is not a failure — it is a language reporting that the value is
 * unconstructible in it (Rust cannot build an invalid &str; Go has no UTF-16 string).
 * Mechanisms may differ; outcome classes may not. What no implementation may do is
 * SUCCEED WITH A DIFFERENT DATUM — the one failure no downstream reader can catch,
 * because the distinguishing fact is the source value and it is gone by then.
 *
 * Dependency-free Node ESM, matching tools/conformance/run.mjs.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// Windows appends .exe; the harness must find the binary on either platform rather
// than silently reporting a spawn failure as if the lane were absent.
const EXE = process.platform === "win32" ? ".exe" : "";

const ADAPTERS = {
  py: { argv: ["python", join(HERE, "adapters", "py", "adapter.py")] },
  go: { argv: [join(REPO, "target", `producer-adapter-go${EXE}`)] },
  ts: { argv: ["node", "--experimental-strip-types", join(HERE, "adapters", "ts", "adapter.ts")] },
  rs: { argv: [join(REPO, "target", "debug", `ontos-producer-adapter${EXE}`)] },
};

/** The recipe an adapter is invoked with, derived from a case's `input`. */
function recipe(input) {
  switch (input.kind) {
    case "int": return ["int", input.decimal];
    case "bool": return ["bool", String(input.value)];
    case "text": return ["text", input.scalars.join(",")];
    case "text-utf16": return ["utf16", input.units.join(",")];
    case "text-bytes": return ["bytes", input.bytes.join("")];
    default: throw new Error(`unknown input kind ${JSON.stringify(input.kind)}`);
  }
}

function runAdapter(lang, args) {
  const [program, ...rest] = ADAPTERS[lang].argv;
  const res = spawnSync(program, [...rest, ...args], { encoding: "utf8", cwd: REPO });
  if (res.error) {
    throw new Error(`cannot spawn ${lang} adapter (${program}): ${res.error.message}`);
  }
  const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!line) {
    throw new Error(`${lang} adapter produced no output (exit ${res.status}): ${res.stderr?.slice(0, 200)}`);
  }
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${lang} adapter emitted non-JSON: ${line.slice(0, 200)}`);
  }
}

/** The frozen oracle: a case cites a vectors/data.json entry BY NAME. */
function loadOracle() {
  const data = JSON.parse(readFileSync(join(REPO, "vectors", "data.json"), "utf8"));
  const byName = new Map(data.encode.map((c) => [c.name, c.hex]));
  return (name) => {
    const hex = byName.get(name);
    if (!hex) {
      // A citation that does not resolve is a HARNESS error, never a skip — a silent
      // skip is how a corpus quietly stops testing anything.
      throw new Error(`case cites vectors/data.json entry ${JSON.stringify(name)}, which does not exist`);
    }
    return hex;
  };
}

function main() {
  const langs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const only = langs.length ? langs : Object.keys(ADAPTERS);
  const cases = JSON.parse(readFileSync(join(REPO, "vectors", "producer-v1", "cases.json"), "utf8"));
  const oracle = loadOracle();

  let checked = 0;
  const failures = [];

  for (const c of cases.cases) {
    const args = recipe(c.input);
    const applicable = c.applies.filter((l) => only.includes(l));
    const results = new Map();

    for (const lang of applicable) {
      const r = runAdapter(lang, args);
      results.set(lang, r);

      if (c.profile === "host") {
        // The law that matters most. `unsupported` and a classified `error` are both
        // conformant; `ok` is the violation, whatever bytes it carries.
        if (r.status === "ok") {
          failures.push(`${c.id}: ${lang} returned ok for an INADMISSIBLE host value (hex=${r.hex}) — §4.1 law 1/2`);
        }
        if (r.status === "error" && String(r.code).startsWith("UNCLASSIFIED:")) {
          failures.push(`${c.id}: ${lang} leaked a non-profile error (${r.code}) — §4.1 law 3`);
        }
      } else {
        // portable / portable-differential: must succeed everywhere.
        if (r.status !== "ok") {
          failures.push(`${c.id}: ${lang} refused a PORTABLE case (${r.status}: ${r.code ?? r.reason})`);
          continue;
        }
        if (!c.oracle) {
          // portable-differential: no frozen vector exists to cite, so agreement is
          // the ONLY assertion. Weaker on purpose, and stated so in the corpus.
          checked += 1;
          continue;
        }
        const want = oracle(c.oracle.vector);
        if (r.hex !== want) {
          failures.push(`${c.id}: ${lang} hex mismatch vs frozen vector ${c.oracle.vector}\n    got  ${r.hex}\n    want ${want}`);
        }
      }
      checked += 1;
    }

    // DIFFERENTIAL: every adapter that produced bytes must have produced the SAME
    // bytes. This is what an oracle alone cannot give — a stale oracle two impls both
    // match still fails here the moment a third disagrees.
    const emitted = [...results].filter(([, r]) => r.status === "ok").map(([l, r]) => [l, r.hex]);
    const distinct = new Set(emitted.map(([, h]) => h));
    if (distinct.size > 1) {
      failures.push(`${c.id}: DIVERGENCE — ${emitted.map(([l, h]) => `${l}=${h}`).join("  ")}`);
    }
  }

  const summary = `producer-conformance: ${cases.cases.length} case(s), ${checked} adapter-run(s) over [${only.join(", ")}]`;
  if (failures.length) {
    console.error(`${summary}\n\n${failures.length} FAILURE(S):\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`${summary} — all agree, all match the frozen oracle.`);
}

main();
