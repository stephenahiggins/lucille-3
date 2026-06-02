import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPrivacySafe } from "../privacy/safety.mjs";

export const requiredTargetTools = Object.freeze(["Claude", "Codex", "Cursor", "ChatGPT"]);
export const requiredProposalCategories = Object.freeze([
  "employee_weekly_report",
  "workflow_automation",
  "ai_assistance",
  "manager_monitoring",
  "enterprise_rollout"
]);

const proposalSetFields = new Set(["schemaVersion", "day", "proposals"]);
const proposalFields = new Set([
  "id",
  "title",
  "status",
  "category",
  "targetTools",
  "summary",
  "implementationSteps",
  "expectedOutcome",
  "estimatedMinutesPerWeek",
  "owner",
  "rolloutMetric",
  "prerequisites",
  "evidenceIds",
  "confidence",
  "exportPlan"
]);
const exportPlanFields = new Set(["claude", "codex", "cursor", "chatgpt"]);

export function readSkillProposalSet(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day);
  const proposalPath = path.join(root, "storage", "analysis", day, "skill-proposals.json");

  if (!existsSync(proposalPath)) {
    throw new Error(`No skill proposals found for ${day}. Run make analyse DAY=${day} first.`);
  }

  const parsed = JSON.parse(readFileSync(proposalPath, "utf8"));
  const proposalSet = validateSkillProposalSet(parsed, { day, source: "skill-proposals.json" });
  assertPrivacySafe(proposalSet, "skillProposalSet");

  return {
    day,
    proposalPath,
    proposalSet,
    proposals: proposalSet.proposals
  };
}

export function writeSkillProposalSet(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day ?? options.proposalSet?.day);
  const proposalPath = path.join(root, "storage", "analysis", day, "skill-proposals.json");
  const proposalSet = validateSkillProposalSet(options.proposalSet, {
    day,
    source: "skillProposalSet"
  });
  assertPrivacySafe(proposalSet, "skillProposalSet");

  mkdirSync(path.dirname(proposalPath), { recursive: true });
  writeFileSync(proposalPath, JSON.stringify(proposalSet, null, 2) + "\n");

  return {
    day,
    proposalPath,
    proposalSet,
    proposals: proposalSet.proposals
  };
}

export function selectSkillProposal(proposals, proposalId) {
  const validatedProposals = requireArray(proposals, "proposals");

  if (proposalId) {
    const id = validateSlug(proposalId, "proposalId");
    const proposal = validatedProposals.find((item) => item.id === id);
    if (!proposal) {
      throw new Error(`Skill proposal "${id}" was not found.`);
    }
    return proposal;
  }

  if (validatedProposals.length === 1) {
    return validatedProposals[0];
  }

  throw new Error("Multiple skill proposals found. Pass --proposal-id to choose one.");
}

export function validateSkillProposalSet(value, { day, source = "skillProposalSet" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a skill proposal set object.`);
  }

  rejectUnexpectedFields(value, proposalSetFields, source);

  const validatedDay = validateDay(day ?? value.day);
  const proposalSet = {
    schemaVersion: requireLiteral(value.schemaVersion, "skill-proposals.v1", `${source}.schemaVersion`),
    day: requireLiteral(value.day, validatedDay, `${source}.day`),
    proposals: requireArray(value.proposals, `${source}.proposals`).map((proposal, index) => (
      validateSkillProposal(proposal, `${source}.proposals[${index}]`)
    ))
  };

  if (proposalSet.proposals.length === 0) {
    throw new Error(`${source}.proposals: expected at least one proposal.`);
  }

  return proposalSet;
}

function validateSkillProposal(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a skill proposal object.`);
  }

  rejectUnexpectedFields(value, proposalFields, source);

  return {
    id: validateSlug(value.id, `${source}.id`),
    title: requireText(value.title, `${source}.title`, 120),
    status: requireLiteral(value.status, "proposed", `${source}.status`),
    category: requireProposalCategory(value.category, `${source}.category`),
    targetTools: requireTargetTools(value.targetTools, `${source}.targetTools`),
    summary: requireText(value.summary, `${source}.summary`, 500),
    implementationSteps: requireTextArray(value.implementationSteps, `${source}.implementationSteps`, 8, 240),
    expectedOutcome: requireText(value.expectedOutcome, `${source}.expectedOutcome`, 500),
    estimatedMinutesPerWeek: requirePositiveInteger(value.estimatedMinutesPerWeek, `${source}.estimatedMinutesPerWeek`),
    owner: requireText(value.owner, `${source}.owner`, 120),
    rolloutMetric: requireText(value.rolloutMetric, `${source}.rolloutMetric`, 240),
    prerequisites: requireTextArray(value.prerequisites, `${source}.prerequisites`, 8, 200),
    evidenceIds: requireEvidenceIds(value.evidenceIds, `${source}.evidenceIds`),
    confidence: requireConfidence(value.confidence, `${source}.confidence`),
    exportPlan: requireExportPlan(value.exportPlan, `${source}.exportPlan`)
  };
}

export function assessSkillPortfolioReadiness(proposals) {
  const items = requireArray(proposals, "proposals");
  const categories = new Set(items.map((proposal) => proposal.category));
  const missingCategories = requiredProposalCategories.filter((category) => !categories.has(category));
  const weakProposals = items
    .filter((proposal) => (
      !Array.isArray(proposal.implementationSteps) ||
      proposal.implementationSteps.length < 3 ||
      !Array.isArray(proposal.prerequisites) ||
      proposal.prerequisites.length < 2 ||
      !Number.isInteger(proposal.estimatedMinutesPerWeek) ||
      proposal.estimatedMinutesPerWeek <= 0 ||
      typeof proposal.rolloutMetric !== "string" ||
      proposal.rolloutMetric.trim() === ""
    ))
    .map((proposal) => proposal.id ?? "unknown");

  return {
    ready: missingCategories.length === 0 && weakProposals.length === 0 && items.length >= requiredProposalCategories.length,
    categories: [...categories],
    missingCategories,
    weakProposals,
    proposalCount: items.length
  };
}

function requireProposalCategory(value, source) {
  const category = requireText(value, source, 80);
  if (!requiredProposalCategories.includes(category)) {
    throw new Error(`${source}: expected one of ${requiredProposalCategories.join(", ")}.`);
  }
  return category;
}

function requireTargetTools(value, source) {
  const tools = requireArray(value, source).map((item, index) => requireText(item, `${source}[${index}]`, 40));
  const missing = requiredTargetTools.filter((tool) => !tools.includes(tool));
  if (missing.length > 0) {
    throw new Error(`${source}: missing target tool(s): ${missing.join(", ")}.`);
  }
  return requiredTargetTools;
}

function requireEvidenceIds(value, source) {
  const ids = requireArray(value, source).map((item, index) => validateEvidenceId(item, `${source}[${index}]`));
  if (ids.length === 0) {
    throw new Error(`${source}: expected at least one evidence ID.`);
  }
  return ids;
}

function requireExportPlan(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected an export plan object.`);
  }

  rejectUnexpectedFields(value, exportPlanFields, source);

  return {
    claude: requireText(value.claude, `${source}.claude`, 200),
    codex: requireText(value.codex, `${source}.codex`, 200),
    cursor: requireText(value.cursor, `${source}.cursor`, 200),
    chatgpt: requireText(value.chatgpt, `${source}.chatgpt`, 200)
  };
}

function requireTextArray(value, source, maxItems, maxLength) {
  const items = requireArray(value, source);
  if (items.length === 0) {
    throw new Error(`${source}: expected at least one item.`);
  }
  if (items.length > maxItems) {
    throw new Error(`${source}: exceeds ${maxItems} items.`);
  }
  return items.map((item, index) => requireText(item, `${source}[${index}]`, maxLength));
}

function rejectUnexpectedFields(value, allowedFields, source) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${source}: unexpected field "${key}".`);
    }
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
    throw new Error(`${source}: expected "${expected}".`);
  }
  return value;
}

function requireText(value, source, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: expected a non-empty string.`);
  }

  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${source}: exceeds ${maxLength} characters.`);
  }
  return text;
}

function validateSlug(value, source) {
  const text = requireText(value, source, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    throw new Error(`${source}: expected lowercase slug text.`);
  }
  return text;
}

function validateEvidenceId(value, source) {
  const text = requireText(value, source, 160);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(text)) {
    throw new Error(`${source}: expected an evidence ID.`);
  }
  return text;
}

function requireConfidence(value, source) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${source}: expected a number.`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${source}: expected a number from 0 to 1.`);
  }
  return Number(value.toFixed(2));
}

function requirePositiveInteger(value, source) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2400) {
    throw new Error(`${source}: expected a positive integer.`);
  }
  return parsed;
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}
