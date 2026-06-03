You are working on Lucille 3, a local-first screen-to-skills assistant.

Lucille records visible work activity at safe intervals, analyses the resulting screen observations locally, and offers to turn repeated work patterns into skills for Claude, Cursor, and ChatGPT. The product must feel helpful, transparent, and privacy-defensible.

Use a RALF loop.

## R - Requirements

Inspect the current repository before acting. Identify the smallest credible v1 blocker and address that blocker in this iteration.

Prioritize blockers in this order:

1. Basic project spine
   - `package.json`
   - TypeScript or plain JavaScript CLI
   - tests
   - README updates
   - Makefile compatibility

2. Safe Makefile workflow
   - `make capture`
   - `make analyse`
   - `make analyse DAY=YYYY-MM-DD`
   - `make analyse`
   - `make analyse OPENAI=1`

3. Privacy-safe capture lifecycle
   - visible capture controls
   - pause/resume/stop behavior
   - excluded apps/domains
   - no hidden monitoring
   - no keystroke logging
   - no clipboard capture
   - no audio capture

4. Local screenshot analysis
   - default local model read from `LUCILLE_LOCAL_MODEL` in `.env`
   - structured frame-level analysis
   - deterministic mock provider for tests and demos
   - raw media deleted after analysis unless debug retention is explicitly enabled

5. Hosted synthesis layer
   - optional only
   - enabled by explicit CLI flag or Makefile `OPENAI=1`
   - requires `OPENAI_API_KEY`
   - uses OpenAI Responses API
   - sends redacted structured frame/storyboard evidence, not raw screenshots by default
   - identifies repeated patterns of work across all local analysis
   - proposes skills for Claude, Cursor, and ChatGPT

6. Skill proposal and export
   - propose before writing tool-specific files
   - include evidence IDs and confidence
   - Claude export as a `SKILL.md` package
   - Cursor export as `.cursor/rules/*.mdc`
   - ChatGPT export as an instructions/knowledge/actions bundle

7. Demo and tests
   - deterministic fixtures
   - no real screen recording required for tests
   - privacy scans for forbidden fields
   - readable demo output

## A - Act

Implement the smallest useful vertical slice for the highest-priority blocker.

Prefer focused, boring implementation over broad refactors. Keep changes easy to inspect. Update docs and tests for any user-visible behavior.

Do not run or add destructive commands such as:

- `git reset --hard`
- `git checkout --`
- `rm -rf` against project or user directories
- force pushes

Do not capture or persist:

- raw keystrokes
- clipboard contents
- passwords
- cookies
- authentication tokens
- full URLs with query strings
- raw document bodies
- raw message bodies
- hidden background capture without clear user control

Use structured storage and validation for all persisted observations.

## L - Learn

Run the relevant checks after the change:

```bash
npm run typecheck --if-present
npm test --if-present
make analyse
node scripts/summarise-ralf-status.mjs
```

If there is no app scaffold yet, create the smallest scaffold first and keep `make analyse` graceful.

Inspect generated files when they exist:

- `storage/analysis/<DAY>/frame-analysis.jsonl`
- `storage/analysis/<DAY>/work-patterns.json`
- `storage/analysis/<DAY>/skill-proposals.json`
- `output/`
- `logs/ralf/`

## F - Fix

Repair failing tests, invalid JSON, weak privacy boundaries, confusing CLI behavior, missing Makefile compatibility, or demo regressions before ending the iteration.

At the end, report:

- the blocker addressed
- what changed
- what checks ran
- what still blocks v1
- the next recommended slice

Stay focused on v1 hardening. Do not build a polished desktop app, cloud backend, team dashboard, or autonomous workflow executor unless those are explicitly requested later.
