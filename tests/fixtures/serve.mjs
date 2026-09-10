/*
 * tests/fixtures/serve.mjs — a dependency-free static server for the mock
 * SPA. Fixed port 4599 to match the fixture recipe's urlPatterns
 * (http://localhost:4599/*) and the dev-only manifest's host permission.
 *
 * SPA-aware: unknown paths (e.g. the pushState route /other) fall back to
 * index.html so client-side routing works. Run with `npm run fixture`.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const PORT = 4599;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "spa");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    // Contain path traversal, then try the file; fall back to index.html
    // for extensionless SPA routes.
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(ROOT, safe);
    let body;
    try {
      body = await readFile(filePath);
    } catch {
      filePath = join(ROOT, "index.html");
      body = await readFile(filePath);
    }

    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`[fixture] serving ${ROOT} at http://localhost:${PORT}`);
});
