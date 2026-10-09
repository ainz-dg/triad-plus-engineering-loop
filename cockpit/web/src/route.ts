import { useEffect, useState } from "react";

// Hash routing: #/p/<project>/c/<card>?file=<path>. Hash routes need no
// server fallback, survive refresh, and keep the back button meaningful
// (closing the artifact viewer is a history step on every device).

export interface Route {
  project: string | null;
  card: string | null;
  file: string | null;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart, query = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const route: Route = { project: null, card: null, file: null };
  if (parts[0] === "p" && parts[1]) route.project = parts[1];
  if (route.project && parts[2] === "c" && parts[3]) route.card = parts[3];
  const file = new URLSearchParams(query).get("file");
  if (file) route.file = file;
  return route;
}

export function routeHref(route: Partial<Route>): string {
  let href = "#/";
  if (route.project) href += `p/${encodeURIComponent(route.project)}`;
  if (route.project && route.card) href += `/c/${encodeURIComponent(route.card)}`;
  if (route.file) href += `?file=${encodeURIComponent(route.file)}`;
  return href;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function navigate(route: Partial<Route>, { replace = false } = {}): void {
  const href = routeHref(route);
  if (replace) window.history.replaceState(null, "", href);
  else window.location.hash = href.slice(1);
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}
