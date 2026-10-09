// Runs before first paint. Mirrors src/theme.ts: "light" | "dark" pin the
// theme, anything else (or no storage) follows the system preference.
(function () {
  try {
    var preference = window.localStorage.getItem("triad-cockpit-theme");
    if (preference === "light" || preference === "dark") document.documentElement.setAttribute("data-theme", preference);
  } catch (error) {
    /* storage unavailable: follow the system preference */
  }
})();
