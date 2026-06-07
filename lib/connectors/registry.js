// Provider registry — the single source of truth the Connections UI and the API
// routes read from. Metadata only (auth type, plan-gating, honest consent copy);
// the actual sync logic lives in each provider module (lib/connectors/<id>.js).
//
// `status`:
//   'available'   — fully wired; users can connect today.
//   'coming-soon' — listed so the UI is honest about the roadmap, but connect is
//                   disabled (Fathom OAuth app / Zoom app-review still pending).

export const PROVIDERS = [
  {
    id:        'fireflies',
    label:     'Fireflies',
    status:    'available',
    auth_type: 'api_key',
    blurb:     'Pull your meeting transcripts from Fireflies into your twin, and keep new ones flowing in automatically.',
    auth_help: 'Find your API key in Fireflies → Settings → Developer Settings (or Integrations → Fireflies API).',
    plan_note: null,
    consent:   'Imports transcripts of your own meetings. Transcripts contain other people’s words and private conversations — only connect meetings you’re comfortable storing in your twin.',
  },
  {
    id:        'fathom',
    label:     'Fathom',
    status:    'coming-soon',
    auth_type: 'oauth',
    blurb:     'Connect Fathom to import your recorded call transcripts.',
    auth_help: 'Sign in with Fathom — no API key needed.',
    plan_note: null,
    consent:   'Imports transcripts of your own recorded calls.',
  },
  {
    id:        'granola',
    label:     'Granola',
    status:    'coming-soon',
    auth_type: 'api_key',
    blurb:     'Import your Granola meeting notes and transcripts.',
    auth_help: 'Paste your Granola API key.',
    plan_note: 'Transcript access requires a Granola Business plan.',
    consent:   'Imports your own meeting notes and transcripts.',
  },
  {
    id:        'zoom',
    label:     'Zoom',
    status:    'coming-soon',
    auth_type: 'oauth',
    blurb:     'Import transcripts from your Zoom cloud recordings.',
    auth_help: 'Sign in with Zoom — no API key needed.',
    plan_note: 'Requires a Pro-or-above Zoom plan with cloud recording enabled.',
    consent:   'Imports transcripts from your own Zoom cloud recordings.',
  },
];

// Providers whose server-side sync is wired today. Routes refuse connect/sync
// for anything not in here even if the UI somehow posts it.
export const LIVE_PROVIDERS = new Set(['fireflies']);

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

export function isLive(id) {
  return LIVE_PROVIDERS.has(id);
}
