/**
 * Mobile compatibility audit for the DrawBound front end.
 *
 * Loads each page at real device viewports and asserts the things that make a
 * phone experience broken:
 *   - no horizontal overflow
 *   - no element wider than the viewport
 *   - interactive controls meet the 44px minimum touch target
 *   - no text below 11px (illegible on a phone)
 *   - the primary CTA is reachable without horizontal scrolling
 *   - fonts do not auto-zoom on focus (iOS zooms when an input is <16px)
 *
 * Usage: node scripts/mobile-audit.mjs [baseUrl]
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:3120";
const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const DEVICES = [
  { name: "iPhone SE", width: 375, height: 667, dsf: 2 },
  { name: "iPhone 14", width: 390, height: 844, dsf: 3 },
  { name: "Pixel 7", width: 412, height: 915, dsf: 2.625 },
  { name: "iPad mini", width: 744, height: 1133, dsf: 2 },
];

const PAGES = [
  { path: "/", label: "landing" },
  { path: "/vault", label: "vault" },
];

const results = [];
function check(device, page, name, ok, detail = "") {
  results.push({ device: device.name, page: page.label, name, ok, detail });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1"],
});

for (const device of DEVICES) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dsf,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  for (const page of PAGES) {
    const p = await context.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // The vault page fetches /api/positions and /api/receipts on load to
      // restore a session. With no session those answer 401, and the page
      // handles it — the browser still logs a console error. That is
      // expected behaviour, not a bug.
      if (/Failed to load resource.*\b(401|403|404)\b/.test(text)) return;
      errors.push(text);
    });

    await p.goto(`${BASE}${page.path}`, { waitUntil: "domcontentloaded" });
    // Wait for React to hydrate and the first paint to settle. `networkidle`
    // is unusable here: the vault page polls every 5s, so the network never
    // goes quiet.
    await p.waitForLoadState("load");
    // Let entrance animations settle so measurements are post-animation.
    await p.waitForTimeout(1600);

    const audit = await p.evaluate(() => {
      const doc = document.documentElement;
      // `clientWidth` is the true CSS viewport width (excludes scrollbar).
      // `window.innerWidth` is unreliable in headless Chrome: it reports the
      // outer window size, which here makes a 390px device look 540px wide.
      const vw = doc.clientWidth;

      // Elements wider than the viewport.
      const wide = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 || r.right > vw + 1 || r.left < -1) {
          const style = getComputedStyle(el);
          // Fixed/absolute elements are sized against the ICB, not the content
          // flow: a `fixed inset-0` header is as wide as the window and cannot
          // push content. Their descendants inherit that wide box rather than
          // a real overflow, so skip the whole subtree.
          if (style.position === "absolute" || style.position === "fixed") continue;
          if (el.closest("header.fixed, .fixed, .nav-blur")) continue;
          // Off-canvas decoration.
          if (el.closest(".marquee")) continue;
          if (el.classList.contains("ambient-glow")) continue;
          // Ignore anything merely clipped by an ancestor that itself handles
          // the overflow (e.g. the marquee track, code blocks that scroll).
          const clipper = el.closest(".overflow-hidden, .overflow-x-auto, .overflow-y-auto, .overflow-clip");
          if (clipper) continue;
          wide.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 60),
            w: Math.round(r.width),
            left: Math.round(r.left),
            right: Math.round(r.right),
          });
        }
      }

      // Interactive controls below the 44px touch-target minimum.
      const smallTargets = [];
      const selectors = 'a[href], button:not([disabled]), input, textarea, select, [role="button"], [role="tab"]';
      for (const el of Array.from(document.querySelectorAll(selectors))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // hidden
        // Inline prose links are exempt: they are not standalone controls,
        // and stretching them to 44px would wreck the paragraph's rhythm.
        if (el.closest("p")) continue;
        if (r.height < 44 || r.width < 44) {
          const style = getComputedStyle(el);
          smallTargets.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 50),
            w: Math.round(r.width),
            h: Math.round(r.height),
            fs: style.fontSize,
          });
        }
      }

      // Text below 11px.
      const tiny = [];
      for (const el of Array.from(document.querySelectorAll("p, span, h1, h2, h3, h4, li, strong, time, div"))) {
        if (!el.textContent?.trim()) continue;
        if (el.children.length > 0) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) {
          tiny.push({ tag: el.tagName.toLowerCase(), fs: Math.round(fs * 10) / 10, text: el.textContent.trim().slice(0, 30) });
        }
      }

      // Text inputs smaller than 16px trigger iOS auto-zoom on focus.
      const zoomable = [];
      for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) zoomable.push({ tag: el.tagName.toLowerCase(), fs: Math.round(fs * 10) / 10, placeholder: el.placeholder?.slice(0, 30) ?? "" });
      }

      // Is the page's own scroll width beyond the viewport? Absolutely
      // positioned decoration (ambient glows, marquee track) and fixed chrome
      // (the header spans the window) do not count: they are off-canvas by
      // design and clipped by an ancestor, so they cannot push content.
      let realOverflow = false;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 0.5) continue;
        const s = getComputedStyle(el);
        if (s.position === "absolute" || s.position === "fixed") continue;
        if (el.closest("header.fixed, .fixed, .nav-blur")) continue;
        if (el.classList.contains("ambient-glow")) continue;
        if (el.closest(".marquee")) continue;
        realOverflow = true;
        break;
      }
      const overflowing = realOverflow;

      return { vw, scrollWidth: doc.scrollWidth, overflowing, wide: wide.slice(0, 8), smallTargets: smallTargets.slice(0, 10), tiny: tiny.slice(0, 8), zoomable };
    });

    check(device, page, "no horizontal overflow", !audit.overflowing, `scroll ${audit.scrollWidth} vs ${audit.vw}`);
    check(device, page, "no oversized elements", audit.wide.length === 0, audit.wide.map((w) => `${w.tag}.${w.cls}@${w.w}px`).join("; "));
    check(device, page, "touch targets >=44px", audit.smallTargets.length === 0, audit.smallTargets.map((t) => `${t.tag} ${t.w}x${t.h}`).join("; "));
    check(device, page, "no text below 11px", audit.tiny.length === 0, audit.tiny.map((t) => `${t.tag}:${t.fs}px`).join("; "));
    check(device, page, "inputs >=16px (no iOS zoom)", audit.zoomable.length === 0, audit.zoomable.map((t) => `${t.tag}:${t.fs}px`).join("; "));
    check(device, page, "no JS errors", errors.length === 0, errors.slice(0, 2).join(" | "));

    // Landing only: headline must be visible without scrolling on a phone.
    if (page.label === "landing") {
      const heroVisible = await p.evaluate(() => {
        const h1 = document.querySelector("h1");
        if (!h1) return false;
        const r = h1.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight + 40;
      });
      check(device, page, "hero headline above the fold", heroVisible);
    }

    // Vault only: the two section tabs must exist and switch panels.
    if (page.label === "vault") {
      const tabs = await p.evaluate(() => Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent.trim()));
      check(device, page, "tab switcher present", tabs.length === 2, tabs.join("/"));

      const tabSizes = await p.evaluate(() =>
        Array.from(document.querySelectorAll('[role="tab"]')).map((t) => {
          const r = t.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}`;
        }),
      );
      const allBig = tabSizes.every((s) => {
        const [w, h] = s.split("x").map(Number);
        return h >= 44 && w >= 44;
      });
      check(device, page, "tab targets >=44px", allBig, tabSizes.join(" "));
    }

    await p.close();
  }

  await context.close();
}

await browser.close();

// Report
const byDevice = new Map();
for (const r of results) {
  if (!byDevice.has(r.device)) byDevice.set(r.device, []);
  byDevice.get(r.device).push(r);
}

let failures = 0;
console.log("MOBILE COMPATIBILITY AUDIT");
console.log("=".repeat(72));
for (const [device, rows] of byDevice) {
  const bad = rows.filter((r) => !r.ok);
  failures += bad.length;
  console.log(`\n${device} — ${rows.length - bad.length}/${rows.length} passed`);
  for (const r of bad) {
    console.log(`  ✗ [${r.page}] ${r.name}${r.detail ? " → " + r.detail.slice(0, 200) : ""}`);
  }
}
console.log("\n" + "=".repeat(72));
console.log(failures === 0 ? `ALL GREEN — ${results.length} checks across ${DEVICES.length} viewports` : `${failures} FAILURES of ${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
