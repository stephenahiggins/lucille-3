import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";
import { assessSkillPortfolioReadiness, requiredProposalCategories } from "../skills/proposals.mjs";

const responsesEndpoint = "https://api.openai.com/v1/responses";
const allowedReasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const requiredTargets = ["Claude", "Codex", "Cursor", "ChatGPT"];

export async function synthesizeWithOpenAI(options = {}) {
  const frames = requireArray(options.frames, "frames");
  const day = requireText(options.day, "day");
  const model = requireText(options.model ?? "gpt-5.5", "model");
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
      throw new Error(`OpenAI Responses API request failed with status ${status}.`);
    }

    const payload = await response.json();
    const parsed = parseResponseJson(extractOutputText(payload));
    const normalized = normalizeOpenAISynthesis(parsed, { day, evidenceIds });
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

export function buildEvidencePackage({ day, frames, localPatterns = [] }) {
  const redactedFrames = frames.map((frame) => ({
    evidenceId: frame.evidenceId,
    day: frame.day,
    capturedAt: frame.capturedAt,
    surface: {
      appName: frame.surface.appName,
      windowTitle: frame.surface.windowTitle,
      domain: frame.surface.domain
    },
    activities: frame.activities,
    visibleIntent: frame.visibleIntent,
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
      evidencePolicy: "redacted_structured_frame_evidence_only",
      rawScreenshotsIncluded: false,
      rawMediaPathsIncluded: false,
      redactions: privacyRedactions()
    },
    frames: redactedFrames,
    localPatterns: localPatterns.map((pattern) => ({
      id: pattern.id,
      title: pattern.title,
      summary: pattern.summary,
      repeatedAcrossEvidence: pattern.repeatedAcrossEvidence,
      confidence: pattern.confidence,
      signals: pattern.signals
    }))
  };
}

function buildResponsesRequest({ day, model, reasoningEffort, evidencePackage, feedback = null }) {
  return {
    model,
    reasoning: {
      effort: reasoningEffort
    },
    instructions: [
      "You synthesize Lucille 3 work-pattern evidence.",
      "Return JSON only.",
      "Use only the supplied redacted structured frame evidence.",
      "Do not ask for or infer from screenshots, hidden monitoring, clipboard, audio, keystrokes, raw document bodies, or raw message bodies.",
      "Analyze the evidence as Lucille, an AI-powered digital transformation consultant for weekly employee efficiency reports.",
      "Generate a minimum marketable product skill portfolio that matches this release promise: employees receive weekly tailored AI efficiency reports, and managers can monitor AI transformation across the organisation.",
      `The proposal set must include at least one proposal in every category: ${requiredProposalCategories.join(", ")}.`,
      "Each proposal must be concrete enough to pilot: named owner, rollout metric, estimated weekly minutes saved, prerequisites, and three or more implementation steps.",
      "Every pattern and proposal must cite evidence IDs and confidence."
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              task: "Identify repeated administrative work patterns and produce weekly efficiency recommendations for AI transformation.",
              day,
              releasePromise: {
                employee: "Each employee receives a tailored weekly efficiency report explaining practical ways to use AI at work.",
                organisation: "Leaders can monitor AI transformation opportunities, adoption, savings, and rollout readiness across the organisation.",
                privacy: "Use redacted structured evidence only; do not rely on hidden monitoring or raw content."
              },
              feedback,
              requiredOutputShape: {
                patterns: [
                  {
                    id: "pattern-stable-slug",
                    title: "Short pattern title",
                    summary: "One sentence grounded in evidence.",
                    repeatedAcrossEvidence: ["evidence-id"],
                    confidence: 0.75,
                    signals: ["short visible signal"],
                    estimatedMinutesPerWeek: 45,
                    recommendation: "Practical user-facing AI assistance recommendation.",
                    enterpriseSignal: "Manager-facing adoption or transformation tracking note."
                  }
                ],
                proposals: [
                  {
                    id: "skill-stable-slug",
                    title: "Short skill title",
                    category: "employee_weekly_report",
                    summary: "One sentence proposal.",
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
            })
          }
        ]
      }
    ]
  };
}

function normalizeOpenAISynthesis(value, { day, evidenceIds }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI synthesis response must be a JSON object.");
  }

  const patterns = requireArray(value.patterns, "OpenAI synthesis patterns")
    .map((pattern, index) => normalizePattern(pattern, { day, evidenceIds, index }));
  const proposals = requireArray(value.proposals, "OpenAI synthesis proposals")
    .map((proposal, index) => normalizeProposal(proposal, { day, evidenceIds, index }));

  if (patterns.length === 0) {
    throw new Error("OpenAI synthesis response must include at least one pattern.");
  }
  if (proposals.length === 0) {
    throw new Error("OpenAI synthesis response must include at least one skill proposal.");
  }

  return { patterns, proposals };
}

function normalizePattern(pattern, { day, evidenceIds, index }) {
  const id = optionalId(pattern.id, `pattern-openai-${day}-${index + 1}`);
  const repeatedAcrossEvidence = requireEvidenceIds(pattern.repeatedAcrossEvidence, evidenceIds, `${id}.repeatedAcrossEvidence`);

  return {
    id,
    title: requireText(pattern.title, `${id}.title`, 120),
    summary: requireText(pattern.summary, `${id}.summary`, 500),
    repeatedAcrossEvidence,
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

function normalizeProposal(proposal, { day, evidenceIds, index }) {
  const id = optionalId(proposal.id, `skill-openai-${day}-${index + 1}`);
  const proposalEvidenceIds = requireEvidenceIds(proposal.evidenceIds, evidenceIds, `${id}.evidenceIds`);

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
