// Single source of truth for the product brand strings (server side).
//
// RENAME NOTE: the launch name is not finalised. When the owner confirms it,
// change BRAND_NAME / BRAND_BYLINE here and the new value flows to every
// runtime-rendered surface that imports this module (currently the share,
// invite, and workspace emails). The visible app chrome reads the matching
// client constant in public/brand.js.
//
// What this file CANNOT drive (static HTML <title>/<meta>, canonical URLs,
// schema.org, the MCP server name, OAuth identifiers, the domain) is listed
// in BRAND_AUDIT.md as the manual rename checklist. Keep public/brand.js and
// this file in sync.
export const BRAND_NAME = 'MyAITwin';
export const BRAND_BYLINE = 'by Luto';
export const BRAND_FULL = `${BRAND_NAME} ${BRAND_BYLINE}`;   // "MyAITwin by Luto"
export const BRAND_TITLE_SUFFIX = `· ${BRAND_NAME}`;          // "· MyAITwin"

// Canonical app origin. The runtime value already comes from process.env.APP_URL
// in every caller; this is the shared definition + production fallback.
export const APP_URL = (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');

// Bare host for display in email footers etc. (no scheme).
export const APP_HOST = APP_URL.replace(/^https?:\/\//, '');
