// Roulib native shell (iOS / Android, Capacitor). Does nothing in a normal browser.
// In the app the page comes from the bundle (capacitor://localhost), so API calls go to the hosted backend,
// which holds every API key. No key ever ships inside the app.
"use strict";
(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  window.ROULIB_NATIVE = cap.getPlatform();
  // Page served from the app bundle (capacitor://localhost on iOS, https://localhost on Android): call the hosted API.
  // During live reload the page comes from a dev server (with a port): keep same-origin calls.
  const bundled = location.protocol === "capacitor:" || (location.hostname === "localhost" && !location.port);
  if (bundled) window.ROULIB_API = "https://roulib-gray.vercel.app";  // Vercel project "roulib" (luigi). Holds every key; see deploy/CHECKLIST.md
  document.documentElement.classList.add("native", "native-" + window.ROULIB_NATIVE);
  const P = cap.Plugins || {};

  // Location through the native plugin: one system prompt, no "capacitor://localhost wants your location" dialog.
  const G = P.Geolocation;
  if (G && navigator.geolocation) {
    const pos = (p) => ({ coords: p.coords, timestamp: p.timestamp });
    const err = (e) => ({ code: /denied|permission/i.test(String(e && e.message)) ? 1 : 2, message: String((e && e.message) || e) });
    const watches = new Map(); let n = 0;
    // Without a network location provider (some phones indoors, emulators) a low-accuracy fix can time out: retry with GPS once.
    navigator.geolocation.getCurrentPosition = (ok, ko, o) => {
      const opts = o || {};
      G.getCurrentPosition(opts).catch((e) => (err(e).code === 1 || opts.enableHighAccuracy ? Promise.reject(e) : G.getCurrentPosition({ ...opts, enableHighAccuracy: true })))
        .then((p) => ok(pos(p)), (e) => ko && ko(err(e)));
    };
    navigator.geolocation.watchPosition = (ok, ko, o) => {
      const id = ++n;
      G.watchPosition(o || {}, (p, e) => (e ? ko && ko(err(e)) : p && ok(pos(p)))).then((cid) => watches.set(id, cid));
      return id;
    };
    navigator.geolocation.clearWatch = (id) => { const cid = watches.get(id); if (cid) G.clearWatch({ id: cid }); watches.delete(id); };
  }

  // A light tap on every main button, like native apps.
  const H = P.Haptics;
  if (H) document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("button, .btn, [role=button]")) H.impact({ style: "LIGHT" }).catch(() => {}); }, true);

  // Links to other sites open in the in-app browser instead of replacing the app.
  const B = P.Browser;
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href^='http']");
    if (!a || !B) return;
    e.preventDefault(); B.open({ url: a.href, presentationStyle: "popover" }).catch(() => { location.href = a.href; });
  }, true);

  // Status bar matches the light ground; the splash screen hides once the page is drawn.
  P.StatusBar && P.StatusBar.setStyle({ style: "LIGHT" }).catch(() => {});
  // Hide the launch screen as soon as the first screen is painted, not after every map script and font has loaded.
  const hideSplash = () => requestAnimationFrame(() => requestAnimationFrame(() => P.SplashScreen && P.SplashScreen.hide({ fadeOutDuration: 180 }).catch(() => {})));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hideSplash, { once: true }); else hideSplash();
})();
