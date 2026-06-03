// POST|GET /api/inngest
//
// Inngest serve route. Registers all background functions with the Inngest
// platform. Inngest polls this endpoint during development; in production,
// Inngest calls it to execute job steps.
//
// Environment variables required:
//   INNGEST_EVENT_KEY   — from Inngest dashboard → Event Keys
//   INNGEST_SIGNING_KEY — from Inngest dashboard → Signing Keys

import { serve } from 'inngest/next';
import { inngest } from '../lib/inngest.js';
import { compileConceptsJob, recompileStaleJob, detectSkillJob, nightlyLintJob } from '../lib/background-jobs.js';

export default serve({
  client:    inngest,
  functions: [compileConceptsJob, recompileStaleJob, detectSkillJob, nightlyLintJob],
});
