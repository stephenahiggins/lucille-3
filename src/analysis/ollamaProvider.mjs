import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveLocalModel } from "../config/models.mjs";
import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";

const defaultEndpoint = "http://127.0.0.1:11434";
const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

export class LocalVisualProviderUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalVisualProviderUnavailable";
  }
}

export async function analyseObservationWithOllama(options = {}) {
  const root = options.root ?? process.cwd();
  const day = requireDay(options.day);
  const model = requireText(resolveLocalModel({
    value: options.model,
    env: options.env
  }), "model", 120);
  const endpoint = normalizeEndpoint(options.endpoint ?? defaultEndpoint);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new LocalVisualProviderUnavailable("Ollama provider requires a fetch implementation.");
  }

  const observation = options.observation;
  const evidenceNumber = Number(options.evidenceNumber);
  const mediaPath = resolveLocalRawMediaPath({ root, day, observation });
  const imageBase64 = readFileSync(mediaPath, "base64");
  const body = buildOllamaRequest({ model, observation, imageBase64 });

  let response;
  try {
    response = await fetchImpl(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new LocalVisualProviderUnavailable(
      `Ollama provider is unavailable at ${endpoint}: ${error.message}`
    );
  }

  if (!response?.ok) {
    const status = response?.status ?? "unknown";
    throw new LocalVisualProviderUnavailable(
      `Ollama provider request failed with status ${status} for model ${model}.`
    );
  }

  const payload = await response.json();
  const parsed = parseOllamaResponse(payload);
  const frame = normalizeOllamaFrame({
    parsed,
    observation,
    day,
    evidenceNumber,
    model
  });
  assertPrivacySafe(frame, "ollamaFrameAnalysis");
  return frame;
}

export function resolveLocalRawMediaPath({ root, day, observation }) {
  const rawMediaDir = path.resolve(root, "storage", "captures", requireDay(day), "raw-media");
  const frameStem = requireObservationId(observation);

  for (const extension of imageExtensions) {
    const candidate = path.resolve(rawMediaDir, `${frameStem}${extension}`);
    assertInside(rawMediaDir, candidate);
    if (existsSync(candidate)) return candidate;
  }

  throw new LocalVisualProviderUnavailable(
    `No local raw media found for observation ${frameStem} under storage/captures/${day}/raw-media/.`
  );
}

export function isLocalVisualProviderUnavailable(error) {
  return error instanceof LocalVisualProviderUnavailable;
}

function buildOllamaRequest({ model, observation, imageBase64 }) {
  return {
    model,
    stream: false,
    format: "json",
    prompt: [
      "Analyze this locally supplied visible screen frame for Lucille 3.",
      "Return JSON only with keys: activity, visibleIntent, keyTasks, evidenceSummaries, riskFlags.",
      "keyTasks must be 1-6 short task labels that describe what work the user is visibly doing, such as reviewing a report, reconciling evidence, drafting follow-up, troubleshooting command output, or reviewing code.",
      "Use concise redacted summaries that name visible applications, pages, documents, UI state, console output categories, and short bounded visible text snippets.",
      "Prefer evidence summaries that explain the user's likely action, visible intent, unresolved errors, repeated attempts, or review burden.",
      "Do not invent workflows that are not visible. Do not rely on import metadata as visual evidence.",
      "Do not transcribe raw document bodies, raw message bodies, passwords, tokens, cookies, full URLs, clipboard contents, keystrokes, or audio.",
      `Existing safe observation metadata: ${JSON.stringify({
        appName: observation.appName,
        windowTitle: observation.windowTitle,
        domain: observation.domain,
        activity: observation.activity,
        visibleTextSummary: observation.visibleTextSummary,
        redactedSignals: observation.redactedSignals
      })}`
    ].join(" "),
    images: [imageBase64]
  };
}

function parseOllamaResponse(payload) {
  if (typeof payload?.response !== "string" || payload.response.trim() === "") {
    throw new Error("Ollama provider returned no JSON response text.");
  }

  try {
    return JSON.parse(payload.response);
  } catch (error) {
    throw new Error(`Ollama provider response was not valid JSON: ${error.message}`);
  }
}

function normalizeOllamaFrame({ parsed, observation, day, evidenceNumber, model }) {
  const summaries = optionalTextArray(parsed.evidenceSummaries, "evidenceSummaries", 6, 160);
  const safeSummaries = summaries.length > 0 ? summaries : observation.redactedSignals;
  requireGroundedVisualSummaries(safeSummaries, observation.id);
  const keyTasks = optionalTextArray(parsed.keyTasks, "keyTasks", 6, 120);
  const taskContext = [
    parsed.visibleIntent,
    parsed.activity,
    observation.activity,
    observation.visibleTextSummary,
    ...safeSummaries
  ].join(" ");
  const safeKeyTasks = normalizeFrameKeyTasks(keyTasks, taskContext);

  return {
    schemaVersion: "frame-analysis.v1",
    evidenceId: primaryScreenshotEvidenceId(observation, evidenceNumber),
    frameId: observation.id,
    day,
    capturedAt: observation.capturedAt,
    provider: "ollama",
    model,
    surface: {
      appName: observation.appName,
      windowTitle: observation.windowTitle,
      domain: observation.domain ?? null
    },
    activities: [requireText(parsed.activity ?? observation.activity, "activity", 80)],
    visibleIntent: requireText(parsed.visibleIntent ?? observation.visibleTextSummary, "visibleIntent", 500),
    keyTasks: safeKeyTasks,
    evidence: safeSummaries.map((summary, index) => ({
      id: observation.evidenceIds[index] ?? `${observation.id}-local-visual-${String(index + 1).padStart(2, "0")}`,
      kind: "local_visual_summary",
      summary
    })),
    redactions: privacyRedactions(),
    riskFlags: optionalTextArray(parsed.riskFlags, "riskFlags", 8, 120)
  };
}

function inferFrameKeyTasks(text) {
  const normalized = String(text ?? "").toLowerCase();
  const primaryText = normalized.slice(0, 320);
  const tasks = [];
  const primary = primaryContext(primaryText);
  const attendanceDominant = primary === "attendance" || (primary !== "development" && /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(normalized));
  const developmentDominant = primary === "development" || (/\b(github|pull request|\bpr\b|code|diff|repository|cursor|codex|terminal|console|npm|make|test)\b/.test(normalized) && !attendanceDominant);

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

  const uniqueTasks = [...new Set(tasks)].slice(0, 6);
  return uniqueTasks.length > 0 ? uniqueTasks : ["Review a visible work surface"];
}

function normalizeFrameKeyTasks(modelTasks, contextText) {
  const inferred = inferFrameKeyTasks(contextText);
  const normalized = String(contextText ?? "").toLowerCase();
  const primary = primaryContext(normalized.slice(0, 320));
  const attendanceDominant = primary === "attendance" || (primary !== "development" && /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(normalized));
  const developmentDominant = primary === "development";
  const allowed = [];

  for (const task of modelTasks) {
    const lower = task.toLowerCase();
    const looksDevelopment = /\b(code|github|pull request|console|command|terminal|test|debug|error)\b/.test(lower);
    const looksAttendance = /\b(attendance|absence|student|pupil|report)\b/.test(lower);
    if (attendanceDominant && looksDevelopment) continue;
    if (developmentDominant && looksAttendance && !looksDevelopment) continue;
    allowed.push(canonicalTaskLabel(task));
  }

  return [...new Set([...inferred, ...allowed])].slice(0, 6);
}

function primaryContext(text) {
  const attendanceMatch = /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.exec(text);
  const developmentMatch = /\b(debugging|code review|reviewing code|testing code|observations\.mjs|hostname|pull request|terminal|console|npm|make|test)\b/.exec(text);
  if (attendanceMatch && (!developmentMatch || attendanceMatch.index < developmentMatch.index)) return "attendance";
  if (developmentMatch) return "development";
  return "unknown";
}

function canonicalTaskLabel(task) {
  const lower = task.toLowerCase();
  if (/\b(attendance|absence|student|pupil)\b/.test(lower)) return "Review attendance report evidence";
  if (/\b(reconcile|qa|quality|check)\b/.test(lower)) return "Reconcile visible evidence and quality checks";
  if (/\b(email|message|draft|follow-up|slack|chat)\b/.test(lower)) return "Draft or review follow-up communication";
  if (/\b(code|github|pull request|pr|diff)\b/.test(lower)) return "Review engineering work and code context";
  if (/\b(console|command|terminal|test|debug|error|troubleshoot)\b/.test(lower)) return "Inspect command output and troubleshoot blockers";
  if (/\b(report|dashboard|chart|metric|spreadsheet|table)\b/.test(lower)) return "Review report or dashboard state";
  if (/\b(queue|todo|status|next action|checklist)\b/.test(lower)) return "Organize next actions into reusable workflow structure";
  return requireTextWithinLimit(task, "keyTask", 120);
}

function requireGroundedVisualSummaries(summaries, observationId) {
  const genericSummaries = new Set([
    "a visible screen frame was imported from the downloads archive for local lucille analysis.",
    "imported archived visible frame",
    "day-scoped local raw media",
    "structured metadata only before analysis",
    "explicit local capture"
  ]);
  const grounded = summaries.some((summary) => !genericSummaries.has(summary.toLowerCase()));
  if (!grounded) {
    throw new Error(
      `Ollama provider returned only generic import metadata for observation ${observationId}; ` +
      "choose a stronger local vision model or improve the prompt before synthesis."
    );
  }
}

function primaryScreenshotEvidenceId(observation, evidenceNumber) {
  return observation.evidenceIds[0] ?? `${observation.id}-raw-frame-${String(evidenceNumber).padStart(3, "0")}`;
}

function requireObservationId(observation) {
  if (!observation || typeof observation !== "object") {
    throw new LocalVisualProviderUnavailable("Cannot resolve raw media for a missing observation.");
  }
  return requireText(observation.id, "observation.id", 160);
}

function requireDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}

function requireText(value, location, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}: expected a non-empty string.`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > maxLength) {
    throw new Error(`${location}: exceeds ${maxLength} characters.`);
  }
  return text;
}

function optionalTextArray(value, location, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return [requireText(value, location, maxLength)];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const coerced = coerceTextItem(value);
    if (typeof coerced === "string") {
      return [requireText(coerced, location, maxLength)];
    }
    value = Object.values(value);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value
    .slice(0, maxItems)
    .map((item, index) => requireTextWithinLimit(coerceTextItem(item), `${location}[${index}]`, maxLength));
}

function coerceTextItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  for (const key of ["summary", "flag", "text", "label", "description"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return Object.values(item).find((value) => typeof value === "string") ?? item;
}

function requireTextWithinLimit(value, location, maxLength) {
  const text = requireText(value, location, Math.max(maxLength, 2000));
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function normalizeEndpoint(endpoint) {
  const url = new URL(requireText(endpoint, "ollamaEndpoint", 200));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Ollama endpoint must be HTTP or HTTPS.");
  }
  return url.origin;
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("Refusing to read raw media outside the day-scoped capture directory.");
}
