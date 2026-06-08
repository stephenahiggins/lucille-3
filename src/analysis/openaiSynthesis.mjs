import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";
import { resolveOpenAIModel } from "../config/models.mjs";
import { assessSkillPortfolioReadiness, requiredProposalCategories } from "../skills/proposals.mjs";

const responsesEndpoint = "https://api.openai.com/v1/responses";
const allowedReasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const requiredTargets = ["Claude", "Codex", "Cursor", "ChatGPT"];

export async function synthesizeWithOpenAI(options = {}) {
  const frames = requireArray(options.frames, "frames");
  const day = requireText(options.day, "day");
  const model = requireText(resolveOpenAIModel({
    value: options.model,
    env: options.env
  }), "model");
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort ?? "high");
  const env = options.env ?? process.env;
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when --openai is enabled.");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("OpenAI synthesis requires a fetch implementation.");
  }

  const evidencePackage = buildEvidencePackage({
    day,
    frames,
    activityTimeline: options.activityTimeline ?? null,
    localPatterns: options.localPatterns ?? []
  });
  assertPrivacySafe(evidencePackage, "openaiEvidencePackage");

  const body = buildResponsesRequest({
    day,
    model,
    reasoningEffort,
    evidencePackage
  });
  const evidenceIds = new Set(frames.map((frame) => frame.evidenceId));
  const timelineCommonTasks = Array.isArray(options.activityTimeline?.commonTasks)
    ? options.activityTimeline.commonTasks
    : [];
  let feedback = null;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const requestBody = attempt === 1 ? body : buildResponsesRequest({
      day,
      model,
      reasoningEffort,
      evidencePackage,
      feedback
    });
    assertPrivacySafe(requestBody, "openaiResponsesBody");

    const response = await fetchImpl(responsesEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response?.ok) {
      const status = response?.status ?? "unknown";
      const detail = await readOpenAIErrorDetail(response);
      throw new Error(`OpenAI Responses API request failed with status ${status}${detail ? `: ${detail}` : ""}.`);
    }

    const payload = await response.json();
    const parsed = parseResponseJson(extractOutputText(payload));
    const normalized = normalizeOpenAISynthesis(parsed, { day, evidenceIds, timelineCommonTasks });
    assertPrivacySafe(normalized, "openaiSynthesis");

    const readiness = assessSkillPortfolioReadiness(normalized.proposals);
    if (readiness.ready) {
      return {
        provider: "openai_responses",
        endpoint: responsesEndpoint,
        model,
        reasoningEffort,
        responseId: typeof payload.id === "string" ? payload.id : null,
        rawScreenshotsSent: false,
        evidencePolicy: evidencePackage.privacy.evidencePolicy,
        patterns: normalized.patterns,
        proposals: normalized.proposals
      };
    }

    lastFailure = readiness;
    feedback = [
      "The previous proposal set was not release-ready.",
      `Missing categories: ${readiness.missingCategories.join(", ") || "none"}.`,
      `Weak proposal IDs: ${readiness.weakProposals.join(", ") || "none"}.`,
      `Proposal count: ${readiness.proposalCount}.`,
      "Regenerate the complete JSON with a portfolio that satisfies every required category."
    ].join(" ");
  }

  throw new Error(
    `OpenAI synthesis did not produce a release-ready skill portfolio. ` +
    `Missing categories: ${lastFailure?.missingCategories.join(", ") || "unknown"}.`
  );
}

export function buildEvidencePackage({ day, frames, activityTimeline = null, localPatterns = [] }) {
  const synthesisFrames = activityTimeline
    ? selectRepresentativeFrames(frames, activityTimeline)
    : frames;
  const redactedFrames = synthesisFrames.map((frame) => ({
    evidenceId: frame.evidenceId,
    day: frame.day,
    capturedAt: frame.capturedAt,
    surface: {
      appName: frame.surface.appName,
      windowTitle: frame.surface.windowTitle,
      domain: frame.surface.domain
    },
    applications: Array.isArray(frame.applications)
      ? frame.applications.map((application) => ({
        name: application.name,
        windowTitle: application.windowTitle,
        domain: application.domain,
        isPrimary: application.isPrimary,
        primaryReason: application.primaryReason
      }))
      : [],
    visitedUrls: Array.isArray(frame.visitedUrls) ? frame.visitedUrls : [],
    primaryApplication: frame.primaryApplication ?? null,
    activities: frame.activities,
    visibleIntent: frame.visibleIntent,
    keyTasks: frame.keyTasks,
    evidence: frame.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary
    })),
    riskFlags: frame.riskFlags
  }));

  return {
    schemaVersion: "openai-synthesis-evidence.v1",
    day,
    privacy: {
      evidencePolicy: activityTimeline
        ? "redacted_structured_timeline_and_representative_frame_evidence_only"
        : "redacted_structured_frame_evidence_only",
      rawScreenshotsIncluded: false,
      rawMediaPathsIncluded: false,
      redactions: privacyRedactions()
    },
    frameSelection: activityTimeline
      ? {
        strategy: "timeline_representatives_only",
        sourceFrameCount: frames.length,
        includedFrameCount: redactedFrames.length,
        note: "OpenAI receives local common-task and segment summaries plus representative redacted frame records; full per-frame analysis remains local."
      }
      : {
        strategy: "all_frames_no_timeline_available",
        sourceFrameCount: frames.length,
        includedFrameCount: redactedFrames.length
      },
    frames: redactedFrames,
    activityTimeline: activityTimeline
      ? {
        schemaVersion: activityTimeline.schemaVersion,
        textCapturePolicy: activityTimeline.textCapturePolicy,
        scaleSummary: activityTimeline.scaleSummary,
        commonTasks: activityTimeline.commonTasks.map((task) => ({
          id: task.id,
          title: task.title,
          segmentIds: task.segmentIds,
          segmentCount: task.segmentCount,
          evidenceIds: task.evidenceIds,
          frameCount: task.frameCount,
          firstAt: task.firstAt,
          lastAt: task.lastAt,
          totalDwellTimeSeconds: task.totalDwellTimeSeconds,
          surfaceSwitchCount: task.surfaceSwitchCount,
          userIntent: task.userIntent,
          evidenceNarrative: task.evidenceNarrative,
          evidenceTrail: task.evidenceTrail,
          commonActions: task.commonActions,
          cognitiveHurdles: task.cognitiveHurdles,
          recommendationSeeds: task.recommendationSeeds,
          confidence: task.confidence
        })),
        segments: activityTimeline.segments.map((segment) => ({
          id: segment.id,
          title: segment.title,
          startAt: segment.startAt,
          endAt: segment.endAt,
          dwellTimeSeconds: segment.dwellTimeSeconds,
          evidenceIds: segment.evidenceIds,
          surfaceSwitchCount: segment.surfaceSwitchCount,
          userIntent: segment.userIntent,
          evidenceTrail: segment.evidenceTrail,
          actionsTaken: segment.actionsTaken,
          cognitiveHurdles: segment.cognitiveHurdles,
          recommendationSeeds: segment.recommendationSeeds,
          confidence: segment.confidence
        }))
      }
      : null,
    localPatterns: localPatterns.map((pattern) => ({
      id: pattern.id,
      title: pattern.title,
      summary: pattern.summary,
      repeatedAcrossEvidence: pattern.repeatedAcrossEvidence,
      evidenceCount: pattern.evidenceCount,
      segmentCount: pattern.segmentCount,
      confidence: pattern.confidence,
      signals: pattern.signals
    }))
  };
}

function selectRepresentativeFrames(frames, activityTimeline, limit = 64) {
  const frameById = new Map(frames.map((frame) => [frame.evidenceId, frame]));
  const selectedIds = [];
  const seen = new Set();
  const addId = (id) => {
    if (typeof id !== "string" || seen.has(id) || !frameById.has(id)) return;
    seen.add(id);
    selectedIds.push(id);
  };

  for (const task of activityTimeline.commonTasks ?? []) {
    for (const item of task.evidenceTrail ?? []) addId(item.evidenceId);
  }
  for (const segment of activityTimeline.segments ?? []) {
    addId(segment.evidenceIds?.[0]);
    addId(segment.evidenceIds?.[Math.floor((segment.evidenceIds?.length ?? 1) / 2)]);
    addId(segment.evidenceIds?.[(segment.evidenceIds?.length ?? 1) - 1]);
  }
  for (const task of activityTimeline.commonTasks ?? []) {
    addId(task.evidenceIds?.[0]);
    addId(task.evidenceIds?.[Math.floor((task.evidenceIds?.length ?? 1) / 2)]);
    addId(task.evidenceIds?.[(task.evidenceIds?.length ?? 1) - 1]);
  }

  return selectedIds.slice(0, limit).map((id) => frameById.get(id));
}

function buildResponsesRequest({ day, model, reasoningEffort, evidencePackage, feedback = null }) {
  return {
    model,
    reasoning: {
      effort: reasoningEffort
    },
    instructions: buildSynthesisInstructions({ feedback }),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(buildSynthesisUserPayload({ day, feedback, evidencePackage }))
          }
        ]
      }
    ]
  };
}

function buildSynthesisInstructions({ feedback = null } = {}) {
  return [
    "You are Lucille's senior work-pattern reviewer and AI transformation consultant.",
    "Return one valid JSON object only. Do not return Markdown, comments, prose outside JSON, or tool instructions.",
    "Use only the supplied redacted structured frame, session, local-pattern, and activity timeline evidence.",
    "Never ask for or infer from raw screenshots, hidden monitoring, clipboard contents, audio, keystrokes, raw document bodies, raw message bodies, passwords, cookies, or query-string URLs.",
    "Your job is not to describe screenshots. Your job is to review interconnected frame evidence and decide which repeated workflows genuinely deserve recommendations.",
    "Reason over the whole timeline: compare commonTasks, segments, frame counts, dwell time, surface switches, primary applications, visited URL patterns, commands, cognitive hurdles, and local pattern candidates.",
    "If activityTimeline.commonTasks is supplied, every pattern repeatedAcrossEvidence must exactly equal one activityTimeline.commonTasks evidenceIds array; do not return narrower subsets for patterns.",
    "If activityTimeline.commonTasks is supplied, every proposal evidenceIds array must use IDs from those commonTasks evidenceIds arrays.",
    "Prefer specific repeated workflows over generic app names. A strong pattern should name the workflow, the friction, the likely user outcome, and the evidence trail.",
    "Recommendations must be user-facing and pilotable. Avoid vague actions such as 'summarize evidence' or 'generate a report section' unless the action explains the concrete checklist, shortcut, automation, or skill the user will actually use.",
    "When collaboration apps are visible, treat them as work context unless the evidence clearly shows non-work browsing. Do not label Slack or calendar usage as procrastination by default.",
    "Generate a skill portfolio that fits Lucille's release promise: employees receive tailored weekly AI efficiency reports, and managers can monitor AI transformation opportunities without raw surveillance.",
    `The proposal set must include at least one proposal in every required category: ${requiredProposalCategories.join(", ")}.`,
    "Every proposal must be concrete enough to pilot: owner, rollout metric, expected outcome, prerequisites, estimated weekly minutes saved, at least three implementation steps, evidence IDs, and confidence.",
    "Prefer 2-6 high-signal patterns and 5-10 balanced proposals. If evidence is thin, lower confidence rather than inventing facts.",
    "Only cite evidence IDs that appear in the supplied evidence package.",
    feedback ? `Previous attempt feedback to fix: ${feedback}` : "No previous attempt feedback."
  ].join(" ");
}

function buildSynthesisUserPayload({ day, feedback, evidencePackage }) {
  return {
    task: "Review interconnected frame analysis and produce pattern-backed weekly efficiency recommendations plus a pilotable AI skill portfolio.",
    day,
    modelUse: {
      defaultPurpose: "OpenAI synthesis is used for pattern review, recommendation quality, skill portfolio construction, and enterprise rollout framing.",
      notUsedFor: "Raw image analysis, all-frame replay, keystroke logging, clipboard capture, audio capture, raw message extraction, or hidden monitoring."
    },
    reviewProtocol: [
      "Start from activityTimeline.commonTasks and identify the strongest repeated workflows.",
      "Map every returned pattern onto exactly one commonTasks evidence group so downstream reports can prove the recommendation from the same representative frame evidence.",
      "Map every returned proposal onto one or more commonTasks evidence groups; do not cite isolated frame IDs that are absent from commonTasks evidenceIds.",
      "Cross-check each candidate against sessionAnalysis-style signals present in segments: primary app, URLs, commands, dwell time, switches, and cognitive hurdles.",
      "Use localPatterns as a baseline, but improve or reject them if the timeline evidence supports a better framing.",
      "Write recommendations as practical user actions: checklist, saved workspace, browser shortcut pack, reviewed command runbook, drafting helper, QA workflow, automation queue, or skill.",
      "Make manager/enterprise proposals measurable without exposing raw user content."
    ],
    releasePromise: {
      employee: "Each employee receives a tailored weekly efficiency report explaining practical ways to use AI at work.",
      organisation: "Leaders can monitor AI transformation opportunities, adoption, savings, and rollout readiness across the organisation.",
      privacy: "Use redacted structured evidence only; do not rely on hidden monitoring or raw content."
    },
    commonTaskEvidenceContract: evidencePackage.activityTimeline
      ? {
        patternEvidenceRule: "Each pattern.repeatedAcrossEvidence must exactly match one activityTimeline.commonTasks[*].evidenceIds array.",
        proposalEvidenceRule: "Each proposal.evidenceIds array must contain only IDs present in activityTimeline.commonTasks[*].evidenceIds.",
        reason: "Lucille's MMP report, task-skill summaries, and readiness verifier share commonTasks as the canonical recommendation evidence contract."
      }
      : null,
    feedback,
    requiredOutputShape: {
      patterns: [
        {
          id: "pattern-stable-slug",
          title: "Short workflow pattern title",
          summary: "One evidence-grounded sentence naming the repeated workflow, friction, and outcome.",
          repeatedAcrossEvidence: ["evidence-id"],
          confidence: 0.75,
          signals: ["short visible signal"],
          estimatedMinutesPerWeek: 45,
          recommendation: "Specific user-facing action that can be piloted next week.",
          enterpriseSignal: "Manager-facing adoption, savings, rollout, or governance tracking note."
        }
      ],
      proposals: [
        {
          id: "skill-stable-slug",
          title: "Short skill title",
          category: "employee_weekly_report",
          summary: "One sentence proposal grounded in repeated-work evidence.",
          implementationSteps: [
            "Concrete setup step",
            "Concrete user workflow step",
            "Concrete validation step"
          ],
          expectedOutcome: "Specific practical outcome for the employee or manager.",
          estimatedMinutesPerWeek: 45,
          owner: "Likely accountable role",
          rolloutMetric: "Specific metric the organisation can track.",
          prerequisites: ["Required template, access, export, or policy input"],
          evidenceIds: ["evidence-id"],
          confidence: 0.75
        }
      ]
    },
    evidence: evidencePackage
  };
}

function normalizeOpenAISynthesis(value, { day, evidenceIds, timelineCommonTasks = [] }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI synthesis response must be a JSON object.");
  }

  const patterns = requireArray(value.patterns, "OpenAI synthesis patterns")
    .map((pattern, index) => normalizePattern(pattern, { day, evidenceIds, timelineCommonTasks, index }));
  const proposals = requireArray(value.proposals, "OpenAI synthesis proposals")
    .map((proposal, index) => normalizeProposal(proposal, { day, evidenceIds, timelineCommonTasks, index }));
  const dedupedPatterns = dedupePatternsByEvidence(patterns);

  if (dedupedPatterns.length === 0) {
    throw new Error("OpenAI synthesis response must include at least one pattern.");
  }
  if (proposals.length === 0) {
    throw new Error("OpenAI synthesis response must include at least one skill proposal.");
  }

  return { patterns: dedupedPatterns, proposals };
}

function normalizePattern(pattern, { day, evidenceIds, timelineCommonTasks, index }) {
  const id = optionalId(pattern.id, `pattern-openai-${day}-${index + 1}`);
  const rawEvidence = requireEvidenceIds(pattern.repeatedAcrossEvidence, evidenceIds, `${id}.repeatedAcrossEvidence`);
  const matchedTask = matchCommonTask(pattern, rawEvidence, timelineCommonTasks);
  const repeatedAcrossEvidence = matchedTask?.evidenceIds ?? rawEvidence;

  return {
    id,
    title: requireText(pattern.title, `${id}.title`, 120),
    summary: requireText(pattern.summary, `${id}.summary`, 500),
    repeatedAcrossEvidence,
    evidenceCount: matchedTask?.frameCount ?? (
      Number.isInteger(pattern.evidenceCount) && pattern.evidenceCount > 0
        ? pattern.evidenceCount
        : repeatedAcrossEvidence.length
    ),
    segmentCount: matchedTask?.segmentCount ?? (
      Number.isInteger(pattern.segmentCount) && pattern.segmentCount > 0
        ? pattern.segmentCount
        : 1
    ),
    confidence: normalizeConfidence(pattern.confidence, `${id}.confidence`),
    signals: optionalTextArray(pattern.signals, `${id}.signals`, 8),
    estimatedMinutesPerWeek: optionalPositiveInteger(pattern.estimatedMinutesPerWeek, `${id}.estimatedMinutesPerWeek`, 45),
    recommendation: requireText(
      pattern.recommendation ?? "Review this repeated workflow for templating, summarization, or automation support.",
      `${id}.recommendation`,
      500
    ),
    enterpriseSignal: requireText(
      pattern.enterpriseSignal ?? "This pattern can be tracked as an AI transformation opportunity without exposing raw content.",
      `${id}.enterpriseSignal`,
      300
    ),
    privacyBoundary: "OpenAI synthesis used redacted structured frame evidence only; raw screenshots were not sent."
  };
}

function normalizeProposal(proposal, { day, evidenceIds, timelineCommonTasks, index }) {
  const id = optionalId(proposal.id, `skill-openai-${day}-${index + 1}`);
  const rawEvidence = requireEvidenceIds(proposal.evidenceIds, evidenceIds, `${id}.evidenceIds`);
  const matchedTask = matchCommonTask(proposal, rawEvidence, timelineCommonTasks);
  const proposalEvidenceIds = matchedTask?.evidenceIds ?? rawEvidence;

  return {
    id,
    title: requireText(proposal.title, `${id}.title`, 120),
    status: "proposed",
    category: normalizeCategory(proposal.category, index),
    targetTools: requiredTargets,
    summary: requireText(proposal.summary, `${id}.summary`, 500),
    implementationSteps: normalizeImplementationSteps(proposal.implementationSteps, id),
    expectedOutcome: requireText(
      proposal.expectedOutcome ?? proposal.summary ?? "A concrete reviewable workflow improvement is available for pilot.",
      `${id}.expectedOutcome`,
      500
    ),
    estimatedMinutesPerWeek: optionalPositiveInteger(
      proposal.estimatedMinutesPerWeek,
      `${id}.estimatedMinutesPerWeek`,
      45
    ),
    owner: requireText(proposal.owner ?? "Department workflow owner", `${id}.owner`, 120),
    rolloutMetric: requireText(
      proposal.rolloutMetric ?? "Track accepted AI-assisted outputs and estimated minutes saved per week.",
      `${id}.rolloutMetric`,
      240
    ),
    prerequisites: normalizePrerequisites(proposal.prerequisites, id),
    evidenceIds: proposalEvidenceIds,
    confidence: normalizeConfidence(proposal.confidence, `${id}.confidence`),
    exportPlan: {
      claude: "SKILL.md package not written until approved",
      codex: "Codex SKILL.md package not written until approved",
      cursor: ".cursor/rules/*.mdc not written until approved",
      chatgpt: "instructions/knowledge/actions bundle not written until approved"
    }
  };
}

function matchCommonTask(source, evidenceIds, timelineCommonTasks) {
  if (!Array.isArray(timelineCommonTasks) || timelineCommonTasks.length === 0) return null;
  const candidates = timelineCommonTasks
    .filter((task) => Array.isArray(task.evidenceIds) && task.evidenceIds.length > 0);
  if (candidates.length === 0) return null;

  const preferred = candidates.filter((task) => (task.frameCount ?? task.evidenceIds.length) > 1 || (task.segmentCount ?? 1) > 1);
  const pool = preferred.length > 0 ? preferred : candidates;
  const sourceText = [
    source?.title,
    source?.summary,
    source?.recommendation,
    source?.expectedOutcome,
    source?.category,
    ...(Array.isArray(source?.signals) ? source.signals : [])
  ].filter(Boolean).join(" ").toLowerCase();
  const evidenceSet = new Set(evidenceIds);

  let best = null;
  for (const task of pool) {
    const overlap = task.evidenceIds.filter((id) => evidenceSet.has(id)).length;
    const textScore = commonTaskTextScore(sourceText, task);
    const frameScore = Math.min(5, Math.round((task.frameCount ?? task.evidenceIds.length) / 20));
    const score = overlap * 100 + textScore * 10 + frameScore;
    if (!best || score > best.score) {
      best = { task, score, overlap, textScore };
    }
  }

  if (best && (best.overlap > 0 || best.textScore > 0)) return best.task;
  return pool[0];
}

function commonTaskTextScore(sourceText, task) {
  const taskText = [
    task.title,
    task.userIntent,
    task.evidenceNarrative,
    ...(Array.isArray(task.commonActions) ? task.commonActions : []),
    ...(Array.isArray(task.cognitiveHurdles) ? task.cognitiveHurdles : []),
    ...(Array.isArray(task.recommendationSeeds) ? task.recommendationSeeds : [])
  ].filter(Boolean).join(" ").toLowerCase();

  let score = 0;
  const termGroups = [
    ["attendance", "absence", "student", "pupil", "report", "dashboard", "qa"],
    ["github", "pull request", "pr", "merge", "code", "terminal", "test", "command"],
    ["slack", "teams", "discord", "message", "collaboration", "meeting"],
    ["browser", "url", "web", "documentation", "research"]
  ];

  for (const terms of termGroups) {
    const sourceHits = terms.filter((term) => sourceText.includes(term));
    if (sourceHits.length === 0) continue;
    score += sourceHits.filter((term) => taskText.includes(term)).length;
  }

  return score;
}

function dedupePatternsByEvidence(patterns) {
  const byEvidence = new Map();
  for (const pattern of patterns) {
    const key = pattern.repeatedAcrossEvidence.join("\u0000");
    const existing = byEvidence.get(key);
    if (!existing || pattern.confidence > existing.confidence) {
      byEvidence.set(key, pattern);
    }
  }
  return [...byEvidence.values()];
}

function normalizeCategory(value, index) {
  if (value === undefined || value === null || value === "") {
    return requiredProposalCategories[index % requiredProposalCategories.length];
  }
  const category = requireText(value, "proposal.category", 80);
  if (!requiredProposalCategories.includes(category)) {
    throw new Error(`Invalid proposal category "${category}".`);
  }
  return category;
}

function normalizeImplementationSteps(value, id) {
  const fallback = [
    "Confirm the existing approved process and data fields.",
    "Pilot a review-only AI assistant on the cited workflow.",
    "Measure accepted outputs, exceptions, and estimated minutes saved."
  ];
  return normalizeTextArrayWithFallback(value, `${id}.implementationSteps`, fallback, 8, 240);
}

function normalizePrerequisites(value, id) {
  const fallback = [
    "Approved process owner",
    "Structured evidence fields",
    "Human review before rollout"
  ];
  return normalizeTextArrayWithFallback(value, `${id}.prerequisites`, fallback, 8, 200);
}

function normalizeTextArrayWithFallback(value, location, fallback, maxItems, maxLength) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  const items = value.slice(0, maxItems).map((item, index) => requireText(item, `${location}[${index}]`, maxLength));
  return items.length > 0 ? items : fallback;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }

  if (chunks.length === 0) {
    throw new Error("OpenAI Responses API returned no text output.");
  }

  return chunks.join("\n");
}

function parseResponseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`OpenAI synthesis response was not valid JSON: ${error.message}`);
  }
}

async function readOpenAIErrorDetail(response) {
  if (!response || typeof response.text !== "function") return "";
  try {
    const text = await response.text();
    if (!text) return "";
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error && typeof error === "object") {
      const parts = [
        typeof error.code === "string" ? error.code : null,
        typeof error.type === "string" ? error.type : null,
        typeof error.message === "string" ? error.message : null
      ].filter(Boolean);
      return truncateErrorDetail(parts.join(" - "));
    }
    return truncateErrorDetail(text);
  } catch {
    return "";
  }
}

function truncateErrorDetail(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeReasoningEffort(value) {
  const effort = requireText(value, "reasoningEffort", 20);
  if (!allowedReasoningEfforts.has(effort)) {
    throw new Error(`Invalid reasoning effort "${effort}".`);
  }
  return effort;
}

function requireArray(value, location) {
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value;
}

function requireEvidenceIds(value, allowedEvidenceIds, location) {
  const ids = optionalTextArray(value, location, 40);
  if (ids.length === 0) {
    throw new Error(`${location}: expected at least one evidence ID.`);
  }

  for (const id of ids) {
    if (!allowedEvidenceIds.has(id)) {
      throw new Error(`${location}: unknown evidence ID "${id}".`);
    }
  }

  return ids;
}

function optionalTextArray(value, location, maxItems) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value.slice(0, maxItems).map((item, index) => requireText(item, `${location}[${index}]`, 160));
}

function optionalId(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const id = requireText(value, "id", 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid id "${id}". Expected lowercase slug text.`);
  }
  return id;
}

function requireText(value, location, maxLength = 160) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}: expected a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${location}: exceeds ${maxLength} characters.`);
  }
  return text;
}

function normalizeConfidence(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location}: expected a number.`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${location}: expected a number from 0 to 1.`);
  }
  return Number(value.toFixed(2));
}

function optionalPositiveInteger(value, location, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2400) {
    throw new Error(`${location}: expected a positive integer.`);
  }
  return parsed;
}
