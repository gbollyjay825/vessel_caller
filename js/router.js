/* ============================================================
   router.js — minimal hash router with /:param matching.
   Hash routing keeps the app a static file set (no server
   rewrites needed) so it runs from python -m http.server.
   ============================================================ */

const routes = [];
let notFound = null;
let onNavigate = null;
let beforeNavigate = null;
let suppressNext = false;
let lastHash = null;

/**
 * setBeforeNavigate(fn) — fn(targetHash) is consulted before any hash
 * navigation dispatches (links, back/forward, programmatic). Return false
 * to block: the previous hash is restored without re-rendering, so the
 * current screen's state survives. Used for the unsaved-changes guard.
 */
export function setBeforeNavigate(fn) {
  beforeNavigate = fn;
}

/** register('/vessel-calls/:id', handler) */
export function register(pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/\//g, "\\/")
        .replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^\\/]+)";
        }) +
      "$"
  );
  routes.push({ regex, keys, handler });
}

export function setNotFound(handler) {
  notFound = handler;
}

export function setOnNavigate(fn) {
  onNavigate = fn;
}

function currentPath() {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || "/dashboard";
}

export function resolve() {
  const path = currentPath();
  const [pathname, queryStr] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(queryStr || ""));

  for (const route of routes) {
    const m = pathname.match(route.regex);
    if (m) {
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      if (onNavigate) onNavigate(pathname);
      route.handler({ params, query, path: pathname });
      return;
    }
  }
  if (notFound) notFound({ path: pathname });
}

/** Programmatic navigation. Same-path calls are a no-op so they can never
    wipe in-progress screen state (e.g. dirty Settings edits). */
export function navigate(to) {
  if (to === currentPath()) return;
  window.location.hash = to;
}

function onHashChange() {
  if (suppressNext) {
    suppressNext = false;
    return;
  }
  const target = window.location.hash || "#/dashboard";
  if (
    beforeNavigate &&
    lastHash !== null &&
    target !== lastHash &&
    beforeNavigate(target) === false
  ) {
    // Blocked: restore the previous hash without re-resolving, so the
    // guarded screen keeps its (dirty) state untouched.
    suppressNext = true;
    window.location.hash = lastHash.replace(/^#/, "");
    return;
  }
  lastHash = window.location.hash;
  resolve();
}

export function start() {
  lastHash = window.location.hash;
  window.addEventListener("hashchange", onHashChange);
  resolve();
}
