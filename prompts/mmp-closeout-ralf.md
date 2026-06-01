You are working on Lucille 3, a local-first screen-to-skills assistant.

This is the MMP closeout RALF loop. Previous loops built the local capture, local analysis, optional OpenAI synthesis, reports, skill export, MMP status, and privacy gates. Your job is to close the remaining MMP blockers without faking evidence or weakening privacy.

Use a RALF loop.

## R - Requirements

Inspect the current repository before acting. Identify the smallest credible blocker and address it in this iteration.

The remaining blockers are:

1. Operator-controlled real capture evidence
   - The project needs a clear smoke workflow for real `make capture` / `make capture-once`.
   - Real capture must be explicit, visible, and operator-controlled.
   - Do not capture unless the command is unmistakably gated by an explicit acknowledgement environment variable such as `LUCILLE_REAL_CAPTURE_ACK=1`.
   - Captured raw media must be day-scoped under `storage/captures/<DAY>/raw-media/`.
   - Every captured frame must have a structured `observation.v1` record under `storage/captures/<DAY>/observations.jsonl`.
   - Excluded apps/domains must be enforced before capture and again before analysis.

2. Real local visual provider smoke evidence
   - Prefer Ollama at `http://127.0.0.1:11434`.
   - Keep `qwen2.5vl:7b` as the default model.
   - Do not send raw screenshots to OpenAI.
   - A real provider smoke should fail clearly if Ollama or the model is unavailable.
   - If the smoke succeeds, persist a minimal redacted `logs/ralf/operator-smoke.json` with `schemaVersion: "operator-smoke.v1"`, `realCaptureIngestion: true`, `localVisualProvider: true`, and `privacyReview: true`.

3. End-to-end MMP workflow evidence
   - The status script should only report MMP-ready when all source signals and generated workflow evidence are present.
   - The operator smoke should run, in order:
     - build
     - explicit acknowledged capture
     - `make analyse DAY=<day> PROVIDER=ollama MODEL=qwen2.5vl:7b`
     - `make report DAY=<day>`
     - `make export-skill DAY=<day> APPROVE_EXPORT=1`
     - artifact validation
     - write `logs/ralf/operator-smoke.json` only after the above succeeds and no forbidden fields are found in generated structured artifacts

4. Privacy boundaries
   - Never persist keystrokes, clipboard contents, audio, passwords, cookies, authentication tokens, full URLs with query strings, raw document bodies, raw message bodies, or hidden background capture.
   - Do not inspect, print, or summarize raw screenshot content in logs.
   - It is acceptable for local Ollama to receive the day-scoped raw media during the acknowledged smoke run only.
   - Raw media should still be deleted after analysis unless explicit debug retention is requested.

## A - Act

Implement the smallest useful vertical slice toward closing the blockers.

Strongly prefer adding a dedicated, reviewable operator smoke command, for example:

- `make operator-smoke DAY=YYYY-MM-DD LUCILLE_REAL_CAPTURE_ACK=1`
- or `node scripts/operator-smoke.mjs --day YYYY-MM-DD --ack-real-capture`

If real capture and Ollama are available and acknowledgement is present, you may run the smoke command. If unavailable, make the failure clear and keep deterministic tests passing.

Do not run destructive commands such as:

- `git reset --hard`
- `git checkout --`
- `rm -rf` against project or user directories
- force pushes

Do not fabricate `operator-smoke.json`. Only write it after the real capture plus real local provider workflow succeeds.

## L - Learn

Run the relevant checks after each change:

```bash
npm run typecheck --if-present
npm test --if-present
make analyse
node scripts/summarise-ralf-status.mjs
```

Also run new safe smoke commands. If `LUCILLE_REAL_CAPTURE_ACK=1` is present and the current iteration has implemented the explicit smoke workflow, run the real operator smoke.

Inspect generated files when they exist:

- `storage/captures/<DAY>/observations.jsonl`
- `storage/captures/<DAY>/raw-media/`
- `storage/analysis/<DAY>/frame-analysis.jsonl`
- `storage/analysis/<DAY>/work-patterns.json`
- `storage/analysis/<DAY>/skill-proposals.json`
- `output/reports/<DAY>.md`
- `output/skills/<DAY>/`
- `logs/ralf/operator-smoke.json`

## F - Fix

Repair failing tests, invalid JSON, weak privacy boundaries, confusing CLI behavior, missing Makefile compatibility, or smoke regressions before ending the iteration.

At the end, report:

- the blocker addressed
- what changed
- what checks ran
- whether real capture/Ollama smoke succeeded
- what still blocks MMP, if anything
- the next recommended slice

Do not call Lucille MMP-ready unless the status script reports all source signals and all workflow evidence present after a real acknowledged smoke run.
