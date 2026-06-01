import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOpenAIModels } from "../src/analysis/modelEvaluation.mjs";
import { runAnalysis } from "../src/analysis/runAnalysis.mjs";
import { handleCaptureAction, readCaptureState } from "../src/capture/controller.mjs";
import { loadDotEnv } from "../src/config/env.mjs";
import { requestScreenCapturePermission, screenCaptureSettingsUrl } from "../src/capture/permissions.mjs";
import { assertPrivacySafe } from "../src/privacy/safety.mjs";
import { generateDailyReport } from "../src/reports/dailyReport.mjs";
import { exportSkillProposal } from "../src/skills/exporters.mjs";

test("runAnalysis writes deterministic privacy-safe analysis artifacts", async () => {
  const root = fixtureRoot();

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  assert.equal(result.frameCount, 3);
  assert.equal(result.patternCount, 1);
  assert.equal(result.proposalCount, 1);
  assert.equal(result.rawMediaLifecycle.action, "retained_by_default");

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const frames = readFileSync(path.join(analysisDir, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const patterns = JSON.parse(readFileSync(path.join(analysisDir, "work-patterns.json"), "utf8"));
  const proposals = JSON.parse(readFileSync(path.join(analysisDir, "skill-proposals.json"), "utf8"));

  assert.equal(frames[0].schemaVersion, "frame-analysis.v1");
  assert.equal(frames[0].model, "moondream:1.8b");
  assert.equal(patterns.patterns[0].repeatedAcrossEvidence.length, 3);
  assert.equal(patterns.synthesis.rawMediaLifecycle.mediaFilesObserved, 0);
  assert.equal(proposals.proposals[0].status, "proposed");
  assert.deepEqual(proposals.proposals[0].targetTools, ["Claude", "Codex", "Cursor", "ChatGPT"]);

  assert.doesNotThrow(() => assertPrivacySafe(frames, "frames"));
  assert.doesNotThrow(() => assertPrivacySafe(patterns, "patterns"));
  assert.doesNotThrow(() => assertPrivacySafe(proposals, "proposals"));
});

test("runAnalysis retains day-scoped raw media by default after frame analysis", async () => {
  const root = fixtureRoot();
  const rawMediaDir = path.join(root, "storage", "captures", "2026-05-30", "raw-media", "nested");
  mkdirSync(rawMediaDir, { recursive: true });
  const screenshotPath = path.join(rawMediaDir, "frame-001.png");
  const sidecarPath = path.join(rawMediaDir, "frame-001.txt");
  writeFileSync(screenshotPath, "not a real image");
  writeFileSync(sidecarPath, "not raw media");

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  assert.equal(result.rawMediaLifecycle.debugRetentionExplicitlyEnabled, false);
  assert.equal(result.rawMediaLifecycle.action, "retained_by_default");
  assert.equal(result.rawMediaLifecycle.mediaFilesObserved, 1);
  assert.equal(result.rawMediaLifecycle.mediaFilesDeleted, 0);
  assert.equal(result.rawMediaLifecycle.mediaFilesRetained, 1);
  assert.equal(existsSync(screenshotPath), true);
  assert.equal(existsSync(sidecarPath), true);
});

test("runAnalysis deletes day-scoped raw media only when explicitly requested", async () => {
  const root = fixtureRoot();
  const rawMediaDir = path.join(root, "storage", "captures", "2026-05-30", "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  const screenshotPath = path.join(rawMediaDir, "frame-001.png");
  writeFileSync(screenshotPath, "not a real image");

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    deleteRawMedia: true
  });

  assert.equal(result.rawMediaLifecycle.debugRetentionExplicitlyEnabled, false);
  assert.equal(result.rawMediaLifecycle.action, "deleted_after_analysis");
  assert.equal(result.rawMediaLifecycle.mediaFilesObserved, 1);
  assert.equal(result.rawMediaLifecycle.mediaFilesDeleted, 1);
  assert.equal(result.rawMediaLifecycle.mediaFilesRetained, 0);
  assert.equal(existsSync(screenshotPath), false);
});

test("runAnalysis can analyse a bounded observation chunk for local vision testing", async () => {
  const root = fixtureRoot();

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    limit: 1,
    offset: 1
  });

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const frames = readFileSync(path.join(analysisDir, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.frameCount, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frameId, "2026-05-30-mock-frame-002");
  assert.equal(frames[0].evidenceId, "fixture-evidence-002");
});

test("runAnalysis rejects an empty observation chunk", async () => {
  const root = fixtureRoot();

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      limit: 5,
      offset: 999
    }),
    /No observations selected/
  );
});

test("runAnalysis rejects persisted observations outside the structured schema", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "manual-frame-001",
      capturedAt: "2026-05-30T09:00:00Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A developer is reviewing structured frame evidence.",
      redactedSignals: ["structured observation"],
      evidenceIds: ["manual-evidence-001"],
      mediaPath: "storage/captures/2026-05-30/raw-media/frame-001.png"
    }) + "\n"
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b"
    }),
    /unexpected field "mediaPath"/
  );
});

test("runAnalysis rejects excluded observations before local or hosted analysis", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "excluded-domain-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Browser",
      windowTitle: "Visible screen",
      domain: "accounts.google.com",
      activity: "explicit_screen_capture",
      visibleTextSummary: "A visible frame was captured for local analysis.",
      redactedSignals: ["structured observation"],
      evidenceIds: ["excluded-domain-001-raw-frame"]
    }) + "\n"
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      fetchImpl: async () => {
        throw new Error("excluded observation should not reach provider");
      }
    }),
    /Refusing to analyse excluded observation excluded-domain-001: domain "accounts\.google\.com" is excluded/
  );

  assert.equal(existsSync(path.join(root, "storage", "analysis", "2026-05-30")), false);
});

test("runAnalysis rejects excluded app observations before provider selection", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "excluded-app-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "1Password",
      windowTitle: "Visible screen",
      domain: null,
      activity: "explicit_screen_capture",
      visibleTextSummary: "A visible frame was captured for local analysis.",
      redactedSignals: ["structured observation"],
      evidenceIds: ["excluded-app-001-raw-frame"]
    }) + "\n"
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      provider: "ollama",
      fetchImpl: async () => {
        throw new Error("excluded observation should not reach provider");
      }
    }),
    /Refusing to analyse excluded observation excluded-app-001: frontmost app "1Password" is excluded/
  );
});

test("explicit Ollama provider fails clearly when local raw media is unavailable", async () => {
  const root = fixtureRoot();

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      provider: "ollama",
      fetchImpl: async () => {
        throw new Error("should not request without raw media");
      }
    }),
    /No local raw media found.*Use --provider mock/
  );
});

test("auto provider does not fall back to mock for real captured observations", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-local-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["obs-local-001-raw-frame"]
    }) + "\n"
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      fetchImpl: async () => {
        throw new Error("should not request without raw media");
      }
    }),
    /Real captured observations require a real local visual provider/
  );
});

test("Ollama provider sends only day-scoped local raw media and persists structured analysis", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-local-001.png"), "local fixture image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-local-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["obs-local-001-raw-frame"]
    }) + "\n"
  );

  let request = null;
  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "ollama",
    fetchImpl: async (url, options) => {
      request = {
        url,
        method: options.method,
        body: JSON.parse(options.body)
      };

      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({
            activity: "code_review",
            visibleIntent: "Reviewing a local-first analysis workflow.",
            evidenceSummaries: [{ summary: "local visual model saw a development workflow", probability: "high" }],
            riskFlags: [{ flag: "possible_sensitive_visible_text", probability: "low" }]
          })
        })
      };
    }
  });

  assert.equal(result.provider, "ollama");
  assert.equal(request.url, "http://127.0.0.1:11434/api/generate");
  assert.equal(request.method, "POST");
  assert.equal(request.body.model, "moondream:1.8b");
  assert.deepEqual(request.body.images, [Buffer.from("local fixture image").toString("base64")]);
  assert.doesNotMatch(JSON.stringify(request.body), /raw-media/);
  assert.doesNotMatch(JSON.stringify(request.body), /OPENAI_API_KEY/);

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const frames = readFileSync(path.join(analysisDir, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const patterns = JSON.parse(readFileSync(path.join(analysisDir, "work-patterns.json"), "utf8"));

  assert.equal(frames[0].provider, "ollama");
  assert.equal(frames[0].evidenceId, "obs-local-001-raw-frame");
  assert.equal(frames[0].evidence[0].kind, "local_visual_summary");
  assert.equal(frames[0].evidence[0].summary, "local visual model saw a development workflow");
  assert.deepEqual(frames[0].riskFlags, ["possible_sensitive_visible_text"]);
  assert.equal(patterns.provider, "ollama");
  assert.deepEqual(patterns.patterns[0].repeatedAcrossEvidence, ["obs-local-001-raw-frame"]);
  assert.equal(patterns.synthesis.rawScreenshotsSent, false);
  assert.equal(patterns.synthesis.rawMediaLifecycle.action, "retained_by_default");
  assert.equal(existsSync(path.join(rawMediaDir, "obs-local-001.png")), true);
  assert.doesNotThrow(() => assertPrivacySafe(frames, "ollamaFrames"));
  assert.doesNotThrow(() => assertPrivacySafe(patterns, "ollamaPatterns"));
});

test("Ollama provider analyses frames sequentially", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-local-001.png"), "local fixture image one");
  writeFileSync(path.join(rawMediaDir, "obs-local-002.png"), "local fixture image two");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    [
      {
        schemaVersion: "observation.v1",
        id: "obs-local-001",
        capturedAt: "2026-05-30T09:00:00.000Z",
        appName: "Cursor",
        windowTitle: "Lucille project workspace",
        domain: null,
        activity: "code_editing",
        visibleTextSummary: "A visible screen frame was captured for local analysis.",
        redactedSignals: ["explicit local capture"],
        evidenceIds: ["obs-local-001-raw-frame"]
      },
      {
        schemaVersion: "observation.v1",
        id: "obs-local-002",
        capturedAt: "2026-05-30T09:00:03.000Z",
        appName: "Cursor",
        windowTitle: "Lucille project workspace",
        domain: null,
        activity: "code_editing",
        visibleTextSummary: "A second visible screen frame was captured for local analysis.",
        redactedSignals: ["explicit local capture"],
        evidenceIds: ["obs-local-002-raw-frame"]
      }
    ].map((observation) => JSON.stringify(observation)).join("\n") + "\n"
  );

  let inFlight = 0;
  let maxInFlight = 0;
  const requestModels = [];

  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "llama3.2-vision:latest",
    provider: "ollama",
    fetchImpl: async (url, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      requestModels.push(JSON.parse(options.body).model);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({
            activity: "code_review",
            visibleIntent: "Reviewing a local-first analysis workflow.",
            evidenceSummaries: ["local visual model saw a development workflow"],
            riskFlags: []
          })
        })
      };
    }
  });

  const frames = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(maxInFlight, 1);
  assert.deepEqual(requestModels, ["llama3.2-vision:latest", "llama3.2-vision:latest"]);
  assert.deepEqual(frames.map((frame) => frame.frameId), ["obs-local-001", "obs-local-002"]);
  assert.deepEqual(frames.map((frame) => frame.evidenceId), [
    "obs-local-001-raw-frame",
    "obs-local-002-raw-frame"
  ]);
});

test("Ollama provider rejects generic import metadata as visual analysis", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-local-001.png"), "local fixture image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-local-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "archived_screen_capture",
      visibleTextSummary: "A visible screen frame was imported from the Downloads Archive for local Lucille analysis.",
      redactedSignals: [
        "imported archived visible frame",
        "day-scoped local raw media",
        "structured metadata only before analysis"
      ],
      evidenceIds: ["obs-local-001-raw-frame"]
    }) + "\n"
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "qwen2.5vl:7b",
      provider: "ollama",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({
            activity: "archived_screen_capture",
            visibleIntent: "unknown",
            evidenceSummaries: [
              "A visible screen frame was imported from the Downloads Archive for local Lucille analysis."
            ],
            riskFlags: []
          })
        })
      })
    }),
    /returned only generic import metadata/
  );
});

test("legacy retainRawMedia option does not delete source images", async () => {
  const root = fixtureRoot();
  const rawMediaDir = path.join(root, "storage", "captures", "2026-05-30", "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  const screenshotPath = path.join(rawMediaDir, "frame-001.webp");
  writeFileSync(screenshotPath, "not a real image");

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    retainRawMedia: true
  });

  assert.equal(result.rawMediaLifecycle.debugRetentionExplicitlyEnabled, false);
  assert.equal(result.rawMediaLifecycle.action, "retained_by_default");
  assert.equal(result.rawMediaLifecycle.mediaFilesRetained, 1);
  assert.equal(existsSync(screenshotPath), true);
});

test("runAnalysis does not follow a symlinked raw media directory", async (t) => {
  const root = fixtureRoot();
  const captureDayDir = path.join(root, "storage", "captures", "2026-05-30");
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "lucille-outside-media-"));
  mkdirSync(captureDayDir, { recursive: true });

  const outsideScreenshotPath = path.join(outsideDir, "outside.png");
  writeFileSync(outsideScreenshotPath, "not a real image");

  try {
    symlinkSync(outsideDir, path.join(captureDayDir, "raw-media"), "dir");
  } catch {
    t.skip("directory symlinks are unavailable in this environment");
    return;
  }

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  assert.equal(result.rawMediaLifecycle.mediaFilesObserved, 0);
  assert.equal(existsSync(outsideScreenshotPath), true);
});

test("OpenAI analysis mode requires an API key", async () => {
  const root = fixtureRoot();

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      openai: true,
      env: {}
    }),
    /OPENAI_API_KEY is required/
  );
});

test("OpenAI analysis mode uses Responses API with redacted structured evidence", async () => {
  const root = fixtureRoot();
  let request = null;

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    openai: true,
    openaiModel: "gpt-5.5",
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async (url, options) => {
      request = {
        url,
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body)
      };

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "resp_test_123",
          output_text: JSON.stringify({
            patterns: [
              {
                id: "pattern-openai-review-loop",
                title: "OpenAI synthesis review loop",
                summary: "The work repeatedly moves from local analysis to verification and documentation.",
                repeatedAcrossEvidence: [
                  "fixture-evidence-001",
                  "fixture-evidence-002",
                  "fixture-evidence-003"
                ],
                confidence: 0.81,
                signals: ["local analysis", "verification", "documentation"]
              }
            ],
            proposals: [
              {
                id: "skill-openai-review-loop",
                title: "OpenAI synthesis review skill",
                category: "employee_weekly_report",
                summary: "Guide assistants to synthesize repeated work patterns from redacted evidence.",
                implementationSteps: [
                  "Generate a weekly efficiency summary from cited evidence.",
                  "Ask the employee to review each recommendation.",
                  "Track accepted recommendations for the next weekly report."
                ],
                expectedOutcome: "Employees receive a concrete weekly report grounded in evidence.",
                estimatedMinutesPerWeek: 30,
                owner: "Employee and line manager",
                rolloutMetric: "Weekly reviewed recommendation count.",
                prerequisites: ["Redacted evidence package", "Employee review process"],
                evidenceIds: [
                  "fixture-evidence-001",
                  "fixture-evidence-002",
                  "fixture-evidence-003"
                ],
                confidence: 0.81
              },
              {
                id: "skill-openai-workflow-automation",
                title: "OpenAI workflow automation skill",
                category: "workflow_automation",
                summary: "Identify repeated workflow steps that can be templated or automated.",
                implementationSteps: [
                  "List repeated workflow steps from evidence.",
                  "Choose one low-risk automation candidate.",
                  "Pilot the automation with human review."
                ],
                expectedOutcome: "Teams get a small automation candidate ready for approval.",
                estimatedMinutesPerWeek: 45,
                owner: "Operations manager",
                rolloutMetric: "Approved automation candidate count.",
                prerequisites: ["Workflow owner", "Approved template or process"],
                evidenceIds: ["fixture-evidence-001", "fixture-evidence-002"],
                confidence: 0.78
              },
              {
                id: "skill-openai-ai-assistance",
                title: "OpenAI task assistance skill",
                category: "ai_assistance",
                summary: "Draft review-only AI assistance for repeated administrative communication.",
                implementationSteps: [
                  "Confirm approved message templates.",
                  "Generate review-only drafts.",
                  "Record accepted and rejected drafts."
                ],
                expectedOutcome: "Users spend less time drafting repeated admin messages.",
                estimatedMinutesPerWeek: 35,
                owner: "Administrative user",
                rolloutMetric: "Accepted draft rate.",
                prerequisites: ["Approved templates", "Human review"],
                evidenceIds: ["fixture-evidence-002"],
                confidence: 0.76
              },
              {
                id: "skill-openai-manager-monitoring",
                title: "OpenAI manager monitoring skill",
                category: "manager_monitoring",
                summary: "Track AI adoption opportunities across weekly employee reports.",
                implementationSteps: [
                  "Aggregate recommendation categories.",
                  "Track accepted recommendations and savings.",
                  "Review team-level blockers weekly."
                ],
                expectedOutcome: "Managers can see AI transformation progress without raw monitoring.",
                estimatedMinutesPerWeek: 25,
                owner: "Line manager",
                rolloutMetric: "Accepted recommendations by team.",
                prerequisites: ["Weekly report outputs", "Manager review cadence"],
                evidenceIds: ["fixture-evidence-001", "fixture-evidence-003"],
                confidence: 0.74
              },
              {
                id: "skill-openai-enterprise-rollout",
                title: "OpenAI enterprise rollout skill",
                category: "enterprise_rollout",
                summary: "Create an organisation-level rollout plan for repeated AI efficiency opportunities.",
                implementationSteps: [
                  "Group opportunities by department and workflow.",
                  "Prioritize pilots by savings and readiness.",
                  "Track rollout status and governance prerequisites."
                ],
                expectedOutcome: "Leadership gets a governed AI transformation backlog.",
                estimatedMinutesPerWeek: 20,
                owner: "Transformation lead",
                rolloutMetric: "Pilots moved from proposed to approved.",
                prerequisites: ["Governance owner", "Department pilot list"],
                evidenceIds: [
                  "fixture-evidence-001",
                  "fixture-evidence-002",
                  "fixture-evidence-003"
                ],
                confidence: 0.73
              }
            ]
          })
        })
      };
    }
  });

  assert.equal(result.frameCount, 3);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer test-key");
  assert.equal(request.body.model, "gpt-5.5");
  assert.equal(request.body.reasoning.effort, "high");

  const requestBody = JSON.stringify(request.body);
  assert.match(requestBody, /redacted_structured_frame_evidence_only/);
  assert.doesNotMatch(requestBody, /screenshotPath/);
  assert.doesNotMatch(requestBody, /raw-media/);
  assert.doesNotMatch(requestBody, /rawDocumentBody/);

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const patterns = JSON.parse(readFileSync(path.join(analysisDir, "work-patterns.json"), "utf8"));
  const proposals = JSON.parse(readFileSync(path.join(analysisDir, "skill-proposals.json"), "utf8"));

  assert.equal(patterns.provider, "openai_responses");
  assert.equal(patterns.model, "gpt-5.5");
  assert.equal(patterns.synthesis.localOnly, false);
  assert.equal(patterns.synthesis.openaiRequested, true);
  assert.equal(patterns.synthesis.rawScreenshotsSent, false);
  assert.equal(patterns.synthesis.openai.responseId, "resp_test_123");
  assert.equal(patterns.patterns[0].id, "pattern-openai-review-loop");
  assert.equal(proposals.proposals[0].id, "skill-openai-review-loop");
  assert.equal(proposals.proposals[0].status, "proposed");
  assert.deepEqual(proposals.proposals[0].targetTools, ["Claude", "Codex", "Cursor", "ChatGPT"]);
  assert.doesNotThrow(() => assertPrivacySafe(patterns, "patterns"));
  assert.doesNotThrow(() => assertPrivacySafe(proposals, "proposals"));
});

test("model evaluation compares candidate models with redacted weekly report evidence", async () => {
  const root = fixtureRoot();
  const requests = [];

  const result = await evaluateOpenAIModels({
    root,
    day: "2026-05-30",
    models: ["gpt-5.5", "gpt-5-mini"],
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      const isStrongModel = body.model === "gpt-5.5";

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `resp_${body.model.replaceAll(".", "_")}`,
          output_text: JSON.stringify({
            readiness: isStrongModel ? 0.91 : 0.61,
            executiveSummary: "Attendance review, parent communication, and spreadsheet reconciliation form a repeated weekly admin loop.",
            recommendedActions: isStrongModel
              ? [
                {
                  title: "Draft attendance follow-up messages",
                  why: "Use approved templates to produce reviewable parent communications from the repeated attendance context.",
                  evidenceIds: ["fixture-evidence-001", "fixture-evidence-002"],
                  confidence: 0.86,
                  estimatedMinutesPerWeek: 55,
                  enterpriseMetric: "Track weekly accepted AI message drafts per attendance officer."
                },
                {
                  title: "Prepare reconciliation checklist",
                  why: "Summarize the spreadsheet checks that recur after MIS review.",
                  evidenceIds: ["fixture-evidence-003"],
                  confidence: 0.82,
                  estimatedMinutesPerWeek: 35,
                  enterpriseMetric: "Track manual reconciliation steps removed from weekly attendance reporting."
                },
                {
                  title: "Bundle the workflow into a weekly report",
                  why: "Show the employee and manager where AI assistance can reduce switching across MIS, email, and spreadsheets.",
                  evidenceIds: ["fixture-evidence-001", "fixture-evidence-002", "fixture-evidence-003"],
                  confidence: 0.84,
                  estimatedMinutesPerWeek: 25,
                  enterpriseMetric: "Track departments with evidence-backed AI transformation opportunities."
                }
              ]
              : [
                {
                  title: "Use a template",
                  why: "Templates may help.",
                  evidenceIds: ["fixture-evidence-001"],
                  confidence: 0.55,
                  estimatedMinutesPerWeek: 10,
                  enterpriseMetric: "Track whether a template is used."
                }
              ],
            risks: ["Validate recommendations with the employee before rollout."]
          })
        })
      };
    }
  });

  assert.equal(result.models.length, 2);
  assert.equal(result.recommendation.model, "gpt-5.5");
  assert.ok(result.models[0].score.total > result.models[1].score.total);
  assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(requests[0].body.model, "gpt-5.5");
  assert.match(JSON.stringify(requests[0].body), /redacted_structured_frame_evidence_only/);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /raw-media/);

  const artifactPath = path.join(root, "storage", "analysis", "2026-05-30", "model-evaluation.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.schemaVersion, "model-evaluation.v1");
  assert.equal(artifact.rawScreenshotsSent, false);
  assert.equal(artifact.recommendation.model, "gpt-5.5");
  assert.doesNotThrow(() => assertPrivacySafe(artifact, "modelEvaluation"));
});

test("model evaluation requires an API key", async () => {
  const root = fixtureRoot();

  await assert.rejects(
    evaluateOpenAIModels({
      root,
      day: "2026-05-30",
      env: {}
    }),
    /OPENAI_API_KEY is required/
  );
});

test("dotenv loader reads local OpenAI API key without overriding exported env", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-env-"));
  writeFileSync(
    path.join(root, ".env"),
    [
      "OPENAI_API_KEY=from-dotenv",
      "EXPORTED_VALUE=from-dotenv",
      "QUOTED_VALUE=\"hello world\"",
      "COMMENTED_VALUE=value # local comment"
    ].join("\n") + "\n"
  );

  const env = {
    EXPORTED_VALUE: "from-shell"
  };
  const result = loadDotEnv({ root, env });

  assert.equal(result.loaded, true);
  assert.deepEqual(result.keys, ["OPENAI_API_KEY", "EXPORTED_VALUE", "QUOTED_VALUE", "COMMENTED_VALUE"]);
  assert.equal(env.OPENAI_API_KEY, "from-dotenv");
  assert.equal(env.EXPORTED_VALUE, "from-shell");
  assert.equal(env.QUOTED_VALUE, "hello world");
  assert.equal(env.COMMENTED_VALUE, "value");
});

test("skill export previews proposed tool files without writing them", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  const result = exportSkillProposal({
    root,
    day: "2026-05-30"
  });

  const expectedClaudePath = path.join(
    "output",
    "skills",
    "2026-05-30",
    "skill-attendance-report-review-assistant",
    "claude",
    "SKILL.md"
  );

  assert.equal(result.approved, false);
  assert.equal(result.filesWritten.length, 0);
  assert.ok(result.filesPlanned.includes(expectedClaudePath));
  assert.equal(existsSync(path.join(root, expectedClaudePath)), false);
  assert.doesNotThrow(() => assertPrivacySafe(result, "skillExportPreview"));
});

test("weekly report writes privacy-safe Markdown from structured analysis artifacts", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "mock"
  });

  const result = generateDailyReport({
    root,
    day: "2026-05-30"
  });

  const reportPath = path.join(root, "output", "reports", "2026-05-30.md");
  const report = readFileSync(reportPath, "utf8");

  assert.equal(result.schemaVersion, "daily-report.v1");
  assert.equal(result.reportPath, path.join("output", "reports", "2026-05-30.md"));
  assert.equal(result.frameCount, 3);
  assert.equal(result.patternCount, 1);
  assert.equal(result.proposalCount, 1);
  assert.match(report, /^# Lucille Weekly Efficiency Report: 2026-05-30/m);
  assert.match(report, /Estimated weekly time saving/);
  assert.match(report, /Organisation signal/);
  assert.match(report, /## Raw Media Lifecycle/);
  assert.match(report, /## Skill Proposals/);
  assert.doesNotMatch(report, /storage\/captures/);
  assert.doesNotMatch(report, /raw-media\/.*\.png/);
  assert.doesNotThrow(() => assertPrivacySafe({ result, report }, "dailyReport"));
});

test("make report invokes dedicated report generation", () => {
  const makefile = readFileSync(path.join(process.cwd(), "Makefile"), "utf8");
  const reportTarget = makefile.match(/^report:.*(?:\n\t.*)*/m)?.[0] ?? "";

  assert.match(reportTarget, /\$\(NODE\) "\$\(CLI\)" report --day "\$\(DAY\)"/);
  assert.doesNotMatch(reportTarget, /review --day/);
});

test("approved skill export writes Claude Codex Cursor and ChatGPT bundles", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  const result = exportSkillProposal({
    root,
    day: "2026-05-30",
    approve: true
  });

  const expectedFiles = [
    path.join("output", "skills", "2026-05-30", "skill-attendance-report-review-assistant", "claude", "SKILL.md"),
    path.join("output", "skills", "2026-05-30", "skill-attendance-report-review-assistant", "codex", "SKILL.md"),
    path.join(
      "output",
      "skills",
      "2026-05-30",
      "skill-attendance-report-review-assistant",
      "cursor",
      ".cursor",
      "rules",
      "skill-attendance-report-review-assistant.mdc"
    ),
    path.join("output", "skills", "2026-05-30", "skill-attendance-report-review-assistant", "chatgpt", "instructions.md"),
    path.join("output", "skills", "2026-05-30", "skill-attendance-report-review-assistant", "chatgpt", "knowledge.md"),
    path.join("output", "skills", "2026-05-30", "skill-attendance-report-review-assistant", "chatgpt", "actions.json")
  ];

  assert.equal(result.approved, true);
  assert.deepEqual([...result.filesWritten].sort(), [...expectedFiles].sort());

  for (const relativePath of expectedFiles) {
    assert.equal(existsSync(path.join(root, relativePath)), true);
  }

  const claudeSkill = readFileSync(path.join(root, expectedFiles[0]), "utf8");
  const codexSkill = readFileSync(path.join(root, expectedFiles[1]), "utf8");
  const cursorRule = readFileSync(path.join(root, expectedFiles[2]), "utf8");
  const chatgptInstructions = readFileSync(path.join(root, expectedFiles[3]), "utf8");
  const chatgptKnowledge = readFileSync(path.join(root, expectedFiles[4]), "utf8");
  const chatgptActions = JSON.parse(readFileSync(path.join(root, expectedFiles[5]), "utf8"));

  assert.match(claudeSkill, /Evidence IDs/);
  assert.match(codexSkill, /Codex Instructions/);
  assert.match(cursorRule, /alwaysApply: false/);
  assert.match(chatgptInstructions, /# Instructions/);
  assert.match(chatgptKnowledge, /Confidence: 0\.74/);
  assert.deepEqual(chatgptActions.actions, []);
  assert.doesNotThrow(() => assertPrivacySafe({
    result,
    claudeSkill,
    cursorRule,
    chatgptInstructions,
    chatgptKnowledge,
    chatgptActions
  }, "approvedSkillExport"));
});

test("privacy validator rejects forbidden persisted fields and query URLs", () => {
  assert.throws(
    () => assertPrivacySafe({ fullUrl: "https://example.test/path?token=abc" }),
    /Privacy validation failed/
  );
});

test("capture controller persists visible privacy-safe lifecycle state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));

  const started = handleCaptureAction({
    root,
    action: "start",
    now: new Date("2026-05-30T09:00:00.000Z")
  });
  assert.equal(started.state.status, "running");
  assert.equal(started.state.previousStatus, null);
  assert.equal(started.state.controls.visibleControlsRequired, true);
  assert.equal(started.state.capturePolicy.hiddenBackgroundCapture, false);
  assert.equal(started.state.capturePolicy.realScreenCaptureEnabled, false);
  assert.equal(started.state.capturePolicy.rawMediaRetention, "none_in_scaffold");
  assert.ok(started.state.capturePolicy.excludedApps.includes("1Password"));
  assert.ok(started.state.capturePolicy.excludedDomains.includes("accounts.google.com"));
  assert.ok(started.state.capturePolicy.disallowedSignals.includes("no_clipboard_capture"));
  assert.doesNotThrow(() => assertPrivacySafe(started.state, "captureState"));

  const paused = handleCaptureAction({
    root,
    action: "pause",
    now: new Date("2026-05-30T09:01:00.000Z")
  });
  assert.equal(paused.state.status, "paused");
  assert.equal(paused.state.previousStatus, "running");

  const resumed = handleCaptureAction({
    root,
    action: "resume",
    now: new Date("2026-05-30T09:02:00.000Z")
  });
  assert.equal(resumed.state.status, "running");
  assert.equal(resumed.state.previousStatus, "paused");

  const stopped = handleCaptureAction({
    root,
    action: "stop",
    now: new Date("2026-05-30T09:03:00.000Z")
  });
  assert.equal(stopped.state.status, "stopped");
  assert.equal(stopped.state.previousStatus, "running");

  const savedState = JSON.parse(readFileSync(started.statePath, "utf8"));
  assert.equal(savedState.status, "stopped");
  assert.doesNotThrow(() => assertPrivacySafe(savedState, "savedCaptureState"));
});

test("capture-once writes day-scoped raw media and one structured observation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));

  const result = handleCaptureAction({
    root,
    action: "once",
    realCaptureAck: true,
    now: new Date("2026-05-30T09:10:11.000Z"),
    platform: "test",
    getActiveWindowHints: () => ({
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null
    }),
    captureScreenshot: ({ outputPath }) => {
      writeFileSync(outputPath, "fixture image bytes");
      return { ok: true };
    }
  });

  assert.equal(result.state.status, "completed_once");
  assert.equal(result.state.capturePolicy.realScreenCaptureEnabled, true);
  assert.equal(result.state.capturePolicy.hiddenBackgroundCapture, false);
  assert.equal(result.state.capturePolicy.rawMediaRetention, "day_scoped_until_analysis");
  assert.equal(result.day, "2026-05-30");
  assert.equal(result.excluded, false);
  assert.equal(result.observation.schemaVersion, "observation.v1");
  assert.equal(result.observation.appName, "Cursor");
  assert.deepEqual(result.observation.evidenceIds, ["obs-20260530091011000-raw-frame"]);

  const rawMediaPath = path.join(root, "storage", "captures", "2026-05-30", "raw-media", "obs-20260530091011000.png");
  const observationsPath = path.join(root, "storage", "captures", "2026-05-30", "observations.jsonl");
  assert.equal(existsSync(rawMediaPath), true);

  const observations = readFileSync(observationsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].id, "obs-20260530091011000");
  assert.deepEqual(observations[0].redactedSignals, [
    "explicit user-invoked capture",
    "day-scoped local raw media",
    "structured metadata only before analysis"
  ]);
  assert.doesNotThrow(() => assertPrivacySafe(observations, "captureOnceObservations"));
});

test("capture-once refuses to capture without explicit real capture acknowledgement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  let captureCalled = false;

  assert.throws(
    () => handleCaptureAction({
      root,
      action: "once",
      env: {},
      now: new Date("2026-05-30T09:10:11.000Z"),
      platform: "test",
      getActiveWindowHints: () => ({
        appName: "Cursor",
        windowTitle: "Lucille project workspace",
        domain: null
      }),
      captureScreenshot: ({ outputPath }) => {
        captureCalled = true;
        writeFileSync(outputPath, "fixture image bytes");
        return { ok: true };
      }
    }),
    /Refusing real capture/
  );

  assert.equal(captureCalled, false);
  assert.equal(existsSync(path.join(root, "storage", "capture-state.json")), false);
  assert.equal(existsSync(path.join(root, "storage", "captures", "2026-05-30")), false);
});

test("make capture loops explicit frame ingestion at the configured interval", () => {
  const makefile = readFileSync(path.join(process.cwd(), "Makefile"), "utf8");
  const captureTarget = makefile.match(/^capture:.*(?:\n\t.*)*/m)?.[0] ?? "";

  assert.match(makefile, /^CAPTURE_INTERVAL \?= 3$/m);
  assert.match(makefile, /^ANALYSE_LIMIT \?=$/m);
  assert.match(makefile, /^ANALYSE_OFFSET \?= 0$/m);
  assert.match(makefile, /--limit \$\(ANALYSE_LIMIT\) --offset \$\(ANALYSE_OFFSET\)/);
  assert.match(captureTarget, /\$\(NODE\) "\$\(CLI\)" capture once/);
  assert.match(captureTarget, /--ack-real-capture/);
  assert.match(captureTarget, /while true/);
  assert.match(captureTarget, /sleep "\$\(CAPTURE_INTERVAL\)"/);
  assert.match(makefile, /^capture-permission:/m);
  assert.match(makefile, /\$\(NODE\) "\$\(CLI\)" capture permission/);
  assert.doesNotMatch(captureTarget, /capture start/);
});

test("screen permission request verifies the actual screencapture path and deletes the probe", () => {
  const calls = [];
  let probePath = null;

  const result = requestScreenCapturePermission({
    platform: "darwin",
    openSettings: false,
    spawnSync: (command, args) => {
      calls.push({ command, args });

      if (command === "swift") {
        return { status: 0, stdout: "granted\n", stderr: "" };
      }

      if (command === "screencapture") {
        probePath = args[1];
        writeFileSync(probePath, "fixture frame");
        return { status: 0, stdout: "", stderr: "" };
      }

      return { status: 127, stdout: "", stderr: `unexpected command ${command}` };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, "granted");
  assert.deepEqual(calls.map((call) => call.command), ["swift", "screencapture"]);
  assert.equal(existsSync(probePath), false);
  assert.match(result.message, /captured and deleted/);
});

test("screen permission request opens Screen Recording settings when capture is denied", () => {
  const calls = [];

  const result = requestScreenCapturePermission({
    platform: "darwin",
    spawnSync: (command, args) => {
      calls.push({ command, args });

      if (command === "swift") {
        return { status: 2, stdout: "not_granted\n", stderr: "" };
      }

      if (command === "screencapture") {
        return { status: 1, stdout: "", stderr: "could not create image from display" };
      }

      if (command === "open") {
        return { status: 0, stdout: "", stderr: "" };
      }

      return { status: 127, stdout: "", stderr: `unexpected command ${command}` };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "needs_manual_grant");
  assert.equal(result.settingsOpened, true);
  assert.deepEqual(calls.map((call) => call.command), ["swift", "screencapture", "open"]);
  assert.deepEqual(calls.at(-1).args, [screenCaptureSettingsUrl]);
  assert.match(result.message, /Grant Screen Recording permission/);
  assert.match(result.message, /Quit and reopen/);
});

test("operator smoke refuses capture before build without explicit acknowledgement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-operator-smoke-"));
  const fakeMake = writeFakeMake(root);

  assert.throws(
    () => execFileSync(process.execPath, [
      path.join(process.cwd(), "scripts", "operator-smoke.mjs"),
      "--day",
      "2026-05-30"
    ], {
      cwd: root,
      env: {
        ...process.env,
        MAKE: fakeMake,
        LUCILLE_REAL_CAPTURE_ACK: ""
      },
      encoding: "utf8",
      stdio: "pipe"
    }),
    /explicit acknowledgement/
  );

  assert.equal(existsSync(path.join(root, "make-calls.log")), false);
  assert.equal(existsSync(path.join(root, "logs", "ralf", "operator-smoke.json")), false);
});

test("operator smoke preflight checks Ollama before any capture command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-operator-smoke-"));
  const fakeMake = writeFakeMake(root);

  assert.throws(
    () => execFileSync(process.execPath, [
      path.join(process.cwd(), "scripts", "operator-smoke.mjs"),
      "--day",
      "2026-05-30",
      "--preflight"
    ], {
      cwd: root,
      env: {
        ...process.env,
        MAKE: fakeMake,
        OLLAMA_HOST: "http://127.0.0.1:1",
        LUCILLE_REAL_CAPTURE_ACK: ""
      },
      encoding: "utf8",
      stdio: "pipe"
    }),
    /Ollama local visual provider is unavailable/
  );

  assert.equal(readFileSync(path.join(root, "make-calls.log"), "utf8"), "build\n");
  assert.equal(existsSync(path.join(root, "storage", "captures")), false);
  assert.equal(existsSync(path.join(root, "logs", "ralf", "operator-smoke.json")), false);
});

test("capture-once enforces excluded apps before observations reach analysis", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  let captureCalled = false;

  const result = handleCaptureAction({
    root,
    action: "once",
    realCaptureAck: true,
    now: new Date("2026-05-30T09:10:11.000Z"),
    platform: "test",
    getActiveWindowHints: () => ({
      appName: "1Password",
      windowTitle: "Visible screen",
      domain: null
    }),
    captureScreenshot: ({ outputPath }) => {
      captureCalled = true;
      writeFileSync(outputPath, "fixture image bytes");
      return { ok: true };
    }
  });

  const captureDayDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaPath = path.join(captureDayDir, "raw-media", "obs-20260530091011000.png");
  const observationsPath = path.join(captureDayDir, "observations.jsonl");
  const exclusionsPath = path.join(captureDayDir, "observation-exclusions.jsonl");

  assert.equal(result.excluded, true);
  assert.equal(result.observation, null);
  assert.equal(captureCalled, false);
  assert.equal(existsSync(rawMediaPath), false);
  assert.equal(existsSync(path.join(captureDayDir, "raw-media")), false);
  assert.equal(existsSync(observationsPath), false);
  assert.equal(existsSync(exclusionsPath), true);
  assert.match(result.message, /skipped before screenshot/);
  assert.match(readFileSync(exclusionsPath, "utf8"), /frontmost app/);
  assert.doesNotThrow(() => assertPrivacySafe(result.exclusion, "captureOnceExclusion"));
});

test("capture-once enforces excluded domains before observations reach analysis", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  let captureCalled = false;

  const result = handleCaptureAction({
    root,
    action: "once",
    realCaptureAck: true,
    now: new Date("2026-05-30T09:10:11.000Z"),
    platform: "test",
    getActiveWindowHints: () => ({
      appName: "Browser",
      windowTitle: "Visible screen",
      domain: "accounts.google.com"
    }),
    captureScreenshot: ({ outputPath }) => {
      captureCalled = true;
      writeFileSync(outputPath, "fixture image bytes");
      return { ok: true };
    }
  });

  assert.equal(result.excluded, true);
  assert.equal(captureCalled, false);
  assert.match(result.exclusion.reason, /domain/);
  assert.equal(existsSync(path.join(root, "storage", "captures", "2026-05-30", "raw-media")), false);
  assert.equal(existsSync(path.join(root, "storage", "captures", "2026-05-30", "observations.jsonl")), false);
});

test("capture-once deletes partial raw media when screenshot capture fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));

  assert.throws(
    () => handleCaptureAction({
      root,
      action: "once",
      realCaptureAck: true,
      now: new Date("2026-05-30T09:10:11.000Z"),
      platform: "test",
      getActiveWindowHints: () => ({
        appName: "Cursor",
        windowTitle: "Lucille project workspace",
        domain: null
      }),
      captureScreenshot: ({ outputPath }) => {
        writeFileSync(outputPath, "partial fixture image bytes");
        return {
          ok: false,
          message: "fixture capture failure"
        };
      }
    }),
    /fixture capture failure/
  );

  const captureDayDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaPath = path.join(captureDayDir, "raw-media", "obs-20260530091011000.png");

  assert.equal(existsSync(rawMediaPath), false);
  assert.equal(existsSync(path.join(captureDayDir, "observations.jsonl")), false);
  assert.equal(existsSync(path.join(root, "storage", "capture-state.json")), false);
});

test("capture pause resume and stop do not create misleading states", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));

  const pausedBeforeStart = handleCaptureAction({
    root,
    action: "pause",
    now: new Date("2026-05-30T09:00:00.000Z")
  });
  assert.equal(pausedBeforeStart.state, null);
  assert.match(pausedBeforeStart.message, /nothing to pause/);
  assert.equal(existsSync(pausedBeforeStart.statePath), false);

  const resumedBeforeStart = handleCaptureAction({
    root,
    action: "resume",
    now: new Date("2026-05-30T09:01:00.000Z")
  });
  assert.equal(resumedBeforeStart.state, null);
  assert.match(resumedBeforeStart.message, /nothing to resume/);

  const stoppedBeforeStart = handleCaptureAction({
    root,
    action: "stop",
    now: new Date("2026-05-30T09:02:00.000Z")
  });
  assert.equal(stoppedBeforeStart.state, null);
  assert.match(stoppedBeforeStart.message, /nothing to stop/);

  const started = handleCaptureAction({
    root,
    action: "start",
    now: new Date("2026-05-30T09:03:00.000Z")
  });
  const stopped = handleCaptureAction({
    root,
    action: "stop",
    now: new Date("2026-05-30T09:04:00.000Z")
  });
  const pauseAfterStop = handleCaptureAction({
    root,
    action: "pause",
    now: new Date("2026-05-30T09:05:00.000Z")
  });

  assert.equal(started.state.status, "running");
  assert.equal(stopped.state.status, "stopped");
  assert.equal(pauseAfterStop.state.status, "stopped");
  assert.match(pauseAfterStop.message, /nothing to pause/);

  const savedState = JSON.parse(readFileSync(started.statePath, "utf8"));
  assert.equal(savedState.status, "stopped");
  assert.equal(savedState.updatedAt, "2026-05-30T09:04:00.000Z");
  assert.doesNotThrow(() => assertPrivacySafe(savedState, "savedCaptureState"));
});

test("capture controller rejects malformed persisted lifecycle state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  const started = handleCaptureAction({
    root,
    action: "start",
    now: new Date("2026-05-30T09:00:00.000Z")
  });

  const state = JSON.parse(readFileSync(started.statePath, "utf8"));
  writeFileSync(started.statePath, JSON.stringify({
    ...state,
    notes: "unexpected unstructured lifecycle field"
  }, null, 2) + "\n");

  assert.throws(
    () => readCaptureState(started.statePath),
    /unexpected field "notes"/
  );
});

test("capture controller rejects weakened persisted control policy", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  const started = handleCaptureAction({
    root,
    action: "start",
    now: new Date("2026-05-30T09:00:00.000Z")
  });

  const state = JSON.parse(readFileSync(started.statePath, "utf8"));
  writeFileSync(started.statePath, JSON.stringify({
    ...state,
    capturePolicy: {
      ...state.capturePolicy,
      hiddenBackgroundCapture: true
    }
  }, null, 2) + "\n");

  assert.throws(
    () => readCaptureState(started.statePath),
    /hiddenBackgroundCapture/
  );
});

test("capture controller rejects full URLs in excluded domains", () => {
  assert.throws(
    () => handleCaptureAction({
      root: mkdtempSync(path.join(os.tmpdir(), "lucille-capture-")),
      action: "start",
      excludedDomains: ["https://example.test/path?token=abc"]
    }),
    /expected a hostname only/
  );
});

test("capture status is graceful before capture state exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-capture-"));
  const result = handleCaptureAction({ root, action: "status" });

  assert.equal(result.state, null);
  assert.match(result.message, /No hidden monitoring is running/);
});

test("RALF status reports generated MMP workflow evidence separately from scaffold signals", async () => {
  const root = fixtureRoot();

  handleCaptureAction({
    root,
    action: "once",
    realCaptureAck: true,
    now: new Date("2026-05-30T09:10:11.000Z"),
    platform: "test",
    getActiveWindowHints: () => ({
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null
    }),
    captureScreenshot: ({ outputPath }) => {
      writeFileSync(outputPath, "fixture image bytes");
      return { ok: true };
    }
  });
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "mock"
  });
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  exportSkillProposal({
    root,
    day: "2026-05-30",
    approve: true
  });

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /MMP workflow evidence: 7\/8/);
  assert.match(output, /ok\s+Capture observations JSONL/);
  assert.match(output, /ok\s+Frame analysis JSONL/);
  assert.match(output, /ok\s+Daily report Markdown/);
  assert.match(output, /ok\s+Approved export bundle/);
  assert.match(output, /--\s+Operator environment smoke/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status does not count an empty raw-media directory as capture evidence", () => {
  const root = fixtureRoot();
  mkdirSync(path.join(root, "storage", "captures", "2026-05-30", "raw-media"), { recursive: true });

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /--\s+Capture observations JSONL/);
  assert.match(output, /--\s+Day-scoped raw media directory/);
  assert.match(output, /MMP workflow evidence: 0\/8/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status requires capture observations to match observation.v1 schema", () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  mkdirSync(path.join(captureDir, "raw-media"), { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      id: "not-a-structured-observation",
      capturedAt: "2026-05-30T09:00:00.000Z"
    }) + "\n"
  );

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /--\s+Capture observations JSONL/);
  assert.match(output, /--\s+Day-scoped raw media directory/);
  assert.match(output, /MMP workflow evidence: 0\/8/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status rejects operator smoke evidence when workflow artifacts are not Ollama-backed", async () => {
  const root = fixtureRoot();

  handleCaptureAction({
    root,
    action: "once",
    realCaptureAck: true,
    now: new Date("2026-05-30T09:10:11.000Z"),
    platform: "test",
    getActiveWindowHints: () => ({
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null
    }),
    captureScreenshot: ({ outputPath }) => {
      writeFileSync(outputPath, "fixture image bytes");
      return { ok: true };
    }
  });
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "mock"
  });
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  exportSkillProposal({
    root,
    day: "2026-05-30",
    approve: true
  });
  mkdirSync(path.join(root, "logs", "ralf"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "ralf", "operator-smoke.json"),
    JSON.stringify({
      schemaVersion: "operator-smoke.v1",
      day: "2026-05-30",
      completedAt: "2026-05-30T09:20:00.000Z",
      realCaptureIngestion: true,
      localVisualProvider: true,
      privacyReview: true,
      provider: "ollama",
      model: "moondream:1.8b",
      evidence: {
        observations: 1,
        rawMediaFilesCaptured: 1,
        frameAnalysis: 1,
        report: "output/reports/2026-05-30.md",
        approvedExport: "output/skills/2026-05-30/skill-attendance-report-review-assistant"
      }
    }, null, 2) + "\n"
  );

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /MMP workflow evidence: 7\/8/);
  assert.match(output, /--\s+Operator environment smoke/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status accepts same-day Ollama smoke evidence with retained raw media", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-local-001.png"), "local fixture image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-local-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["obs-local-001-raw-frame"]
    }) + "\n"
  );

  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "ollama",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response: JSON.stringify({
          activity: "code_review",
          visibleIntent: "Reviewing a local-first analysis workflow.",
          evidenceSummaries: ["local visual model saw a development workflow"],
          riskFlags: []
        })
      })
    })
  });
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  exportSkillProposal({
    root,
    day: "2026-05-30",
    approve: true
  });
  mkdirSync(path.join(root, "logs", "ralf"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "ralf", "operator-smoke.json"),
    JSON.stringify({
      schemaVersion: "operator-smoke.v1",
      day: "2026-05-30",
      completedAt: "2026-05-30T09:20:00.000Z",
      realCaptureIngestion: true,
      localVisualProvider: true,
      privacyReview: true,
      provider: "ollama",
      model: "moondream:1.8b",
      evidence: {
        observations: 1,
        rawMediaFilesCaptured: 1,
        frameAnalysis: 1,
        report: "output/reports/2026-05-30.md",
        approvedExport: "output/skills/2026-05-30/skill-attendance-report-review-assistant"
      }
    }, null, 2) + "\n"
  );

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /MMP workflow evidence: 8\/8/);
  assert.match(output, /ok\s+Operator environment smoke/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status rejects unsafe approved export artifacts", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-local-001.png"), "local fixture image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-local-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["obs-local-001-raw-frame"]
    }) + "\n"
  );

  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "ollama",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response: JSON.stringify({
          activity: "code_review",
          visibleIntent: "Reviewing a local-first analysis workflow.",
          evidenceSummaries: ["local visual model saw a development workflow"],
          riskFlags: []
        })
      })
    })
  });
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  exportSkillProposal({
    root,
    day: "2026-05-30",
    approve: true
  });

  const actionsPath = findExportedActionsPath(root, "2026-05-30");
  const actions = JSON.parse(readFileSync(actionsPath, "utf8"));
  writeFileSync(actionsPath, JSON.stringify({
    ...actions,
    authToken: "token=abc"
  }, null, 2) + "\n");

  mkdirSync(path.join(root, "logs", "ralf"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "ralf", "operator-smoke.json"),
    JSON.stringify({
      schemaVersion: "operator-smoke.v1",
      day: "2026-05-30",
      completedAt: "2026-05-30T09:20:00.000Z",
      realCaptureIngestion: true,
      localVisualProvider: true,
      privacyReview: true,
      provider: "ollama",
      model: "moondream:1.8b"
    }, null, 2) + "\n"
  );

  const output = execFileSync("node", [path.join(process.cwd(), "scripts", "summarise-ralf-status.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /--\s+Approved export bundle/);
  assert.match(output, /--\s+Operator environment smoke/);
  assert.match(output, /MMP workflow evidence: 6\/8/);
  assert.match(output, /MMP status: not ready/);
});

function findExportedActionsPath(root, day) {
  const skillsDir = path.join(root, "output", "skills", day);
  for (const skillId of readdirSync(skillsDir)) {
    const candidate = path.join(skillsDir, skillId, "chatgpt", "actions.json");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No exported actions.json found under ${skillsDir}`);
}

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-analysis-"));
  const fixturesDir = path.join(root, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  copyFileSync(
    path.join(process.cwd(), "fixtures", "mock-observations.json"),
    path.join(fixturesDir, "mock-observations.json")
  );
  return root;
}

function writeFakeMake(root) {
  const fakeMake = path.join(root, "fake-make.sh");
  writeFileSync(fakeMake, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> make-calls.log\n");
  chmodSync(fakeMake, 0o755);
  return fakeMake;
}
