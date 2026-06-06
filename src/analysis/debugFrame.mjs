import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  analyseObservationWithOllama,
  buildOllamaPrompt,
  resolveLocalRawMediaPath
} from "./ollamaProvider.mjs";
import { validateObservations } from "./observations.mjs";
import { resolveLocalModel } from "../config/models.mjs";
import {
  defaultExcludedApps,
  defaultExcludedDomains,
  observationExclusionReason
} from "../privacy/exclusions.mjs";
import { assertPrivacySafe } from "../privacy/safety.mjs";

export async function debugFrameAnalysis(options = {}) {
  const root = options.root ?? process.cwd();
  const day = requireDay(options.day ?? today());
  const model = requireText(resolveLocalModel({
    value: options.model,
    env: options.env
  }), "model", 120);
  const observations = loadCaptureObservations({ root, day });
  const selected = selectObservation(observations, {
    frameId: options.frameId,
    offset: options.offset ?? 0
  });

  enforceObservationExclusion(selected.observation, {
    excludedApps: options.excludedApps ?? defaultExcludedApps,
    excludedDomains: options.excludedDomains ?? defaultExcludedDomains
  });

  const mediaPath = resolveLocalRawMediaPath({
    root,
    day,
    observation: selected.observation
  });
  const prompt = buildOllamaPrompt({ observation: selected.observation });
  const frame = await analyseObservationWithOllama({
    root,
    day,
    observation: selected.observation,
    evidenceNumber: selected.index + 1,
    model,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    endpoint: options.ollamaEndpoint ?? options.env?.OLLAMA_HOST
  });

  const result = {
    schemaVersion: "debug-frame-analysis.v1",
    day,
    model,
    provider: "ollama",
    promptSource: "src/analysis/ollamaProvider.mjs#buildOllamaPrompt",
    selected: {
      index: selected.index,
      frameId: selected.observation.id,
      evidenceIds: selected.observation.evidenceIds,
      capturedAt: selected.observation.capturedAt,
      rawMediaPath: path.relative(root, mediaPath)
    },
    prompt,
    frame
  };
  assertPrivacySafe(result, "debugFrameAnalysis");
  return result;
}

function loadCaptureObservations({ root, day }) {
  const captureFile = path.join(root, "storage", "captures", day, "observations.jsonl");
  if (!existsSync(captureFile)) {
    throw new Error(`No captured observations found at ${captureFile}. Run capture first or choose a day with raw media.`);
  }

  const rows = readFileSync(captureFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (rows.length === 0) {
    throw new Error(`No structured observations found in ${captureFile}.`);
  }
  return validateObservations(rows, { day });
}

function selectObservation(observations, { frameId, offset }) {
  if (frameId) {
    const index = observations.findIndex((observation) => observation.id === frameId || observation.evidenceIds.includes(frameId));
    if (index === -1) {
      throw new Error(`No observation or evidence ID matched "${frameId}".`);
    }
    return { index, observation: observations[index] };
  }

  const index = requireNonNegativeInteger(offset, "offset");
  if (index >= observations.length) {
    throw new Error(`No observation at offset ${index}; ${observations.length} observation(s) are available.`);
  }
  return { index, observation: observations[index] };
}

function enforceObservationExclusion(observation, { excludedApps, excludedDomains }) {
  const reason = observationExclusionReason({
    appName: observation.appName,
    domain: observation.domain,
    excludedApps,
    excludedDomains
  });

  if (reason) {
    throw new Error(
      `Refusing to debug excluded observation ${observation.id}: ${reason}. ` +
      "Remove the observation or update the explicit exclusion policy."
    );
  }
}

function requireNonNegativeInteger(value, location) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${location}: expected a non-negative integer.`);
  }
  return number;
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

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
