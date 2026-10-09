// Vitest + Testing Library: cleanup runs automatically with `globals: true`.
//
// Node >= 25 defines its own experimental `localStorage` global (undefined
// without --localstorage-file), which shadows jsdom's. Point the test global
// back at jsdom's Web Storage so the UI sees a browser-like environment on
// every supported Node version.
const dom = (globalThis as unknown as { jsdom?: { window: Window } }).jsdom;
if (dom && !globalThis.localStorage) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
}
export {};
