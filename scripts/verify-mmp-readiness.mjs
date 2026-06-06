#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateActivityTimeline } from "../src/analysis/activityTimeline.mjs";
import {
  buildTaskSkillSummary,
  buildTaskSkillSummaryFromArtifacts
} from "../src/analysis/taskSkillSummary.mjs";
import { assertPrivacySafe } from "../src/privacy/safety.mjs";
import { buildSkillArtifacts } from "../src/skills/exporters.mjs";
import {
  assessSkillPortfolioReadiness,
  requiredProposalCategories,
  validateSkillProposalSet
} from "../src/skills/proposals.mjs";

const representativeEvidenceCap = 50;
const evidenceTrailCap = 20;

export function verifyMmpReadiness(options = {}) {
  const root = options.root ?? process.env.LUCILLE_ROOT ?? process.cwd();
  const day = validateDay(options.day ?? process.env.DAY ?? latestAnalysisDay(root));
  const analysisDir = path.join(root, "storage", "analysis", day);
  const reportPath = path.join(root, "output", "reports", `${day}.md`);
  const failures = [];

  const frames = readFrameAnalysis(path.join(analysisDir, "frame-analysis.jsonl"), failures);
  const timeline = readTimeline(path.join(analysisDir, "activity-timeline.json"), { day, failures });
  const workPatterns = readJson(path.join(analysisDir, "work-patterns.json"), "work patterns", failures);
  const proposalSet = readProposals(path.join(analysisDir, "skill-proposals.json"), { day, failures });
  const taskSkillSummary = readJson(path.join(analysisDir, "task-skill-summary.json"), "task skill summary", failures);
  const reportMarkdown = readReport(reportPath, failures);

  if (frames) verifyFrames(frames, failures);
  if (timeline) verifyTimeline(timeline, frames, failures);
  if (workPatterns) verifyWorkPatterns(workPatterns, timeline, frames, failures);
  if (taskSkillSummary) verifyTaskSkillSummary(taskSkillSummary, timeline, proposalSet, failures);
  if (proposalSet) verifySkillProposals(proposalSet, workPatterns, timeline, frames, root, day, failures);
  if (reportMarkdown) verifyReport(reportMarkdown, failures);

  const summary = buildSummary({
    root,
    day,
    frames,
    timeline,
    workPatterns,
    proposalSet,
    taskSkillSummary,
    reportPath,
    failures
  });
  if (failures.length > 0) {
    const error = new Error(`MMP readiness failed for ${day}: ${failures.join("; ")}`);
    error.summary = summary;
    throw error;
  }
  return summary;
}

function readFrameAnalysis(filePath, failures) {
  if (!existsSync(filePath)) {
    failures.push("frame-analysis.jsonl is missing");
    return null;
  }
  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    failures.push("frame-analysis.jsonl contains no frames");
    return null;
  }
  try {
    const frames = lines.map((line) => JSON.parse(line));
    assertPrivacySafe(frames, "mmpReadiness.frames");
    return frames;
  } catch (error) {
    failures.push(`frame-analysis.jsonl is invalid: ${error.message}`);
    return null;
  }
}

function readTimeline(filePath, { day, failures }) {
  const parsed = readJson(filePath, "activity timeline", failures);
  if (!parsed) return null;
  try {
    return validateActivityTimeline(parsed, { day, source: "activity-timeline.json" });
  } catch (error) {
    failures.push(`activity-timeline.json is invalid: ${error.message}`);
    return null;
  }
}

function readProposals(filePath, { day, failures }) {
  const parsed = readJson(filePath, "skill proposals", failures);
  if (!parsed) return null;
  try {
    return validateSkillProposalSet(parsed, { day, source: "skill-proposals.json" });
  } catch (error) {
    failures.push(`skill-proposals.json is invalid: ${error.message}`);
    return null;
  }
}

function readJson(filePath, label, failures) {
  if (!existsSync(filePath)) {
    failures.push(`${path.basename(filePath)} is missing`);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    assertPrivacySafe(parsed, `mmpReadiness.${label}`);
    return parsed;
  } catch (error) {
    failures.push(`${path.basename(filePath)} is invalid: ${error.message}`);
    return null;
  }
}

function readReport(filePath, failures) {
  if (!existsSync(filePath)) {
    failures.push(`${path.relative(process.cwd(), filePath)} is missing`);
    return null;
  }
  const markdown = readFileSync(filePath, "utf8");
  try {
    assertPrivacySafe(markdown, "mmpReadiness.report");
  } catch (error) {
    failures.push(`report is not privacy-safe: ${error.message}`);
  }
  return markdown;
}

function verifyFrames(frames, failures) {
  for (const [index, frame] of frames.entries()) {
    const source = `frame ${index + 1}`;
    if (frame?.schemaVersion !== "frame-analysis.v1") failures.push(`${source} has the wrong schema`);
    if (!isEvidenceId(frame?.evidenceId)) failures.push(`${source} is missing a valid evidenceId`);
    if (!Array.isArray(frame?.keyTasks) || frame.keyTasks.length === 0) {
      failures.push(`${source} does not draw out key tasks`);
    }
    if (!Array.isArray(frame?.applications) || frame.applications.length === 0) {
      failures.push(`${source} is missing visible applications`);
    } else if (frame.applications.filter((application) => application?.isPrimary === true).length !== 1) {
      failures.push(`${source} must identify exactly one primary application`);
    }
    if (!frame?.primaryApplication?.name) {
      failures.push(`${source} is missing primaryApplication`);
    }
  }
}

function verifyTimeline(timeline, frames, failures) {
  if (timeline.textCapturePolicy !== "visible_text_ocr_only") {
    failures.push("timeline must use visible_text_ocr_only");
  }
  if (!timeline.scaleSummary) {
    failures.push("timeline is missing scaleSummary");
  } else {
    if (timeline.scaleSummary.frameCount < timeline.snapshots.length) {
      failures.push("timeline scaleSummary frameCount is smaller than representative snapshots");
    }
    if (timeline.scaleSummary.segmentCount !== timeline.segments.length) {
      failures.push("timeline scaleSummary segmentCount does not match segments");
    }
    if (timeline.scaleSummary.commonTaskCount !== timeline.commonTasks.length) {
      failures.push("timeline scaleSummary commonTaskCount does not match commonTasks");
    }
    if (timeline.scaleSummary.snapshotCount !== timeline.snapshots.length) {
      failures.push("timeline scaleSummary snapshotCount does not match representative snapshots");
    }
    if (timeline.scaleSummary.snapshotCount > timeline.scaleSummary.representativeSnapshotCap) {
      failures.push("timeline representative snapshots exceed the snapshot cap");
    }
    if (!/common_tasks_group_repeated_timeline_segments/.test(timeline.scaleSummary.aggregationStrategy)) {
      failures.push("timeline scaleSummary does not declare common-task aggregation");
    }
  }
  if (frames && timeline.scaleSummary.frameCount !== frames.length) {
    failures.push(`timeline frame count (${timeline.scaleSummary.frameCount}) does not match analysed frames (${frames.length})`);
  }
  if (timeline.commonTasks.length === 0) failures.push("timeline has no common tasks");
  if (frames?.length > 1 && timeline.commonTasks.length >= frames.length) {
    failures.push("timeline appears to model one common task per frame instead of aggregating repeated tasks");
  }
  if (!timeline.commonTasks.some((task) => task.frameCount > 1)) {
    failures.push("no common task spans multiple frames");
  }

  for (const snapshot of timeline.snapshots) {
    if (!Array.isArray(snapshot.keyTasks) || snapshot.keyTasks.length === 0) {
      failures.push(`${snapshot.id} is missing keyTasks`);
    }
  }
  for (const segment of timeline.segments) {
    if (!Number.isInteger(segment.frameCount) || segment.frameCount < 1) {
      failures.push(`${segment.id} is missing frameCount`);
    }
    if (segment.evidenceIds.length > representativeEvidenceCap) {
      failures.push(`${segment.id} exceeds the representative evidence cap`);
    }
    if (segment.evidenceTrail.length > evidenceTrailCap) {
      failures.push(`${segment.id} exceeds the evidence trail cap`);
    }
  }
  for (const task of timeline.commonTasks) {
    if (!Number.isInteger(task.segmentCount) || task.segmentCount < 1) {
      failures.push(`${task.id} is missing segmentCount`);
    }
    if (task.segmentCount < task.segmentIds.length) {
      failures.push(`${task.id} has more representative segment IDs than segmentCount`);
    }
    if (task.evidenceIds.length > representativeEvidenceCap) {
      failures.push(`${task.id} exceeds the representative evidence cap`);
    }
    if (task.evidenceTrail.length > evidenceTrailCap) {
      failures.push(`${task.id} exceeds the evidence trail cap`);
    }
    if (task.frameCount < task.evidenceTrail.length || task.frameCount < task.evidenceIds.length) {
      failures.push(`${task.id} has impossible frame/evidence counts`);
    }
    if (!task.evidenceTrail.every((entry) => Array.isArray(entry.keyTasks) && entry.keyTasks.length > 0)) {
      failures.push(`${task.id} has evidence trail entries without key tasks`);
    }
  }
}

function verifyWorkPatterns(workPatterns, timeline, frames, failures) {
  if (workPatterns.schemaVersion !== "work-patterns.v1") failures.push("work-patterns.json has the wrong schema");
  if (!Array.isArray(workPatterns.patterns) || workPatterns.patterns.length === 0) {
    failures.push("work-patterns.json has no patterns");
    return;
  }
  if (frames?.length > 1 && workPatterns.patterns.length >= frames.length) {
    failures.push("work patterns appear to be generated per frame instead of from common tasks");
  }
  if (!workPatterns.patterns.some((pattern) => Number(pattern.evidenceCount ?? 0) > 1)) {
    failures.push("no work pattern carries multi-frame evidenceCount");
  }

  const commonEvidenceSets = new Set((timeline?.commonTasks ?? []).map((task) => evidenceKey(task.evidenceIds)));
  for (const pattern of workPatterns.patterns) {
    if (!Number.isInteger(pattern.evidenceCount) || pattern.evidenceCount < 1) {
      failures.push(`${pattern.id ?? "pattern"} is missing evidenceCount`);
    }
    if (!Number.isInteger(pattern.segmentCount) || pattern.segmentCount < 1) {
      failures.push(`${pattern.id ?? "pattern"} is missing segmentCount`);
    }
    if (!Array.isArray(pattern.repeatedAcrossEvidence) || pattern.repeatedAcrossEvidence.length === 0) {
      failures.push(`${pattern.id ?? "pattern"} has no repeatedAcrossEvidence`);
    }
    if (commonEvidenceSets.size > 0 && !commonEvidenceSets.has(evidenceKey(pattern.repeatedAcrossEvidence))) {
      failures.push(`${pattern.id ?? "pattern"} does not map to a timeline common task`);
    }
  }
}

function verifySkillProposals(proposalSet, workPatterns, timeline, frames, root, day, failures) {
  const portfolio = assessSkillPortfolioReadiness(proposalSet.proposals);
  if (!portfolio.ready) {
    failures.push(`skill portfolio is not ready; missing categories: ${portfolio.missingCategories.join(", ") || "none"}; weak proposals: ${portfolio.weakProposals.join(", ") || "none"}`);
  }

  const proposals = proposalSet.proposals;
  const proposalEvidenceGroups = new Set(proposals.map((proposal) => evidenceKey(proposal.evidenceIds)));
  if (frames?.length > 1 && proposalEvidenceGroups.size >= frames.length) {
    failures.push("skill proposals appear to preserve frame-level evidence groups instead of common-task groups");
  }
  if (!proposals.every((proposal) => proposal.evidenceIds.length > 1)) {
    failures.push("each skill proposal should cite multi-frame evidence, not a single frame");
  }

  const patterns = workPatterns?.patterns ?? [];
  for (const pattern of patterns) {
    const matching = proposals.filter((proposal) => overlaps(proposal.evidenceIds, pattern.repeatedAcrossEvidence));
    for (const category of ["employee_weekly_report", "workflow_automation", "ai_assistance"]) {
      if (!matching.some((proposal) => proposal.category === category)) {
        failures.push(`${pattern.id} is missing a ${category} skill proposal`);
      }
    }
  }

  const commonEvidence = new Set((timeline?.commonTasks ?? []).flatMap((task) => task.evidenceIds));
  for (const proposal of proposals) {
    if (!proposal.evidenceIds.every((id) => commonEvidence.has(id))) {
      failures.push(`${proposal.id} cites evidence that is not in the common task timeline`);
    }
  }

  for (const category of requiredProposalCategories) {
    if (!proposals.some((proposal) => proposal.category === category)) {
      failures.push(`missing required proposal category ${category}`);
    }
  }

  verifySkillArtifactsCarryTaskContext({ root, day, proposals, failures });
}

function verifyTaskSkillSummary(taskSkillSummary, timeline, proposalSet, failures) {
  if (taskSkillSummary.schemaVersion !== "task-skill-summary.v1") {
    failures.push("task-skill-summary.json has the wrong schema");
  }
  if (!Array.isArray(taskSkillSummary.commonTasks) || taskSkillSummary.commonTasks.length === 0) {
    failures.push("task-skill-summary.json has no common tasks");
    return;
  }
  if (timeline && taskSkillSummary.commonTasks.length !== timeline.commonTasks.length) {
    failures.push("task-skill-summary.json does not cover every timeline common task");
  }
  if (timeline && proposalSet) {
    const derivedSummary = buildTaskSkillSummaryFromArtifacts({
      day: taskSkillSummary.day,
      activityTimeline: timeline,
      proposalSet
    });
    if (canonicalJson(taskSkillSummary) !== canonicalJson(derivedSummary)) {
      failures.push("task-skill-summary.json is stale or does not match activity-timeline.json plus skill-proposals.json");
    }
  }
  const proposalIds = new Set((proposalSet?.proposals ?? []).map((proposal) => proposal.id));
  for (const task of taskSkillSummary.commonTasks) {
    if (!Number.isInteger(task.evidenceCount) || task.evidenceCount < 2) {
      failures.push(`${task.id ?? "task"} does not expose multi-frame evidenceCount`);
    }
    if (!Array.isArray(task.evidenceIds) || task.evidenceIds.length < 2) {
      failures.push(`${task.id ?? "task"} does not expose multi-frame representative evidence IDs`);
    }
    if (Array.isArray(task.evidenceIds) && task.evidenceIds.length > task.evidenceCount) {
      failures.push(`${task.id ?? "task"} has more representative evidence IDs than frame evidence count`);
    }
    if (!Array.isArray(task.topTasks) || task.topTasks.length === 0) {
      failures.push(`${task.id ?? "task"} does not expose key tasks`);
    }
    if (!Array.isArray(task.skills) || task.skills.length === 0) {
      failures.push(`${task.id ?? "task"} has no matching skills`);
      continue;
    }
    for (const category of ["employee_weekly_report", "workflow_automation", "ai_assistance"]) {
      if (!task.skills.some((skill) => skill.category === category)) {
        failures.push(`${task.id ?? "task"} is missing a ${category} skill`);
      }
    }
    for (const skill of task.skills) {
      if (!proposalIds.has(skill.id)) failures.push(`${task.id ?? "task"} references unknown skill ${skill.id}`);
      if (!Number.isInteger(skill.overlap) || skill.overlap < 1) {
        failures.push(`${task.id ?? "task"} skill ${skill.id} does not cite overlapping evidence`);
      }
    }
  }
}

function verifySkillArtifactsCarryTaskContext({ root, day, proposals, failures }) {
  let taskSummary = null;
  try {
    taskSummary = buildTaskSkillSummary({ root, day });
  } catch (error) {
    failures.push(`could not build task-skill summary for exports: ${error.message}`);
    return;
  }

  for (const proposal of proposals) {
    const taskContexts = taskSummary.commonTasks.filter((task) => (
      task.skills.some((skill) => skill.id === proposal.id)
    ));
    const exportRoot = path.join(root, "output", "skills", day, proposal.id);
    const artifacts = buildSkillArtifacts({ day, proposal, exportRoot, taskContexts });
    if (taskContexts.length === 0) {
      failures.push(`${proposal.id} has no matching repeated-task context for export`);
    }
    for (const artifact of artifacts) {
      if (!artifact.filePath.endsWith(path.join("chatgpt", "actions.json")) && !/Repeated Task Context/.test(artifact.content)) {
        failures.push(`${proposal.id} ${artifact.target} export is missing repeated task context`);
      }
    }
    const chatgptActions = artifacts.find((artifact) => artifact.filePath.endsWith(path.join("chatgpt", "actions.json")));
    if (chatgptActions) {
      const parsed = JSON.parse(chatgptActions.content);
      if (!Array.isArray(parsed.repeatedTaskContexts) || parsed.repeatedTaskContexts.length === 0) {
        failures.push(`${proposal.id} ChatGPT actions export is missing repeatedTaskContexts`);
      } else if (!parsed.repeatedTaskContexts.every((task) => Array.isArray(task.evidenceIds) && task.evidenceIds.length > 1)) {
        failures.push(`${proposal.id} ChatGPT actions export repeatedTaskContexts are missing multi-frame evidence IDs`);
      }
    }
  }
}

function verifyReport(markdown, failures) {
  for (const pattern of [
    /## Activity Timeline/i,
    /## Common Tasks/i,
    /Frame-backed task trail/i,
    /## Efficiency Opportunit(?:y|ies)/i,
    /## Skills By Repeated Task/i,
    /Matching skills:/i,
    /## Skill Proposals/i,
    /AI transformation manager dashboard/i,
    /Enterprise AI rollout readiness/i
  ]) {
    if (!pattern.test(markdown)) failures.push(`report is missing ${pattern}`);
  }
}

function buildSummary({ root, day, frames, timeline, workPatterns, proposalSet, taskSkillSummary, reportPath, failures }) {
  const commonTasks = timeline?.commonTasks ?? [];
  const patterns = workPatterns?.patterns ?? [];
  const proposals = proposalSet?.proposals ?? [];
  const repeatedTaskFrameCount = commonTasks.reduce((sum, task) => sum + Math.max(0, task.frameCount), 0);
  return {
    ready: failures.length === 0,
    root,
    day,
    frameCount: frames?.length ?? 0,
    commonTaskCount: commonTasks.length,
    taskSkillSummaryCount: taskSkillSummary?.commonTasks?.length ?? 0,
    repeatedTaskFrameCount,
    patternCount: patterns.length,
    proposalCount: proposals.length,
    proposalCategories: [...new Set(proposals.map((proposal) => proposal.category))].sort(),
    reportPath,
    failures
  };
}

function latestAnalysisDay(root) {
  const analysisDir = path.join(root, "storage", "analysis");
  if (!existsSync(analysisDir)) throw new Error(`No analysis directory found at ${analysisDir}.`);
  const days = readdirSync(analysisDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (days.length === 0) throw new Error(`No analysis days found in ${analysisDir}.`);
  return days[0];
}

function validateDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("DAY must be in YYYY-MM-DD format.");
  }
  return value;
}

function isEvidenceId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function evidenceKey(ids) {
  return [...new Set(ids ?? [])].sort().join("|");
}

function overlaps(left, right) {
  const rightSet = new Set(right ?? []);
  return (left ?? []).some((id) => rightSet.has(id));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--day") {
      options.day = argv[++index];
    } else if (arg.startsWith("--day=")) {
      options.day = arg.slice("--day=".length);
    } else if (arg === "--root") {
      options.root = argv[++index];
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printSummary(summary, json = false) {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`MMP readiness: ${summary.ready ? "ready" : "not ready"}`);
  console.log(`Day: ${summary.day}`);
  console.log(`Frames: ${summary.frameCount}`);
  console.log(`Common tasks: ${summary.commonTaskCount}`);
  console.log(`Task-skill summaries: ${summary.taskSkillSummaryCount}`);
  console.log(`Repeated-task frame evidence: ${summary.repeatedTaskFrameCount}`);
  console.log(`Work patterns: ${summary.patternCount}`);
  console.log(`Skill proposals: ${summary.proposalCount}`);
  console.log(`Proposal categories: ${summary.proposalCategories.join(", ")}`);
  console.log(`Report: ${summary.reportPath}`);
  if (summary.failures.length > 0) {
    console.log("Failures:");
    for (const failure of summary.failures) console.log(`- ${failure}`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = verifyMmpReadiness(options);
    printSummary(summary, options.json);
  } catch (error) {
    if (error.summary) printSummary(error.summary, process.argv.includes("--json"));
    console.error(error.message);
    process.exitCode = 1;
  }
}
