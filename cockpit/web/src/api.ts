import type { Artifact, CardDetail, CardList, Workspace } from "./types";

// Thin client for the read-only Cockpit API. Same-origin only; the session is
// the HttpOnly cookie set by /api/session, so no secret is handled here.

export type ApiErrorKind = "unauthorized" | "unreachable" | "not_found" | "refused" | "server";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

const listeners = new Set<() => void>();
/** Notified when any request finds the session gone (401). */
export function onUnauthorized(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("unreachable", null, "The Cockpit server cannot be reached.");
  }
  let body: { error?: { code?: string; message?: string } } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) return body as T;
  const message = body?.error?.message ?? `Request failed with status ${response.status}`;
  if (response.status === 401) {
    listeners.forEach((listener) => listener());
    throw new ApiError("unauthorized", 401, message);
  }
  if (response.status === 404) throw new ApiError("not_found", 404, message);
  if (response.status === 403) throw new ApiError("refused", 403, message);
  throw new ApiError("server", response.status, message);
}

const segment = encodeURIComponent;

export const api = {
  workspace: (signal?: AbortSignal) => getJson<Workspace>("/api/workspace", signal),
  cards: (project: string, signal?: AbortSignal) => getJson<CardList>(`/api/projects/${segment(project)}/cards`, signal),
  card: (project: string, card: string, signal?: AbortSignal) =>
    getJson<CardDetail>(`/api/projects/${segment(project)}/cards/${segment(card)}`, signal),
  file: (project: string, path: string, signal?: AbortSignal) =>
    getJson<Artifact>(`/api/projects/${segment(project)}/files?path=${segment(path)}`, signal),
};
