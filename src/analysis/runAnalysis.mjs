import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyseObservationWithOllama,
  isLocalVisualProviderUnavailable
} from "./ollamaProvider.mjs";
import { buildActivityTimeline } from "./activityTimeline.mjs";
import { synthesizeWithOpenAI } from "./openaiSynthesis.mjs";
import { buildTaskSkillSummaryFromArtifacts } from "./taskSkillSummary.mjs";
import { validateObservations } from "./observations.mjs";
import { applyRawMediaLifecycle } from "../capture/rawMediaLifecycle.mjs";
import { resolveLocalModel, resolveOpenAIModel } from "../config/models.mjs";
import {
  defaultExcludedApps,
  defaultExcludedDomains,
  observationExclusionReason
} from "../privacy/exclusions.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";
import { validateSkillProposalSet } from "../skills/proposals.mjs";

const defaultOptions = {
  model: null,
  provider: "auto",
  limit: null,
  offset: 0,
  slides: null,
  openai: false,
  openaiModel: null,
  reasoningEffort: "high",
  deleteRawMedia: false,
  env: process.env,
  fetchImpl: null,
  root: process.cwd()
};

export async function runAnalysis(options = {}) {
  const config = { ...defaultOptions, ...options };
  const day = validateDay(config.day ?? today());
  const model = validateNonEmpty(resolveLocalModel({
    value: config.model,
    env: config.env
  }), "model");
  const provider = validateProvider(config.provider ?? config.env.LUCILLE_ANALYSIS_PROVIDER ?? "auto");
  const offset = validateNonNegativeInteger(config.offset ?? 0, "offset");
  const limit = config.limit === null || config.limit === undefined || config.limit === ""
    ? null
    : validatePositiveInteger(config.limit, "limit");
  const slideIndexes = config.slides === null || config.slides === undefined || config.slides === ""
    ? null
    : parseSlideGroups(config.slides);

  if (slideIndexes && (limit !== null || offset !== 0)) {
    throw new Error("--slides cannot be combined with --limit or --offset.");
  }

  if (config.openai && !config.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when --openai is enabled.");
  }
  const openaiModel = config.openai
    ? validateNonEmpty(resolveOpenAIModel({
      value: config.openaiModel,
      env: config.env
    }), "openaiModel")
    : config.openaiModel
      ? validateNonEmpty(config.openaiModel, "openaiModel")
      : null;

  const observationSource = loadObservations(config.root, day);
  const observations = validateObservations(observationSource.observations, { day });
  const structuredObservations = slideIndexes
    ? selectObservationSlides(observations, slideIndexes, day)
    : applyObservationChunk(observations, { offset, limit });
  if (structuredObservations.length === 0) {
    throw new Error(`No observations selected for ${day}; adjust --slides, --offset, or --limit.`);
  }
  enforceObservationExclusions(structuredObservations, {
    excludedApps: config.excludedApps ?? defaultExcludedApps,
    excludedDomains: config.excludedDomains ?? defaultExcludedDomains
  });
  assertPrivacySafe(structuredObservations, "observations");

  const analysisDir = path.join(config.root, "storage", "analysis", day);
  mkdirSync(analysisDir, { recursive: true });

  const { frameAnalysis, localProvider } = await buildFrameAnalysis({
    observations: structuredObservations,
    root: config.root,
    day,
    model,
    provider,
    fetchImpl: config.fetchImpl,
    ollamaEndpoint: config.ollamaEndpoint ?? config.env.OLLAMA_HOST
  });
  assertPrivacySafe(frameAnalysis, "frameAnalysis");

  const rawMediaLifecycle = applyRawMediaLifecycle({
    root: config.root,
    day,
    deleteRawMedia: config.deleteRawMedia
  });
  assertPrivacySafe(rawMediaLifecycle, "rawMediaLifecycle");

  const activityTimeline = buildActivityTimeline({
    day,
    frames: frameAnalysis
  });
  assertPrivacySafe(activityTimeline, "activityTimeline");

  const localWorkPatterns = buildWorkPatterns(activityTimeline, {
    day,
    model,
    provider: localProvider,
    openai: config.openai,
    openaiModel,
    reasoningEffort: config.reasoningEffort,
    rawMediaLifecycle
  });

  const openaiSynthesis = config.openai
    ? await synthesizeWithOpenAI({
      frames: frameAnalysis,
      activityTimeline,
      day,
      model: openaiModel,
      reasoningEffort: config.reasoningEffort,
      env: config.env,
      fetchImpl: config.fetchImpl,
      localPatterns: localWorkPatterns.patterns
    })
    : null;

  const workPatterns = buildWorkPatterns(activityTimeline, {
    day,
    model,
    provider: localProvider,
    openai: config.openai,
    openaiModel,
    reasoningEffort: config.reasoningEffort,
    rawMediaLifecycle,
    openaiSynthesis
  });
  assertPrivacySafe(workPatterns, "workPatterns");

  const skillProposals = validateSkillProposalSet(
    buildSkillProposals(workPatterns, day, openaiSynthesis?.proposals),
    { day, source: "skillProposals" }
  );
  assertPrivacySafe(skillProposals, "skillProposals");
  const taskSkillSummary = buildTaskSkillSummaryFromArtifacts({
    day,
    activityTimeline,
    proposalSet: skillProposals
  });
  assertPrivacySafe(taskSkillSummary, "taskSkillSummary");

  writeFileSync(
    path.join(analysisDir, "frame-analysis.jsonl"),
    frameAnalysis.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
  );
  writeJson(path.join(analysisDir, "activity-timeline.json"), activityTimeline);
  writeJson(path.join(analysisDir, "work-patterns.json"), workPatterns);
  writeJson(path.join(analysisDir, "skill-proposals.json"), skillProposals);
  writeJson(path.join(analysisDir, "task-skill-summary.json"), taskSkillSummary);

  return {
    day,
    analysisDir,
    frameCount: frameAnalysis.length,
    timelineSegmentCount: activityTimeline.segments.length,
    patternCount: workPatterns.patterns.length,
    proposalCount: skillProposals.proposals.length,
    commonTaskCount: taskSkillSummary.commonTasks.length,
    provider: localProvider,
    rawMediaLifecycle
  };
}

export function readAnalysisSummary(root, day) {
  const analysisDir = path.join(root, "storage", "analysis", validateDay(day));
  const proposalsPath = path.join(analysisDir, "skill-proposals.json");

  if (!existsSync(proposalsPath)) {
    return {
      day,
      exists: false,
      proposals: []
    };
  }

  const proposals = JSON.parse(readFileSync(proposalsPath, "utf8"));
  assertPrivacySafe(proposals, "skillProposals");

  return {
    day,
    exists: true,
    proposals: proposals.proposals
  };
}

function loadObservations(root, day) {
  const captureFile = path.join(root, "storage", "captures", day, "observations.jsonl");

  if (!existsSync(captureFile)) {
    throw new Error(
      `No captured observations found at ${captureFile}. ` +
      "Run make capture or make capture-once for this day before analysis; mock fixture analysis is disabled."
    );
  }

  const rows = readFileSync(captureFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (rows.length === 0) {
    throw new Error(`No structured observations found in ${captureFile}`);
  }

  return {
    source: "capture",
    observations: rows
  };
}

function parseSlideGroups(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new Error("--slides must include at least one slide number or range.");

  const indexes = [];
  const seen = new Set();
  for (const rawGroup of text.split(",")) {
    const group = rawGroup.trim();
    if (group === "") throw new Error(`Invalid --slides group in "${text}".`);
    const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(group);
    if (!match) {
      throw new Error(`Invalid --slides group "${group}". Use 1-based numbers and ranges like 1-3,7,10-12.`);
    }

    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (end < start) {
      throw new Error(`Invalid --slides range "${group}": range end must be greater than or equal to start.`);
    }

    for (let slide = start; slide <= end; slide += 1) {
      const index = slide - 1;
      if (!seen.has(index)) {
        seen.add(index);
        indexes.push(index);
      }
    }
  }

  return indexes;
}

function selectObservationSlides(observations, slideIndexes, day) {
  const selected = [];
  for (const index of slideIndexes) {
    const observation = observations[index];
    if (!observation) {
      throw new Error(
        `Slide ${index + 1} is outside the ${observations.length} observation(s) available for ${day}.`
      );
    }
    selected.push(observation);
  }
  return selected;
}

function enforceObservationExclusions(observations, { excludedApps, excludedDomains }) {
  for (const observation of observations) {
    const reason = observationExclusionReason({
      appName: observation.appName,
      domain: observation.domain,
      excludedApps,
      excludedDomains
    });

    if (reason) {
      throw new Error(
        `Refusing to analyse excluded observation ${observation.id}: ${reason}. ` +
        "Remove the observation or update the explicit exclusion policy."
      );
    }
  }
}

async function buildFrameAnalysis({
  observations,
  root,
  day,
  model,
  provider,
  fetchImpl,
  ollamaEndpoint
}) {
  try {
    const frameAnalysis = [];
    for (const [index, observation] of observations.entries()) {
      frameAnalysis.push(await analyseObservationWithOllama({
        root,
        day,
        observation,
        evidenceNumber: index + 1,
        model,
        fetchImpl,
        endpoint: ollamaEndpoint
      }));
    }

    return {
      frameAnalysis,
      localProvider: "ollama"
    };
  } catch (error) {
    if (provider === "auto" && isLocalVisualProviderUnavailable(error)) {
      throw new Error(
        `${error.message} Real captured observations require a real local visual provider; ` +
        `start Ollama with model ${model}. Mock fixture analysis is disabled.`
      );
    }

    if (provider === "ollama" && isLocalVisualProviderUnavailable(error)) {
      throw new Error(`${error.message} Start Ollama with model ${model}. Mock fixture analysis is disabled.`);
    }

    throw error;
  }
}

function buildWorkPatterns(activityTimeline, context) {
  const openaiSynthesis = context.openaiSynthesis ?? null;

  return {
    schemaVersion: "work-patterns.v1",
    day: context.day,
    provider: openaiSynthesis ? openaiSynthesis.provider : context.provider,
    model: openaiSynthesis ? openaiSynthesis.model : context.model,
    synthesis: {
      localOnly: !openaiSynthesis,
      openaiRequested: Boolean(context.openai),
      openaiModel: context.openai ? context.openaiModel : null,
      reasoningEffort: context.openai ? context.reasoningEffort : null,
      openai: openaiSynthesis
        ? {
          provider: openaiSynthesis.provider,
          endpoint: openaiSynthesis.endpoint,
          responseId: openaiSynthesis.responseId
        }
        : null,
      rawScreenshotsSent: false,
      evidencePolicy: openaiSynthesis?.evidencePolicy ?? "redacted_structured_evidence_only",
      rawMediaLifecycle: context.rawMediaLifecycle
    },
    patterns: openaiSynthesis?.patterns ?? buildLocalPatternsFromTimeline(activityTimeline)
  };
}

function buildLocalPatternsFromTimeline(activityTimeline) {
  const tasks = [...activityTimeline.commonTasks].sort((left, right) => (
    taskFrictionScore(right) - taskFrictionScore(left)
  ));
  const usedIds = new Set();

  return tasks.slice(0, 5).map((task) => {
    const id = uniquePatternId(task.title, usedIds);
    const signals = unique([
      ...task.cognitiveHurdles,
      ...task.commonActions,
      ...task.recommendationSeeds
    ]).slice(0, 12);

    return {
      id,
      title: task.title,
      summary: inferPatternSummaryFromTask(task),
      repeatedAcrossEvidence: task.evidenceIds,
      evidenceCount: task.frameCount,
      segmentCount: task.segmentCount,
      confidence: task.confidence,
      signals,
      estimatedMinutesPerWeek: estimateWeeklySavingMinutesFromTask(task),
      recommendation: inferRecommendationFromTask(task),
      enterpriseSignal: truncateText(
        `Track this common task as an evidence-backed AI transformation opportunity by measuring total dwell time (${task.totalDwellTimeSeconds} seconds), repeated segments (${task.segmentCount}), surface switches (${task.surfaceSwitchCount}), accepted recommendations, and weekly minutes saved.`,
        400
      ),
      privacyBoundary: "Uses common task clusters, activity timeline segments, evidence IDs, and bounded visible text snippets only; no screenshots, hidden input capture, clipboard, audio, raw document bodies, or raw message bodies are stored."
    };
  });
}

function uniquePatternId(title, usedIds) {
  const base = `pattern-${slugify(title)}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function taskFrictionScore(task) {
  return (
    task.totalDwellTimeSeconds +
    task.surfaceSwitchCount * 60 +
    task.cognitiveHurdles.length * 45 +
    task.segmentCount * 30 +
    task.frameCount * 10
  );
}

function inferPatternSummaryFromTask(task) {
  const hurdle = task.cognitiveHurdles[0] ?? "the work needs clearer next steps";
  return truncateText(
    `Lucille clustered ${task.frameCount} screenshot-backed frame(s) across ${task.segmentCount} timeline segment(s) into one repeated task: ${task.userIntent} The main cognitive hurdle is that ${hurdle.toLowerCase()}.`,
    500
  );
}

function inferRecommendationFromTask(task) {
  const seed = task.recommendationSeeds[0] ?? "Generate a reviewable AI assistance experiment for this workflow";
  const hurdle = task.cognitiveHurdles[0] ?? "the next action is not obvious from scattered work surfaces";
  return truncateText(
    `${seed}. Focus the recommendation on overcoming this repeated-task hurdle: ${hurdle.toLowerCase()}. Cite ${task.evidenceIds.join(", ")} so the employee can approve or correct the interpretation.`,
    600
  );
}

function estimateWeeklySavingMinutesFromTask(task) {
  const dwellEstimate = Math.round(task.totalDwellTimeSeconds / 4);
  const switchEstimate = task.surfaceSwitchCount * 12;
  const hurdleEstimate = task.cognitiveHurdles.length * 10;
  const repetitionEstimate = Math.max(0, task.segmentCount - 1) * 18;
  return Math.min(300, Math.max(30, dwellEstimate + switchEstimate + hurdleEstimate + repetitionEstimate));
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function truncateText(text, maxLength) {
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + "." : text;
}

function buildSkillProposals(workPatterns, day, openaiProposals = null) {
  const proposals = openaiProposals ?? [
    ...workPatterns.patterns.flatMap((pattern) => buildLocalSkillProposals(pattern)),
    ...buildPortfolioSkillProposals(workPatterns.patterns)
  ];
  return {
    schemaVersion: "skill-proposals.v1",
    day,
    proposals: ensureUniqueProposalIds(proposals)
  };
}

function buildPortfolioSkillProposals(patterns) {
  if (patterns.length === 0) return [];
  const evidenceIds = unique(patterns.flatMap((pattern) => pattern.repeatedAcrossEvidence));
  const totalMinutes = patterns.reduce((sum, pattern) => sum + pattern.estimatedMinutesPerWeek, 0);
  const totalEvidenceCount = patterns.reduce((sum, pattern) => sum + (pattern.evidenceCount ?? pattern.repeatedAcrossEvidence.length), 0);
  const averageConfidence = Number((patterns.reduce((sum, pattern) => sum + pattern.confidence, 0) / patterns.length).toFixed(2));
  const topPatterns = patterns.slice(0, 3);
  const evidenceSummary = formatEvidenceList(evidenceIds);
  const patternSummary = topPatterns.map((pattern) => pattern.title).join("; ");
  const hurdleSummary = unique(patterns.flatMap((pattern) => pattern.signals))
    .filter((signal) => /hurdle|dwell|burden|switch|blocked|unresolved|manual|reconciliation|command|sensitive|connecting/i.test(signal))
    .slice(0, 4)
    .join("; ") || "repeated work needs clearer ownership, status, and AI assistance choices";
  const base = {
    status: "proposed",
    targetTools: ["Claude", "Codex", "Cursor", "ChatGPT"],
    estimatedMinutesPerWeek: Math.max(30, Math.round(totalMinutes / Math.max(1, patterns.length))),
    evidenceIds,
    confidence: averageConfidence,
    exportPlan: {
      claude: "SKILL.md package not written until approved",
      codex: "Codex SKILL.md package not written until approved",
      cursor: ".cursor/rules/*.mdc not written until approved",
      chatgpt: "instructions/knowledge/actions bundle not written until approved"
    }
  };

  return [
    {
      ...base,
      id: "skill-ai-transformation-manager-dashboard",
      title: "AI transformation manager dashboard",
      category: "manager_monitoring",
      summary: truncateText(`Give managers a weekly view of ${totalEvidenceCount} repeated-task frame(s), represented by ${evidenceSummary}, showing where AI skills could reduce friction without exposing raw screenshots.`, 500),
      implementationSteps: [
        `Roll up common tasks (${patternSummary}) into manager-visible categories with evidence counts, confidence, estimated minutes, and owner.`,
        `Highlight the top cognitive hurdles: ${truncateText(hurdleSummary, 180)}.`,
        "Track accepted, corrected, rejected, and pending skill recommendations by team and week.",
        "Show privacy status for each cluster: redacted structured evidence only, employee review required, no hidden input capture.",
        "Escalate only aggregate opportunity metrics unless the employee approves a specific recommendation for sharing."
      ],
      expectedOutcome: "Managers can monitor AI transformation opportunities across repeated work while keeping employee-level evidence reviewable and privacy-bounded.",
      owner: "Team manager or transformation lead",
      rolloutMetric: "Common tasks reviewed, recommendations accepted, estimated minutes saved, and team-level rollout blockers cleared.",
      prerequisites: [
        "Approved team reporting policy",
        "Employee review workflow for recommendations",
        "Common task categories mapped to teams or functions"
      ]
    },
    {
      ...base,
      id: "skill-enterprise-ai-rollout-readiness",
      title: "Enterprise AI rollout readiness",
      category: "enterprise_rollout",
      summary: truncateText(`Turn ${totalEvidenceCount} repeated-task frame(s), represented by ${evidenceSummary}, into an enterprise rollout backlog that prioritizes high-confidence skills, governance needs, and measurable weekly savings.`, 500),
      implementationSteps: [
        "Group repeated-task clusters into enterprise rollout themes such as reporting, workflow queues, drafting, troubleshooting, and quality review.",
        "Score each theme by evidence count, confidence, estimated weekly minutes saved, privacy sensitivity, and manager readiness.",
        "Define rollout stages: pilot, employee-reviewed, manager-monitored, policy-approved, and scaled.",
        "Create a governance checklist for approved tools, redaction boundaries, review ownership, and success metrics.",
        "Publish a weekly transformation summary that separates employee assistance, manager monitoring, and enterprise rollout decisions."
      ],
      expectedOutcome: "Leadership gets a practical AI transformation backlog grounded in repeated work evidence rather than consultant-style speculation.",
      owner: "AI transformation owner",
      rolloutMetric: "Pilot skills launched, teams onboarded, governance checks completed, and cumulative minutes saved per week.",
      prerequisites: [
        "Named enterprise transformation owner",
        "Approved AI tool policy",
        "Manager dashboard categories and privacy review gates"
      ]
    }
  ];
}

function buildLocalSkillProposals(pattern) {
  const text = `${pattern.title} ${pattern.summary} ${pattern.signals.join(" ")}`.toLowerCase();
  const titleText = pattern.title.toLowerCase();
  const attendanceWorkflow = titleText.includes("attendance") || (text.includes("attendance") && !/\b(github|pull request|code|terminal|console)\b/.test(titleText));
  const developmentWorkflow = !attendanceWorkflow && (text.includes("github") || text.includes("pull request") || text.includes("code"));
  const reportWorkflow = text.includes("report");
  const cognitiveHurdle = truncateText(inferCognitiveHurdleForProposal(pattern), 150);
  const timelineEvidence = formatEvidenceList(pattern.repeatedAcrossEvidence);
  const slug = developmentWorkflow
    ? "development-review-reporting"
    : attendanceWorkflow
      ? "attendance-report-review"
      : slugify(pattern.title);
  const base = {
    status: "proposed",
    targetTools: ["Claude", "Codex", "Cursor", "ChatGPT"],
    estimatedMinutesPerWeek: pattern.estimatedMinutesPerWeek ?? 45,
    evidenceIds: pattern.repeatedAcrossEvidence,
    confidence: pattern.confidence,
    exportPlan: {
      claude: "SKILL.md package not written until approved",
      codex: "Codex SKILL.md package not written until approved",
      cursor: ".cursor/rules/*.mdc not written until approved",
      chatgpt: "instructions/knowledge/actions bundle not written until approved"
    }
  };

  const reportProposal = developmentWorkflow
    ? {
      ...base,
      id: "skill-development-review-reporting-assistant",
      title: "Development review reporting assistant",
      category: "employee_weekly_report",
      summary: truncateText(pattern.recommendation, 500),
      implementationSteps: [
        `Summarize repeated-task evidence ${timelineEvidence}: dwell time, visible engineering surfaces, actions, and intent.`,
        `Name the cognitive hurdle to overcome: ${cognitiveHurdle}.`,
        "Generate a weekly engineering workflow note with completed review activity, unresolved follow-ups, and likely context-switching points.",
        "Draft a concise manager-ready update that separates product/report testing, code review, collaboration, and capture-tool work.",
        "Ask the employee to approve or correct each recommendation before any team-level reporting."
      ],
      expectedOutcome: "Engineering and product staff get an evidence-backed weekly efficiency report that explains the visible hurdle and next AI-assisted action.",
      owner: "Engineer or product owner reviewing the weekly report",
      rolloutMetric: "Accepted weekly recommendations, unresolved PR/report follow-ups closed, and minutes saved from reduced status reconstruction.",
      prerequisites: [
        "Access to redacted frame summaries",
        "Employee review before sharing",
        "Approved reporting categories for engineering and product work"
      ]
    }
    : attendanceWorkflow
      ? {
      ...base,
      id: "skill-attendance-report-review-assistant",
      title: "Attendance report review assistant",
      category: "employee_weekly_report",
      summary: truncateText(pattern.recommendation, 500),
      implementationSteps: [
        `Summarize repeated-task evidence ${timelineEvidence}: report review, follow-up drafting, reconciliation, and dwell time.`,
        `Name the cognitive hurdle to overcome: ${cognitiveHurdle}.`,
        "Generate a review checklist for report completeness, chart interpretation, follow-up questions, and reconciliation checks.",
        "Draft follow-up notes for the report owner without transcribing raw student data.",
        "Require human approval before using any generated message or report update."
      ],
      expectedOutcome: "Report owners spend less time reconstructing the current report state while keeping sensitive student data out of generated artifacts.",
      owner: "Report owner",
      rolloutMetric: "Report QA checks completed, accepted checklist items, and minutes saved per review cycle.",
      prerequisites: [
        "Approved report QA checklist",
        "Redacted structured frame summaries",
        "Named report reviewer"
      ]
      }
      : {
    ...base,
    id: `skill-${slugify(pattern.title)}-assistant`,
    title: `${pattern.title} assistant`,
    category: reportWorkflow ? "employee_weekly_report" : "ai_assistance",
    summary: truncateText(pattern.recommendation, 500),
    implementationSteps: [
      `Summarize repeated-task evidence ${timelineEvidence}: intent, actions, dwell time, and friction signals.`,
      `Name the cognitive hurdle to overcome: ${cognitiveHurdle}.`,
      "Identify repeated manual steps and context switching visible in the timeline.",
      "Propose one reviewable AI assistance experiment for the next week.",
      "Record employee approval, corrections, and estimated minutes saved."
    ],
    expectedOutcome: "The employee receives a grounded weekly efficiency recommendation tied to the actual observed workflow.",
    owner: "Employee and line manager",
    rolloutMetric: "Accepted recommendation count, corrected recommendation count, and estimated minutes saved.",
    prerequisites: [
      "Redacted structured frame summaries",
      "Employee review process",
      "Approved reporting categories"
    ]
  };

  const automationProposal = {
    ...base,
    id: `skill-${slug}-workflow-queue`,
    title: `${reportProposal.title.replace(/ assistant$/i, "")} workflow queue`,
    category: "workflow_automation",
    summary: truncateText(`Create a small review queue for the repeated task cited by ${timelineEvidence} so the user can overcome this hurdle: ${cognitiveHurdle.toLowerCase()}.`, 500),
    implementationSteps: [
      "Define queue fields for common task ID, segment IDs, evidence IDs, work surface, next action, owner, status, blocker, and due date.",
      "Generate queue entries from repeated-task actions and ask the employee to approve or edit each one.",
      "Group approved entries into review, communication, report QA, and engineering follow-up lanes.",
      "Export the queue as a weekly action list that keeps the cited cognitive hurdle visible until resolved."
    ],
    expectedOutcome: "Repeated work moves from scattered context into a reviewed action queue with clear owners and statuses.",
    owner: reportProposal.owner,
    rolloutMetric: "Approved queue entries, follow-ups closed, blockers removed, and minutes saved from status reconstruction.",
    prerequisites: [
      "Approved queue fields",
      "Employee review before sharing",
      "A lightweight place to store weekly action status"
    ]
  };

  const assistanceProposal = {
    ...base,
    id: `skill-${slug}-drafting-assistant`,
    title: `${reportProposal.title.replace(/ assistant$/i, "")} drafting assistant`,
    category: "ai_assistance",
    summary: truncateText(`Draft review-only notes, status updates, and next-step prompts from repeated-task evidence ${timelineEvidence}, focused on the hurdle: ${cognitiveHurdle.toLowerCase()}.`, 500),
    implementationSteps: [
      "Turn each common action and recommendation seed into a short draft status note.",
      "Ask the user to choose the audience: self, manager, teammate, or project channel.",
      "Generate a concise draft with open questions, next actions, and confidence limits.",
      "Require human review before sending or saving the draft."
    ],
    expectedOutcome: "The employee spends less time writing routine updates while keeping all generated text review-only.",
    owner: reportProposal.owner,
    rolloutMetric: "Drafts accepted, drafts edited, follow-up messages sent, and minutes saved per week.",
    prerequisites: [
      "Approved tone and audience rules",
      "Employee review before sending",
      "Evidence summaries for the current week"
    ]
  };

  return [reportProposal, automationProposal, assistanceProposal];
}

function inferCognitiveHurdleForProposal(pattern) {
  return pattern.signals.find((signal) => (
    /hurdle|dwell|burden|switch|blocked|unresolved|manual|reconciliation|command|sensitive|connecting/i.test(signal)
  )) ?? "the user has to reconstruct intent, status, and next actions from scattered visible work";
}

function formatEvidenceList(evidenceIds) {
  if (evidenceIds.length <= 2) return evidenceIds.join(", ");
  return `${evidenceIds.slice(0, 2).join(", ")}, +${evidenceIds.length - 2} more`;
}

function ensureUniqueProposalIds(proposals) {
  const used = new Set();
  return proposals.map((proposal) => {
    if (!used.has(proposal.id)) {
      used.add(proposal.id);
      return proposal;
    }

    let suffix = 2;
    let candidate = truncateSlug(`${proposal.id}-${suffix}`, 120);
    while (used.has(candidate)) {
      suffix += 1;
      candidate = truncateSlug(`${proposal.id}-${suffix}`, 120);
    }
    used.add(candidate);
    return {
      ...proposal,
      id: candidate
    };
  });
}

function truncateSlug(value, maxLength) {
  const text = value.slice(0, maxLength).replace(/-+$/g, "");
  return text || "proposal";
}

function summarizeIntent(observation) {
  return observation.visibleTextSummary;
}

function inferFrameKeyTasks(text) {
  const normalized = String(text ?? "").toLowerCase();
  const tasks = [];
  const attendanceDominant = /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(normalized);
  const developmentDominant = /\b(github|pull request|\bpr\b|code|diff|repository|cursor|codex|terminal|console|npm|make|test)\b/.test(normalized) && !attendanceDominant;

  if (attendanceDominant) {
    tasks.push("Review attendance report evidence");
  }
  if (/\b(reconcile|reconciliation|check|qa|manual|review)\b/.test(normalized)) {
    tasks.push("Reconcile visible evidence and quality checks");
  }
  if (/\b(email|message|draft|follow-up|communication|slack|teams|chat)\b/.test(normalized)) {
    tasks.push("Draft or review follow-up communication");
  }
  if (developmentDominant) {
    tasks.push("Review engineering work and code context");
  }
  if (developmentDominant && /\b(terminal|console|command|npm|make|test|build|error|failed|exception)\b/.test(normalized)) {
    tasks.push("Inspect command output and troubleshoot blockers");
  }
  if (!developmentDominant && /\b(report|dashboard|chart|metric|spreadsheet|table|export)\b/.test(normalized)) {
    tasks.push("Review report or dashboard state");
  }
  if (/\b(template|checklist|queue|todo|next action|status)\b/.test(normalized)) {
    tasks.push("Organize next actions into reusable workflow structure");
  }

  const uniqueTasks = unique(tasks).slice(0, 6);
  return uniqueTasks.length > 0 ? uniqueTasks : ["Review a visible work surface"];
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}

function validateNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${name}: expected a non-empty string.`);
  }
  return value.trim();
}

function validateProvider(value) {
  const provider = validateNonEmpty(value, "provider");
  if (!["auto", "ollama"].includes(provider)) {
    throw new Error(`Invalid provider "${provider}". Expected auto or ollama. Mock fixture analysis is disabled.`);
  }
  return provider;
}

function applyObservationChunk(observations, { offset, limit }) {
  return observations.slice(offset, limit === null ? undefined : offset + limit);
}

function validateNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function validatePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}
