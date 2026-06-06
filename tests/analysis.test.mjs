import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { buildActivityTimeline } from "../src/analysis/activityTimeline.mjs";
import { buildSessionAnalysis } from "../src/analysis/sessionAnalysis.mjs";
import { debugFrameAnalysis } from "../src/analysis/debugFrame.mjs";
import { evaluateOpenAIModels } from "../src/analysis/modelEvaluation.mjs";
import { normalizeFrameWorkSummary } from "../src/analysis/frameWorkSummary.mjs";
import { runAnalysis } from "../src/analysis/runAnalysis.mjs";
import { handleCaptureAction, readCaptureState } from "../src/capture/controller.mjs";
import { loadDotEnv } from "../src/config/env.mjs";
import { requestScreenCapturePermission, screenCaptureSettingsUrl } from "../src/capture/permissions.mjs";
import { assertPrivacySafe } from "../src/privacy/safety.mjs";
import { generateDailyReport } from "../src/reports/dailyReport.mjs";
import { exportSkillProposal } from "../src/skills/exporters.mjs";
import { createSkillUiServer } from "../src/ui/server.mjs";

const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const parsedUrl = new URL(String(url));
  const body = JSON.parse(options.body ?? "{}");
  if (
    ["127.0.0.1", "localhost"].includes(parsedUrl.hostname) &&
    parsedUrl.pathname === "/api/generate" &&
    typeof body.prompt === "string" &&
    typeof body.model === "string"
  ) {
    const observation = parseObservationFromOllamaPrompt(body.prompt);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        response: JSON.stringify(buildLocalVisualTestResponse(observation))
      })
    };
  }

  if (typeof originalFetch === "function") {
    return originalFetch(url, options);
  }

  throw new Error(`Unexpected fetch URL in test: ${url}`);
};

test("runAnalysis writes deterministic privacy-safe analysis artifacts", async () => {
  const root = fixtureRoot();

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  assert.equal(result.frameCount, 3);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.timelineSegmentCount, 1);
  assert.equal(result.patternCount, 1);
  assert.equal(result.proposalCount, 5);
  assert.equal(result.commonTaskCount, 1);
  assert.equal(result.memoryRegularTaskCount, 1);
  assert.equal(result.wrapUpRecommendationCount, 10);
  assert.equal(result.rawMediaLifecycle.action, "retained_by_default");

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const frames = readFileSync(path.join(analysisDir, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const patterns = JSON.parse(readFileSync(path.join(analysisDir, "work-patterns.json"), "utf8"));
  const proposals = JSON.parse(readFileSync(path.join(analysisDir, "skill-proposals.json"), "utf8"));
  const timeline = JSON.parse(readFileSync(path.join(analysisDir, "activity-timeline.json"), "utf8"));
  const sessionAnalysis = JSON.parse(readFileSync(path.join(analysisDir, "session-analysis.json"), "utf8"));
  const taskSkillSummary = JSON.parse(readFileSync(path.join(analysisDir, "task-skill-summary.json"), "utf8"));
  const memoryUpdate = JSON.parse(readFileSync(path.join(analysisDir, "memory-update.json"), "utf8"));
  const optimizationWrapUp = JSON.parse(readFileSync(path.join(analysisDir, "optimization-wrap-up.json"), "utf8"));
  const userMemory = JSON.parse(readFileSync(path.join(root, "storage", "memory", "user-memory.json"), "utf8"));

  assert.equal(frames[0].schemaVersion, "frame-analysis.v1");
  assert.equal(frames[0].model, "moondream:1.8b");
  assert.ok(Array.isArray(frames[0].applications));
  assert.ok(frames[0].applications.length >= 1);
  assert.equal(frames[0].applications.filter((application) => application.isPrimary).length, 1);
  assert.equal(frames[0].primaryApplication.name, frames[0].applications.find((application) => application.isPrimary).name);
  assert.ok(Array.isArray(frames[0].keyTasks));
  assert.ok(frames[0].keyTasks.length > 0);
  assert.match(frames[0].keyTasks.join(" "), /attendance|report|review|reconcile/i);
  assert.equal(timeline.schemaVersion, "activity-timeline.v1");
  assert.equal(timeline.textCapturePolicy, "visible_text_ocr_only");
  assert.equal(timeline.scaleSummary.frameCount, 3);
  assert.equal(timeline.scaleSummary.snapshotCount, 3);
  assert.equal(timeline.scaleSummary.segmentCount, 1);
  assert.equal(timeline.scaleSummary.commonTaskCount, 1);
  assert.equal(timeline.scaleSummary.representativeSnapshotCap, 50);
  assert.equal(timeline.scaleSummary.representativeEvidenceIdCap, 50);
  assert.equal(timeline.scaleSummary.evidenceTrailCap, 20);
  assert.match(timeline.scaleSummary.aggregationStrategy, /common_tasks_group_repeated_timeline_segments/);
  assert.equal(timeline.snapshots.length, 3);
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.commonTasks.length, 1);
  assert.equal(timeline.commonTasks[0].frameCount, 3);
  assert.equal(timeline.commonTasks[0].segmentCount, 1);
  assert.equal(timeline.commonTasks[0].evidenceIds.length, 3);
  assert.equal(timeline.commonTasks[0].evidenceTrail.length, 3);
  assert.deepEqual(timeline.snapshots[0].keyTasks, frames[0].keyTasks);
  assert.match(timeline.commonTasks[0].evidenceNarrative, /3 frame\(s\).*1 separated timeline segment/i);
  assert.ok(timeline.commonTasks[0].evidenceTrail.every((entry) => entry.keyTasks.length > 0));
  assert.equal(timeline.segments[0].dwellTimeSeconds, 360);
  assert.equal(timeline.segments[0].evidenceTrail.length, 3);
  assert.match(timeline.segments[0].cognitiveHurdles.join(" "), /Attendance follow-up|dwell|switch/i);
  assert.equal(sessionAnalysis.schemaVersion, "session-analysis.v1");
  assert.equal(sessionAnalysis.sourceFrameCount, 3);
  assert.equal(sessionAnalysis.sessions.length, 1);
  assert.equal(sessionAnalysis.sessions[0].frameCount, 3);
  assert.ok(sessionAnalysis.sessions[0].focusApplication);
  assert.ok(sessionAnalysis.sessions[0].applications.length >= 1);
  assert.match(sessionAnalysis.sessions[0].focusSummary, /frame/i);
  assert.equal(taskSkillSummary.schemaVersion, "task-skill-summary.v1");
  assert.equal(taskSkillSummary.commonTasks.length, 1);
  assert.equal(taskSkillSummary.commonTasks[0].evidenceCount, 3);
  assert.equal(taskSkillSummary.commonTasks[0].evidenceIds.length, 3);
  assert.match(taskSkillSummary.commonTasks[0].topTasks.join(" "), /attendance/i);
  assert.ok(taskSkillSummary.commonTasks[0].skills.some((skill) => skill.category === "employee_weekly_report"));
  assert.ok(taskSkillSummary.commonTasks[0].skills.some((skill) => skill.category === "workflow_automation"));
  assert.ok(taskSkillSummary.commonTasks[0].skills.some((skill) => skill.category === "ai_assistance"));
  assert.equal(patterns.patterns[0].repeatedAcrossEvidence.length, 3);
  assert.match(patterns.patterns[0].summary, /clustered/i);
  assert.match(patterns.patterns[0].signals.join(" "), /hurdle|dwell|switch|reconciliation/i);
  assert.equal(patterns.synthesis.rawMediaLifecycle.mediaFilesObserved, 3);
  assert.equal(proposals.proposals[0].status, "proposed");
  assert.deepEqual(proposals.proposals[0].targetTools, ["Claude", "Codex", "Cursor", "ChatGPT"]);
  assert.equal(new Set(proposals.proposals.map((proposal) => proposal.id)).size, proposals.proposals.length);
  assert.ok(proposals.proposals.some((proposal) => proposal.category === "employee_weekly_report"));
  assert.ok(proposals.proposals.some((proposal) => proposal.category === "workflow_automation"));
  assert.ok(proposals.proposals.some((proposal) => proposal.category === "ai_assistance"));
  assert.ok(proposals.proposals.some((proposal) => proposal.category === "manager_monitoring"));
  assert.ok(proposals.proposals.some((proposal) => proposal.category === "enterprise_rollout"));
  assert.ok(proposals.proposals.some((proposal) => /attendance/i.test(proposal.title)));
  assert.match(proposals.proposals[0].summary, /hurdle|timeline|evidence/i);
  assert.equal(memoryUpdate.schemaVersion, "memory-update.v1");
  assert.equal(memoryUpdate.dayProfile.frameCount, 3);
  assert.equal(memoryUpdate.dayProfile.sessionCount, 1);
  assert.equal(memoryUpdate.memorySummary.regularTaskCount, 1);
  assert.equal(userMemory.schemaVersion, "user-memory.v1");
  assert.equal(userMemory.regularTasks.length, 1);
  assert.equal(optimizationWrapUp.schemaVersion, "optimization-wrap-up.v1");
  assert.equal(optimizationWrapUp.efficiencyRecommendations.length, 10);
  assert.ok(optimizationWrapUp.efficiencyRecommendations.every((recommendation) => recommendation.evidenceIds.length > 0));
  assert.equal(optimizationWrapUp.procrastinationEstimate.classification, "no_strong_signal");

  assert.doesNotThrow(() => assertPrivacySafe(frames, "frames"));
  assert.doesNotThrow(() => assertPrivacySafe(timeline, "timeline"));
  assert.doesNotThrow(() => assertPrivacySafe(sessionAnalysis, "sessionAnalysis"));
  assert.doesNotThrow(() => assertPrivacySafe(taskSkillSummary, "taskSkillSummary"));
  assert.doesNotThrow(() => assertPrivacySafe(patterns, "patterns"));
  assert.doesNotThrow(() => assertPrivacySafe(proposals, "proposals"));
  assert.doesNotThrow(() => assertPrivacySafe(memoryUpdate, "memoryUpdate"));
  assert.doesNotThrow(() => assertPrivacySafe(userMemory, "userMemory"));
  assert.doesNotThrow(() => assertPrivacySafe(optimizationWrapUp, "optimizationWrapUp"));
});

test("MMP readiness verifier proves common-task aggregation and skill coverage", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });
  generateDailyReport({ root, day: "2026-05-30" });

  const output = execFileSync("node", ["scripts/verify-mmp-readiness.mjs", "--day", "2026-05-30"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUCILLE_ROOT: root
    },
    encoding: "utf8"
  });

  assert.match(output, /MMP readiness: ready/);
  assert.match(output, /Frames: 3/);
  assert.match(output, /Sessions: 1/);
  assert.match(output, /Common tasks: 1/);
  assert.match(output, /Task-skill summaries: 1/);
  assert.match(output, /Repeated-task frame evidence: 3/);
  assert.match(output, /Memory regular tasks: 1/);
  assert.match(output, /Wrap-up recommendations: 10/);
  assert.match(output, /employee_weekly_report/);
  assert.match(output, /workflow_automation/);
  assert.match(output, /ai_assistance/);
  assert.match(output, /manager_monitoring/);
  assert.match(output, /enterprise_rollout/);
});

test("user memory replaces a rerun day instead of double-counting it", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  const memory = JSON.parse(readFileSync(path.join(root, "storage", "memory", "user-memory.json"), "utf8"));
  assert.deepEqual(memory.analysedDays, ["2026-05-30"]);
  assert.equal(memory.dayProfiles.length, 1);
  assert.equal(memory.regularTasks[0].observedFrameCount, 3);
  assert.equal(memory.regularTasks[0].observedSessionCount, 1);
});

test("runAnalysis resumes from cached real frame analysis without re-calling the provider", async () => {
  const root = fixtureRoot();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    const observation = parseObservationFromOllamaPrompt(JSON.parse(options.body).prompt);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        response: JSON.stringify(buildLocalVisualTestResponse(observation))
      })
    };
  };

  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    fetchImpl
  });
  assert.equal(calls, 3);

  const progress = [];
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    onFrameProgress: (event) => progress.push(event.status),
    fetchImpl: async () => {
      throw new Error("provider should not be called for cached frames");
    }
  });

  assert.deepEqual(progress, ["cached", "cached", "cached"]);
  const cacheDir = path.join(root, "storage", "analysis", "2026-05-30", "frame-cache");
  assert.ok(existsSync(cacheDir));
  const memory = JSON.parse(readFileSync(path.join(root, "storage", "memory", "user-memory.json"), "utf8"));
  assert.equal(memory.regularTasks[0].observedFrameCount, 3);
});

test("runAnalysis normalizes generic cached import metadata as a blank frame", async () => {
  const root = fixtureRoot();
  const day = "2026-05-30";
  const observation = readFileSync(path.join(root, "storage", "captures", day, "observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];
  const cacheDir = path.join(
    root,
    "storage",
    "analysis",
    day,
    "frame-cache",
    "moondream-1-8b",
    "frame-analysis-visual-app-url-memory-1536-primary-url-2026-06-06"
  );
  mkdirSync(cacheDir, { recursive: true });
  const frame = {
    schemaVersion: "frame-analysis.v1",
    evidenceId: observation.evidenceIds[0],
    frameId: observation.id,
    day,
    capturedAt: observation.capturedAt,
    provider: "ollama",
    model: "moondream:1.8b",
    surface: {
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null
    },
    applications: [
      {
        name: "Unknown",
        windowTitle: null,
        domain: null,
        isPrimary: true,
        primaryReason: "No visible application branding or window title"
      }
    ],
    visitedUrls: [],
    primaryApplication: {
      name: "Unknown",
      windowTitle: null,
      domain: null,
      primaryReason: "No visible application branding or window title"
    },
    activities: ["archived_screen_capture"],
    visibleIntent: "analyze locally imported screen frame",
    keyTasks: ["Review a visible work surface", "analyze screen frame"],
    evidence: [
      {
        id: observation.evidenceIds[0],
        kind: "local_visual_summary",
        summary: "A screen frame was imported from the Downloads Archive for local Lucille analysis."
      },
      {
        id: `${observation.id}-local-visual-02`,
        kind: "local_visual_summary",
        summary: "The screen frame is a day-scoped local raw media."
      }
    ],
    redactions: ["no_keystrokes", "no_clipboard_capture", "no_audio_capture", "no_raw_document_bodies", "no_raw_message_bodies", "query_strings_removed"],
    riskFlags: []
  };
  writeFileSync(path.join(cacheDir, `${observation.id}.json`), JSON.stringify({
    schemaVersion: "frame-analysis-cache.v1",
    promptVersion: "frame-analysis-visual-app-url-memory-1536-primary-url-2026-06-06",
    provider: "ollama",
    model: "moondream:1.8b",
    day,
    frameId: observation.id,
    evidenceId: observation.evidenceIds[0],
    cachedAt: "2026-06-06T00:00:00.000Z",
    frame
  }, null, 2) + "\n");

  await runAnalysis({
    root,
    day,
    model: "moondream:1.8b",
    slides: "1",
    fetchImpl: async () => {
      throw new Error("provider should not be called for cached frame");
    }
  });

  const analysedFrame = readFileSync(path.join(root, "storage", "analysis", day, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.equal(analysedFrame.primaryApplication.name, "No visible application");
  assert.deepEqual(analysedFrame.applications.map((application) => application.name), ["No visible application"]);
  assert.deepEqual(analysedFrame.keyTasks, ["No visible work surface identified"]);
  assert.match(analysedFrame.evidence[0].summary, /blank, obscured, or too dark/);
  assert.doesNotMatch(JSON.stringify(analysedFrame), /Downloads Archive|structured metadata|raw media/i);
});

test("runAnalysis drops implausible app-derived cached URLs", async () => {
  const root = fixtureRoot();
  const day = "2026-05-30";
  const observation = readFileSync(path.join(root, "storage", "captures", day, "observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];
  const cacheDir = path.join(
    root,
    "storage",
    "analysis",
    day,
    "frame-cache",
    "moondream-1-8b",
    "frame-analysis-visual-app-url-memory-1536-primary-url-2026-06-06"
  );
  mkdirSync(cacheDir, { recursive: true });
  const frame = {
    schemaVersion: "frame-analysis.v1",
    evidenceId: observation.evidenceIds[0],
    frameId: observation.id,
    day,
    capturedAt: observation.capturedAt,
    provider: "ollama",
    model: "moondream:1.8b",
    surface: {
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null
    },
    applications: [
      {
        name: "Browser",
        windowTitle: "Canvas",
        domain: "canvas",
        isPrimary: true,
        primaryReason: "Browser surface is visible."
      },
      {
        name: "GitHub",
        windowTitle: "Pull request",
        domain: "github.com",
        isPrimary: false,
        primaryReason: "GitHub pull request is visible."
      }
    ],
    visitedUrls: ["https://canvas/"],
    primaryApplication: {
      name: "Browser",
      windowTitle: "Canvas",
      domain: "canvas",
      primaryReason: "Browser surface is visible."
    },
    activities: ["browser_review"],
    visibleIntent: "Reviewing a browser report page.",
    keyTasks: ["Review report or dashboard state"],
    evidence: [
      {
        id: observation.evidenceIds[0],
        kind: "local_visual_summary",
        summary: "A browser tab is visible."
      }
    ],
    redactions: ["no_keystrokes", "no_clipboard_capture", "no_audio_capture", "no_raw_document_bodies", "no_raw_message_bodies", "query_strings_removed"],
    riskFlags: []
  };
  writeFileSync(path.join(cacheDir, `${observation.id}.json`), JSON.stringify({
    schemaVersion: "frame-analysis-cache.v1",
    promptVersion: "frame-analysis-visual-app-url-memory-1536-primary-url-2026-06-06",
    provider: "ollama",
    model: "moondream:1.8b",
    day,
    frameId: observation.id,
    evidenceId: observation.evidenceIds[0],
    cachedAt: "2026-06-06T00:00:00.000Z",
    frame
  }, null, 2) + "\n");

  await runAnalysis({
    root,
    day,
    model: "moondream:1.8b",
    slides: "1",
    fetchImpl: async () => {
      throw new Error("provider should not be called for cached frame");
    }
  });

  const analysedFrame = readFileSync(path.join(root, "storage", "analysis", day, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(analysedFrame.visitedUrls, ["https://github.com/"]);
  assert.doesNotMatch(JSON.stringify(analysedFrame.visitedUrls), /canvas/);
});

test("MMP readiness verifier rejects stale task-skill summaries", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });
  generateDailyReport({ root, day: "2026-05-30" });
  const summaryPath = path.join(root, "storage", "analysis", "2026-05-30", "task-skill-summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  summary.commonTasks[0].title = "Stale task title";
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");

  assert.throws(
    () => execFileSync("node", ["scripts/verify-mmp-readiness.mjs", "--day", "2026-05-30"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LUCILLE_ROOT: root
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }),
    /task-skill-summary\.json is stale/
  );
});

test("CLI tasks command lists common tasks before matching skills", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });

  const output = execFileSync("node", [path.join(process.cwd(), "src", "cli.mjs"), "tasks", "--day", "2026-05-30"], {
    cwd: root,
    env: process.env,
    encoding: "utf8"
  });

  assert.match(output, /Common tasks for 2026-05-30/);
  assert.match(output, /Attendance report review workflow/);
  assert.match(output, /3 frame\(s\), 1 segment\(s\)/);
  assert.match(output, /Representative evidence IDs: fixture-evidence-001, fixture-evidence-002, fixture-evidence-003/);
  assert.match(output, /Key tasks: .*attendance/i);
  assert.match(output, /Skills:/);
  assert.match(output, /\[employee_weekly_report\]/);
  assert.match(output, /\[workflow_automation\]/);
  assert.match(output, /\[ai_assistance\]/);
});

test("CLI analyse writes a latest debug analysis JSON bundle", async () => {
  const root = fixtureRoot();
  const debugPath = path.join(root, "debug", "latest-debug-analysis.json");
  const server = await startLocalOllamaTestServer();

  let output;
  try {
    const result = await execFileAsync("node", [
      path.join(process.cwd(), "src", "cli.mjs"),
      "analyse",
      "--day", "2026-05-30",
      "--model", "moondream:1.8b",
      "--provider", "ollama",
      "--slides", "1,3",
      "--debug-output", debugPath
    ], {
      cwd: root,
      env: {
        ...process.env,
        OLLAMA_HOST: server.url
      },
      encoding: "utf8"
    });
    output = result.stdout;
  } finally {
    await server.close();
  }

  const debugOutput = JSON.parse(readFileSync(debugPath, "utf8"));
  assert.match(output, /Debug JSON:/);
  assert.equal(debugOutput.schemaVersion, "debug-analysis.v1");
  assert.equal(debugOutput.result.frameCount, 2);
  assert.equal(debugOutput.result.analysisDir, "storage/analysis/2026-05-30");
  assert.deepEqual(debugOutput.artifacts.frameAnalysis.map((frame) => frame.frameId), [
    "2026-05-30-mock-frame-001",
    "2026-05-30-mock-frame-003"
  ]);
  assert.equal(debugOutput.artifacts.activityTimeline.schemaVersion, "activity-timeline.v1");
  assert.equal(debugOutput.artifacts.sessionAnalysis.schemaVersion, "session-analysis.v1");
  assert.equal(debugOutput.artifacts.workPatterns.schemaVersion, "work-patterns.v1");
  assert.equal(debugOutput.artifacts.skillProposals.schemaVersion, "skill-proposals.v1");
  assert.equal(debugOutput.artifacts.taskSkillSummary.schemaVersion, "task-skill-summary.v1");
  assert.equal(debugOutput.artifacts.memoryUpdate.schemaVersion, "memory-update.v1");
  assert.equal(debugOutput.artifacts.optimizationWrapUp.schemaVersion, "optimization-wrap-up.v1");
  assert.equal(debugOutput.artifacts.optimizationWrapUp.efficiencyRecommendations.length, 10);
});

test("activity timeline groups repeated screenshots into a dwell-bearing segment", () => {
  const frames = [
    syntheticFrame({
      id: "dev-frame-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille pull request review",
      visibleIntent: "Reviewing a GitHub pull request and visible code changes.",
      evidence: ["GitHub pull request diff", "reviewing code changes"]
    }),
    syntheticFrame({
      id: "dev-frame-002",
      capturedAt: "2026-05-30T09:02:00.000Z",
      appName: "Terminal",
      windowTitle: "Lucille tests",
      visibleIntent: "Inspecting test command output for the same GitHub pull request.",
      evidence: ["terminal test output", "visible failing test summary"]
    }),
    syntheticFrame({
      id: "dev-frame-003",
      capturedAt: "2026-05-30T09:04:00.000Z",
      appName: "Chrome",
      windowTitle: "GitHub pull request conversation",
      visibleIntent: "Returning to the pull request conversation after checking test output.",
      evidence: ["GitHub pull request conversation", "unresolved review follow-up"]
    })
  ];

  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });

  assert.equal(timeline.schemaVersion, "activity-timeline.v1");
  assert.equal(timeline.textCapturePolicy, "visible_text_ocr_only");
  assert.equal(timeline.scaleSummary.frameCount, 3);
  assert.equal(timeline.scaleSummary.snapshotCount, 3);
  assert.equal(timeline.scaleSummary.commonTaskCount, 1);
  assert.equal(timeline.scaleSummary.representativeSnapshotCap, 50);
  assert.equal(timeline.snapshots.length, 3);
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.commonTasks.length, 1);
  assert.equal(timeline.commonTasks[0].frameCount, 3);
  assert.equal(timeline.commonTasks[0].segmentCount, 1);
  assert.equal(timeline.commonTasks[0].evidenceTrail.length, 3);
  assert.match(timeline.commonTasks[0].evidenceTrail[0].keyTasks.join(" "), /engineering|code|review/i);
  assert.equal(timeline.segments[0].dwellTimeSeconds, 360);
  assert.equal(timeline.segments[0].surfaceSwitchCount, 2);
  assert.deepEqual(timeline.segments[0].evidenceIds, [
    "dev-frame-001-evidence",
    "dev-frame-002-evidence",
    "dev-frame-003-evidence"
  ]);
  assert.match(timeline.segments[0].userIntent, /engineering|review/i);
});

test("session analysis extracts real commands without treating Git labels as commands", () => {
  const frames = [
    syntheticFrame({
      id: "command-frame-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Terminal",
      windowTitle: "Lucille tests",
      visibleIntent: "Inspecting npm test output and Git changes in the sidebar.",
      evidence: ["Terminal shows npm test running", "Git changes panel is visible"]
    }),
    syntheticFrame({
      id: "command-frame-002",
      capturedAt: "2026-05-30T09:01:00.000Z",
      appName: "Terminal",
      windowTitle: "Lucille tests",
      visibleIntent: "Reviewing git status before rerunning checks.",
      evidence: ["Terminal shows git status"]
    })
  ];
  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });
  const sessionAnalysis = buildSessionAnalysis({ day: "2026-05-30", frames, activityTimeline: timeline });
  const commands = sessionAnalysis.sessions.flatMap((session) => session.commands.map((item) => item.command));

  assert.ok(commands.some((command) => command.startsWith("npm test")));
  assert.ok(commands.some((command) => command.startsWith("git status")));
  assert.ok(!commands.some((command) => /Git changes/i.test(command)));
});

test("activity timeline splits large gaps and stores only redacted visible snippets", () => {
  const frames = [
    syntheticFrame({
      id: "safe-frame-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Terminal",
      windowTitle: "Visible console",
      visibleIntent: "Inspecting a visible console error.",
      evidence: [
        "https://example.test/path?token=abc",
        "password reset token appears on screen",
        "visible console error summary"
      ]
    }),
    syntheticFrame({
      id: "safe-frame-002",
      capturedAt: "2026-05-30T09:11:01.000Z",
      appName: "Terminal",
      windowTitle: "Visible console",
      visibleIntent: "Inspecting a visible console error after a long pause.",
      evidence: ["visible console retry summary"]
    })
  ];

  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });
  const serialized = JSON.stringify(timeline);
  const keyText = collectKeys(timeline).join(" ");

  assert.equal(timeline.segments.length, 2);
  assert.equal(timeline.commonTasks.length, 1);
  assert.equal(timeline.commonTasks[0].segmentCount, 2);
  assert.equal(timeline.commonTasks[0].segmentIds.length, 2);
  assert.deepEqual(timeline.commonTasks[0].evidenceIds, [
    "safe-frame-001-evidence",
    "safe-frame-002-evidence"
  ]);
  assert.doesNotMatch(serialized, /example\.test\/path\?/);
  assert.doesNotMatch(serialized, /password reset token/);
  assert.match(serialized, /visible console error summary/);
  assert.doesNotMatch(keyText, /keystroke|clipboard|audio|rawDocument|rawMessage/i);
  assert.doesNotThrow(() => assertPrivacySafe(timeline, "activityTimeline"));
});

test("activity timeline classifies by primary frame intent before secondary surfaces", () => {
  const frames = [
    syntheticFrame({
      id: "mixed-attendance-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Browser",
      windowTitle: "Archived capture",
      visibleIntent: "Review attendance report follow-up and reconciliation.",
      activities: ["attendance review"],
      evidence: [
        "Attendance report needs manual reconciliation",
        "Secondary console output and GitHub pull request are visible in another window"
      ],
      keyTasks: [
        "Review attendance report evidence",
        "Reconcile visible evidence and quality checks"
      ]
    }),
    syntheticFrame({
      id: "mixed-development-001",
      capturedAt: "2026-05-30T09:01:00.000Z",
      appName: "Cursor",
      windowTitle: "Archived capture",
      visibleIntent: "Debugging and reviewing code for validation errors.",
      activities: ["code review and debugging"],
      evidence: [
        "Code editor and terminal error output are the main work surface",
        "A secondary attendance report is visible in another browser window"
      ],
      keyTasks: [
        "Review engineering work and code context",
        "Inspect command output and troubleshoot blockers"
      ]
    })
  ];

  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });

  assert.equal(timeline.segments.length, 2);
  assert.equal(timeline.commonTasks.length, 2);
  assert.equal(timeline.segments[0].title, "Attendance report review workflow");
  assert.equal(timeline.segments[1].title, "Development review and reporting workflow");
  assert.match(timeline.segments[0].evidenceTrail[0].keyTasks.join(" "), /attendance/i);
  assert.match(timeline.segments[1].evidenceTrail[0].keyTasks.join(" "), /engineering|command|troubleshoot/i);
});

test("activity timeline caps representative evidence while preserving full frame counts", () => {
  const frames = Array.from({ length: 64 }, (_, index) => syntheticFrame({
    id: `scale-frame-${String(index + 1).padStart(3, "0")}`,
    capturedAt: `2026-05-30T09:${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 10).padStart(2, "0")}.000Z`,
    appName: "Browser",
    windowTitle: "Attendance report",
    visibleIntent: "Review attendance report follow-up and reconciliation.",
    activities: ["attendance review"],
    evidence: ["Attendance report needs manual reconciliation"],
    keyTasks: [
      "Review attendance report evidence",
      "Reconcile visible evidence and quality checks"
    ]
  }));

  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });

  assert.equal(timeline.scaleSummary.frameCount, 64);
  assert.equal(timeline.scaleSummary.snapshotCount, 50);
  assert.equal(timeline.scaleSummary.segmentCount, 1);
  assert.equal(timeline.scaleSummary.commonTaskCount, 1);
  assert.equal(timeline.scaleSummary.representativeSnapshotCap, 50);
  assert.equal(timeline.scaleSummary.representativeEvidenceIdCap, 50);
  assert.equal(timeline.scaleSummary.evidenceTrailCap, 20);
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.snapshots.length, 50);
  assert.equal(timeline.segments[0].frameCount, 64);
  assert.equal(timeline.segments[0].evidenceIds.length, 50);
  assert.equal(timeline.segments[0].evidenceTrail.length, 20);
  assert.equal(timeline.commonTasks.length, 1);
  assert.equal(timeline.commonTasks[0].frameCount, 64);
  assert.equal(timeline.commonTasks[0].segmentCount, 1);
  assert.equal(timeline.commonTasks[0].evidenceIds.length, 50);
  assert.equal(timeline.commonTasks[0].evidenceTrail.length, 20);
  assert.match(timeline.commonTasks[0].evidenceNarrative, /20 frame\(s\).*64 screenshot-backed evidence item\(s\)/);
});

test("activity timeline caps representative segment IDs while preserving full segment counts", () => {
  const start = Date.parse("2026-05-30T08:00:00.000Z");
  const frames = Array.from({ length: 48 }, (_, index) => syntheticFrame({
    id: `repeat-segment-${String(index + 1).padStart(3, "0")}`,
    capturedAt: new Date(start + index * 11 * 60 * 1000).toISOString(),
    appName: "Browser",
    windowTitle: "Attendance report",
    visibleIntent: "Review attendance report follow-up and reconciliation.",
    activities: ["attendance review"],
    evidence: ["Attendance report needs manual reconciliation"],
    keyTasks: [
      "Review attendance report evidence",
      "Reconcile visible evidence and quality checks"
    ]
  }));

  const timeline = buildActivityTimeline({ day: "2026-05-30", frames });

  assert.equal(timeline.scaleSummary.frameCount, 48);
  assert.equal(timeline.scaleSummary.segmentCount, 48);
  assert.equal(timeline.scaleSummary.commonTaskCount, 1);
  assert.equal(timeline.segments.length, 48);
  assert.equal(timeline.commonTasks.length, 1);
  assert.equal(timeline.commonTasks[0].segmentCount, 48);
  assert.equal(timeline.commonTasks[0].segmentIds.length, 40);
  assert.equal(timeline.commonTasks[0].frameCount, 48);
  assert.equal(timeline.commonTasks[0].evidenceIds.length, 48);
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
  assert.equal(result.rawMediaLifecycle.mediaFilesObserved, 4);
  assert.equal(result.rawMediaLifecycle.mediaFilesDeleted, 0);
  assert.equal(result.rawMediaLifecycle.mediaFilesRetained, 4);
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
  assert.equal(result.rawMediaLifecycle.mediaFilesObserved, 4);
  assert.equal(result.rawMediaLifecycle.mediaFilesDeleted, 4);
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
  assert.equal(result.memoryRegularTaskCount, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frameId, "2026-05-30-mock-frame-002");
  assert.equal(frames[0].evidenceId, "fixture-evidence-002");
  const memory = JSON.parse(readFileSync(path.join(root, "storage", "memory", "user-memory.json"), "utf8"));
  assert.equal(memory.dayProfiles.length, 1);
  assert.equal(memory.dayProfiles[0].taskSignals.length, 1);
  assert.equal(memory.regularTasks.length, 0);
});

test("runAnalysis can analyse selected slide groups for debug analysis", async () => {
  const root = fixtureRoot();

  const result = await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    slides: "1,3"
  });

  const analysisDir = path.join(root, "storage", "analysis", "2026-05-30");
  const frames = readFileSync(path.join(analysisDir, "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.frameCount, 2);
  assert.deepEqual(frames.map((frame) => frame.frameId), [
    "2026-05-30-mock-frame-001",
    "2026-05-30-mock-frame-003"
  ]);
  assert.deepEqual(frames.map((frame) => frame.evidenceId), [
    "fixture-evidence-001",
    "fixture-evidence-003"
  ]);
});

test("runAnalysis rejects invalid debug slide selections", async () => {
  const root = fixtureRoot();

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      slides: "3-1"
    }),
    /range end must be greater than or equal to start/
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      slides: "4"
    }),
    /outside the 3 observation/
  );

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b",
      slides: "1,3",
      limit: 1
    }),
    /--slides cannot be combined/
  );
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
  rmSync(path.join(root, "storage", "captures", "2026-05-30", "raw-media"), {
    recursive: true,
    force: true
  });

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
    /No local raw media found.*Mock fixture analysis is disabled/
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
	            applications: [
	              {
	                name: "Cursor",
	                windowTitle: "Lucille project workspace",
	                domain: null,
	                isPrimary: false,
	                primaryReason: "Code editor is visible but the cursor is not on it."
	              },
	              {
	                name: "Terminal",
	                windowTitle: "Lucille tests",
	                domain: null,
	                isPrimary: true,
	                primaryReason: "Mouse cursor is positioned over the terminal output area."
	              }
	            ],
	            primaryApplication: {
	              name: "Terminal",
	              windowTitle: "Lucille tests",
	              domain: null,
	              primaryReason: "Mouse cursor is positioned over the terminal output area."
	            },
	            visitedUrls: [],
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
	  assert.deepEqual(frames[0].applications.map((application) => application.name), ["Cursor", "Terminal"]);
	  assert.deepEqual(frames[0].visitedUrls, []);
	  assert.equal(frames[0].primaryApplication.name, "Terminal");
	  assert.match(frames[0].primaryApplication.primaryReason, /cursor/i);
	  assert.deepEqual(frames[0].riskFlags, ["possible_sensitive_visible_text"]);
  assert.equal(patterns.provider, "ollama");
  assert.deepEqual(patterns.patterns[0].repeatedAcrossEvidence, ["obs-local-001-raw-frame"]);
  assert.equal(patterns.synthesis.rawScreenshotsSent, false);
  assert.equal(patterns.synthesis.rawMediaLifecycle.action, "retained_by_default");
  assert.equal(existsSync(path.join(rawMediaDir, "obs-local-001.png")), true);
  assert.doesNotThrow(() => assertPrivacySafe(frames, "ollamaFrames"));
  assert.doesNotThrow(() => assertPrivacySafe(patterns, "ollamaPatterns"));
});

test("Ollama provider retries a timed-out local image request at fallback size", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-retry-001.png"), "local retry image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-retry-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["obs-retry-001-raw-frame"]
    }) + "\n"
  );

  const attempts = [];
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "ollama",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      attempts.push(body.prompt);
      if (attempts.length === 1) {
        throw new Error("This operation was aborted");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({
            activity: "code_review",
            visibleIntent: "Reviewing local code.",
            applications: [
              {
                name: "Cursor",
                windowTitle: "Lucille project workspace",
                domain: null,
                isPrimary: true,
                primaryReason: "The editor is the focused window."
              }
            ],
            primaryApplication: {
              name: "Cursor",
              windowTitle: "Lucille project workspace",
              domain: null,
              primaryReason: "The editor is the focused window."
            },
            visitedUrls: [],
            keyTasks: ["Review engineering work and code context"],
            evidenceSummaries: ["Cursor shows a local code workspace."],
            riskFlags: []
          })
        })
      };
    }
  });

  assert.equal(attempts.length, 2);
  assert.match(attempts[0], /1536px/);
  assert.match(attempts[1], /1024px/);
});

test("Ollama provider retries malformed local model JSON at fallback size", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-json-retry-001.png"), "local malformed json retry image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-json-retry-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Google Chrome",
      windowTitle: "Google Search",
      domain: "google.com",
      activity: "browser_research",
      visibleTextSummary: "A visible browser search page was captured for local analysis.",
      redactedSignals: ["browser search results visible"],
      evidenceIds: ["obs-json-retry-001-raw-frame"]
    }) + "\n"
  );

  const attempts = [];
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    provider: "ollama",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      attempts.push(body.prompt);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: attempts.length === 1
            ? "{\"activity\":\"browser_research\","
            : JSON.stringify({
              activity: "browser_research",
              visibleIntent: "Reviewing browser search results.",
              applications: [
                {
                  name: "Google Chrome",
                  windowTitle: "Google Search",
                  domain: "google.com",
                  isPrimary: true,
                  primaryReason: "The browser is the focused window."
                }
              ],
              primaryApplication: {
                name: "Google Chrome",
                windowTitle: "Google Search",
                domain: "google.com",
                primaryReason: "The browser is the focused window."
              },
              visitedUrls: ["https://google.com/search"],
              keyTasks: ["Search for information"],
              evidenceSummaries: ["Google search results are visible."],
              riskFlags: []
            })
        })
      };
    }
  });

  assert.equal(attempts.length, 2);
  assert.match(attempts[0], /1536px/);
  assert.match(attempts[1], /1024px/);
});

test("Ollama provider differentiates Discord Slack and Microsoft Teams applications", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-chat-001.png"), "local chat apps image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-chat-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Browser",
      windowTitle: "Visible communication workspace",
      domain: null,
      activity: "communication_review",
      visibleTextSummary: "Discord, Slack, and Microsoft Teams communication windows are visible.",
      redactedSignals: ["discord channel visible", "slack workspace visible", "teams chat visible"],
      evidenceIds: ["obs-chat-001-raw-frame"]
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
          activity: "communication_review",
          visibleIntent: "Reviewing communication across visible chat applications.",
          applications: [
            {
              name: "Chat",
              windowTitle: "community-server",
              domain: "discord.com",
              isPrimary: true,
              primaryReason: "Cursor is over the Discord channel list."
            },
            {
              name: "Workspace chat",
              windowTitle: "Engineering Slack",
              domain: "slack.com",
              isPrimary: false,
              primaryReason: "Slack is visible but the cursor is not on it."
            },
            {
              name: "Teams",
              windowTitle: "Daily standup",
              domain: "teams.microsoft.com",
              isPrimary: false,
              primaryReason: "Teams is visible but not under the cursor."
            }
          ],
          primaryApplication: {
            name: "Chat",
            windowTitle: "community-server",
            domain: "discord.com",
            primaryReason: "Cursor is over the Discord channel list."
          },
          keyTasks: ["Draft or review follow-up communication"],
          evidenceSummaries: [
            "Discord channel list is visible",
            "Slack workspace is visible",
            "Microsoft Teams chat is visible"
          ],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), [
    "Discord",
    "Slack",
    "Microsoft Teams",
    "Browser"
  ]);
  assert.equal(frame.primaryApplication.name, "Discord");
  assert.equal(frame.applications.filter((application) => application.isPrimary).length, 1);
});

test("Ollama provider treats the Arbor data and AI communication window as Slack", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-slack-001.png"), "local slack image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-slack-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Browser",
      windowTitle: "Visible communication workspace",
      domain: null,
      activity: "communication_review",
      visibleTextSummary: "The Arbor data and AI Slack channel is visible.",
      redactedSignals: ["arbor-data-and-ai channel visible", "slack workspace visible"],
      evidenceIds: ["obs-slack-001-raw-frame"]
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
          activity: "communication_review",
          visibleIntent: "Reviewing the Arbor data and AI communication channel.",
          applications: [
            {
              name: "Discord",
              windowTitle: "arbor-data-and-ai",
              domain: "discord.com",
              isPrimary: true,
              primaryReason: "Cursor is over the communication window."
            }
          ],
          primaryApplication: {
            name: "Discord",
            windowTitle: "arbor-data-and-ai",
            domain: "discord.com",
            primaryReason: "Cursor is over the communication window."
          },
          keyTasks: ["Draft or review follow-up communication"],
          evidenceSummaries: ["Arbor data and AI Slack channel is visible"],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.equal(frame.applications[0].name, "Slack");
  assert.equal(frame.applications[0].domain, "arbor-data-and-ai.slack.com");
  assert.equal(frame.primaryApplication.name, "Slack");
});

test("Ollama provider removes vague Discord duplicates from Slack workspace frames", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-slack-duplicate-001.png"), "local slack image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-slack-duplicate-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Slack",
      windowTitle: "Engineering Slack",
      domain: "slack.com",
      activity: "communication_review",
      visibleTextSummary: "A Slack workspace and code editor are visible.",
      redactedSignals: ["slack workspace visible", "code editor visible"],
      evidenceIds: ["obs-slack-duplicate-001-raw-frame"]
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
          activity: "communication_review",
          visibleIntent: "Reviewing code while monitoring Slack messages.",
          applications: [
            {
              name: "Microsoft Teams",
              windowTitle: "Teams",
              domain: "teams.microsoft.com",
              isPrimary: true,
              primaryReason: "The cursor is over a Teams chat window."
            },
            {
              name: "Visual Studio Code",
              windowTitle: "Lucille project",
              domain: null,
              isPrimary: false,
              primaryReason: "Cursor is over the code editor."
            },
            {
              name: "Discord",
              windowTitle: "Discord",
              domain: "discord.com",
              isPrimary: false,
              primaryReason: "Discord window is visible but not the primary focus."
            },
            {
              name: "Slack",
              windowTitle: "Engineering Slack",
              domain: "slack.com",
              isPrimary: false,
              primaryReason: "Slack window is visible but not the primary focus."
            }
          ],
          primaryApplication: {
            name: "Microsoft Teams",
            windowTitle: "Teams",
            domain: "teams.microsoft.com",
            primaryReason: "The cursor is over a Teams chat window."
          },
          visitedUrls: ["https://discord.com/"],
          keyTasks: ["reviewing Discord messages", "Draft or review follow-up communication"],
          evidenceSummaries: [
            "Discord window shows communication activity.",
            "Slack workspace is visible."
          ],
          riskFlags: ["The presence of ongoing communication in Slack and Discord could indicate a need for coordination."]
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), [
    "Slack",
    "Visual Studio Code"
  ]);
  assert.equal(frame.primaryApplication.name, "Slack");
  assert.equal(frame.applications.filter((application) => application.isPrimary).length, 1);
  assert.deepEqual(frame.visitedUrls, []);
  assert.doesNotMatch(JSON.stringify(frame), /discord/i);
});

test("Ollama provider treats ambiguous Discord and Teams chat mix as Slack when no browser is present", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-slack-ambiguous-001.png"), "local slack image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-slack-ambiguous-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "communication_review",
      visibleTextSummary: "A communication workspace is visible.",
      redactedSignals: ["communication workspace visible", "code review visible"],
      evidenceIds: ["obs-slack-ambiguous-001-raw-frame"]
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
          activity: "communication_review",
          visibleIntent: "Reviewing a chat thread about code review.",
          applications: [
            {
              name: "Microsoft Teams",
              windowTitle: "Microsoft Teams",
              domain: null,
              isPrimary: true,
              primaryReason: "Microsoft Teams window is active and in focus."
            },
            {
              name: "Discord",
              windowTitle: "Discord",
              domain: null,
              isPrimary: false,
              primaryReason: "Discord window is visible but not the primary focus."
            }
          ],
          primaryApplication: {
            name: "Microsoft Teams",
            windowTitle: "Microsoft Teams",
            domain: null,
            primaryReason: "Microsoft Teams window is active and in focus."
          },
          visitedUrls: ["https://teams.microsoft.com/"],
          keyTasks: ["reviewing Microsoft Teams chat", "reviewing Discord messages"],
          evidenceSummaries: ["The user is reviewing code in a Microsoft Teams chat window."],
          riskFlags: ["Discord and Microsoft Teams are open."]
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), ["Slack"]);
  assert.equal(frame.primaryApplication.name, "Slack");
  assert.deepEqual(frame.visitedUrls, []);
  assert.doesNotMatch(JSON.stringify(frame), /discord|teams/i);
});

test("Ollama provider treats ambiguous Teams-only chat as Slack when Teams UI cues are absent", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-slack-teams-only-001.png"), "local slack image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-slack-teams-only-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "communication_review",
      visibleTextSummary: "A communication workspace is visible.",
      redactedSignals: ["communication workspace visible", "terminal visible"],
      evidenceIds: ["obs-slack-teams-only-001-raw-frame"]
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
          activity: "communication_review",
          visibleIntent: "Reviewing a chat message about a project task.",
          applications: [
            {
              name: "Microsoft Teams",
              windowTitle: "MIS-71371 Adjust",
              domain: "teams.microsoft.com",
              isPrimary: true,
              primaryReason: "The cursor is over the Teams window, indicating it is the primary application."
            },
            {
              name: "Terminal",
              windowTitle: "Terminal",
              domain: null,
              isPrimary: false,
              primaryReason: "Terminal window is visible but not under the cursor."
            }
          ],
          primaryApplication: {
            name: "Microsoft Teams",
            windowTitle: "MIS-71371 Adjust",
            domain: "teams.microsoft.com",
            primaryReason: "The cursor is over the Teams window, indicating it is the primary application."
          },
          visitedUrls: ["https://teams.microsoft.com/"],
          keyTasks: ["reviewing Microsoft Teams chat", "Inspect command output and troubleshoot blockers"],
          evidenceSummaries: ["The user is reviewing a chat message in Microsoft Teams regarding a project task."],
          riskFlags: ["The user is working with sensitive project information in a shared Teams environment."]
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), ["Slack", "Terminal"]);
  assert.equal(frame.primaryApplication.name, "Slack");
  assert.deepEqual(frame.visitedUrls, []);
  assert.doesNotMatch(JSON.stringify({
    applications: frame.applications,
    primaryApplication: frame.primaryApplication,
    keyTasks: frame.keyTasks,
    evidence: frame.evidence.map((item) => ({ kind: item.kind, summary: item.summary })),
    riskFlags: frame.riskFlags,
    visitedUrls: frame.visitedUrls
  }), /teams/i);
});

test("Ollama provider treats Teams-labelled calendar surfaces as Google Calendar", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-calendar-001.png"), "local calendar image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-calendar-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Google Chrome",
      windowTitle: "Google Calendar",
      domain: "calendar.google.com",
      activity: "calendar_review",
      visibleTextSummary: "Google Calendar is visible beside a code editor.",
      redactedSignals: ["calendar visible", "code editor visible"],
      evidenceIds: ["obs-calendar-001-raw-frame"]
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
          activity: "calendar_review",
          visibleIntent: "Reviewing calendar while working on code.",
          applications: [
            {
              name: "Microsoft Teams",
              windowTitle: "June 2026",
              domain: "teams.microsoft.com",
              isPrimary: false,
              primaryReason: "calendar view"
            },
            {
              name: "Visual Studio Code",
              windowTitle: "Visual Studio Code",
              domain: null,
              isPrimary: true,
              primaryReason: "code editor"
            },
            {
              name: "Microsoft Teams",
              windowTitle: "Teams",
              domain: "teams.microsoft.com",
              isPrimary: false,
              primaryReason: "Teams navigation bar visible"
            }
          ],
          primaryApplication: {
            name: "Visual Studio Code",
            windowTitle: "Visual Studio Code",
            domain: null,
            primaryReason: "code editor"
          },
          visitedUrls: ["https://teams.microsoft.com/"],
          keyTasks: ["working with Microsoft Teams", "Review engineering work and code context"],
          evidenceSummaries: ["The user is managing their calendar using Microsoft Teams."],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), [
    "Google Calendar",
    "Visual Studio Code",
    "Google Chrome"
  ]);
  assert.equal(frame.primaryApplication.name, "Visual Studio Code");
  assert.deepEqual(frame.visitedUrls, ["https://calendar.google.com/"]);
  assert.doesNotMatch(JSON.stringify({
    applications: frame.applications,
    keyTasks: frame.keyTasks,
    evidence: frame.evidence.map((item) => ({ kind: item.kind, summary: item.summary })),
    visitedUrls: frame.visitedUrls
  }), /teams/i);
});

test("Ollama provider extracts browser visited URLs and strips private URL parts", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-browser-001.png"), "local browser image");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-browser-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Google Chrome",
      windowTitle: "Reports",
      domain: "reports.example.test",
      activity: "browser_review",
      visibleTextSummary: "A browser report page is visible.",
      redactedSignals: ["browser address bar visible"],
      evidenceIds: ["obs-browser-001-raw-frame"]
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
          activity: "browser_review",
          visibleIntent: "Reviewing a browser report page.",
          applications: [
            {
              name: "Google Chrome",
              windowTitle: "Reports",
              domain: "reports.example.test",
              currentUrl: "https://reports.example.test/students/attendance?token=secret#section",
              isPrimary: true,
              primaryReason: "Cursor is over the browser content."
            },
            {
              name: "Google Chrome",
              windowTitle: "GitHub PR",
              domain: "github.com/org/repo/pull/3606",
              url: "github.com/org/repo/pull/3606",
              isPrimary: false,
              primaryReason: "Secondary browser window is visible."
            },
            {
              name: "Finder",
              windowTitle: "Downloads",
              domain: "not a hostname value",
              isPrimary: false,
              primaryReason: "Local file browser is visible."
            }
          ],
          primaryApplication: {
            name: "Google Chrome",
            windowTitle: "Reports",
            domain: "reports.example.test",
            primaryReason: "Cursor is over the browser content."
          },
          visitedUrls: [
            "reports.example.test/students/attendance?utm_source=capture",
            { url: "https://github.com/org/repo/pull/3606?notification_referrer_id=private" }
          ],
          keyTasks: ["Review report or dashboard state"],
          evidenceSummaries: ["A browser report page is visible"],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.visitedUrls, [
    "https://reports.example.test/students/attendance",
    "https://github.com/org/repo/pull/3606",
    "https://reports.example.test/",
    "https://github.com/"
  ]);
  assert.equal(frame.applications[1].domain, "github.com");
  assert.equal(frame.applications[2].domain, null);
  assert.doesNotMatch(JSON.stringify(frame), /token=|utm_source|notification_referrer_id|#/);
  assert.doesNotThrow(() => assertPrivacySafe(frame, "browserFrame"));
});

test("Ollama provider rewrites generic capture intent from visible app evidence", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-work-summary-001.png"), "local Slack screenshot");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-work-summary-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "archived_screen_capture",
      visibleTextSummary: "A visible screen frame was imported from the Downloads Archive for local Lucille analysis.",
      redactedSignals: ["day-scoped local raw media"],
      evidenceIds: ["obs-work-summary-001-raw-frame"]
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
          activity: "archived_screen_capture",
          visibleIntent: "analyzing a local screen capture",
          applications: [
            {
              name: "Slack",
              windowTitle: "Direct messages",
              domain: "slack.com",
              isPrimary: true,
              primaryReason: "Slack is the foreground window under the cursor."
            },
            {
              name: "GitHub",
              windowTitle: "Pull request",
              domain: "github.com/org/repo/pull/3606",
              isPrimary: false,
              primaryReason: "A GitHub pull request is visible behind Slack."
            }
          ],
          primaryApplication: {
            name: "Slack",
            windowTitle: "Direct messages",
            domain: "slack.com",
            primaryReason: "Slack is the foreground window under the cursor."
          },
          visitedUrls: ["https://github.com/org/repo/pull/3606"],
          keyTasks: ["Draft or review follow-up communication"],
          evidenceSummaries: [
            "Slack message from Jane Smith says the project is delayed.",
            "A GitHub pull request is visible in a browser behind Slack.",
            "Visual Studio Code shows code snippets for the same task."
          ],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.equal(frame.visibleIntent, "Draft or review follow-up communication in Slack with GitHub also visible.");
  assert.deepEqual(frame.activities, ["team_communication"]);
  assert.deepEqual(frame.evidence.map((item) => item.summary), [
    "A communication app is visible with team collaboration context; message text and personal names are not stored.",
    "A code review or pull request surface is visible for engineering coordination.",
    "A code editor is visible with engineering work in progress."
  ]);
  assert.doesNotMatch(JSON.stringify(frame), /analyzing a local screen capture|archived_screen_capture/i);
  assert.doesNotMatch(JSON.stringify(frame), /Jane Smith|project is delayed|code snippets/i);
});

test("Ollama provider drops GitLab hallucination from local Git tooling", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-git-tooling-001.png"), "local VS Code git screenshot");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-git-tooling-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "archived_screen_capture",
      visibleTextSummary: "A visible screen frame was imported from the Downloads Archive for local Lucille analysis.",
      redactedSignals: ["day-scoped local raw media"],
      evidenceIds: ["obs-git-tooling-001-raw-frame"]
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
          activity: "code review",
          visibleIntent: "code review and development",
          applications: [
            {
              name: "Visual Studio Code",
              windowTitle: "SmartReportTemplateBuilder.tsx",
              domain: null,
              isPrimary: true,
              primaryReason: "Foreground editor is active."
            },
            {
              name: "GitLens",
              windowTitle: "GitLens",
              domain: "localhost",
              isPrimary: false,
              primaryReason: "GitLens controls are visible in VS Code."
            },
            {
              name: "GitLab",
              windowTitle: "arbor-fe-library",
              domain: "gitlab.com",
              isPrimary: false,
              primaryReason: "Branches and commits visible in the right panel."
            },
            {
              name: "Terminal",
              windowTitle: "zsh",
              domain: null,
              isPrimary: false,
              primaryReason: "Terminal is visible below the editor."
            }
          ],
          primaryApplication: {
            name: "Visual Studio Code",
            windowTitle: "SmartReportTemplateBuilder.tsx",
            domain: null,
            primaryReason: "Foreground editor is active."
          },
          visitedUrls: ["https://gitlab.com/arbor-education/arbor-fe-library"],
          keyTasks: ["working with GitLab", "executing Git commands"],
          evidenceSummaries: [
            "The GitLab interface shows a list of branches and commits.",
            "The Terminal window shows Git commands being executed."
          ],
          riskFlags: ["The user is working with GitLab."]
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), [
    "Visual Studio Code",
    "GitLens",
    "Terminal"
  ]);
  assert.deepEqual(frame.visitedUrls, []);
  assert.doesNotMatch(JSON.stringify(frame), /GitLab|gitlab\\.com/);
  assert.match(JSON.stringify(frame), /version control/);
});

test("Ollama provider names browser surfaces from visible hostnames", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-browser-surfaces-001.png"), "local browser surfaces screenshot");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-browser-surfaces-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Unknown",
      windowTitle: "Imported archived capture",
      domain: null,
      activity: "archived_screen_capture",
      visibleTextSummary: "A visible screen frame was imported from the Downloads Archive for local Lucille analysis.",
      redactedSignals: ["day-scoped local raw media"],
      evidenceIds: ["obs-browser-surfaces-001-raw-frame"]
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
          activity: "multi_app_review",
          visibleIntent: "Analyzing a workspace for potential tasks and applications",
          applications: [
            {
              name: "Slack",
              windowTitle: "Arbor",
              domain: null,
              isPrimary: true,
              primaryReason: "Slack is the focused foreground window."
            },
            {
              name: "Slack",
              windowTitle: "Slack web",
              domain: "arbor-education.slack.com",
              isPrimary: false,
              primaryReason: "Slack web surface is also visible."
            },
            {
              name: "Browser",
              windowTitle: "LinkedIn",
              domain: "www.linkedin.com",
              isPrimary: false,
              primaryReason: "LinkedIn page is visible."
            },
            {
              name: "Browser",
              windowTitle: "GitHub",
              domain: "github.com",
              isPrimary: false,
              primaryReason: "GitHub page is visible."
            },
            {
              name: "Browser",
              windowTitle: "Browser",
              domain: "www.linkedin.com",
              isPrimary: false,
              primaryReason: "Duplicate LinkedIn page is visible."
            }
          ],
          primaryApplication: {
            name: "Slack",
            windowTitle: "Arbor",
            domain: null,
            primaryReason: "Slack is the focused foreground window."
          },
          visitedUrls: [
            "https://www.linkedin.com/feed/",
            "https://github.com/org/repo/pull/1",
            "https://arbor.com/",
            "https://canvas.com/"
          ],
          keyTasks: ["Review engineering work and code context"],
          evidenceSummaries: [
            "Slack workspace is visible.",
            "LinkedIn feed is visible.",
            "GitHub pull request page is visible."
          ],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), ["Slack", "LinkedIn", "GitHub"]);
  assert.equal(frame.visibleIntent, "Draft or review follow-up communication in Slack with LinkedIn and GitHub also visible.");
  assert.equal(frame.applications.filter((application) => application.name === "LinkedIn").length, 1);
  assert.deepEqual(frame.visitedUrls, [
    "https://www.linkedin.com/feed/",
    "https://github.com/org/repo/pull/1",
    "https://www.linkedin.com/",
    "https://github.com/"
  ]);
});

test("Ollama provider canonicalizes repeated editor and AI tool app names", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(path.join(rawMediaDir, "obs-app-canonical-001.png"), "local app canonical screenshot");
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "obs-app-canonical-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "VS Code",
      windowTitle: "CanvasController.php",
      domain: null,
      activity: "code_review",
      visibleTextSummary: "A code editor is visible with an AI evaluation tool nearby.",
      redactedSignals: ["code editor visible", "AI tool panel visible"],
      evidenceIds: ["obs-app-canonical-001-raw-frame"]
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
          visibleIntent: "Reviewing code while comparing AI evaluation output.",
          applications: [
            {
              name: "VS Code",
              windowTitle: "CanvasController.php",
              domain: null,
              isPrimary: true,
              primaryReason: "The VS Code editor is the foreground window."
            },
            {
              name: "Agenta Window",
              windowTitle: "Evaluation dashboard",
              domain: "app.agenta.ai",
              isPrimary: false,
              primaryReason: "The Agenta evaluation window is visible behind the editor."
            }
          ],
          primaryApplication: {
            name: "VS Code",
            windowTitle: "CanvasController.php",
            domain: null,
            primaryReason: "The VS Code editor is the foreground window."
          },
          visitedUrls: ["https://app.agenta.ai/evaluations"],
          keyTasks: ["Review code", "Compare AI evaluation output"],
          evidenceSummaries: [
            "VS Code shows the project file being reviewed.",
            "Agenta evaluation dashboard is visible."
          ],
          riskFlags: []
        })
      })
    })
  });

  const frame = readFileSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[0];

  assert.deepEqual(frame.applications.map((application) => application.name), ["Visual Studio Code", "Agenta"]);
  assert.equal(frame.primaryApplication.name, "Visual Studio Code");
});

test("frame work summary canonicalizes cached app aliases", () => {
  const frame = normalizeFrameWorkSummary({
    schemaVersion: "frame-analysis.v1",
    evidenceId: "obs-cached-app-alias-001-raw-frame",
    frameId: "obs-cached-app-alias-001",
    day: "2026-05-30",
    capturedAt: "2026-05-30T09:00:00.000Z",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    surface: {
      appName: "VS Code",
      windowTitle: "CanvasController.php",
      domain: null
    },
    applications: [
      {
        name: "VS Code",
        windowTitle: "CanvasController.php",
        domain: null,
        isPrimary: true,
        primaryReason: "The VS Code editor is foregrounded."
      },
      {
        name: "Agenta Window",
        windowTitle: "Evaluation dashboard",
        domain: "app.agenta.ai",
        isPrimary: false,
        primaryReason: "The Agenta evaluation window is visible."
      }
    ],
    visitedUrls: ["https://app.agenta.ai/evaluations"],
    primaryApplication: {
      name: "VS Code",
      windowTitle: "CanvasController.php",
      domain: null,
      primaryReason: "The VS Code editor is foregrounded."
    },
    activities: ["code_review"],
    visibleIntent: "Reviewing code while comparing AI evaluation output.",
    keyTasks: ["Review code", "Compare AI evaluation output"],
    evidence: [
      {
        id: "obs-cached-app-alias-001-local-visual-01",
        kind: "local_visual_summary",
        summary: "VS Code shows the project file being reviewed."
      }
    ],
    redactions: [],
    riskFlags: []
  });

  assert.deepEqual(frame.applications.map((application) => application.name), ["Visual Studio Code", "Agenta"]);
  assert.equal(frame.primaryApplication.name, "Visual Studio Code");
});

test("frame work summary treats ambiguous Arbor chat sidebars as Slack not Discord", () => {
  const frame = normalizeFrameWorkSummary({
    schemaVersion: "frame-analysis.v1",
    evidenceId: "obs-cached-slack-001-raw-frame",
    frameId: "obs-cached-slack-001",
    day: "2026-05-30",
    capturedAt: "2026-05-30T09:00:00.000Z",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    surface: {
      appName: "Cursor",
      windowTitle: "canvas.desktop.twig",
      domain: null
    },
    applications: [
      {
        name: "Visual Studio Code",
        windowTitle: "canvas.desktop.twig",
        domain: null,
        isPrimary: true,
        primaryReason: "Foreground window with code editor"
      },
      {
        name: "Discord",
        windowTitle: "Arbor",
        domain: "discord.com",
        isPrimary: false,
        primaryReason: "Sidebar with chat and activity"
      }
    ],
    visitedUrls: [],
    primaryApplication: {
      name: "Visual Studio Code",
      windowTitle: "canvas.desktop.twig",
      domain: null,
      primaryReason: "Foreground window with code editor"
    },
    activities: ["code_review"],
    visibleIntent: "Reviewing code and team communication.",
    keyTasks: ["Review engineering work and code context"],
    evidence: [
      {
        id: "obs-cached-slack-001-local-visual-01",
        kind: "local_visual_summary",
        summary: "A communication app is visible with team collaboration context."
      }
    ],
    redactions: [],
    riskFlags: []
  });

  assert.deepEqual(frame.applications.map((application) => application.name), ["Visual Studio Code", "Slack"]);
  assert.doesNotMatch(JSON.stringify(frame), /Discord|discord\.com/);
});

test("frame work summary treats ambiguous Arbor Teams sidebars as Slack", () => {
  const frame = normalizeFrameWorkSummary({
    schemaVersion: "frame-analysis.v1",
    evidenceId: "obs-cached-teams-slack-001-raw-frame",
    frameId: "obs-cached-teams-slack-001",
    day: "2026-05-30",
    capturedAt: "2026-05-30T09:00:00.000Z",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    surface: {
      appName: "Google Chrome",
      windowTitle: "GitHub",
      domain: "github.com"
    },
    applications: [
      {
        name: "GitHub",
        windowTitle: "arbor-education/arbor-fe-library",
        domain: "github.com",
        isPrimary: true,
        primaryReason: "The GitHub interface is focused."
      },
      {
        name: "Microsoft Teams",
        windowTitle: "arbor-education",
        domain: "teams.microsoft.com",
        isPrimary: false,
        primaryReason: "The Teams window is visible but not active."
      }
    ],
    visitedUrls: ["https://github.com/arbor-education/arbor-fe-library/pull/3606"],
    primaryApplication: {
      name: "GitHub",
      windowTitle: "arbor-education/arbor-fe-library",
      domain: "github.com",
      primaryReason: "The GitHub interface is focused."
    },
    activities: ["code_review"],
    visibleIntent: "Reviewing code and communication.",
    keyTasks: ["Review engineering work and code context"],
    evidence: [
      {
        id: "obs-cached-teams-slack-001-local-visual-01",
        kind: "local_visual_summary",
        summary: "A communication app is visible with team collaboration context."
      }
    ],
    redactions: [],
    riskFlags: []
  });

  assert.deepEqual(frame.applications.map((application) => application.name), ["GitHub", "Slack"]);
  assert.doesNotMatch(JSON.stringify(frame), /Microsoft Teams|teams\.microsoft\.com|\bTeams\b/);
});

test("frame work summary redacts communication notification window titles", () => {
  const frame = normalizeFrameWorkSummary({
    schemaVersion: "frame-analysis.v1",
    evidenceId: "obs-notification-title-001-raw-frame",
    frameId: "obs-notification-title-001",
    day: "2026-05-30",
    capturedAt: "2026-05-30T09:00:00.000Z",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    surface: {
      appName: "Visual Studio Code",
      windowTitle: "Project file",
      domain: null
    },
    applications: [
      {
        name: "Visual Studio Code",
        windowTitle: "Project file",
        domain: null,
        isPrimary: true,
        primaryReason: "The code editor is focused."
      },
      {
        name: "Slack",
        windowTitle: "New message from Lattice",
        domain: "slack.com",
        isPrimary: false,
        primaryReason: "Slack notification is visible."
      }
    ],
    visitedUrls: [],
    primaryApplication: {
      name: "Visual Studio Code",
      windowTitle: "Project file",
      domain: null,
      primaryReason: "The code editor is focused."
    },
    activities: ["code_review"],
    visibleIntent: "Reviewing code with a communication app visible.",
    keyTasks: ["Review engineering work and code context"],
    evidence: [
      {
        id: "obs-notification-title-001-local-visual-01",
        kind: "local_visual_summary",
        summary: "A code editor is visible with engineering work in progress."
      }
    ],
    redactions: [],
    riskFlags: []
  });

  assert.equal(frame.applications[1].windowTitle, "Slack notification");
  assert.doesNotMatch(JSON.stringify(frame), /message from|Lattice/);
});

test("frame work summary drops known inferred vendor URLs but keeps real visited URLs", () => {
  const frame = normalizeFrameWorkSummary({
    schemaVersion: "frame-analysis.v1",
    evidenceId: "obs-inferred-vendor-urls-001-raw-frame",
    frameId: "obs-inferred-vendor-urls-001",
    day: "2026-05-30",
    capturedAt: "2026-05-30T09:00:00.000Z",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    surface: {
      appName: "Google Chrome",
      windowTitle: "Smart Reports",
      domain: "all-through.sis.local"
    },
    applications: [
      {
        name: "Google Chrome",
        windowTitle: "Smart Reports",
        domain: "all-through.sis.local",
        isPrimary: true,
        primaryReason: "The browser is focused."
      }
    ],
    visitedUrls: [
      "https://all-through.sis.local/canvas-ui/canvas/chat-id/redacted/document-mode/",
      "https://jira.atlassian.com/browse/SIS-70412",
      "https://github.com/arbor-education/arbor-fe-library/pull/3606",
      "https://smartreports.com/",
      "https://lucille-ui-recorder.com/",
      "https://arbor-education.github.io/",
      "https://jira.com/",
      "https://www.adobe.com/",
      "https://www.apple.com/"
    ],
    primaryApplication: {
      name: "Google Chrome",
      windowTitle: "Smart Reports",
      domain: "all-through.sis.local",
      primaryReason: "The browser is focused."
    },
    activities: ["browser_work"],
    visibleIntent: "Reviewing Smart Reports in a browser.",
    keyTasks: ["Review report output"],
    evidence: [
      {
        id: "obs-inferred-vendor-urls-001-local-visual-01",
        kind: "local_visual_summary",
        summary: "A browser page is visible with report output."
      }
    ],
    redactions: [],
    riskFlags: []
  });

  assert.deepEqual(frame.visitedUrls, [
    "https://all-through.sis.local/canvas-ui/canvas/chat-id/redacted/document-mode/",
    "https://jira.atlassian.com/browse/SIS-70412",
    "https://github.com/arbor-education/arbor-fe-library/pull/3606"
  ]);
});

test("debugFrameAnalysis analyses one frame and exposes the prompt without writing artifacts", async () => {
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
        appName: "Terminal",
        windowTitle: "Lucille prompt debugging",
        domain: null,
        activity: "debugging_prompt",
        visibleTextSummary: "A visible screen frame was captured for local prompt debugging.",
        redactedSignals: ["explicit local prompt debug capture"],
        evidenceIds: ["obs-local-002-raw-frame"]
      }
    ].map((observation) => JSON.stringify(observation)).join("\n") + "\n"
  );

  let request = null;
  const result = await debugFrameAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b",
    frameId: "obs-local-002-raw-frame",
    fetchImpl: async (url, options) => {
      request = {
        url,
        body: JSON.parse(options.body)
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({
            activity: "debugging_prompt",
            visibleIntent: "Testing a single screenshot analysis prompt.",
            keyTasks: ["Inspect command output and troubleshoot blockers"],
            evidenceSummaries: ["terminal shows a prompt debugging workflow"],
            riskFlags: []
          })
        })
      };
    }
  });

  assert.equal(result.schemaVersion, "debug-frame-analysis.v1");
  assert.equal(result.selected.index, 1);
  assert.equal(result.selected.frameId, "obs-local-002");
  assert.equal(result.selected.rawMediaPath, "storage/captures/2026-05-30/raw-media/obs-local-002.png");
  assert.match(result.promptSource, /buildOllamaPrompt/);
  assert.match(result.prompt, /Return JSON only/);
  assert.match(result.prompt, /Lucille 3/);
  assert.equal(result.frame.frameId, "obs-local-002");
  assert.equal(result.frame.evidenceId, "obs-local-002-raw-frame");
  assert.equal(result.frame.evidence[0].summary, "terminal shows a prompt debugging workflow");
  assert.equal(request.url, "http://127.0.0.1:11434/api/generate");
  assert.equal(request.body.images.length, 1);
  assert.deepEqual(request.body.images, [Buffer.from("local fixture image two").toString("base64")]);
  assert.equal(existsSync(path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl")), false);
  assert.doesNotThrow(() => assertPrivacySafe(result, "debugFrame"));
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
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(root, "storage", "captures", "2026-05-30", "raw-media");
  rmSync(rawMediaDir, { recursive: true, force: true });
  mkdirSync(rawMediaDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    JSON.stringify({
      schemaVersion: "observation.v1",
      id: "frame-001",
      capturedAt: "2026-05-30T09:00:00.000Z",
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: ["frame-001-raw-frame"]
    }) + "\n"
  );
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
  rmSync(path.join(captureDayDir, "raw-media"), { recursive: true, force: true });

  const outsideScreenshotPath = path.join(outsideDir, "outside.png");
  writeFileSync(outsideScreenshotPath, "not a real image");

  try {
    symlinkSync(outsideDir, path.join(captureDayDir, "raw-media"), "dir");
  } catch {
    t.skip("directory symlinks are unavailable in this environment");
    return;
  }

  await assert.rejects(
    runAnalysis({
      root,
      day: "2026-05-30",
      model: "moondream:1.8b"
    }),
    /No local raw media found/
  );
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
	      if (String(url).includes("/api/generate")) {
	        const body = JSON.parse(options.body);
	        const observation = parseObservationFromOllamaPrompt(body.prompt);
	        return {
	          ok: true,
	          status: 200,
	          json: async () => ({
	            response: JSON.stringify(buildLocalVisualTestResponse(observation))
	          })
	        };
	      }

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
  assert.match(requestBody, /redacted_structured_timeline_and_frame_evidence_only/);
  assert.match(requestBody, /activityTimeline/);
  assert.match(requestBody, /dwellTimeSeconds/);
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
    env: {
      OPENAI_API_KEY: "test-key",
      LUCILLE_EVAL_BASELINE_MODEL: "model-evaluation-baseline"
    },
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
    day: "2026-05-30",
    proposalId: "skill-attendance-report-review-assistant"
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
    provider: "ollama"
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
  assert.equal(result.timelineSegmentCount, 1);
  assert.equal(result.patternCount, 1);
  assert.equal(result.proposalCount, 5);
  assert.equal(result.commonTaskCount, 1);
  assert.match(report, /^# Lucille Weekly Efficiency Report: 2026-05-30/m);
  assert.match(report, /Estimated weekly time saving/);
  assert.match(report, /Organisation signal/);
  assert.match(report, /## Raw Media Lifecycle/);
  assert.match(report, /## Activity Timeline/);
  assert.match(report, /Frames represented: 3/);
  assert.match(report, /Representative timeline snapshots stored: 3/);
  assert.match(report, /Representative snapshot cap: 50 snapshot\(s\)/);
  assert.match(report, /Representative evidence cap: 50 evidence ID\(s\) per cluster/);
  assert.match(report, /Evidence trail cap: 20 frame-backed entry\(s\) per cluster/);
  assert.match(report, /Aggregation strategy: common_tasks_group_repeated_timeline_segments_with_bounded_representative_evidence/);
  assert.match(report, /## Common Tasks/);
  assert.match(report, /Repeated across:/);
  assert.match(report, /## Timeline Segments/);
  assert.match(report, /Dwell time: 360 seconds/);
  assert.match(report, /Cognitive hurdles/);
  assert.match(report, /## Skills By Repeated Task/);
  assert.match(report, /Representative evidence IDs: fixture-evidence-001, fixture-evidence-002, fixture-evidence-003/);
  assert.match(report, /Matching skills:/);
  assert.match(report, /Attendance report review workflow/);
  assert.match(report, /employee_weekly_report/);
  assert.match(report, /workflow_automation/);
  assert.match(report, /ai_assistance/);
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

test("make verify-mmp invokes the release readiness gate", () => {
  const makefile = readFileSync(path.join(process.cwd(), "Makefile"), "utf8");
  const verifyTarget = makefile.match(/^verify-mmp:.*(?:\n\t.*)*/m)?.[0] ?? "";

  assert.match(makefile, /make verify-mmp/);
  assert.match(verifyTarget, /DAY="\$\(DAY\)" \$\(NPM\) run verify:mmp/);
});

test("debug make targets write latest JSON to an ignored debug directory", () => {
  const makefile = readFileSync(path.join(process.cwd(), "Makefile"), "utf8");
  const gitignore = readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
  const dirsTarget = makefile.match(/^dirs:.*(?:\n\t.*)*/m)?.[0] ?? "";
  const debugAnalysisTarget = makefile.match(/^debug-analysis:.*(?:\n\t.*)*/m)?.[0] ?? "";
  const debugFrameTarget = makefile.match(/^debug-frame:.*(?:\n\t.*)*/m)?.[0] ?? "";

  assert.match(makefile, /^DEBUG_DIR \?= debug$/m);
  assert.match(gitignore, /^debug\/$/m);
  assert.match(dirsTarget, /"\$\(DEBUG_DIR\)"/);
  assert.match(debugAnalysisTarget, /--debug-output \$\(DEBUG_DIR\)\/latest-debug-analysis\.json/);
  assert.match(debugFrameTarget, /--debug-output \$\(DEBUG_DIR\)\/latest-debug-frame\.json/);
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
    proposalId: "skill-attendance-report-review-assistant",
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
  assert.match(claudeSkill, /Repeated Task Context/);
  assert.match(claudeSkill, /Evidence coverage: 3 frame\(s\) across 1 timeline segment\(s\)/);
  assert.match(claudeSkill, /Representative evidence IDs: fixture-evidence-001, fixture-evidence-002, fixture-evidence-003/);
  assert.match(claudeSkill, /Key tasks: .*attendance/i);
  assert.match(codexSkill, /Codex Instructions/);
  assert.match(codexSkill, /Repeated Task Context/);
  assert.match(cursorRule, /alwaysApply: false/);
  assert.match(cursorRule, /Repeated Task Context/);
  assert.match(chatgptInstructions, /# Instructions/);
  assert.match(chatgptInstructions, /Repeated Task Context/);
  assert.match(chatgptKnowledge, /Confidence: 0\.74/);
  assert.match(chatgptKnowledge, /Repeated Task Context/);
  assert.equal(chatgptActions.repeatedTaskContexts.length, 1);
  assert.equal(chatgptActions.repeatedTaskContexts[0].evidenceCount, 3);
  assert.equal(chatgptActions.repeatedTaskContexts[0].evidenceIds.length, 3);
  assert.match(chatgptActions.repeatedTaskContexts[0].topTasks.join(" "), /attendance/i);
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

test("skill web UI API edits generates and downloads skill proposals", async () => {
  const root = fixtureRoot();
  await runAnalysis({
    root,
    day: "2026-05-30",
    model: "moondream:1.8b"
  });
  const rawMediaDir = path.join(root, "storage", "captures", "2026-05-30", "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  for (const evidenceId of ["fixture-evidence-001", "fixture-evidence-002", "fixture-evidence-003"]) {
    writeFileSync(path.join(rawMediaDir, `${evidenceId}.png`), "fixture frame bytes");
  }
  mkdirSync(path.join(root, "storage", "analysis", "2026-05-29"), { recursive: true });
  writeFileSync(path.join(root, "storage", "analysis", "2026-05-29", "work-patterns.json"), "{}\n");
  mkdirSync(path.join(root, "storage", "analysis", "not-a-day"), { recursive: true });

  const server = createSkillUiServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Lucille Skills/);
    assert.match(pageHtml, /<select id="day">/);
    assert.match(pageHtml, /<select id="sort">/);
    assert.match(pageHtml, /Confidence high to low/);
    assert.match(pageHtml, /<select id="category-filter">/);
    assert.match(pageHtml, /<select id="confidence-filter">/);
    assert.match(pageHtml, /High \(0\.80\+\)/);
    assert.match(pageHtml, /Medium \(0\.60-0\.79\)/);
    assert.match(pageHtml, /Low \(&lt;0\.60\)/);
    assert.match(pageHtml, /<input id="search"/);
    assert.match(pageHtml, /Common Tasks/);
    assert.match(pageHtml, /<aside class="proposal-sidebar">/);
    assert.match(pageHtml, /<h1>Proposals<\/h1>/);
    assert.match(pageHtml, /id="common-tasks"/);
    assert.match(pageHtml, /task-evidence/);
    assert.match(pageHtml, /frame-preview/);
    assert.match(pageHtml, /summary-frame-links/);
    assert.match(pageHtml, /All referenced frames/);
    assert.match(pageHtml, /api\/raw-frame/);
    assert.doesNotMatch(pageHtml, /type="date"/);

    const daysResponse = await fetch(`${baseUrl}/api/analysis-days`);
    assert.equal(daysResponse.status, 200);
    const days = await daysResponse.json();
    assert.deepEqual(days.days, ["2026-05-30"]);

    const loadedResponse = await fetch(`${baseUrl}/api/proposals?day=2026-05-30`);
    assert.equal(loadedResponse.status, 200);
    const loaded = await loadedResponse.json();
    assert.equal(loaded.schemaVersion, "proposal-ui-data.v1");
    assert.equal(loaded.proposals.length, 5);
    assert.equal(loaded.proposalSet.proposals.length, 5);
    assert.equal(loaded.commonTasks.length, 1);
    assert.equal(loaded.commonTasks[0].evidenceIds.length, 3);
    assert.match(loaded.commonTasks[0].evidenceNarrative, /frame\(s\).*timeline segment/i);
    assert.ok(loaded.commonTasks[0].skills.length >= 3);
    assert.ok(loaded.commonTasks[0].skills.some((skill) => skill.category === "employee_weekly_report"));
    assert.ok(loaded.commonTasks[0].skills.some((skill) => skill.category === "workflow_automation"));
    assert.ok(loaded.commonTasks[0].skills.some((skill) => skill.category === "ai_assistance"));

    const frameResponse = await fetch(`${baseUrl}/api/raw-frame?day=2026-05-30&evidenceId=fixture-evidence-001`);
    assert.equal(frameResponse.status, 200);
    assert.equal(frameResponse.headers.get("content-type"), "image/png");
    assert.equal(await frameResponse.text(), "fixture frame bytes");

    loaded.proposalSet.proposals[0].title = "Edited Attendance Report Review Assistant";
    loaded.proposalSet.proposals[0].implementationSteps = [
      ...loaded.proposalSet.proposals[0].implementationSteps.slice(0, 3),
      "Confirm the edited skill still cites screenshot-backed evidence."
    ];

    const savedResponse = await fetch(`${baseUrl}/api/proposals?day=2026-05-30`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loaded)
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.schemaVersion, "proposal-ui-data.v1");
    assert.equal(saved.proposals[0].title, "Edited Attendance Report Review Assistant");
    assert.ok(saved.commonTasks[0].skills.some((skill) => skill.title === "Edited Attendance Report Review Assistant"));

    const refreshedTaskSummary = JSON.parse(readFileSync(
      path.join(root, "storage", "analysis", "2026-05-30", "task-skill-summary.json"),
      "utf8"
    ));
    assert.ok(refreshedTaskSummary.commonTasks[0].skills.some((skill) => (
      skill.title === "Edited Attendance Report Review Assistant"
    )));

    const generateResponse = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        day: "2026-05-30",
        proposalId: saved.proposals[0].id
      })
    });
    assert.equal(generateResponse.status, 200);
    const generated = await generateResponse.json();
    assert.equal(generated.approved, true);
    assert.equal(generated.filesWritten.length, 6);

    const downloadResponse = await fetch(`${baseUrl}/api/download?day=2026-05-30&proposalId=${saved.proposals[0].id}`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get("content-disposition"), /skill-bundle\.json/);
    const bundle = await downloadResponse.json();
    assert.equal(bundle.schemaVersion, "skill-download-bundle.v1");
    assert.equal(bundle.repeatedTaskContexts.length, 1);
    assert.equal(bundle.repeatedTaskContexts[0].evidenceCount, 3);
    assert.equal(bundle.repeatedTaskContexts[0].evidenceIds.length, 3);
    assert.equal(bundle.files.length, 6);
    assert.match(
      bundle.files.find((file) => file.path.endsWith("codex/SKILL.md")).content,
      /Repeated Task Context/
    );
    assert.match(
      bundle.files.find((file) => file.path.endsWith("codex/SKILL.md")).content,
      /Edited Attendance Report Review Assistant/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
  assert.match(makefile, /^OPERATOR_SMOKE_CAPTURE_COUNT \?= 3$/m);
  assert.match(makefile, /^OPERATOR_SMOKE_CAPTURE_INTERVAL \?= \$\(CAPTURE_INTERVAL\)$/m);
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
        LUCILLE_LOCAL_MODEL: "moondream:1.8b",
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

test("operator smoke validates the generated weekly efficiency report heading", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts", "operator-smoke.mjs"), "utf8");

  assert.match(source, /# Lucille Weekly Efficiency Report:/);
  assert.doesNotMatch(source, /# Lucille Daily Report:/);
});

test("operator smoke captures a bounded multi-frame sequence before MMP verification", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts", "operator-smoke.mjs"), "utf8");
  const makefile = readFileSync(path.join(process.cwd(), "Makefile"), "utf8");
  const operatorSmokeTarget = makefile.match(/^operator-smoke:.*(?:\n\t.*)*/m)?.[0] ?? "";
  const existingSmokeTarget = makefile.match(/^operator-smoke-existing:.*(?:\n\t.*)*/m)?.[0] ?? "";

  assert.match(source, /LUCILLE_OPERATOR_SMOKE_CAPTURE_COUNT \?\? "3"/);
  assert.match(source, /function captureSmokeSequence/);
  assert.match(source, /for \(let index = 0; index < count; index \+= 1\)/);
  assert.match(source, /captureCountRequested/);
  assert.match(source, /fromExistingEvidence/);
  assert.match(source, /existing_day_evidence/);
  assert.match(source, /fresh_capture_sequence/);
  assert.match(source, /run\(make, \["verify-mmp", `DAY=\$\{day\}`\]\)/);
  assert.match(operatorSmokeTarget, /--capture-count \$\(OPERATOR_SMOKE_CAPTURE_COUNT\)/);
  assert.match(operatorSmokeTarget, /--capture-interval \$\(OPERATOR_SMOKE_CAPTURE_INTERVAL\)/);
  assert.match(existingSmokeTarget, /--from-existing-evidence/);
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
    provider: "ollama"
  });
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  const proposalId = firstProposalId(root, "2026-05-30");
  exportSkillProposal({
    root,
    day: "2026-05-30",
    proposalId,
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

  assert.match(output, /MMP workflow evidence: 9\/10/);
  assert.match(output, /ok\s+Capture observations JSONL/);
  assert.match(output, /ok\s+Frame analysis JSONL/);
  assert.match(output, /ok\s+Activity timeline JSON/);
  assert.match(output, /ok\s+Task-skill summary JSON/);
  assert.match(output, /ok\s+Daily report Markdown/);
  assert.match(output, /ok\s+Approved export bundle/);
  assert.match(output, /--\s+Operator environment smoke/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status does not count an empty raw-media directory as capture evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-analysis-"));
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
  assert.match(output, /MMP workflow evidence: 0\/10/);
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
  assert.match(output, /MMP workflow evidence: 0\/10/);
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
    provider: "ollama"
  });
  const frameAnalysisPath = path.join(root, "storage", "analysis", "2026-05-30", "frame-analysis.jsonl");
  const nonOllamaFrames = readFileSync(frameAnalysisPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => ({ ...JSON.parse(line), provider: "test-provider" }));
  writeFileSync(frameAnalysisPath, nonOllamaFrames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  generateDailyReport({
    root,
    day: "2026-05-30"
  });
  const proposalId = firstProposalId(root, "2026-05-30");
  exportSkillProposal({
    root,
    day: "2026-05-30",
    proposalId,
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
      captureMode: "existing_day_evidence",
      captureCountRequested: 3,
      captureIntervalSeconds: 3,
      mmpReady: true,
      mmpReadiness: smokeReadinessSummary({ frameCount: 3 }),
      evidence: {
        observations: 3,
        rawMediaFilesCaptured: 3,
        frameAnalysis: 3,
        report: "output/reports/2026-05-30.md",
        approvedExport: `output/skills/2026-05-30/${proposalId}`
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

  assert.match(output, /MMP workflow evidence: 9\/10/);
  assert.match(output, /--\s+Operator environment smoke/);
  assert.match(output, /MMP status: not ready/);
});

test("RALF status accepts same-day Ollama smoke evidence with retained raw media", async () => {
  const root = fixtureRoot();
  const captureDir = path.join(root, "storage", "captures", "2026-05-30");
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  for (const id of ["obs-local-001", "obs-local-002", "obs-local-003"]) {
    writeFileSync(path.join(rawMediaDir, `${id}.png`), "local fixture image");
  }
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    ["obs-local-001", "obs-local-002", "obs-local-003"].map((id, index) => JSON.stringify({
      schemaVersion: "observation.v1",
      id,
      capturedAt: `2026-05-30T09:00:0${index}.000Z`,
      appName: "Cursor",
      windowTitle: "Lucille project workspace",
      domain: null,
      activity: "code_editing",
      visibleTextSummary: "A visible screen frame was captured for local analysis.",
      redactedSignals: ["explicit local capture"],
      evidenceIds: [`${id}-raw-frame`]
    })).join("\n") + "\n"
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
  const proposalId = firstProposalId(root, "2026-05-30");
  exportSkillProposal({
    root,
    day: "2026-05-30",
    proposalId,
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
      captureMode: "existing_day_evidence",
      captureCountRequested: 3,
      captureIntervalSeconds: 3,
      mmpReady: true,
      mmpReadiness: smokeReadinessSummary({ frameCount: 3 }),
      evidence: {
        observations: 3,
        rawMediaFilesCaptured: 3,
        frameAnalysis: 3,
        report: "output/reports/2026-05-30.md",
        approvedExport: `output/skills/2026-05-30/${proposalId}`
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

  assert.match(output, /MMP workflow evidence: 10\/10/);
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
  const proposalId = firstProposalId(root, "2026-05-30");
  exportSkillProposal({
    root,
    day: "2026-05-30",
    proposalId,
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
      model: "moondream:1.8b",
      captureMode: "existing_day_evidence",
      mmpReady: true,
      mmpReadiness: smokeReadinessSummary()
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
  assert.match(output, /MMP workflow evidence: 8\/10/);
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

function firstProposalId(root, day) {
  const proposals = JSON.parse(
    readFileSync(path.join(root, "storage", "analysis", day, "skill-proposals.json"), "utf8")
  );
  return proposals.proposals[0].id;
}

function smokeReadinessSummary(options = {}) {
  const frameCount = options.frameCount ?? 1;
  return {
    frameCount,
    commonTaskCount: 1,
    taskSkillSummaryCount: 1,
    repeatedTaskFrameCount: frameCount,
    patternCount: 1,
    proposalCount: 5,
    proposalCategories: [
      "employee_weekly_report",
      "workflow_automation",
      "ai_assistance",
      "manager_monitoring",
      "enterprise_rollout"
    ]
  };
}

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lucille-analysis-"));
  const fixturesDir = path.join(root, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  copyFileSync(
    path.join(process.cwd(), "fixtures", "mock-observations.json"),
    path.join(fixturesDir, "mock-observations.json")
  );
  writeCapturedFixtureObservations(root, "2026-05-30");
  return root;
}

function writeCapturedFixtureObservations(root, day) {
  const fixtures = JSON.parse(readFileSync(path.join(root, "fixtures", "mock-observations.json"), "utf8"));
  const captureDir = path.join(root, "storage", "captures", day);
  const rawMediaDir = path.join(captureDir, "raw-media");
  mkdirSync(rawMediaDir, { recursive: true });
  const observations = fixtures.map((fixture, index) => ({
    schemaVersion: "observation.v1",
    id: `${day}-${fixture.fixtureId}`,
    capturedAt: `${day}T09:${String(index * 7).padStart(2, "0")}:00.000Z`,
    appName: fixture.appName,
    windowTitle: fixture.windowTitle,
    domain: fixture.domain,
    activity: fixture.activity,
    visibleTextSummary: fixture.visibleTextSummary,
    redactedSignals: fixture.redactedSignals,
    evidenceIds: fixture.evidenceIds
  }));
  writeFileSync(
    path.join(captureDir, "observations.jsonl"),
    observations.map((observation) => JSON.stringify(observation)).join("\n") + "\n"
  );
  for (const observation of observations) {
    writeFileSync(path.join(rawMediaDir, `${observation.id}.png`), `local visual frame for ${observation.id}`);
  }
}

function parseObservationFromOllamaPrompt(prompt) {
  const marker = "Existing safe observation metadata: ";
  const index = String(prompt ?? "").indexOf(marker);
  if (index === -1) return {};
  const text = String(prompt).slice(index + marker.length);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function buildLocalVisualTestResponse(observation = {}) {
  const text = [
    observation.activity,
    observation.visibleTextSummary,
    ...(observation.redactedSignals ?? [])
  ].join(" ").toLowerCase();
  const attendance = /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(text);
  const development = /\b(github|pull request|\bpr\b|code|diff|repository|cursor|codex|terminal|console|npm|make|test)\b/.test(text);
  const keyTasks = [];
  if (attendance) keyTasks.push("Review attendance report evidence");
  if (/\b(reconcile|reconciliation|check|qa|manual|review)\b/.test(text)) keyTasks.push("Reconcile visible evidence and quality checks");
  if (/\b(email|message|draft|follow-up|communication|slack|teams|chat)\b/.test(text)) keyTasks.push("Draft or review follow-up communication");
  if (development) keyTasks.push("Review engineering work and code context");
  if (development && /\b(terminal|console|command|npm|make|test|build|error|failed|exception)\b/.test(text)) {
    keyTasks.push("Inspect command output and troubleshoot blockers");
  }
  if (!development && /\b(report|dashboard|chart|metric|spreadsheet|table|export)\b/.test(text)) {
    keyTasks.push("Review report or dashboard state");
  }

  const appName = observation.appName ?? "Visible work app";
  const summaries = (observation.redactedSignals?.length ? observation.redactedSignals : [observation.visibleTextSummary ?? "visible workflow"])
    .slice(0, 4)
    .map((signal) => `${appName} shows ${signal}`);

  return {
    activity: observation.activity ?? "visible_work",
    visibleIntent: observation.visibleTextSummary ?? `Reviewing visible work in ${appName}.`,
    applications: [
      {
        name: appName,
        windowTitle: observation.windowTitle ?? null,
        domain: observation.domain ?? null,
        isPrimary: true,
        primaryReason: "Cursor position is not visible in the test frame; using focused active window metadata."
      },
      {
        name: "Background Reference App",
        windowTitle: "Visible secondary work surface",
        domain: null,
        isPrimary: false,
        primaryReason: "Visible secondary application, but not under the cursor."
      }
    ],
    primaryApplication: {
      name: appName,
      windowTitle: observation.windowTitle ?? null,
      domain: observation.domain ?? null,
      primaryReason: "Cursor position is not visible in the test frame; using focused active window metadata."
    },
    keyTasks: keyTasks.length > 0 ? keyTasks : ["Review a visible work surface"],
    evidenceSummaries: summaries,
    riskFlags: []
  };
}

async function startLocalOllamaTestServer() {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const observation = parseObservationFromOllamaPrompt(body.prompt);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        response: JSON.stringify(buildLocalVisualTestResponse(observation))
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function syntheticFrame(options = {}) {
  const id = options.id ?? "synthetic-frame-001";
  const day = options.day ?? "2026-05-30";
  const evidenceId = options.evidenceId ?? `${id}-evidence`;

  return {
    schemaVersion: "frame-analysis.v1",
    evidenceId,
    frameId: id,
    day,
    capturedAt: options.capturedAt ?? `${day}T09:00:00.000Z`,
    provider: "ollama",
    model: "test-model",
    surface: {
      appName: options.appName ?? "Cursor",
      windowTitle: options.windowTitle ?? "Lucille project workspace",
      domain: options.domain ?? null
    },
    applications: options.applications ?? [
      {
        name: options.appName ?? "Cursor",
        windowTitle: options.windowTitle ?? "Lucille project workspace",
        domain: options.domain ?? null,
        isPrimary: true,
        primaryReason: "Synthetic frame uses focused active window metadata."
      }
    ],
    visitedUrls: options.visitedUrls ?? [],
    primaryApplication: options.primaryApplication ?? {
      name: options.appName ?? "Cursor",
      windowTitle: options.windowTitle ?? "Lucille project workspace",
      domain: options.domain ?? null,
      primaryReason: "Synthetic frame uses focused active window metadata."
    },
    activities: options.activities ?? ["visible_work"],
    visibleIntent: options.visibleIntent ?? "Reviewing a visible work surface.",
    keyTasks: options.keyTasks ?? ["Review a visible work surface"],
    evidence: (options.evidence ?? ["visible workflow summary"]).map((summary, index) => ({
      id: `${id}-summary-${String(index + 1).padStart(2, "0")}`,
      kind: "local_visual_summary",
      summary
    })),
    redactions: [],
    riskFlags: options.riskFlags ?? []
  };
}

function collectKeys(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectKeys(item));
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

function writeFakeMake(root) {
  const fakeMake = path.join(root, "fake-make.sh");
  writeFileSync(fakeMake, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> make-calls.log\n");
  chmodSync(fakeMake, 0o755);
  return fakeMake;
}
