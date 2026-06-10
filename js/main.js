/* ============================================================
   main.js — app bootstrap: builds the persistent shell (sidebar +
   top bar), wires the hash router to screens (spec §1.4).
   ============================================================ */
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { initials } from "./format.js";
import { api } from "./store.js";
import * as router from "./router.js";
import { confirmDialog } from "./components/modal.js";
import { toastInfo, toastSuccess } from "./components/toast.js";

import { renderDashboard } from "./screens/dashboard.js";
import { renderVesselCalls } from "./screens/vesselCalls.js";
import { renderVesselCallDetail } from "./screens/vesselCallDetail.js";
import { renderInspections } from "./screens/inspections.js";
import { renderNewInspection } from "./screens/newInspection.js";
import { renderInvoices } from "./screens/invoices.js";
import { renderAnalytics } from "./screens/analytics.js";
import { renderSettings } from "./screens/settings.js";

const NAV = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard", path: "/dashboard" },
  { key: "vessel-calls", label: "Vessel Calls", icon: "ship", path: "/vessel-calls" },
  { key: "inspections", label: "Inspections", icon: "clipboard", path: "/inspections" },
  { key: "invoices", label: "Invoices", icon: "invoice", path: "/invoices" },
  { key: "analytics", label: "Analytics", icon: "gauge", path: "/analytics" },
  { key: "settings", label: "Settings", icon: "settings", path: "/settings" },
];

const user = api.getUser();

/* ---------------- Popover helper ---------------- */

function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach((p) => p._close && p._close());
}

function openPopover(anchor, contentNode) {
  closeAllPopovers();
  const rect = anchor.getBoundingClientRect();
  const pop = h("div.popover", { style: { position: "fixed", top: `${rect.bottom + 8}px`, visibility: "hidden" } }, contentNode);
  document.body.appendChild(pop);
  let left = rect.right - pop.offsetWidth;
  left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
  pop.style.left = `${left}px`;
  pop.style.visibility = "visible";

  const close = () => {
    pop.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    // Keyboard users land back where they opened the menu from
    if (anchor && typeof anchor.focus === "function") anchor.focus();
  };
  const onDoc = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const focusables = () =>
    [...pop.querySelectorAll("button, a[href], input, [tabindex]")].filter(
      (n) => !n.disabled
    );
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = focusables();
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next =
        e.key === "ArrowDown"
          ? items[(i + 1) % items.length]
          : items[(i - 1 + items.length) % items.length];
      next.focus();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);
  // Move focus into the menu so keyboard users can operate it
  requestAnimationFrame(() => {
    const first = focusables()[0];
    if (first) first.focus();
  });
  pop._close = close;
  return { close, el: pop };
}

/* ---------------- Shell ---------------- */

let currentPort = "Port of Calabar";

function buildSidebar(navLinks) {
  const brand = h(
    "a.brand",
    { href: "#/dashboard", "aria-label": "Vessel Caller — home" },
    h("span.brand__glyph", icon("anchor", { size: 20 })),
    h(
      "span.brand__text",
      h("span.brand__name", "Vessel Caller"),
      h("span.brand__sub", "Calabar Port · Inspection")
    )
  );

  const nav = h(
    "nav.nav",
    { "aria-label": "Primary" },
    h("div.nav__section-label", "Operations"),
    NAV.map((item) => {
      const link = h(
        "a.nav-item",
        { href: `#${item.path}`, "data-key": item.key },
        icon(item.icon, { size: 20 }),
        h("span.nav-item__label", item.label)
      );
      navLinks[item.key] = link;
      link.addEventListener("click", closeDrawer);
      return link;
    })
  );

  const userCard = h(
    "div.user-card",
    h("span.avatar", initials(user.name)),
    h(
      "div.user-card__meta",
      h("div.user-card__name", user.name),
      h("div.user-card__role", user.role)
    ),
    h(
      "button.icon-btn.user-card__signout",
      {
        type: "button",
        onClick: signOut,
        "aria-label": "Sign out",
        title: "Sign out",
        style: { width: "32px", height: "32px" },
      },
      icon("log-out", { size: 18 })
    )
  );

  return h("aside.sidebar", { id: "sidebar" }, brand, nav, userCard);
}

function buildTopbar(titleEl) {
  const hamburger = h(
    "button.hamburger",
    { type: "button", "aria-label": "Open menu", onClick: openDrawer },
    icon("menu", { size: 20 })
  );

  const portBtn = h(
    "button.port-select",
    { type: "button", "aria-haspopup": "true" },
    icon("anchor", { size: 18 }),
    h("span", currentPort),
    icon("chevron-down", { size: 16 })
  );
  portBtn.addEventListener("click", () => openPortMenu(portBtn));

  const bell = h(
    "button.icon-btn",
    { type: "button", "aria-label": "Notifications", "aria-haspopup": "true" },
    icon("bell", { size: 20 }),
    h("span.icon-btn__dot", { id: "bell-dot" })
  );
  bell.addEventListener("click", () => openNotifications(bell));

  const userBtn = h(
    "button.icon-btn",
    {
      type: "button",
      "aria-label": "Account menu",
      "aria-haspopup": "true",
      style: { width: "auto", padding: "0 4px" },
    },
    h("span.avatar", { style: { width: "32px", height: "32px", fontSize: "12px" } }, initials(user.name))
  );
  userBtn.addEventListener("click", () => openUserMenu(userBtn));

  return h(
    "header.topbar",
    hamburger,
    titleEl,
    h("div.topbar__spacer"),
    h("div.topbar__right", portBtn, bell, userBtn)
  );
}

/* ---------------- Topbar menus ---------------- */

function openPortMenu(anchor) {
  const settingsPromise = api.getSettings();
  const list = h("div", h("div.menu-head", h("div.menu-head__title", "Switch location")));
  settingsPromise.then((s) => {
    const ports = [s.port.name, "Port Harcourt", "Lagos (Apapa)", "Onne Port"];
    ports.forEach((p) => {
      const item = h(
        "button",
        { class: "menu-item" + (p === currentPort ? " is-active" : ""), type: "button" },
        icon("map-pin", { size: 16 }),
        h("span", p),
        p === currentPort ? icon("check", { size: 16 }) : null
      );
      item.addEventListener("click", () => {
        currentPort = p;
        anchor.querySelector("span").textContent = p;
        closeAllPopovers();
        toastInfo("Location switched", `Now viewing ${p}.`);
      });
      list.appendChild(item);
    });
  });
  openPopover(anchor, list);
}

function openNotifications(anchor) {
  const items = [
    { title: "Invoice INV-2026-0441 is unpaid", time: "2 hours ago" },
    { title: "Inspection INS-2026-0024 completed", time: "Yesterday" },
    { title: "MT Cross River berthed at Calabar Oil Terminal", time: "2 days ago" },
  ];
  const body = h(
    "div",
    h(
      "div.menu-head",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      h("div.menu-head__title", "Notifications"),
      h(
        "button.link-quiet",
        {
          type: "button",
          onClick: () => {
            const dot = document.getElementById("bell-dot");
            if (dot) dot.style.display = "none";
            closeAllPopovers();
          },
        },
        "Mark all read"
      )
    ),
    items.map((n) =>
      h(
        "div.notif-item",
        h("span.notif-item__dot"),
        h("div", h("div.notif-item__title", n.title), h("div.notif-item__time", n.time))
      )
    )
  );
  openPopover(anchor, body);
}

function openUserMenu(anchor) {
  const body = h(
    "div",
    h(
      "div.menu-head",
      h("div.menu-head__title", user.name),
      h("div.menu-head__sub", `${user.role} · ${currentPort}`)
    ),
    h("div.menu-sep"),
    menuLink("settings", "Settings", () => router.navigate("/settings")),
    h(
      "button.menu-item.menu-item--danger",
      { type: "button", onClick: signOut },
      icon("log-out", { size: 16 }),
      "Sign out"
    )
  );
  openPopover(anchor, body);
}

function menuLink(ic, label, onClick) {
  return h(
    "button.menu-item",
    {
      type: "button",
      onClick: () => {
        closeAllPopovers();
        onClick();
      },
    },
    icon(ic, { size: 16 }),
    label
  );
}

function signOut() {
  closeAllPopovers();
  confirmDialog({
    title: "Sign out?",
    message: "You will need to sign in again to access the platform.",
    confirmLabel: "Sign out",
  }).then((ok) => {
    if (ok) toastSuccess("Signed out", "This is a demo — you remain signed in.");
  });
}

/* ---------------- Unsaved-changes nav guard (spec §1.9) ----------------
   A screen (e.g. Settings) sets window.__navGuard = () => isDirty.
   The guard is centralised in the router's beforeNavigate hook, so EVERY
   hash navigation path is covered: sidebar links, the brand link, row
   "Open" links, programmatic navigate(), and browser back/forward. */
router.setBeforeNavigate((targetHash) => {
  if (typeof window.__navGuard === "function" && window.__navGuard()) {
    confirmDialog({
      title: "Discard unsaved changes?",
      message: "You have unsaved changes on this page. Leave without saving?",
      confirmLabel: "Leave",
      danger: true,
    }).then((ok) => {
      if (ok) {
        window.__navGuard = null;
        router.navigate(targetHash.replace(/^#/, ""));
      }
    });
    return false; // block now; re-navigate above if confirmed
  }
  return true;
});

/* ---------------- Mobile drawer ---------------- */

let scrim = null;
function openDrawer() {
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.add("is-open");
  scrim = h("div.scrim", { onClick: closeDrawer });
  document.body.appendChild(scrim);
}
function closeDrawer() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("is-open");
  if (scrim) {
    scrim.remove();
    scrim = null;
  }
}

/* ---------------- Boot ---------------- */

function boot() {
  const app = document.getElementById("app");
  const navLinks = {};
  const titleEl = h("span.topbar__title", "Dashboard");
  const contentInner = h("div.content__inner");
  const content = h("div.content", { id: "scroll-region" }, contentInner);

  const shell = h(
    "div.app-shell",
    buildSidebar(navLinks),
    h("div.main", buildTopbar(titleEl), content)
  );
  app.replaceChildren(shell);
  app.removeAttribute("aria-busy");

  function setActive(key) {
    Object.entries(navLinks).forEach(([k, link]) =>
      link.classList.toggle("is-active", k === key)
    );
    const item = NAV.find((n) => n.key === key);
    if (item) setTitle(item.label);
  }
  function setTitle(title) {
    titleEl.textContent = title;
    document.title = `${title} · Calabar Port`;
  }

  const mkCtx = (r, key) => ({
    content: contentInner,
    params: r.params || {},
    query: r.query || {},
    setTitle,
    setActive: () => setActive(key),
    navigate: router.navigate,
    scrollTop: () => (content.scrollTop = 0),
  });

  const screen = (key, fn) => (r) => {
    closeAllPopovers();
    closeDrawer();
    window.__navGuard = null; // reset any prior screen's unsaved guard
    setActive(key);
    content.scrollTop = 0;
    fn(mkCtx(r, key));
  };

  router.register("/dashboard", screen("dashboard", renderDashboard));
  router.register("/vessel-calls", screen("vessel-calls", renderVesselCalls));
  router.register("/vessel-calls/:id", screen("vessel-calls", renderVesselCallDetail));
  router.register("/inspections/new", screen("inspections", renderNewInspection));
  router.register("/inspections", screen("inspections", renderInspections));
  router.register("/invoices", screen("invoices", renderInvoices));
  router.register("/analytics", screen("analytics", renderAnalytics));
  router.register("/settings", screen("settings", renderSettings));

  router.setNotFound((r) => {
    setActive("dashboard");
    contentInner.replaceChildren(
      h(
        "div.empty",
        { style: { paddingTop: "80px" } },
        h("div.empty__icon", icon("alert-circle", { size: 20 })),
        h("div.empty__title", "Page not found"),
        h("p.empty__body", `No screen matches “${r.path}”.`),
        h("a.btn.btn--primary", { href: "#/dashboard" }, "Back to dashboard")
      )
    );
  });

  router.start();
}

boot();
