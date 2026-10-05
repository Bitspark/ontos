#!/usr/bin/env node
// check-workspace-links.mjs — preflight for the npm-workspace symlinks.
//
// The footgun (ontos-internal#57): a stale local `node_modules/@bitspark/` can be missing
// the workspace symlink for a package that joined the workspace after your last
// install (or carry a registry-installed copy instead of the link), so a build
// like `npm run -w @bitspark/ontos-cli build` fails with confusing module-
// resolution errors until `npm ci` re-links it. CI is unaffected (it always
// installs clean); this bites only interactive local checkouts.
//
// This script verifies that every in-repo `@bitspark/ontos-*` dependency edge
// resolves to its workspace directory, exactly as Node module resolution will
// see it. Silent on success; on failure it exits 1 with the one actionable
// remedy: run `npm ci` at the repo root. Stdlib only — it must run even when
// node_modules is broken, which is the very state it diagnoses.
//
// One member is exempt as a CONSUMER: the `@bitspark/ontos` umbrella (atlas,
// at `substrate/release-facts.json#umbrella.path`, default `meta/`). The umbrella
// is a *generated, published* artifact that pins its members at the active BOM's
// registry version lines so `npm i @bitspark/ontos` resolves the published unit —
// during a release the in-repo packages run AHEAD of the published BOM (e.g. an
// in-repo `data/ts@0.5.0` against an umbrella pin of `0.4.0`), so npm rightly
// installs those deps from the registry, NOT as in-repo symlinks. Holding the
// umbrella to the workspace-link rule would red exactly when it is correct, so we
// skip its outgoing edges. Its members are still checked against each other.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Junctions (npm's link flavor on Windows) and symlinks both resolve via
// realpath; compare case-insensitively on win32 (drive-letter case varies).
const norm = (p) => (process.platform === "win32" ? realpathSync(p).toLowerCase() : realpathSync(p));

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspaces = (rootPkg.workspaces ?? []).filter((w) => !w.includes("*"));

// The umbrella's workspace path (e.g. `meta`) — read from the release facts the
// release pipeline uses; default `package.json` (a single-package repo has none).
let umbrellaWs = null;
try {
  const facts = JSON.parse(readFileSync(join(root, "substrate", "release-facts.json"), "utf8"));
  const p = facts?.umbrella?.path; // e.g. "meta/package.json"
  if (p) umbrellaWs = dirname(p).replace(/\\/g, "/"); // -> "meta"
} catch {
  /* no facts / no umbrella declared — nothing exempt */
}

// name -> workspace dir, for every npm workspace package in the repo.
const wsDirByName = new Map();
const members = [];
for (const ws of workspaces) {
  const dir = join(root, ws);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  wsDirByName.set(pkg.name, dir);
  members.push({ dir, pkg, ws: ws.replace(/\\/g, "/") });
}

const problems = [];
for (const { dir, pkg, ws } of members) {
  // The umbrella pins published registry versions on purpose — its edges are not
  // in-repo links. Skip it as a consumer (see the header note).
  if (umbrellaWs && ws === umbrellaWs) continue;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    if (!wsDirByName.has(name)) continue; // not an in-repo edge
    // Walk up from the consumer exactly like Node resolution: the first
    // node_modules/<name> found (consumer dir -> repo root) must be the
    // workspace directory itself.
    let found = null;
    for (let d = dir; ; d = dirname(d)) {
      const candidate = join(d, "node_modules", ...name.split("/"));
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
      if (norm(d) === norm(root) || dirname(d) === d) break;
    }
    if (found === null) {
      problems.push(`${pkg.name} -> ${name}: no node_modules link found (up to the repo root)`);
    } else if (norm(found) !== norm(wsDirByName.get(name))) {
      problems.push(`${pkg.name} -> ${name}: resolves to ${found}, not the workspace dir ${wsDirByName.get(name)}`);
    }
  }
}

if (problems.length > 0) {
  console.error("stale node_modules: missing/wrong @bitspark workspace link(s) — run `npm ci` at the repo root to re-link, then retry the build.");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
