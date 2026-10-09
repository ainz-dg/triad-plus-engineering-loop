import { useEffect, useState } from "react";
import { ApiError } from "./api";

export type Resource<T> =
  | { state: "loading"; data?: T }
  | { state: "ready"; data: T }
  | { state: "error"; error: ApiError; data?: T };

/**
 * Load `key` with `loader`; reload when `key` or `epoch` changes. Previous
 * data stays visible while a refresh is in flight, so refresh never blanks
 * the screen.
 */
export function useResource<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>, epoch: number): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ state: "loading" });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setResource((previous) => ({ state: "loading", data: previous.data }));
    loader(controller.signal).then(
      (data) => setResource({ state: "ready", data }),
      (error: unknown) => {
        if ((error as Error).name === "AbortError") return;
        const apiError = error instanceof ApiError ? error : new ApiError("server", null, String((error as Error).message ?? error));
        setResource({ state: "error", error: apiError });
      },
    );
    return () => controller.abort();
    // The loader is defined inline by callers; `key` captures its inputs.
  }, [key, epoch]);
  return resource;
}
