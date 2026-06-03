import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateActivityTimeline } from "../analysis/activityTimeline.mjs";
import { buildTaskSkillSummaryFromArtifacts } from "../analysis/taskSkillSummary.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";
import { validateSkillProposalSet } from "../skills/proposals.mjs";

const frameFields = new Set([
  "schemaVersion",
  "evidenceId",
  "frameId",
  "day",
  "capturedAt",
  "provider",
  "model",
  "surface",
  "activities",
  "visibleIntent",
  "keyTasks",
  "evidence",
  "redactions",
  "riskFlags"
]);
const surfaceFields = new Set(["appName", "windowTitle", "domain"]);
const evidenceFields = new Set(["id", "kind", "summary"]);
const workPatternSetFields = new Set(["schemaVersion", "day", "provider", "model", "synthesis", "patterns"]);
const synthesisFields = new Set([
  "localOnly",
  "openaiRequested",
  "openaiModel",
  "reasoningEffort",
  "openai",
  "rawScreenshotsSent",
  "evidencePolicy",
  "rawMediaLifecycle"
]);
const rawMediaLifecycleFields = new Set([
  "schemaVersion",
  "day",
  "debugRetentionExplicitlyEnabled",
  "action",
  "rawMediaDirectories",
  "mediaFilesObserved",
  "mediaFilesDeleted",
  "mediaFilesRetained",
  "policy"
]);
const patternFields = new Set([
  "id",
  "title",
  "summary",
  "repeatedAcrossEvidence",
  "evidenceCount",
  "segmentCount",
  "confidence",
  "signals",
  "estimatedMinutesPerWeek",
  "recommendation",
  "enterpriseSignal",
  "privacyBoundary"
]);

export function generateDailyReport(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day);
  const analysisDir = path.join(root, "storage", "analysis", day);

  const frames = readFrameAnalysis(path.join(analysisDir, "frame-analysis.jsonl"), day);
  const activityTimeline = readActivityTimeline(path.join(analysisDir, "activity-timeline.json"), day);
  const workPatterns = readWorkPatterns(path.join(analysisDir, "work-patterns.json"), day);
  const proposalSet = readSkillProposals(path.join(analysisDir, "skill-proposals.json"), day);
  const taskSkillSummary = buildTaskSkillSummaryFromArtifacts({ day, activityTimeline, proposalSet });
  const reportMarkdown = renderReport({ day, frames, activityTimeline, workPatterns, proposalSet, taskSkillSummary });

  assertPrivacySafe({
    day,
    frameCount: frames.length,
    activityTimeline,
    workPatterns,
    proposalSet,
    taskSkillSummary,
    reportMarkdown
  }, "dailyReport");

  const reportPath = path.join(root, "output", "reports", `${day}.md`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, reportMarkdown);

  return {
    schemaVersion: "daily-report.v1",
    day,
    reportPath: path.relative(root, reportPath),
    frameCount: frames.length,
    timelineSegmentCount: activityTimeline.segments.length,
    patternCount: workPatterns.patterns.length,
    proposalCount: proposalSet.proposals.length,
    commonTaskCount: taskSkillSummary.commonTasks.length,
    message: `Wrote weekly efficiency report for ${day}.`
  };
}

function readFrameAnalysis(filePath, day) {
  if (!existsSync(filePath)) {
    throw new Error(`No frame analysis found for ${day}. Run make analyse DAY=${day} first.`);
  }

  const rows = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (rows.length === 0) {
    throw new Error(`No frame analysis records found for ${day}. Run make analyse DAY=${day} first.`);
  }

  return rows.map((frame, index) => validateFrame(frame, {
    day,
    source: `frame-analysis.jsonl[${index}]`
  }));
}

function readWorkPatterns(filePath, day) {
  if (!existsSync(filePath)) {
    throw new Error(`No work patterns found for ${day}. Run make analyse DAY=${day} first.`);
  }

  return validateWorkPatterns(JSON.parse(readFileSync(filePath, "utf8")), {
    day,
    source: "work-patterns.json"
  });
}

function readActivityTimeline(filePath, day) {
  if (!existsSync(filePath)) {
    throw new Error(`No activity timeline found for ${day}. Run make analyse DAY=${day} first.`);
  }

  return validateActivityTimeline(JSON.parse(readFileSync(filePath, "utf8")), {
    day,
    source: "activity-timeline.json"
  });
}

function readSkillProposals(filePath, day) {
  if (!existsSync(filePath)) {
    throw new Error(`No skill proposals found for ${day}. Run make analyse DAY=${day} first.`);
  }

  return validateSkillProposalSet(JSON.parse(readFileSync(filePath, "utf8")), {
    day,
    source: "skill-proposals.json"
  });
}

function validateFrame(value, { day, source }) {
  requireObject(value, source);
  rejectUnexpectedFields(value, frameFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "frame-analysis.v1", `${source}.schemaVersion`),
    evidenceId: requireEvidenceId(value.evidenceId, `${source}.evidenceId`),
    frameId: requireText(value.frameId, `${source}.frameId`, 160),
    day: requireLiteral(value.day, day, `${source}.day`),
    capturedAt: requireIsoTimestamp(value.capturedAt, `${source}.capturedAt`, day),
    provider: requireText(value.provider, `${source}.provider`, 80),
    model: requireText(value.model, `${source}.model`, 120),
    surface: validateSurface(value.surface, `${source}.surface`),
    activities: requireTextArray(value.activities, `${source}.activities`, 12, 80),
    visibleIntent: requireText(value.visibleIntent, `${source}.visibleIntent`, 500),
    keyTasks: requireTextArray(value.keyTasks, `${source}.keyTasks`, 6, 120),
    evidence: requireArray(value.evidence, `${source}.evidence`).map((item, index) => (
      validateEvidence(item, `${source}.evidence[${index}]`)
    )),
    redactions: requireTextArray(value.redactions, `${source}.redactions`, 20, 120),
    riskFlags: requireTextArray(value.riskFlags, `${source}.riskFlags`, 12, 120)
  };
}

function validateSurface(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, surfaceFields, source);

  return {
    appName: requireText(value.appName, `${source}.appName`, 80),
    windowTitle: requireText(value.windowTitle, `${source}.windowTitle`, 160),
    domain: value.domain === null ? null : requireHostnameOnly(value.domain, `${source}.domain`)
  };
}

function validateEvidence(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, evidenceFields, source);

  return {
    id: requireText(value.id, `${source}.id`, 160),
    kind: requireText(value.kind, `${source}.kind`, 80),
    summary: requireText(value.summary, `${source}.summary`, 160)
  };
}

function validateWorkPatterns(value, { day, source }) {
  requireObject(value, source);
  rejectUnexpectedFields(value, workPatternSetFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "work-patterns.v1", `${source}.schemaVersion`),
    day: requireLiteral(value.day, day, `${source}.day`),
    provider: requireText(value.provider, `${source}.provider`, 80),
    model: requireText(value.model, `${source}.model`, 120),
    synthesis: validateSynthesis(value.synthesis, `${source}.synthesis`, day),
    patterns: requireArray(value.patterns, `${source}.patterns`).map((pattern, index) => (
      validatePattern(pattern, `${source}.patterns[${index}]`)
    ))
  };
}

function validateSynthesis(value, source, day) {
  requireObject(value, source);
  rejectUnexpectedFields(value, synthesisFields, source);

  return {
    localOnly: requireBoolean(value.localOnly, `${source}.localOnly`),
    openaiRequested: requireBoolean(value.openaiRequested, `${source}.openaiRequested`),
    openaiModel: value.openaiModel === null ? null : requireText(value.openaiModel, `${source}.openaiModel`, 120),
    reasoningEffort: value.reasoningEffort === null ? null : requireText(value.reasoningEffort, `${source}.reasoningEffort`, 40),
    openai: value.openai,
    rawScreenshotsSent: requireLiteral(value.rawScreenshotsSent, false, `${source}.rawScreenshotsSent`),
    evidencePolicy: requireText(value.evidencePolicy, `${source}.evidencePolicy`, 120),
    rawMediaLifecycle: validateRawMediaLifecycle(value.rawMediaLifecycle, `${source}.rawMediaLifecycle`, day)
  };
}

function validateRawMediaLifecycle(value, source, day) {
  requireObject(value, source);
  rejectUnexpectedFields(value, rawMediaLifecycleFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "raw-media-lifecycle.v1", `${source}.schemaVersion`),
    day: requireLiteral(value.day, day, `${source}.day`),
    debugRetentionExplicitlyEnabled: requireBoolean(value.debugRetentionExplicitlyEnabled, `${source}.debugRetentionExplicitlyEnabled`),
    action: requireText(value.action, `${source}.action`, 80),
    rawMediaDirectories: requireTextArray(value.rawMediaDirectories, `${source}.rawMediaDirectories`, 4, 80),
    mediaFilesObserved: requireNonNegativeInteger(value.mediaFilesObserved, `${source}.mediaFilesObserved`),
    mediaFilesDeleted: requireNonNegativeInteger(value.mediaFilesDeleted, `${source}.mediaFilesDeleted`),
    mediaFilesRetained: requireNonNegativeInteger(value.mediaFilesRetained, `${source}.mediaFilesRetained`),
    policy: requireText(value.policy, `${source}.policy`, 240)
  };
}

function validatePattern(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, patternFields, source);

  return {
    id: requireSlug(value.id, `${source}.id`),
    title: requireText(value.title, `${source}.title`, 120),
    summary: requireText(value.summary, `${source}.summary`, 500),
    repeatedAcrossEvidence: requireArray(value.repeatedAcrossEvidence, `${source}.repeatedAcrossEvidence`)
      .map((id, index) => requireEvidenceId(id, `${source}.repeatedAcrossEvidence[${index}]`)),
    evidenceCount: requireNonNegativeInteger(value.evidenceCount, `${source}.evidenceCount`),
    segmentCount: requireNonNegativeInteger(value.segmentCount, `${source}.segmentCount`),
    confidence: requireConfidence(value.confidence, `${source}.confidence`),
    signals: requireTextArray(value.signals, `${source}.signals`, 12, 160),
    estimatedMinutesPerWeek: requireNonNegativeInteger(value.estimatedMinutesPerWeek, `${source}.estimatedMinutesPerWeek`),
    recommendation: requireText(value.recommendation, `${source}.recommendation`, 600),
    enterpriseSignal: requireText(value.enterpriseSignal, `${source}.enterpriseSignal`, 400),
    privacyBoundary: requireText(value.privacyBoundary, `${source}.privacyBoundary`, 500)
  };
}

function renderReport({ day, frames, activityTimeline, workPatterns, proposalSet, taskSkillSummary }) {
  const lifecycle = workPatterns.synthesis.rawMediaLifecycle;
  const totalWeeklyMinutes = workPatterns.patterns.reduce((sum, pattern) => sum + pattern.estimatedMinutesPerWeek, 0);
  const captureSurfaces = frames.map((frame) => {
    const domain = frame.surface.domain ? `, ${frame.surface.domain}` : "";
    return `- ${frame.capturedAt}: ${frame.surface.appName} (${frame.surface.windowTitle}${domain})`;
  }).join("\n");
  const patterns = workPatterns.patterns.map((pattern) => (
    `## Efficiency Opportunity: ${pattern.title}

${pattern.summary}

- Confidence: ${pattern.confidence}
- Estimated weekly time saving: ${pattern.estimatedMinutesPerWeek} minutes
- Suggested action: ${pattern.recommendation}
- Organisation signal: ${pattern.enterpriseSignal}
- Evidence count: ${pattern.evidenceCount} frame(s) across ${pattern.segmentCount} segment(s)
- Representative evidence: ${pattern.repeatedAcrossEvidence.join(", ")}
- Signals: ${pattern.signals.join("; ")}
- Privacy boundary: ${pattern.privacyBoundary}`
  )).join("\n\n");
  const commonTasks = activityTimeline.commonTasks.map((task) => (
    `### ${task.title}

- Repeated across: ${task.segmentCount} timeline segment(s), ${task.frameCount} frame(s)
- First seen: ${task.firstAt}
- Last seen: ${task.lastAt}
- Total dwell time: ${task.totalDwellTimeSeconds} seconds
- User intent: ${task.userIntent}
- Evidence narrative: ${task.evidenceNarrative}
- Common actions: ${task.commonActions.join("; ")}
- Cognitive hurdles: ${task.cognitiveHurdles.join("; ") || "No major friction signal visible"}
- Recommendation seeds: ${task.recommendationSeeds.join("; ")}
- Representative evidence: ${task.evidenceIds.join(", ")}

Frame-backed task trail:
${task.evidenceTrail.map((entry) => (
  `- ${entry.evidenceId} (${entry.capturedAt}, ${entry.surface}): ${entry.keyTasks.join("; ")} | signals: ${entry.signals.join("; ")}`
)).join("\n")}`
  )).join("\n\n");
  const timeline = activityTimeline.segments.map((segment) => (
    `### ${segment.title}

- Time: ${segment.startAt} to ${segment.endAt}
- Dwell time: ${segment.dwellTimeSeconds} seconds
- User intent: ${segment.userIntent}
- Actions taken: ${segment.actionsTaken.join("; ")}
- Cognitive hurdles: ${segment.cognitiveHurdles.join("; ") || "No major friction signal visible"}
- Recommendation seeds: ${segment.recommendationSeeds.join("; ")}
- Evidence: ${segment.evidenceIds.join(", ")}
- Frame tasks: ${segment.evidenceTrail.map((entry) => `${entry.evidenceId}: ${entry.keyTasks.join("; ")}`).join(" | ")}`
  )).join("\n\n");
  const taskSkillMatches = taskSkillSummary.commonTasks.map((task) => (
    `### ${task.title}

- Evidence coverage: ${task.evidenceCount} frame(s) across ${task.segmentCount} timeline segment(s)
- Representative evidence IDs: ${task.evidenceIds.join(", ")}
- Dwell time: ${task.dwellTimeSeconds} seconds
- Confidence: ${task.confidence}
- Key tasks: ${task.topTasks.join("; ")}
- Evidence narrative: ${task.evidenceNarrative}

Matching skills:
${task.skills.map((skill) => (
  `- ${skill.title} (${skill.category}, confidence ${skill.confidence}, evidence overlap ${skill.overlap}, saves ${skill.estimatedMinutesPerWeek} min/week)`
)).join("\n")}`
  )).join("\n\n");
  const proposals = proposalSet.proposals.map((proposal) => (
    `### ${proposal.title}

${proposal.summary}

- Owner: ${proposal.owner}
- Category: ${proposal.category}
- Estimated weekly time saving: ${proposal.estimatedMinutesPerWeek} minutes
- Expected outcome: ${proposal.expectedOutcome}
- Rollout metric: ${proposal.rolloutMetric}
- Evidence: ${proposal.evidenceIds.join(", ")}
- Confidence: ${proposal.confidence}

Implementation steps:
${proposal.implementationSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

Prerequisites:
${proposal.prerequisites.map((item) => `- ${item}`).join("\n")}`
  )).join("\n\n");

  return `# Lucille Weekly Efficiency Report: ${day}

## Summary

- Frames analysed: ${frames.length}
- Provider: ${workPatterns.provider}
- Model: ${workPatterns.model}
- Estimated weekly time saving: ${totalWeeklyMinutes} minutes
- AI transformation opportunities: ${workPatterns.patterns.length}
- Local-only synthesis: ${workPatterns.synthesis.localOnly}
- OpenAI requested: ${workPatterns.synthesis.openaiRequested}
- Raw screenshots sent to OpenAI: ${workPatterns.synthesis.rawScreenshotsSent}
- Evidence policy: ${workPatterns.synthesis.evidencePolicy}

Lucille identified practical ways this employee could use AI to reduce repeated administrative effort. The recommendations are intended for review and rollout tracking, not hidden monitoring.

## Capture Surfaces

${captureSurfaces}

## Raw Media Lifecycle

- Action: ${lifecycle.action}
- Files observed: ${lifecycle.mediaFilesObserved}
- Files deleted: ${lifecycle.mediaFilesDeleted}
- Files retained: ${lifecycle.mediaFilesRetained}
- Debug retention explicitly enabled: ${lifecycle.debugRetentionExplicitlyEnabled}

## Activity Timeline

- Text capture policy: ${activityTimeline.textCapturePolicy}
- Frames represented: ${activityTimeline.scaleSummary.frameCount}
- Common tasks: ${activityTimeline.scaleSummary.commonTaskCount}
- Timeline segments: ${activityTimeline.scaleSummary.segmentCount}
- Representative timeline snapshots stored: ${activityTimeline.scaleSummary.snapshotCount}
- Representative snapshot cap: ${activityTimeline.scaleSummary.representativeSnapshotCap} snapshot(s)
- Representative evidence cap: ${activityTimeline.scaleSummary.representativeEvidenceIdCap} evidence ID(s) per cluster
- Evidence trail cap: ${activityTimeline.scaleSummary.evidenceTrailCap} frame-backed entry(s) per cluster
- Aggregation strategy: ${activityTimeline.scaleSummary.aggregationStrategy}

## Common Tasks

${commonTasks}

## Timeline Segments

${timeline}

${patterns}

## Skills By Repeated Task

${taskSkillMatches}

## Skill Proposals

${proposals}

## Privacy Notes

This report is generated from structured analysis artifacts only. It does not include raw screenshots, raw media paths, keystrokes, clipboard contents, audio, passwords, cookies, authentication tokens, full URLs with query strings, raw document bodies, or raw message bodies.
`;
}

function rejectUnexpectedFields(value, allowedFields, source) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${source}: unexpected field "${key}".`);
    }
  }
}

function requireObject(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected an object.`);
  }
}

function requireArray(value, source) {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: expected an array.`);
  }
  return value;
}

function requireLiteral(value, expected, source) {
  if (value !== expected) {
    throw new Error(`${source}: expected ${JSON.stringify(expected)}.`);
  }
  return value;
}

function requireBoolean(value, source) {
  if (typeof value !== "boolean") {
    throw new Error(`${source}: expected a boolean.`);
  }
  return value;
}

function requireNonNegativeInteger(value, source) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${source}: expected a non-negative integer.`);
  }
  return value;
}

function requireTextArray(value, source, maxItems, maxLength) {
  const items = requireArray(value, source);
  if (items.length > maxItems) {
    throw new Error(`${source}: exceeds ${maxItems} items.`);
  }
  return items.map((item, index) => requireText(item, `${source}[${index}]`, maxLength));
}

function requireText(value, source, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: expected a non-empty string.`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > maxLength) {
    throw new Error(`${source}: exceeds ${maxLength} characters.`);
  }
  return text;
}

function requireSlug(value, source) {
  const text = requireText(value, source, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    throw new Error(`${source}: expected lowercase slug text.`);
  }
  return text;
}

function requireEvidenceId(value, source) {
  const text = requireText(value, source, 160);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(text)) {
    throw new Error(`${source}: expected an evidence ID.`);
  }
  return text;
}

function requireConfidence(value, source) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${source}: expected a number from 0 to 1.`);
  }
  return Number(value.toFixed(2));
}

function requireIsoTimestamp(value, source, day) {
  const timestamp = requireText(value, source, 40);
  const parsed = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(timestamp) || Number.isNaN(parsed.getTime())) {
    throw new Error(`${source}: expected an ISO-8601 UTC timestamp.`);
  }
  const canonical = parsed.toISOString();
  if (!canonical.startsWith(`${day}T`)) {
    throw new Error(`${source}: must belong to day ${day}.`);
  }
  return canonical;
}

function requireHostnameOnly(value, source) {
  const domain = requireText(value, source, 253).toLowerCase();
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes("?") ||
    domain.includes("#") ||
    domain.includes("@") ||
    /\s/.test(domain)
  ) {
    throw new Error(`${source}: expected a hostname only.`);
  }
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain)) {
    throw new Error(`${source}: contains unsupported hostname characters.`);
  }
  return domain;
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}
