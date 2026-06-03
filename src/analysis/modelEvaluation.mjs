import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildEvidencePackage } from "./openaiSynthesis.mjs";
import { runAnalysis } from "./runAnalysis.mjs";
import { resolveEvaluationBaselineModel, resolveEvaluationModels } from "../config/models.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";

const responsesEndpoint = "https://api.openai.com/v1/responses";

export async function evaluateOpenAIModels(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day ?? today());
  const env = options.env ?? process.env;
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for model evaluation.");
  }

  const models = normalizeModels(resolveEvaluationModels({
    value: options.models,
    env
  }));
  const baselineModel = resolveEvaluationBaselineModel({
    value: options.baselineModel,
    env
  });
  const reasoningEffort = options.reasoningEffort ?? "high";

  await runAnalysis({
    root,
    day,
    provider: "mock",
    model: baselineModel,
    deleteRawMedia: false
  });

  const analysisDir = path.join(root, "storage", "analysis", day);
  const frames = readFrames(path.join(analysisDir, "frame-analysis.jsonl"));
  const evidencePackage = buildEvidencePackage({ day, frames, localPatterns: [] });
  assertPrivacySafe(evidencePackage, "modelEvaluationEvidence");

  const results = [];
  for (const model of models) {
    results.push(await evaluateOneModel({
      model,
      day,
      reasoningEffort,
      apiKey,
      evidencePackage,
      evidenceIds: new Set(frames.map((frame) => frame.evidenceId)),
      fetchImpl: options.fetchImpl ?? globalThis.fetch
    }));
  }

  const artifact = {
    schemaVersion: "model-evaluation.v1",
    day,
    evidencePolicy: evidencePackage.privacy.evidencePolicy,
    rawScreenshotsSent: false,
    evaluatedAt: new Date().toISOString(),
    models: results,
    recommendation: recommendModel(results)
  };
  assertPrivacySafe(artifact, "modelEvaluation");

  mkdirSync(analysisDir, { recursive: true });
  const outputPath = path.join(analysisDir, "model-evaluation.json");
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n");

  return {
    day,
    outputPath: path.relative(root, outputPath),
    models: results,
    recommendation: artifact.recommendation
  };
}

async function evaluateOneModel({ model, day, reasoningEffort, apiKey, evidencePackage, evidenceIds, fetchImpl }) {
  const started = Date.now();
  try {
    const body = buildEvaluationRequest({ model, day, reasoningEffort, evidencePackage });
    assertPrivacySafe(body, `modelEvaluationRequest.${model}`);

    const response = await fetchImpl(responsesEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response?.ok) {
      return failedModelResult(model, `Responses API status ${response?.status ?? "unknown"}`, started);
    }

    const payload = await response.json();
    const normalized = normalizeEvaluation(parseOutputText(payload), { model, evidenceIds });
    const score = scoreEvaluation(normalized, evidenceIds);

    return {
      model,
      ok: true,
      responseId: typeof payload.id === "string" ? payload.id : null,
      elapsedMs: Date.now() - started,
      score,
      readiness: normalized.readiness,
      executiveSummary: normalized.executiveSummary,
      recommendedActions: normalized.recommendedActions,
      risks: normalized.risks
    };
  } catch (error) {
    return failedModelResult(model, error.message, started);
  }
}

function buildEvaluationRequest({ model, day, reasoningEffort, evidencePackage }) {
  return {
    model,
    reasoning: {
      effort: reasoningEffort
    },
    instructions: [
      "You are evaluating whether a model can power Lucille weekly efficiency reports.",
      "Return JSON only.",
      "Use only the supplied redacted structured evidence.",
      "Do not request or infer from screenshots, hidden monitoring, clipboard, audio, keystrokes, raw document bodies, raw message bodies, or full URLs.",
      "The output must be practical for an employee and useful for organisation-level AI transformation monitoring."
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              task: "Produce a weekly efficiency analysis from Lucille evidence.",
              day,
              requiredOutputShape: {
                readiness: 0.8,
                executiveSummary: "One paragraph grounded in the evidence.",
                recommendedActions: [
                  {
                    title: "Action title",
                    why: "Why this helps the employee work more efficiently.",
                    evidenceIds: ["evidence-id"],
                    confidence: 0.8,
                    estimatedMinutesPerWeek: 45,
                    enterpriseMetric: "Adoption or transformation metric for managers."
                  }
                ],
                risks: ["short caveat"]
              },
              evidence: evidencePackage
            })
          }
        ]
      }
    ]
  };
}

function normalizeEvaluation(text, { model, evidenceIds }) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${model}: expected a JSON object.`);
  }

  const recommendedActions = requireArray(value.recommendedActions, `${model}.recommendedActions`)
    .slice(0, 6)
    .map((action, index) => normalizeAction(action, {
      source: `${model}.recommendedActions[${index}]`,
      evidenceIds
    }));

  if (recommendedActions.length === 0) {
    throw new Error(`${model}: expected at least one recommended action.`);
  }

  return {
    readiness: normalizeConfidence(value.readiness, `${model}.readiness`),
    executiveSummary: requireText(value.executiveSummary, `${model}.executiveSummary`, 2000),
    recommendedActions,
    risks: optionalTextArray(value.risks, `${model}.risks`, 6, 500)
  };
}

function normalizeAction(action, { source, evidenceIds }) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error(`${source}: expected an action object.`);
  }
  const citedEvidence = requireArray(action.evidenceIds, `${source}.evidenceIds`)
    .map((id, index) => requireKnownEvidenceId(id, evidenceIds, `${source}.evidenceIds[${index}]`));

  if (citedEvidence.length === 0) {
    throw new Error(`${source}: expected at least one evidence id.`);
  }

  return {
    title: requireText(action.title, `${source}.title`, 120),
    why: requireText(action.why, `${source}.why`, 1500),
    evidenceIds: [...new Set(citedEvidence)],
    confidence: normalizeConfidence(action.confidence, `${source}.confidence`),
    estimatedMinutesPerWeek: requirePositiveInteger(action.estimatedMinutesPerWeek, `${source}.estimatedMinutesPerWeek`),
    enterpriseMetric: requireText(action.enterpriseMetric, `${source}.enterpriseMetric`, 500)
  };
}

function scoreEvaluation(evaluation, evidenceIds) {
  const evidenceCount = evidenceIds.size;
  const cited = new Set(evaluation.recommendedActions.flatMap((action) => action.evidenceIds));
  const evidenceCoverage = evidenceCount === 0 ? 0 : cited.size / evidenceCount;
  const actionability = Math.min(1, evaluation.recommendedActions.length / 3);
  const quantified = evaluation.recommendedActions.filter((action) => action.estimatedMinutesPerWeek > 0).length /
    evaluation.recommendedActions.length;
  const enterprise = evaluation.recommendedActions.filter((action) => action.enterpriseMetric.length >= 12).length /
    evaluation.recommendedActions.length;
  const confidence = evaluation.recommendedActions.reduce((sum, action) => sum + action.confidence, 0) /
    evaluation.recommendedActions.length;

  const total = (
    evaluation.readiness * 0.2 +
    evidenceCoverage * 0.25 +
    actionability * 0.2 +
    quantified * 0.15 +
    enterprise * 0.1 +
    confidence * 0.1
  );

  return {
    total: Number(total.toFixed(2)),
    evidenceCoverage: Number(evidenceCoverage.toFixed(2)),
    actionability: Number(actionability.toFixed(2)),
    quantified: Number(quantified.toFixed(2)),
    enterprise: Number(enterprise.toFixed(2)),
    confidence: Number(confidence.toFixed(2))
  };
}

function recommendModel(results) {
  const viable = results
    .filter((result) => result.ok)
    .sort((a, b) => b.score.total - a.score.total);

  if (viable.length === 0) {
    return {
      model: null,
      rationale: "No evaluated model returned a valid privacy-safe weekly efficiency analysis."
    };
  }

  const best = viable[0];
  return {
    model: best.model,
    score: best.score.total,
    rationale: `${best.model} produced the strongest evidence-grounded weekly efficiency analysis in this run.`
  };
}

function failedModelResult(model, error, started) {
  return {
    model,
    ok: false,
    responseId: null,
    elapsedMs: Date.now() - started,
    score: {
      total: 0,
      evidenceCoverage: 0,
      actionability: 0,
      quantified: 0,
      enterprise: 0,
      confidence: 0
    },
    readiness: 0,
    executiveSummary: "",
    recommendedActions: [],
    risks: [error]
  };
}

function parseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  if (chunks.length === 0) {
    throw new Error("Responses API returned no text output.");
  }
  return chunks.join("\n");
}

function readFrames(filePath) {
  if (!existsSync(filePath)) {
    throw new Error("No baseline frame analysis found for model evaluation.");
  }
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeModels(value) {
  const models = Array.isArray(value) ? value : String(value).split(",");
  const normalized = models.map((model) => requireText(model, "model", 120)).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one model is required.");
  }
  return [...new Set(normalized)];
}

function requireArray(value, location) {
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value;
}

function requireKnownEvidenceId(value, evidenceIds, location) {
  const id = requireText(value, location, 160);
  if (!evidenceIds.has(id)) {
    throw new Error(`${location}: unknown evidence id "${id}".`);
  }
  return id;
}

function optionalTextArray(value, location, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  const items = requireArray(value, location);
  if (items.length > maxItems) {
    throw new Error(`${location}: exceeds ${maxItems} items.`);
  }
  return items.map((item, index) => requireText(item, `${location}[${index}]`, maxLength));
}

function requireText(value, location, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}: expected a non-empty string.`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > maxLength) {
    return text.slice(0, maxLength).trimEnd();
  }
  return text;
}

function normalizeConfidence(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${location}: expected a number from 0 to 1.`);
  }
  return Number(value.toFixed(2));
}

function requirePositiveInteger(value, location) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2400) {
    throw new Error(`${location}: expected a positive integer.`);
  }
  return parsed;
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
