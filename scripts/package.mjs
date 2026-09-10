/*
 * scripts/package.mjs — produce the shippable zip from dist/, with guards
 * that a dev-only (dist-test) build can NEVER be shipped by accident
 * (Charter / Phase 6 requirement).
 *
 * Guards, before zipping:
 *  1. dist/ exists and looks like a production build.
 *  2. dist/manifest.json is NOT the dev-test manifest — its name has no
 *     "TEST BUILD" marker and its host_permissions include no localhost.
 *  3. We only ever add files from dist/, so no dist-test/ path can enter the
 *     archive; we assert that explicitly too.
 *
 * Zips with the platform `tar` (bsdtar on Windows 10+, macOS, Linux), which
 * writes a real .zip via `-a` (format by extension) — no npm dependency.
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const DIST = "dist";
const OUT_DIR = "dist-pack";

function fail(msg) {
  console.error(`[package] REFUSING TO SHIP: ${msg}`);
  process.exit(1);
}

// 1. dist/ present.
if (!existsSync(DIST)) fail("dist/ not found — run `npm run build` first.");
for (const required of ["manifest.json", "background.js", "gmail.js", "sidepanel.html"]) {
  if (!existsSync(join(DIST, required))) fail(`dist/${required} missing — build looks incomplete.`);
}

// 2. Not the dev-test manifest.
const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
if (/TEST BUILD/i.test(manifest.name ?? "")) {
  fail("dist/manifest.json is a TEST BUILD — you built dist-test into dist/.");
}
const hosts = [
  ...(manifest.host_permissions ?? []),
  ...(manifest.optional_host_permissions ?? []),
];
if (hosts.some((h) => /localhost/i.test(h))) {
  fail("dist/manifest.json grants localhost — that's the fixture/dev host, not shippable.");
}

// 3. Nothing dev-only anywhere under dist/ (belt and suspenders).
//
// Each of these was verified by hand at Phase 10 and held — but "it happens
// to be absent" is not a guard. A sourcemap:true in a vite config, or a
// fixture accidentally emitted into dist/, would otherwise ship silently.
// These assertions make that a build failure instead.
const DEV_ARTIFACT_RULES = [
  {
    // Sourcemaps expose our full annotated TypeScript to anyone who unzips
    // the extension. No vite config emits them today; this keeps it that way.
    test: (p) => /\.map$/i.test(p),
    why: "source map",
  },
  {
    // The mock-SPA fixture and the Playwright harness are dev-only. They live
    // under tests/, outside dist/ — this asserts they stay there.
    test: (p) => /(^|[\\/])(fixtures?|spa|e2e)([\\/]|$)/i.test(p),
    why: "test fixture / e2e artifact",
  },
  {
    test: (p) => /dist-test/i.test(p),
    why: "dist-test artifact",
  },
  {
    test: (p) => /\.(spec|test)\.[cm]?[jt]s$/i.test(p),
    why: "spec/test file",
  },
];

let scanned = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    scanned += 1;
    for (const rule of DEV_ARTIFACT_RULES) {
      if (rule.test(p)) fail(`found a ${rule.why} under dist/: ${p}`);
    }
    if (statSync(p).isDirectory()) walk(p);
  }
}
walk(DIST);
console.log(
  `[package] ✓ dev-artifact scan: ${scanned} paths, 0 violations ` +
    `(${DEV_ARTIFACT_RULES.map((r) => r.why).join(", ")})`
);

// Zip dist/ contents → dist-pack/swivel-<version>.zip
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR);
const zipPath = join(OUT_DIR, `swivel-${manifest.version}.zip`);
try {
  // -a: infer format from extension (.zip). -C dist .: archive dist/ contents
  // at the archive root (so the zip unpacks straight to a loadable folder).
  execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", DIST, "."], { stdio: "inherit" });
} catch (err) {
  fail(
    `zip step failed (${err instanceof Error ? err.message : err}). ` +
      `Ensure 'tar' is available, or zip the dist/ folder manually.`
  );
}

// 4. Post-zip readback: re-apply the dev-artifact rules to the ACTUAL archive
// listing. Scanning dist/ checks the input; this checks the thing that ships.
// Cheap, and it closes the gap where the zip step itself pulls something in.
let entries;
try {
  entries = execFileSync("tar", ["-tf", zipPath], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
} catch (err) {
  fail(`could not read back ${zipPath} to verify its contents (${err.message}).`);
}

for (const entry of entries) {
  for (const rule of DEV_ARTIFACT_RULES) {
    if (rule.test(entry)) fail(`${rule.why} present INSIDE the zip: ${entry}`);
  }
}
console.log(
  `[package] ✓ archive readback: ${entries.length} entries, 0 dev artifacts`
);
for (const entry of entries) console.log(`[package]     ${entry}`);

console.log(`[package] ✓ ${zipPath} (from dist/, dev-build guards passed)`);
