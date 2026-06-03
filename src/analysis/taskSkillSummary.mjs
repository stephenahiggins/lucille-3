import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateActivityTimeline } from "./activityTimeline.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";
import { readSkillProposalSet } from "../skills/proposals.mjs";

export function buildTaskSkillSummary(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day);
  const { proposalSet } = readSkillProposalSet({ root, day });
  const timelinePath = path.join(root, "storage", "analysis", day, "activity-timeline.json");
  if (!existsSync(timelinePath)) {
    throw new Error(`No activity timeline found for ${day}. Run analysis first.`);
  }

  const activityTimeline = validateActivityTimeline(JSON.parse(readFileSync(timelinePath, "utf8")), {
    day,
    source: "activity-timeline.json"
  });
  return buildTaskSkillSummaryFromArtifacts({ day, activityTimeline, proposalSet });
}

export function writeTaskSkillSummary(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day);
  const summary = buildTaskSkillSummary({ root, day });
  const analysisDir = path.join(root, "storage", "analysis", day);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(
    path.join(analysisDir, "task-skill-summary.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  return summary;
}

export function buildTaskSkillSummaryFromArtifacts({ day, activityTimeline, proposalSet }) {
  const validatedDay = validateDay(day);
  const timeline = validateActivityTimeline(activityTimeline, {
    day: validatedDay,
    source: "activityTimeline"
  });
  const proposals = Array.isArray(proposalSet?.proposals) ? proposalSet.proposals : [];
  const commonTasks = timeline.commonTasks.map((task) => taskSummary({ task, proposals }));
  const summary = {
    schemaVersion: "task-skill-summary.v1",
    day: validatedDay,
    commonTasks
  };
  assertPrivacySafe(summary, "taskSkillSummary");
  return summary;
}

function taskSummary({ task, proposals }) {
  return {
    id: task.id,
    title: task.title,
    evidenceCount: task.frameCount,
    evidenceIds: task.evidenceIds,
    segmentCount: task.segmentCount,
    dwellTimeSeconds: task.totalDwellTimeSeconds,
    confidence: task.confidence,
    evidenceNarrative: task.evidenceNarrative,
    topTasks: unique(task.evidenceTrail.flatMap((entry) => entry.keyTasks)).slice(0, 5),
    skills: matchingSkillSummaries({ task, proposals })
  };
}

function matchingSkillSummaries({ task, proposals }) {
  const taskEvidence = new Set(task.evidenceIds);
  return proposals
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      category: proposal.category,
      confidence: proposal.confidence,
      estimatedMinutesPerWeek: proposal.estimatedMinutesPerWeek,
      overlap: proposal.evidenceIds.filter((id) => taskEvidence.has(id)).length
    }))
    .filter((proposal) => proposal.overlap > 0)
    .sort((left, right) => (
      right.overlap - left.overlap ||
      right.confidence - left.confidence ||
      left.title.localeCompare(right.title)
    ));
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function validateDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("day must be in YYYY-MM-DD format.");
  }
  return value;
}
