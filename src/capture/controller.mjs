import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";
import { validateObservations } from "../analysis/observations.mjs";
import { requestScreenCapturePermission } from "./permissions.mjs";
import {
  defaultExcludedApps,
  defaultExcludedDomains,
  observationExclusionReason
} from "../privacy/exclusions.mjs";

const validActions = new Set(["start", "pause", "resume", "stop", "once", "status"]);
const persistedActions = new Set(["start", "pause", "resume", "stop", "once"]);
const validStatuses = new Set(["running", "paused", "stopped", "completed_once"]);
const captureStateFields = new Set([
  "schemaVersion",
  "status",
  "previousStatus",
  "lastAction",
  "updatedAt",
  "controls",
  "capturePolicy",
  "notice"
]);
const controlsFields = new Set([
  "visibleControlsRequired",
  "operatorInitiated",
  "availableActions"
]);
const capturePolicyFields = new Set([
  "schemaVersion",
  "realScreenCaptureEnabled",
  "hiddenBackgroundCapture",
  "rawMediaRetention",
  "allowedSource",
  "excludedApps",
  "excludedDomains",
  "disallowedSignals"
]);
const observationExclusionReasonFields = new Set([
  "schemaVersion",
  "id",
  "capturedAt",
  "reason",
  "appName",
  "domain"
]);

const statusForAction = {
  start: "running",
  pause: "paused",
  resume: "running",
  stop: "stopped",
  once: "completed_once"
};

export function handleCaptureAction(options = {}) {
  const root = options.root ?? process.cwd();
  const action = options.action ?? "status";
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;

  if (!validActions.has(action)) {
    throw new Error(`Unknown capture action "${action}". Expected start, pause, resume, stop, once, or status.`);
  }

  const statePath = captureStatePath(root);

  if (action === "status") {
    return readCaptureStatus(statePath);
  }

  const previous = readCaptureState(statePath);
  const transition = resolveCaptureTransition(action, previous);

  if (transition.noop) {
    return {
      state: previous,
      statePath,
      message: transition.message
    };
  }

  if (action === "once" && !hasRealCaptureAck(options, env)) {
    throw new Error(
      "Refusing real capture: set LUCILLE_REAL_CAPTURE_ACK=1 or pass --ack-real-capture for an explicit operator-controlled capture."
    );
  }

  const state = buildCaptureState({
    action,
    status: transition.status,
    previousStatus: previous?.status ?? null,
    now,
    excludedApps: options.excludedApps ?? defaultExcludedApps,
    excludedDomains: options.excludedDomains ?? defaultExcludedDomains,
    realScreenCaptureEnabled: action === "once"
  });

  validateCaptureState(state, "captureState");
  assertPrivacySafe(state, "captureState");

  if (action === "once") {
    const ingestion = captureOnce({
      root,
      now,
      day: options.day,
      excludedApps: state.capturePolicy.excludedApps,
      excludedDomains: state.capturePolicy.excludedDomains,
      captureScreenshot: options.captureScreenshot,
      getActiveWindowHints: options.getActiveWindowHints,
      platform: options.platform ?? process.platform
    });

    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

    return {
      state,
      statePath,
      ...ingestion,
      message: ingestion.message
    };
  }

  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  return {
    state,
    statePath,
    message: messageForAction(action, state.status)
  };
}

export function readCaptureState(statePath) {
  if (!existsSync(statePath)) return null;
  const state = validateCaptureState(JSON.parse(readFileSync(statePath, "utf8")), "captureState");
  assertPrivacySafe(state, "captureState");
  return state;
}

export function captureStatePath(root) {
  return path.join(root, "storage", "capture-state.json");
}

function readCaptureStatus(statePath) {
  const state = readCaptureState(statePath);

  if (!state) {
    return {
      state: null,
      statePath,
      message: "Capture has no saved control state. No hidden monitoring is running."
    };
  }

  return {
    state,
    statePath,
    message: `Capture state is ${state.status}. No hidden monitoring is running.`
  };
}

function resolveCaptureTransition(action, previous) {
  const previousStatus = previous?.status ?? null;

  if (action === "pause" && previousStatus !== "running") {
    return {
      noop: true,
      message: "Capture is not running; nothing to pause. No hidden monitoring is running."
    };
  }

  if (action === "resume" && previousStatus !== "paused") {
    return {
      noop: true,
      message: "Capture is not paused; nothing to resume. No hidden monitoring is running."
    };
  }

  if (action === "stop" && previousStatus !== "running" && previousStatus !== "paused") {
    return {
      noop: true,
      message: "Capture is not running; nothing to stop. No hidden monitoring is running."
    };
  }

  return {
    noop: false,
    status: statusForAction[action]
  };
}

function buildCaptureState({
  action,
  status,
  previousStatus,
  now,
  excludedApps,
  excludedDomains,
  realScreenCaptureEnabled = false
}) {
  return {
    schemaVersion: "capture-state.v1",
    status,
    previousStatus,
    lastAction: action,
    updatedAt: now.toISOString(),
    controls: {
      visibleControlsRequired: true,
      operatorInitiated: true,
      availableActions: ["start", "pause", "resume", "stop", "once", "status"]
    },
    capturePolicy: {
      schemaVersion: "capture-policy.v1",
      realScreenCaptureEnabled,
      hiddenBackgroundCapture: false,
      rawMediaRetention: realScreenCaptureEnabled ? "day_scoped_until_analysis" : "none_in_scaffold",
      allowedSource: "visible_screen_observations_only",
      excludedApps,
      excludedDomains,
      disallowedSignals: [
        ...privacyRedactions(),
        "no_passwords",
        "no_cookies",
        "no_authentication_tokens",
        "no_full_urls_with_query_strings"
      ]
    },
    notice: realScreenCaptureEnabled
      ? "This operator-invoked capture stores one visible screenshot under day-scoped raw media and one structured observation."
      : "This scaffold records visible control state only. It does not start hidden background capture or collect screenshots."
  };
}

export function validateCaptureState(value, source = "captureState") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a capture state object.`);
  }

  rejectUnexpectedFields(value, captureStateFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "capture-state.v1", `${source}.schemaVersion`),
    status: requireStatus(value.status, `${source}.status`),
    previousStatus: requireOptionalStatus(value.previousStatus, `${source}.previousStatus`),
    lastAction: requireAction(value.lastAction, `${source}.lastAction`),
    updatedAt: requireIsoTimestamp(value.updatedAt, `${source}.updatedAt`),
    controls: validateControls(value.controls, `${source}.controls`),
    capturePolicy: validateCapturePolicy(value.capturePolicy, `${source}.capturePolicy`),
    notice: requireText(value.notice, `${source}.notice`, 240)
  };
}

function validateControls(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a controls object.`);
  }

  rejectUnexpectedFields(value, controlsFields, source);

  return {
    visibleControlsRequired: requireLiteral(value.visibleControlsRequired, true, `${source}.visibleControlsRequired`),
    operatorInitiated: requireLiteral(value.operatorInitiated, true, `${source}.operatorInitiated`),
    availableActions: requireExactStringSet(
      value.availableActions,
      [...validActions],
      `${source}.availableActions`
    )
  };
}

function validateCapturePolicy(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a capture policy object.`);
  }

  rejectUnexpectedFields(value, capturePolicyFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "capture-policy.v1", `${source}.schemaVersion`),
    realScreenCaptureEnabled: requireBoolean(value.realScreenCaptureEnabled, `${source}.realScreenCaptureEnabled`),
    hiddenBackgroundCapture: requireLiteral(
      value.hiddenBackgroundCapture,
      false,
      `${source}.hiddenBackgroundCapture`
    ),
    rawMediaRetention: requireOneOf(
      value.rawMediaRetention,
      ["none_in_scaffold", "day_scoped_until_analysis"],
      `${source}.rawMediaRetention`
    ),
    allowedSource: requireLiteral(
      value.allowedSource,
      "visible_screen_observations_only",
      `${source}.allowedSource`
    ),
    excludedApps: requireTextArray(value.excludedApps, `${source}.excludedApps`, 40, 80),
    excludedDomains: requireTextArray(value.excludedDomains, `${source}.excludedDomains`, 40, 253)
      .map((domain, index) => requireHostnameOnly(domain, `${source}.excludedDomains[${index}]`)),
    disallowedSignals: requireExactStringSet(
      value.disallowedSignals,
      [
        ...privacyRedactions(),
        "no_passwords",
        "no_cookies",
        "no_authentication_tokens",
        "no_full_urls_with_query_strings"
      ],
      `${source}.disallowedSignals`
    )
  };
}

function rejectUnexpectedFields(value, allowedFields, source) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${source}: unexpected field "${key}".`);
    }
  }
}

function requireLiteral(value, expected, source) {
  if (value !== expected) {
    throw new Error(`${source}: expected ${JSON.stringify(expected)}.`);
  }
  return value;
}

function requireBoolean(value, source) {
  if (typeof value !== "boolean") {
    throw new Error(`${source}: expected a boolean.`);
  }
  return value;
}

function requireOneOf(value, expected, source) {
  const text = requireText(value, source, 80);
  if (!expected.includes(text)) {
    throw new Error(`${source}: expected one of ${expected.join(", ")}.`);
  }
  return text;
}

function requireStatus(value, source) {
  const status = requireText(value, source, 40);
  if (!validStatuses.has(status)) {
    throw new Error(`${source}: expected running, paused, stopped, or completed_once.`);
  }
  return status;
}

function requireOptionalStatus(value, source) {
  if (value === null) return null;
  return requireStatus(value, source);
}

function requireAction(value, source) {
  const action = requireText(value, source, 40);
  if (!persistedActions.has(action)) {
    throw new Error(`${source}: expected start, pause, resume, stop, or once.`);
  }
  return action;
}

function requireIsoTimestamp(value, source) {
  const timestamp = requireText(value, source, 40);
  const parsed = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(timestamp) || Number.isNaN(parsed.getTime())) {
    throw new Error(`${source}: expected an ISO-8601 UTC timestamp.`);
  }
  return parsed.toISOString();
}

function requireExactStringSet(value, expected, source) {
  const items = requireTextArray(value, source, expected.length, 120);
  const extras = items.filter((item) => !expected.includes(item));
  const missing = expected.filter((item) => !items.includes(item));

  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`${source}: expected exactly ${expected.join(", ")}.`);
  }

  return expected;
}

function requireTextArray(value, source, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: expected an array.`);
  }
  if (value.length === 0) {
    throw new Error(`${source}: expected at least one item.`);
  }
  if (value.length > maxItems) {
    throw new Error(`${source}: exceeds ${maxItems} items.`);
  }

  return value.map((item, index) => requireText(item, `${source}[${index}]`, maxLength));
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

function requireHostnameOnly(value, source) {
  const domain = value.toLowerCase();
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes("?") ||
    domain.includes("#") ||
    domain.includes("@") ||
    /\s/.test(domain)
  ) {
    throw new Error(`${source}: expected a hostname only, not a full URL or credential-bearing value.`);
  }

  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain)) {
    throw new Error(`${source}: contains unsupported hostname characters.`);
  }

  return domain;
}

function messageForAction(action, status) {
  if (action === "once") {
    return `Capture state set to ${status}.`;
  }

  return `Capture state set to ${status}. No hidden monitoring is running.`;
}

function captureOnce({
  root,
  now,
  day,
  excludedApps,
  excludedDomains,
  captureScreenshot,
  getActiveWindowHints,
  platform
}) {
  const captureDay = validateDay(day ?? localDay(now));
  const captureDayDir = path.join(root, "storage", "captures", captureDay);
  const rawMediaDir = path.join(captureDayDir, "raw-media");
  mkdirSync(captureDayDir, { recursive: true });

  const timestamp = now.toISOString();
  const id = `obs-${timestamp.replace(/[^0-9]/g, "").slice(0, 17)}`;
  const mediaPath = path.join(rawMediaDir, `${id}.png`);
  const hints = sanitizeHints((getActiveWindowHints ?? readActiveWindowHints)({ platform }));
  const excludedReason = observationExclusionReason({
    appName: hints.appName,
    domain: hints.domain,
    excludedApps,
    excludedDomains
  });

  if (excludedReason) {
    const exclusion = validateObservationExclusion({
      schemaVersion: "observation-exclusion.v1",
      id,
      capturedAt: timestamp,
      reason: excludedReason,
      appName: hints.appName,
      domain: hints.domain
    }, "observationExclusion");
    assertPrivacySafe(exclusion, "observationExclusion");
    writeFileSync(
      path.join(captureDayDir, "observation-exclusions.jsonl"),
      JSON.stringify(exclusion) + "\n",
      { flag: "a" }
    );
    return {
      day: captureDay,
      observation: null,
      rawMediaPath: null,
      excluded: true,
      exclusion,
      message: `Capture skipped before screenshot because ${excludedReason}. No raw media was written.`
    };
  }

  mkdirSync(rawMediaDir, { recursive: true });

  try {
    const captureResult = (captureScreenshot ?? captureVisibleScreen)({ outputPath: mediaPath, platform });

    if (!captureResult.ok) {
      cleanupPartialRawMedia(mediaPath);
      throw new Error(captureResult.message);
    }

    const observation = validateObservations([
      {
        schemaVersion: "observation.v1",
        id,
        capturedAt: timestamp,
        appName: hints.appName,
        windowTitle: hints.windowTitle,
        domain: hints.domain,
        activity: "explicit_screen_capture",
        visibleTextSummary: "A visible screen frame was captured by an explicit operator command for local analysis.",
        redactedSignals: [
          "explicit user-invoked capture",
          "day-scoped local raw media",
          "structured metadata only before analysis"
        ],
        evidenceIds: [`${id}-raw-frame`]
      }
    ], { day: captureDay, source: "captureOnceObservation" })[0];
    assertPrivacySafe(observation, "captureOnceObservation");

    writeFileSync(
      path.join(captureDayDir, "observations.jsonl"),
      JSON.stringify(observation) + "\n",
      { flag: "a" }
    );

    return {
      day: captureDay,
      observation,
      rawMediaPath: path.relative(root, mediaPath),
      excluded: false,
      message: `Captured one visible frame for ${captureDay}: wrote observations.jsonl and day-scoped raw media.`
    };
  } catch (error) {
    cleanupPartialRawMedia(mediaPath);
    throw error;
  }
}

function cleanupPartialRawMedia(mediaPath) {
  if (existsSync(mediaPath)) {
    unlinkSync(mediaPath);
  }
}

function hasRealCaptureAck(options, env) {
  return options.realCaptureAck === true || env.LUCILLE_REAL_CAPTURE_ACK === "1";
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}

function captureVisibleScreen({ outputPath, platform }) {
  if (platform !== "darwin") {
    return {
      ok: false,
      message: "Real capture-once currently supports macOS screencapture only. Use injected fixtures for tests."
    };
  }

  const result = runScreencapture(outputPath);

  if (result.ok) return result;

  const permission = requestScreenCapturePermission();
  if (!permission.ok) {
    return {
      ok: false,
      message: `${result.message}\n${permission.message}`
    };
  }

  return runScreencapture(outputPath);
}

function runScreencapture(outputPath) {
  const result = spawnSync("screencapture", ["-x", outputPath], {
    encoding: "utf8",
    timeout: 20_000
  });

  if (result.error) {
    return {
      ok: false,
      message: `screencapture failed: ${result.error.message}.`
    };
  }

  if (result.status !== 0 || !existsSync(outputPath)) {
    const detail = (result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      message: `screencapture did not produce a frame${detail ? `: ${detail}` : ""}.`
    };
  }

  return { ok: true };
}

function readActiveWindowHints({ platform }) {
  if (platform !== "darwin") {
    return {
      appName: "Unknown",
      windowTitle: "Visible screen",
      domain: null
    };
  }

  const result = spawnSync("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true'
  ], {
    encoding: "utf8",
    timeout: 5_000
  });

  return {
    appName: result.status === 0 ? result.stdout.trim() || "Unknown" : "Unknown",
    windowTitle: "Visible screen",
    domain: null
  };
}

function sanitizeHints(value = {}) {
  return {
    appName: sanitizeText(value.appName, "Unknown", 80),
    windowTitle: sanitizeText(value.windowTitle, "Visible screen", 160),
    domain: value.domain ? requireHostnameOnly(String(value.domain), "captureOnce.domain") : null
  };
}

function sanitizeText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const text = value.trim().replace(/\s+/g, " ");
  if (text === "") return fallback;
  return text.slice(0, maxLength);
}

function validateObservationExclusion(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected an observation exclusion object.`);
  }
  rejectUnexpectedFields(value, observationExclusionReasonFields, source);

  return {
    schemaVersion: requireLiteral(value.schemaVersion, "observation-exclusion.v1", `${source}.schemaVersion`),
    id: requireText(value.id, `${source}.id`, 160),
    capturedAt: requireIsoTimestamp(value.capturedAt, `${source}.capturedAt`),
    reason: requireText(value.reason, `${source}.reason`, 220),
    appName: requireText(value.appName, `${source}.appName`, 80),
    domain: value.domain === null ? null : requireHostnameOnly(value.domain, `${source}.domain`)
  };
}

function localDay(now) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
