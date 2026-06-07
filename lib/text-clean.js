// Server-side dash stripping for stored + compiled text.
//
// The founder's hardest rule: no em dashes (U+2014) and no en dashes (U+2013),
// anywhere a user can see them. The client chat sanitiser enforces this on twin
// replies; these helpers enforce the same on the OTHER write paths — stored item
// titles and the compiled concept/synthesis pages — so a value reads identically
// wherever it surfaces (Recent, chat welcome, citations, the page itself).
//
// Not in public/, so it is not scanned by scripts/lint-dashes.mjs; the dash
// literals below are the matchers that remove dashes, not user-facing copy.

// Prose: an em dash becomes a sentence break, an en dash a comma. Mirrors the
// client sanitiser (public/twin.html sanitizeTwinText) exactly.
export function stripDashes(text) {
  return String(text == null ? '' : text)
    .replace(/—/g, '. ')   // em dash -> sentence break
    .replace(/–/g, ', ')   // en dash -> comma
    .replace(/\s+\./g, '.')     // tidy spacing the substitution can leave
    .replace(/\.\s*\./g, '.');
}

// Titles never carry a sentence break: join the two phrases with a comma, the
// way the founder rewrites a dash in a heading.
export function cleanTitle(text) {
  if (text == null) return text;
  return String(text)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
