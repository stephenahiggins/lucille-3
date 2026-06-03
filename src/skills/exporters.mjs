import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildTaskSkillSummary } from "../analysis/taskSkillSummary.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";
import { readSkillProposalSet, requiredTargetTools, selectSkillProposal } from "./proposals.mjs";

export function exportSkillProposal(options = {}) {
  const root = options.root ?? process.cwd();
  const approve = Boolean(options.approve);
  const { day, proposalPath, proposals } = readSkillProposalSet({
    root,
    day: options.day
  });
  const proposal = selectSkillProposal(proposals, options.proposalId);
  const exportRoot = path.join(root, "output", "skills", day, proposal.id);
  const taskContexts = matchingTaskContexts({
    proposal,
    summary: buildTaskSkillSummary({ root, day })
  });
  const artifacts = buildSkillArtifacts({ day, proposal, exportRoot, taskContexts });
  const filesPlanned = artifacts.map((artifact) => path.relative(root, artifact.filePath));

  assertPrivacySafe({
    day,
    proposal,
    taskContexts,
    filesPlanned,
    contents: artifacts.map((artifact) => artifact.content)
  }, "skillExportPlan");

  if (!approve) {
    return {
      schemaVersion: "skill-export.v1",
      day,
      proposalId: proposal.id,
      approved: false,
      sourceProposalFile: path.relative(root, proposalPath),
      exportRoot: path.relative(root, exportRoot),
      filesPlanned,
      filesWritten: [],
      message: "Preview only. Re-run with --approve-export to write tool-specific skill files."
    };
  }

  for (const artifact of artifacts) {
    mkdirSync(path.dirname(artifact.filePath), { recursive: true });
    writeFileSync(artifact.filePath, artifact.content);
  }

  return {
    schemaVersion: "skill-export.v1",
    day,
    proposalId: proposal.id,
    approved: true,
    sourceProposalFile: path.relative(root, proposalPath),
    exportRoot: path.relative(root, exportRoot),
    filesPlanned,
    filesWritten: filesPlanned,
    message: `Wrote approved skill export for ${proposal.id}.`
  };
}

export function buildSkillArtifacts({ day, proposal, exportRoot, taskContexts = [] }) {
  const slug = proposal.id;
  const artifacts = [
    {
      target: "Claude",
      filePath: path.join(exportRoot, "claude", "SKILL.md"),
      content: renderClaudeSkill({ day, proposal, taskContexts })
    },
    {
      target: "Codex",
      filePath: path.join(exportRoot, "codex", "SKILL.md"),
      content: renderCodexSkill({ day, proposal, taskContexts })
    },
    {
      target: "Cursor",
      filePath: path.join(exportRoot, "cursor", ".cursor", "rules", `${slug}.mdc`),
      content: renderCursorRule({ day, proposal, taskContexts })
    },
    {
      target: "ChatGPT",
      filePath: path.join(exportRoot, "chatgpt", "instructions.md"),
      content: renderChatGPTInstructions({ day, proposal, taskContexts })
    },
    {
      target: "ChatGPT",
      filePath: path.join(exportRoot, "chatgpt", "knowledge.md"),
      content: renderChatGPTKnowledge({ day, proposal, taskContexts })
    },
    {
      target: "ChatGPT",
      filePath: path.join(exportRoot, "chatgpt", "actions.json"),
      content: renderChatGPTActions({ day, proposal, taskContexts })
    }
  ];

  assertRequiredTargets(artifacts);
  return artifacts;
}

function renderClaudeSkill({ day, proposal, taskContexts }) {
  return `${frontMatterComment(day, proposal)}
# ${proposal.title}

## Purpose
${proposal.summary}

## Concrete Proposal
- Owner: ${proposal.owner}
- Category: ${proposal.category}
- Estimated weekly time saving: ${proposal.estimatedMinutesPerWeek} minutes
- Expected outcome: ${proposal.expectedOutcome}
- Rollout metric: ${proposal.rolloutMetric}

## Implementation Steps
${proposal.implementationSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## Prerequisites
${proposal.prerequisites.map((item) => `- ${item}`).join("\n")}

## When To Use
Use this skill when the user asks for help with the repeated work pattern supported by the evidence IDs below.

## Evidence IDs
${proposal.evidenceIds.map((id) => `- ${id}`).join("\n")}

${renderRepeatedTaskContextMarkdown(taskContexts)}

## Confidence
${proposal.confidence}

## Privacy Boundary
Use redacted structured evidence only. Do not request screenshots, keystrokes, clipboard contents, audio, raw document bodies, or raw message bodies.

## Workflow
1. Confirm the user wants this proposed skill applied.
2. Use the evidence-backed pattern as guidance, not as an autonomous workflow executor.
3. Keep any generated files scoped to the user's explicit request.
`;
}

function renderCodexSkill({ day, proposal, taskContexts }) {
  return `${frontMatterComment(day, proposal)}
# ${proposal.title}

## Purpose
${proposal.summary}

## Release Category
${proposal.category}

## Concrete Rollout
- Owner: ${proposal.owner}
- Estimated weekly time saving: ${proposal.estimatedMinutesPerWeek} minutes
- Expected outcome: ${proposal.expectedOutcome}
- Rollout metric: ${proposal.rolloutMetric}

## Implementation Steps
${proposal.implementationSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## Prerequisites
${proposal.prerequisites.map((item) => `- ${item}`).join("\n")}

## Evidence IDs
${proposal.evidenceIds.map((id) => `- ${id}`).join("\n")}

${renderRepeatedTaskContextMarkdown(taskContexts)}

## Codex Instructions
Use this skill when helping implement, test, document, or package this Lucille recommendation. Keep changes local-first, evidence-grounded, and privacy-preserving. Do not add hidden capture, keystroke capture, clipboard capture, raw message bodies, raw document bodies, full URLs with query strings, or raw screenshot transmission.
`;
}

function renderCursorRule({ day, proposal, taskContexts }) {
  return `---
description: ${proposal.title}
globs: []
alwaysApply: false
---

${frontMatterComment(day, proposal)}
# ${proposal.title}

${proposal.summary}

Owner: ${proposal.owner}
Category: ${proposal.category}
Estimated weekly time saving: ${proposal.estimatedMinutesPerWeek} minutes
Expected outcome: ${proposal.expectedOutcome}
Rollout metric: ${proposal.rolloutMetric}
Implementation steps:
${proposal.implementationSteps.map((step) => `- ${step}`).join("\n")}
Prerequisites:
${proposal.prerequisites.map((item) => `- ${item}`).join("\n")}

Evidence IDs: ${proposal.evidenceIds.join(", ")}
Confidence: ${proposal.confidence}

${renderRepeatedTaskContextMarkdown(taskContexts)}

Use redacted structured evidence only. Do not capture keystrokes, clipboard contents, audio, raw document bodies, or raw message bodies.
`;
}

function renderChatGPTInstructions({ day, proposal, taskContexts }) {
  return `${frontMatterComment(day, proposal)}
# Instructions

Use this proposed skill when the conversation matches: ${proposal.summary}

Concrete rollout:
${proposal.implementationSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

Expected outcome: ${proposal.expectedOutcome}
Owner: ${proposal.owner}
Category: ${proposal.category}
Metric: ${proposal.rolloutMetric}

${renderRepeatedTaskContextMarkdown(taskContexts)}

Before acting, confirm the user wants the skill applied. Keep work local to the user's request and cite evidence IDs when explaining why the skill applies.
`;
}

function renderChatGPTKnowledge({ day, proposal, taskContexts }) {
  return `${frontMatterComment(day, proposal)}
# Knowledge

Title: ${proposal.title}
Summary: ${proposal.summary}
Owner: ${proposal.owner}
Category: ${proposal.category}
Estimated weekly time saving: ${proposal.estimatedMinutesPerWeek} minutes
Expected outcome: ${proposal.expectedOutcome}
Rollout metric: ${proposal.rolloutMetric}
Implementation steps:
${proposal.implementationSteps.map((step) => `- ${step}`).join("\n")}
Prerequisites:
${proposal.prerequisites.map((item) => `- ${item}`).join("\n")}
Evidence IDs: ${proposal.evidenceIds.join(", ")}
Confidence: ${proposal.confidence}
Targets: ${proposal.targetTools.join(", ")}

${renderRepeatedTaskContextMarkdown(taskContexts)}

Privacy boundary: use redacted structured evidence only. Do not rely on screenshots, hidden monitoring, clipboard contents, audio, keystrokes, raw document bodies, or raw message bodies.
`;
}

function renderChatGPTActions({ day, proposal, taskContexts }) {
  return JSON.stringify({
    schemaVersion: "chatgpt-actions-bundle.v1",
    day,
    proposalId: proposal.id,
    title: proposal.title,
    category: proposal.category,
    owner: proposal.owner,
    estimatedMinutesPerWeek: proposal.estimatedMinutesPerWeek,
    rolloutMetric: proposal.rolloutMetric,
    repeatedTaskContexts: taskContexts.map((task) => ({
      id: task.id,
      title: task.title,
      evidenceCount: task.evidenceCount,
      evidenceIds: task.evidenceIds,
      segmentCount: task.segmentCount,
      dwellTimeSeconds: task.dwellTimeSeconds,
      confidence: task.confidence,
      topTasks: task.topTasks,
      evidenceNarrative: task.evidenceNarrative
    })),
    actions: [],
    note: "No external actions are configured for this local-first proposed skill export."
  }, null, 2) + "\n";
}

function matchingTaskContexts({ proposal, summary }) {
  return summary.commonTasks
    .map((task) => {
      const matchingSkill = task.skills.find((skill) => skill.id === proposal.id);
      return matchingSkill ? { ...task, overlap: matchingSkill.overlap } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.overlap - left.overlap ||
      right.evidenceCount - left.evidenceCount ||
      left.title.localeCompare(right.title)
    ))
    .slice(0, 3)
    .map(({ skills, overlap, ...task }) => task);
}

function renderRepeatedTaskContextMarkdown(taskContexts) {
  if (taskContexts.length === 0) {
    return `## Repeated Task Context
- No matching common task cluster was found. Use the proposal evidence IDs and ask the employee to confirm the repeated task before applying this skill.`;
  }

  return `## Repeated Task Context
${taskContexts.map((task) => (
    `### ${task.title}
- Evidence coverage: ${task.evidenceCount} frame(s) across ${task.segmentCount} timeline segment(s)
- Representative evidence IDs: ${task.evidenceIds.join(", ")}
- Dwell time: ${task.dwellTimeSeconds} seconds
- Confidence: ${task.confidence}
- Key tasks: ${task.topTasks.join("; ")}
- Why this skill helps: ${task.evidenceNarrative}`
  )).join("\n\n")}`;
}

function frontMatterComment(day, proposal) {
  return `<!-- Generated from Lucille proposal ${proposal.id} for ${day}. Status: proposed. Tool-specific files are written only after explicit approval. -->`;
}

function assertRequiredTargets(artifacts) {
  const targets = new Set(artifacts.map((artifact) => artifact.target));
  const missing = requiredTargetTools.filter((tool) => !targets.has(tool));
  if (missing.length > 0) {
    throw new Error(`Missing export artifact target(s): ${missing.join(", ")}.`);
  }
}
