// Single source of truth for the product brand strings (client side).
//
// Mirrors lib/brand.js. The visible app chrome (header logo lockup) reads from
// window.BRAND so a rename is a one-line change here. On load this fills any
// header lockup already in the DOM (the .logo-name / .logo-by spans every
// authenticated page ships) and re-fills lockups injected later (the shared
// header in surface-nav.js) via applyBrand().
//
// RENAME NOTE: change NAME / BYLINE here and in lib/brand.js together. Static
// <title>/<meta> tags and infra identifiers are NOT driven by this file; see
// BRAND_AUDIT.md for the full manual rename checklist.
(function () {
  const BRAND = {
    NAME: 'MyAITwin',
    BYLINE: 'by Luto',
  };
  BRAND.FULL = BRAND.NAME + ' ' + BRAND.BYLINE;
  BRAND.TITLE_SUFFIX = '· ' + BRAND.NAME;
  window.BRAND = BRAND;

  // Fill every header lockup currently in the DOM from the constant. Idempotent
  // and safe to call again after injecting a header. Only touches text content.
  function applyBrand(root) {
    (root || document).querySelectorAll('.logo-name').forEach(el => { el.textContent = BRAND.NAME; });
    (root || document).querySelectorAll('.logo-by').forEach(el => { el.textContent = BRAND.BYLINE; });
  }
  BRAND.apply = applyBrand;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyBrand());
  } else {
    applyBrand();
  }
})();
