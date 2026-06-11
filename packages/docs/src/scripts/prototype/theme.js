/* Weave — shared theme toggle. Persists to localStorage["weave-theme"]. */
(function () {
  var KEY = "weave-theme";
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-toggle button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === theme));
    });
  }
  // re-apply saved theme on load
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === "light" || saved === "dark") apply(saved);

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-set]");
    if (!btn) return;
    var theme = btn.getAttribute("data-theme-set");
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}
  });
})();
