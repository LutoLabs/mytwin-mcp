// Build-time guard for the founder's hardest rule: NO em dashes (U+2014) and NO
// en dashes (U+2013), anywhere a user can see them. Fails the build if any are
// found in user-facing strings of the shipped surfaces.
//
// It strips comments (HTML, CSS, JS block + line) before checking, so invisible
// code comments don't trip it — only rendered copy, attributes, and JS string
// literals are linted. Prototype/retired pages are skipped.
//
// Run:  node scripts/lint-dashes.mjs        (exit 1 if any found)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public';
// Not shipped / not in nav: experiments + the retired account page.
const SKIP = new Set([
  'activation.html', 'activation-next.html', 'activation-v3.html',
  'home-next.html', 'account.html',
]);
const DASH = /[—–]|&mdash;|&ndash;|&#x?201[34];|&#821[12];/i;

// Replace a matched span with same-length spaces (keeps line numbers honest).
const blank = (m) => m.replace(/[^\n]/g, ' ');

function stripComments(src, isHtml) {
  let s = src;
  if (isHtml) s = s.replace(/<!--[\s\S]*?-->/g, blank).replace(/<style[\s\S]*?<\/style>/gi, blank);
  s = s.replace(/\/\*[\s\S]*?\*\//g, blank);          // CSS/JS block comments
  s = s.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length))); // JS line comments
  return s;
}

const files = readdirSync(DIR)
  .filter((f) => /\.(html|js)$/.test(f) && !SKIP.has(f))
  .sort();

const hits = [];
for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8');
  const rawLines = raw.split('\n');
  const code = stripComments(raw, f.endsWith('.html'));
  code.split('\n').forEach((line, i) => {
    // A line may opt out only where a dash is genuinely required and not user
    // facing (e.g. the chat sanitiser's own dash-matching regex). Checked on the
    // raw line, since the marker lives in a (stripped) comment.
    if ((rawLines[i] || '').includes('lint-allow-dash')) return;
    if (DASH.test(line)) hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 110) });
  });
}

if (hits.length) {
  console.error(`\n✗ Found ${hits.length} em/en dash(es) in user-facing strings (banned):\n`);
  for (const h of hits) console.error(`  public/${h.file}:${h.line}  ${h.text}`);
  console.error('\nRewrite each (comma, full stop, or a reworded sentence). No em (—) or en (–) dashes, anywhere.\n');
  process.exit(1);
}
console.log('✓ No em/en dashes in user-facing strings across shipped surfaces.');
