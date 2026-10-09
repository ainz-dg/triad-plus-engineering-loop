// Theme preference: "system" follows prefers-color-scheme through CSS; "light"
// and "dark" pin it with data-theme. public/theme-init.js applies the stored
// value before first paint, so there is no flash on load.

export type ThemePreference = "system" | "light" | "dark";
const KEY = "triad-cockpit-theme";

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  try {
    if (preference === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, preference);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}
