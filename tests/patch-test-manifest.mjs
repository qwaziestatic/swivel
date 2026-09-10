/*
 * tests/patch-test-manifest.mjs — turn the shipped manifest (copied into
 * dist-test/ by Vite's publicDir) into the DEV-ONLY test manifest.
 *
 * The only difference from production is a host permission for the local
 * fixture server, which lets the hub inject content scripts onto
 * http://localhost:4599/* (generic extractor now, target.ts in Phase 7)
 * without a user gesture. This manifest must NEVER ship: it lives only in
 * dist-test/, `npm run build` never reads or emits it, and Phase 10's
 * packaging step asserts dist-test/ is absent from the zip.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-test", "manifest.json");
const FIXTURE_HOST = "http://localhost:4599/*";

const manifest = JSON.parse(await readFile(OUT, "utf8"));

manifest.name = `${manifest.name} (TEST BUILD — do not ship)`;
manifest.host_permissions = Array.from(
  new Set([...(manifest.host_permissions ?? []), FIXTURE_HOST])
);

await writeFile(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[build:test] patched ${OUT} (+${FIXTURE_HOST})`);
