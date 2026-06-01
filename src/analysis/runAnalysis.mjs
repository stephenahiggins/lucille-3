import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadMockObservations } from "./mockProvider.mjs";
import {
  analyseObservationWithOllama,
  isLocalVisualProviderUnavailable
} from "./ollamaProvider.mjs";
import { synthesizeWithOpenAI } from "./openaiSynthesis.mjs";
import { validateObservations } from "./observations.mjs";
import { applyRawMediaLifecycle } from "../capture/rawMediaLifecycle.mjs";
import {
  defaultExcludedApps,
  defaultExcludedDomains,
  observationExclusionReason
} from "../privacy/exclusions.mjs";
import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";

const defaultOptions = {
  model: "moondream:1.8b",
  provider: "auto",
  limit: null,
  offset: 0,
  openai: false,
  openaiModel: "gpt-5.5",
  reasoningEffort: "high",
  deleteRawMedia: false,
  env: process.env,
  fetchImpl: globalThis.fetch,
  root: process.cwd()
};

export async function runAnalysis(options = {}) {
  const config = { ...defaultOptions, ...options };
  const day = validateDay(config.day ?? today());
  const model = validateNonEmpty(config.model, "model");
  const provider = validateProvider(config.provider ?? config.env.LUCILLE_ANALYSIS_PROVIDER ?? "auto");
  const offset = validateNonNegativeInteger(config.offset ?? 0, "offset");
  const limit = config.limit === null || config.limit === undefined || config.limit === ""
    ? null
    : validatePositiveInteger(config.limit, "limit");

  if (config.openai && !config.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when --openai is enabled.");
  }

  const observationSource = loadObservations(config.root, day);
  const structuredObservations = applyObservationChunk(
    validateObservations(observationSource.observations, { day }),
    { offset, limit }
  );
  if (structuredObservations.length === 0) {
    throw new Error(`No observations selected for ${day}; adjust --offset or --limit.`);
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
    source: observationSource.source,
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

  const localWorkPatterns = buildWorkPatterns(frameAnalysis, {
    day,
    model,
    provider: localProvider,
    openai: config.openai,
    openaiModel: config.openaiModel,
    reasoningEffort: config.reasoningEffort,
    rawMediaLifecycle
  });

  const openaiSynthesis = config.openai
    ? await synthesizeWithOpenAI({
      frames: frameAnalysis,
      day,
      model: config.openaiModel,
      reasoningEffort: config.reasoningEffort,
      env: config.env,
      fetchImpl: config.fetchImpl,
      localPatterns: localWorkPatterns.patterns
    })
    : null;

  const workPatterns = buildWorkPatterns(frameAnalysis, {
    day,
    model,
    provider: localProvider,
    openai: config.openai,
    openaiModel: config.openaiModel,
    reasoningEffort: config.reasoningEffort,
    rawMediaLifecycle,
    openaiSynthesis
  });
  assertPrivacySafe(workPatterns, "workPatterns");

  const skillProposals = buildSkillProposals(workPatterns, day, openaiSynthesis?.proposals);
  assertPrivacySafe(skillProposals, "skillProposals");

  writeFileSync(
    path.join(analysisDir, "frame-analysis.jsonl"),
    frameAnalysis.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
  );
  writeJson(path.join(analysisDir, "work-patterns.json"), workPatterns);
  writeJson(path.join(analysisDir, "skill-proposals.json"), skillProposals);

  return {
    day,
    analysisDir,
    frameCount: frameAnalysis.length,
    patternCount: workPatterns.patterns.length,
    proposalCount: skillProposals.proposals.length,
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
    return {
      source: "fixture",
      observations: loadMockObservations(root, day)
    };
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
  source,
  fetchImpl,
  ollamaEndpoint
}) {
  if (provider === "mock") {
    return {
      frameAnalysis: observations.map((observation, index) => analyseObservationWithMock(observation, {
        day,
        evidenceNumber: index + 1,
        model
      })),
      localProvider: "mock"
    };
  }

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
    if (provider === "auto" && source !== "capture" && isLocalVisualProviderUnavailable(error)) {
      return {
        frameAnalysis: observations.map((observation, index) => analyseObservationWithMock(observation, {
          day,
          evidenceNumber: index + 1,
          model
        })),
        localProvider: "mock"
      };
    }

    if (provider === "auto" && source === "capture" && isLocalVisualProviderUnavailable(error)) {
      throw new Error(
        `${error.message} Real captured observations require a real local visual provider; ` +
        `start Ollama with model ${model} or pass --provider mock explicitly for fixture-only testing.`
      );
    }

    if (provider === "ollama" && isLocalVisualProviderUnavailable(error)) {
      throw new Error(`${error.message} Use --provider mock for deterministic fixture analysis, or start Ollama with model ${model}.`);
    }

    throw error;
  }
}

function analyseObservationWithMock(observation, context) {
  return {
    schemaVersion: "frame-analysis.v1",
    evidenceId: primaryScreenshotEvidenceId(observation, context),
    frameId: observation.id,
    day: context.day,
    capturedAt: observation.capturedAt,
    provider: "mock",
    model: context.model,
    surface: {
      appName: observation.appName,
      windowTitle: observation.windowTitle,
      domain: observation.domain ?? null
    },
    activities: [observation.activity],
    visibleIntent: summarizeIntent(observation),
    evidence: observation.redactedSignals.map((signal, index) => ({
      id: observation.evidenceIds[index] ?? `${observation.id}-signal-${String(index + 1).padStart(2, "0")}`,
      kind: "redacted_visible_summary",
      summary: signal
    })),
    redactions: privacyRedactions(),
    riskFlags: []
  };
}

function primaryScreenshotEvidenceId(observation, context) {
  return observation.evidenceIds[0] ?? `${observation.id}-raw-frame-${String(context.evidenceNumber).padStart(3, "0")}`;
}

function buildWorkPatterns(frames, context) {
  const evidenceIds = frames.map((frame) => frame.evidenceId);
  const signals = [...new Set(frames.flatMap((frame) => frame.evidence.map((item) => item.summary)))];
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
    patterns: openaiSynthesis?.patterns ?? buildLocalPatterns(frames, signals)
  };
}

function buildLocalPatterns(frames, signals) {
  const evidenceIds = frames.map((frame) => frame.evidenceId);
  const surfaces = [...new Set(frames.map((frame) => frame.surface.appName).filter(Boolean))];
  const activities = [...new Set(frames.flatMap((frame) => frame.activities).filter(Boolean))];
  const normalizedSignals = signals.slice(0, 8);

  return [
    {
      id: `pattern-${slugify(inferPatternTitle(normalizedSignals, surfaces, activities))}`,
      title: inferPatternTitle(normalizedSignals, surfaces, activities),
      summary: inferPatternSummary(normalizedSignals, surfaces),
      repeatedAcrossEvidence: evidenceIds,
      confidence: confidenceFor(frames.length),
      signals: normalizedSignals,
      estimatedMinutesPerWeek: estimateWeeklySavingMinutes(frames.length, normalizedSignals.length),
      recommendation: inferRecommendation(normalizedSignals),
      enterpriseSignal: "Track this as an evidence-backed AI transformation opportunity by measuring repeated manual steps, context switching, accepted AI assistance, and weekly minutes saved.",
      privacyBoundary: "Uses frame summaries and evidence IDs only; no screenshots, keystrokes, clipboard, audio, raw document bodies, or raw message bodies are stored."
    }
  ];
}

function inferPatternTitle(signals, surfaces, activities) {
  const text = `${signals.join(" ")} ${surfaces.join(" ")} ${activities.join(" ")}`.toLowerCase();
  if (text.includes("github") || text.includes("pull request") || text.includes("code")) {
    return "Development review and reporting workflow";
  }
  if (text.includes("attendance")) {
    return "Attendance report review workflow";
  }
  if (text.includes("report")) {
    return "Report building and review workflow";
  }
  if (text.includes("chat") || text.includes("slack") || text.includes("discord")) {
    return "Collaboration and context-switching workflow";
  }
  return "Repeated desktop workflow";
}

function inferPatternSummary(signals, surfaces) {
  const signalText = signals.length > 0 ? signals.join("; ") : "structured frame evidence";
  const surfaceText = surfaces.length > 0 ? ` across ${surfaces.join(", ")}` : "";
  return `The selected frames show a repeated work context${surfaceText}: ${signalText}.`;
}

function inferRecommendation(signals) {
  const text = signals.join(" ").toLowerCase();
  if (text.includes("github") || text.includes("pull request") || text.includes("code")) {
    return "Create an AI-assisted weekly engineering workflow report that summarizes active PR review, team discussion, report testing, and follow-up actions from cited frame evidence.";
  }
  if (text.includes("report")) {
    return "Create an AI-assisted report QA checklist that summarizes visible report-building steps, flags unfinished sections, and proposes next actions for review.";
  }
  return "Create an AI-assisted weekly efficiency note that summarizes the observed repeated workflow, identifies context switching, and proposes one reviewable automation or drafting aid.";
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function buildSkillProposals(workPatterns, day, openaiProposals = null) {
  return {
    schemaVersion: "skill-proposals.v1",
    day,
    proposals: openaiProposals ?? workPatterns.patterns.map((pattern) => buildLocalSkillProposal(pattern))
  };
}

function buildLocalSkillProposal(pattern) {
  const text = `${pattern.title} ${pattern.summary} ${pattern.signals.join(" ")}`.toLowerCase();
  const developmentWorkflow = text.includes("github") || text.includes("pull request") || text.includes("code");
  const reportWorkflow = text.includes("report");
  const attendanceWorkflow = text.includes("attendance") && !developmentWorkflow;
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

  if (developmentWorkflow) {
    return {
      ...base,
      id: "skill-development-review-reporting-assistant",
      title: "Development review reporting assistant",
      category: "employee_weekly_report",
      summary: pattern.recommendation,
      implementationSteps: [
        "Summarize the visible GitHub pull request, team discussion, report page, terminal activity, and open work surfaces from cited evidence.",
        "Generate a weekly engineering workflow note with completed review activity, unresolved follow-ups, and likely context-switching points.",
        "Draft a concise manager-ready update that separates product/report testing, code review, collaboration, and capture-tool work.",
        "Ask the employee to approve or correct each recommendation before any team-level reporting."
      ],
      expectedOutcome: "Engineering and product staff get an evidence-backed weekly efficiency report without inventing non-visible workflows.",
      owner: "Engineer or product owner reviewing the weekly report",
      rolloutMetric: "Accepted weekly recommendations, unresolved PR/report follow-ups closed, and minutes saved from reduced status reconstruction.",
      prerequisites: [
        "Access to redacted frame summaries",
        "Employee review before sharing",
        "Approved reporting categories for engineering and product work"
      ]
    };
  }

  if (attendanceWorkflow) {
    return {
      ...base,
      id: "skill-attendance-report-review-assistant",
      title: "Attendance report review assistant",
      category: "ai_assistance",
      summary: pattern.recommendation,
      implementationSteps: [
        "Summarize the visible attendance report sections and charts from cited evidence.",
        "Generate a review checklist for report completeness, chart interpretation, and next questions.",
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
    };
  }

  return {
    ...base,
    id: `skill-${slugify(pattern.title)}-assistant`,
    title: `${pattern.title} assistant`,
    category: reportWorkflow ? "employee_weekly_report" : "ai_assistance",
    summary: pattern.recommendation,
    implementationSteps: [
      "Summarize the observed workflow from cited evidence only.",
      "Identify repeated manual steps and context switching visible in the frame summaries.",
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
}

function summarizeIntent(observation) {
  return observation.visibleTextSummary;
}

function confidenceFor(frameCount) {
  return Number(Math.min(0.86, 0.62 + frameCount * 0.04).toFixed(2));
}

function estimateWeeklySavingMinutes(frameCount, signalCount) {
  return Math.min(180, Math.max(30, frameCount * 18 + signalCount * 6));
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
  if (!["auto", "mock", "ollama"].includes(provider)) {
    throw new Error(`Invalid provider "${provider}". Expected auto, mock, or ollama.`);
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
