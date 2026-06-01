const observationFields = new Set([
  "schemaVersion",
  "id",
  "capturedAt",
  "appName",
  "windowTitle",
  "domain",
  "activity",
  "visibleTextSummary",
  "redactedSignals",
  "evidenceIds"
]);

const maxLengths = {
  id: 160,
  appName: 80,
  windowTitle: 160,
  domain: 253,
  activity: 80,
  visibleTextSummary: 500,
  signal: 160,
  evidenceId: 160
};

export function validateObservations(observations, { day, source = "observations" } = {}) {
  if (!Array.isArray(observations)) {
    throw new Error(`${source}: expected an array of structured observations.`);
  }

  return observations.map((observation, index) => validateObservation(observation, {
    day,
    source: `${source}[${index}]`
  }));
}

function validateObservation(observation, { day, source }) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error(`${source}: expected an observation object.`);
  }

  for (const key of Object.keys(observation)) {
    if (!observationFields.has(key)) {
      throw new Error(`${source}: unexpected field "${key}" in persisted observation.`);
    }
  }

  const validated = {
    schemaVersion: requireLiteral(observation.schemaVersion, "observation.v1", `${source}.schemaVersion`),
    id: requireText(observation.id, `${source}.id`, maxLengths.id),
    capturedAt: requireIsoTimestamp(observation.capturedAt, `${source}.capturedAt`, day),
    appName: requireText(observation.appName, `${source}.appName`, maxLengths.appName),
    windowTitle: requireText(observation.windowTitle, `${source}.windowTitle`, maxLengths.windowTitle),
    domain: optionalDomain(observation.domain, `${source}.domain`),
    activity: requireText(observation.activity, `${source}.activity`, maxLengths.activity),
    visibleTextSummary: requireText(
      observation.visibleTextSummary,
      `${source}.visibleTextSummary`,
      maxLengths.visibleTextSummary
    ),
    redactedSignals: requireSignals(observation.redactedSignals, `${source}.redactedSignals`),
    evidenceIds: requireEvidenceIds(observation.evidenceIds, `${source}.evidenceIds`)
  };

  return validated;
}

function requireLiteral(value, expected, location) {
  if (value !== expected) {
    throw new Error(`${location}: expected "${expected}".`);
  }
  return value;
}

function requireText(value, location, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}: expected a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${location}: exceeds ${maxLength} characters.`);
  }
  return value.trim();
}

function requireIsoTimestamp(value, location, day) {
  const timestamp = requireText(value, location, 40);
  const parsed = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(timestamp) || Number.isNaN(parsed.getTime())) {
    throw new Error(`${location}: expected an ISO-8601 UTC timestamp.`);
  }
  const canonical = parsed.toISOString();
  if (day && !canonical.startsWith(`${day}T`)) {
    throw new Error(`${location}: must belong to day ${day}.`);
  }
  return canonical;
}

function optionalDomain(value, location) {
  if (value === null || value === undefined) return null;
  const domain = requireText(value, location, maxLengths.domain).toLowerCase();

  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes("?") ||
    domain.includes("#") ||
    domain.includes("@") ||
    /\s/.test(domain)
  ) {
    throw new Error(`${location}: expected a hostname only, not a full URL or credential-bearing value.`);
  }

  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain)) {
    throw new Error(`${location}: contains unsupported hostname characters.`);
  }

  return domain;
}

function requireSignals(value, location) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${location}: expected at least one redacted visible signal.`);
  }
  if (value.length > 12) {
    throw new Error(`${location}: exceeds 12 signals.`);
  }

  return value.map((signal, index) => requireText(signal, `${location}[${index}]`, maxLengths.signal));
}

function requireEvidenceIds(value, location) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${location}: expected at least one evidence id.`);
  }
  if (value.length > 12) {
    throw new Error(`${location}: exceeds 12 evidence ids.`);
  }

  return value.map((evidenceId, index) => {
    const value = requireText(evidenceId, `${location}[${index}]`, maxLengths.evidenceId);
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) {
      throw new Error(`${location}[${index}]: contains unsupported evidence id characters.`);
    }
    return value;
  });
}
