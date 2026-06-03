You are working on Lucille 3, a local-first screen-to-skills assistant.

This is the MMP readiness RALF loop. The previous hardening loop created the project spine, safe capture lifecycle state, deterministic analysis, optional OpenAI synthesis, and approval-gated skill export. Your job now is to close the remaining MMP blockers without weakening privacy.

Use a RALF loop.

## R - Requirements

Inspect the current repository before acting. Identify the smallest credible MMP blocker and address that blocker in this iteration.

The remaining blockers are:

1. Real capture ingestion gate
   - `make capture` and `make capture-once` must move beyond state-only scaffolding where safely possible.
   - Prefer a transparent local capture command that is explicitly user-invoked, never hidden.
   - Captured raw media must be day-scoped under `storage/captures/<DAY>/raw-media/`.
   - Every captured frame must produce a structured `observation.v1` record under `storage/captures/<DAY>/observations.jsonl`.
   - Persist only safe structured metadata: observation id, timestamp, app/window hints if available, host-only domains, visible summary, redacted signals, and evidence ids.
   - Never persist keystrokes, clipboard contents, audio, passwords, cookies, auth tokens, full URLs with query strings, raw document bodies, raw message bodies, or hidden background capture.
   - Enforce excluded apps and domains before persisted observations reach analysis.

2. Real local visual model provider plumbing
   - Keep the default local model in `LUCILLE_LOCAL_MODEL` in `.env`.
   - Add a real provider path that can call a local model service when available, preferably Ollama if present.
   - Keep deterministic mock mode for tests, demos, and unavailable local models.
   - Fail clearly when the user explicitly requests a real provider that is unavailable.
   - Send only local raw media to local analysis. Do not send raw screenshots to OpenAI by default.

3. MMP user-facing workflow
   - `make capture`
   - `make capture-once`
   - `make analyse DAY=YYYY-MM-DD`
   - `make analyse OPENAI=1`
   - `make report DAY=YYYY-MM-DD`
   - `make export-skill DAY=YYYY-MM-DD APPROVE_EXPORT=1`
   - The happy path should be explainable in the README and deterministic without paid services.

4. MMP quality bar
   - Tests must cover privacy boundaries, ingestion, provider selection, and skill export.
   - Demo fixtures must be readable.
   - `node scripts/summarise-ralf-status.mjs` should report MMP readiness, not just scaffold readiness.
   - Generated artifacts must be valid JSON or Markdown.

## A - Act

Implement the smallest useful vertical slice for the highest-priority remaining blocker.

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
- audio

Use structured storage and validation for all persisted observations.

If implementing macOS capture, prefer built-in tools such as `screencapture` and make failures clear when screen recording permission is missing. Do not try to bypass OS permissions.

## L - Learn

Run the relevant checks after the change:

```bash
npm run typecheck --if-present
npm test --if-present
make analyse
node scripts/summarise-ralf-status.mjs
```

Also run any new MMP smoke commands that are safe in a headless or permission-limited environment. For real capture, tests may use fixtures and dependency injection rather than forcing a screen recording permission prompt.

Inspect generated files when they exist:

- `storage/captures/<DAY>/observations.jsonl`
- `storage/captures/<DAY>/raw-media/`
- `storage/analysis/<DAY>/frame-analysis.jsonl`
- `storage/analysis/<DAY>/work-patterns.json`
- `storage/analysis/<DAY>/skill-proposals.json`
- `output/`
- `logs/ralf/`

## F - Fix

Repair failing tests, invalid JSON, weak privacy boundaries, confusing CLI behavior, missing Makefile compatibility, or demo regressions before ending the iteration.

At the end, report:

- the MMP blocker addressed
- what changed
- what checks ran
- what still blocks MMP
- the next recommended slice

Do not call the product MMP-ready until real capture ingestion, local visual provider plumbing, privacy enforcement, reports, and skill export all have tested happy paths.
