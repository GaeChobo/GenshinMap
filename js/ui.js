"use strict";

/* 테마 토글(라이트/다크) + 모바일 사이드바 드로어 — 디자인 핸드오프 스니펫 */

// ===== 테마 토글 =====
(function () {
  const root = document.documentElement;
  const KEY = "genshinmap-theme";
  const saved = localStorage.getItem(KEY);
  root.setAttribute("data-theme", saved || "auto"); // 'auto'는 CSS에서 prefers-color-scheme를 따름
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  function label() {
    const dark = getComputedStyle(root).colorScheme.includes("dark");
    btn.textContent = dark ? "☀" : "☾";
  }
  label();
  btn.addEventListener("click", function () {
    const cur = getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem(KEY, next);
    label();
  });
})();

// ===== 모바일 드로어 =====
(function () {
  const body = document.body;
  const menu = document.getElementById("menuToggle");
  const scrim = document.getElementById("sidebarScrim");
  if (menu) menu.addEventListener("click", () => body.classList.toggle("sidebar-open"));
  if (scrim) scrim.addEventListener("click", () => body.classList.remove("sidebar-open"));
  // 필터를 고르면 드로어 닫기(모바일)
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.addEventListener("click", (e) => {
    if (e.target.closest(".filter-row") && window.matchMedia("(max-width: 860px)").matches)
      body.classList.remove("sidebar-open");
  });
})();
