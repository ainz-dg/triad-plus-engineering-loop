import { useEffect, useState } from "react";
import { ApiError } from "./api";

export type Resource<T> =
  | { state: "idle"; data?: undefined; loadedAt?: undefined }
  | { state: "loading"; data?: T; loadedAt?: Date }
  | { state: "ready"; data: T; loadedAt: Date }
  | { state: "error"; error: ApiError; data?: T; loadedAt?: Date };

interface Entry<T> {
  key: string | null;
  resource: Resource<T>;
}

/**
 * Load the resource identified by `key`; reload when `key` or `epoch` changes.
 *
 * Identity and refresh are different events:
 * - a new `key` is a different resource (another project, card, or file), so
 *   nothing loaded for the previous key is ever returned for it;
 * - a new `epoch` with the same `key` is a refresh, so the last good data stays
 *   on screen while it runs, and stays (marked as an error) if it fails.
 * Responses for a superseded request are discarded even if they arrive after
 * the UI moved on, so a late answer cannot overwrite the current identity.
 * `loadedAt` is set only when data actually arrives.
 */
export function useResource<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>, epoch: number): Resource<T> {
  const [entry, setEntry] = useState<Entry<T>>({ key: null, resource: { state: "idle" } });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const controller = new AbortController();
    const keep = (previous: Entry<T>) => (previous.key === key && previous.resource.state !== "idle" ? previous.resource : null);
    setEntry((previous) => {
      const kept = keep(previous);
      return { key, resource: kept?.data !== undefined ? { state: "loading", data: kept.data, loadedAt: kept.loadedAt } : { state: "loading" } };
    });
    loader(controller.signal).then(
      (data) => {
        if (current) setEntry({ key, resource: { state: "ready", data, loadedAt: new Date() } });
      },
      (error: unknown) => {
        if (!current || (error as Error).name === "AbortError") return;
        const apiError = error instanceof ApiError ? error : new ApiError("server", null, String((error as Error).message ?? error));
        setEntry((previous) => {
          const kept = keep(previous);
          return { key, resource: { state: "error", error: apiError, data: kept?.data, loadedAt: kept?.loadedAt } };
        });
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
    // The loader is defined inline by callers; `key` captures its inputs.
  }, [key, epoch]);

  if (key === null) return { state: "idle" };
  // Until the effect has started a request for this key, nothing is known
  // about it: never hand out data that was loaded for another key.
  if (entry.key !== key) return { state: "loading" };
  return entry.resource;
}

type Loadable = { state: string; loadedAt?: Date };

/** Truthful refresh status for the resources on screen. */
export function refreshStatus(resources: Loadable[]): { kind: "refreshing" | "failed" | "updated" | "empty"; at?: Date } {
  const active = resources.filter((resource) => resource.state !== "idle");
  if (active.some((resource) => resource.state === "loading")) return { kind: "refreshing" };
  if (active.some((resource) => resource.state === "error")) return { kind: "failed" };
  const times = active.map((resource) => resource.loadedAt).filter((value): value is Date => value instanceof Date);
  if (times.length === 0) return { kind: "empty" };
  // The oldest data on screen bounds how fresh the whole view is.
  return { kind: "updated", at: new Date(Math.min(...times.map((time) => time.getTime()))) };
}
