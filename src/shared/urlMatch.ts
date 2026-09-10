/**
 * src/shared/urlMatch.ts — chrome match-pattern matching, as a PURE
 * function so target routing is deterministic and unit-testable without a
 * live chrome.tabs.query (which isn't available in vitest).
 *
 * The hub queries all tabs and filters with this, rather than relying on
 * tabs.query({ url }) — that keeps the matching logic here, tested, and
 * identical between production and tests.
 *
 * Supports the subset of the chrome match-pattern grammar we actually use:
 *   <scheme>://<host><path>
 *   scheme: "*" (→ http|https) | http | https | file | ftp
 *   host:   "*" | "*.example.com" | exact host
 *   path:   "/..." with "*" wildcards (matched against path+query+hash)
 * Plus the special token "<all_urls>".
 */

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Glob (only "*" is special) → anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesPattern(url: string, pattern: string): boolean {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):\/\//.test(url);

  const pat = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!pat) return false;
  const [, scheme, host, path] = pat as unknown as [string, string, string, string];

  const u = /^([a-z]+):\/\/([^/]*)(\/.*)?$/i.exec(url);
  if (!u) return false;
  const uScheme = u[1]!.toLowerCase();
  const uHost = u[2]!.toLowerCase();
  const uPath = u[3] ?? "/"; // includes query + hash; fine since our paths end in /*

  // Scheme: "*" means http or https only (chrome semantics).
  if (scheme === "*") {
    if (uScheme !== "http" && uScheme !== "https") return false;
  } else if (scheme !== uScheme) {
    return false;
  }

  // Host: "*" any; "*.domain" matches domain and any subdomain; else exact.
  if (host !== "*") {
    if (host.startsWith("*.")) {
      const domain = host.slice(2).toLowerCase();
      if (uHost !== domain && !uHost.endsWith(`.${domain}`)) return false;
    } else if (host.toLowerCase() !== uHost) {
      return false;
    }
  }

  return globToRegExp(path).test(uPath);
}

export function matchesAnyPattern(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(url, p));
}
