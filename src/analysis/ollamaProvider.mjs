import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLocalModel } from "../config/models.mjs";
import { assertPrivacySafe, privacyRedactions } from "../privacy/safety.mjs";

const defaultEndpoint = "http://127.0.0.1:11434";
const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];
const maxModelImageDimension = 512;
const modelRequestTimeoutMs = 120_000;

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
  const preparedImage = prepareModelImage(mediaPath);
  const imageBase64 = readFileSync(preparedImage.path, "base64");
  preparedImage.cleanup();
  const body = buildOllamaRequest({ model, observation, imageBase64 });

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, modelRequestTimeoutMs);
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

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function prepareModelImage(mediaPath) {
  const dimensions = imageDimensions(mediaPath);
  if (!dimensions || Math.max(dimensions.width, dimensions.height) <= maxModelImageDimension) {
    return { path: mediaPath, cleanup: () => {} };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lucille-model-frame-"));
  const outputPath = path.join(tempDir, "frame.png");
  try {
    execFileSync("sips", ["-s", "format", "png", "-Z", String(maxModelImageDimension), mediaPath, "--out", outputPath], {
      stdio: "ignore"
    });
    return {
      path: outputPath,
      cleanup: () => rmSync(tempDir, { recursive: true, force: true })
    };
  } catch {
    rmSync(tempDir, { recursive: true, force: true });
    return { path: mediaPath, cleanup: () => {} };
  }
}

function imageDimensions(mediaPath) {
  try {
    const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", mediaPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export function buildOllamaPrompt({ observation }) {
  return [
    "Analyze this locally supplied visible screen frame for Lucille 3.",
    "Return JSON only with keys: activity, visibleIntent, applications, primaryApplication, visitedUrls, keyTasks, evidenceSummaries, riskFlags.",
    "applications must be an array of every visible or inferable running application/work surface in the frame. Each item should include name, windowTitle when visible, domain when visible as a hostname only, isPrimary, and primaryReason.",
    "Whenever a web browser window or browser-based app is visible, OCR the address bar and include visitedUrls as an array of visible visited URLs. Preserve hostnames and visible paths, but remove query strings, fragments, usernames, passwords, tokens, cookies, and tracking parameters. If only the hostname is visible, include the hostname as an https URL.",
    "Differentiate communication apps precisely: Discord, Slack, and Microsoft Teams are separate applications. Use visible branding, domains, sidebar labels, and window titles; do not call Discord Slack or Teams, do not call Slack Discord or Teams, and use Microsoft Teams for Teams work/chat windows.",
    "Slack visual cues include a purple workspace sidebar, workspace switcher, channel names prefixed with #, and left rail labels like Home, DMs, Activity, Later, More. If those Slack cues are visible, label the app Slack even when the channel or workspace name resembles a community/server name.",
    "Discord visual cues include server icons, Discord server/channel layout, voice channel controls, and Discord branding; do not infer Discord from a #channel name alone. Microsoft Teams visual cues include Teams/Chat/Calendar/Calls navigation, tenant/team lists, and teams.microsoft.com.",
    "Use the mouse cursor position to decide primaryApplication when the cursor is visible. The primary application is the application currently in use: the app/window under or nearest the cursor, or the focused active window if the cursor is not visible. Say when the cursor is not visible instead of inventing cursor evidence.",
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
  ].join(" ");
}

export function buildOllamaRequest({ model, observation, imageBase64 }) {
  return {
    model,
    stream: false,
    format: "json",
    prompt: buildOllamaPrompt({ observation }),
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
  const applications = normalizeApplications({
    parsedApplications: parsed.applications ?? parsed.visibleApplications,
    parsedPrimaryApplication: parsed.primaryApplication,
    observation
  });
  const evidenceSummaries = normalizeEvidenceSummariesForApplications(safeSummaries, applications);
  const frameKeyTasks = normalizeTextArrayForApplications(safeKeyTasks, applications);
  const riskFlags = normalizeTextArrayForApplications(optionalTextArray(parsed.riskFlags, "riskFlags", 8, 120), applications);
  const primaryApplication = applications.find((application) => application.isPrimary) ?? applications[0];
  const visitedUrls = normalizeVisitedUrls({
    parsedUrls: parsed.visitedUrls ?? parsed.urls ?? parsed.browserUrls,
    parsedApplications: parsed.applications ?? parsed.visibleApplications,
    applications,
    observation
  }).filter((url) => isVisitedUrlConsistentWithApplications(url, applications));

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
    applications,
    visitedUrls,
    primaryApplication: {
      name: primaryApplication.name,
      windowTitle: primaryApplication.windowTitle,
      domain: primaryApplication.domain,
      primaryReason: primaryApplication.primaryReason
    },
    activities: [requireText(parsed.activity ?? observation.activity, "activity", 80)],
    visibleIntent: requireText(parsed.visibleIntent ?? observation.visibleTextSummary, "visibleIntent", 500),
    keyTasks: frameKeyTasks,
    evidence: evidenceSummaries.map((summary, index) => ({
      id: observation.evidenceIds[index] ?? `${observation.id}-local-visual-${String(index + 1).padStart(2, "0")}`,
      kind: "local_visual_summary",
      summary
    })),
    redactions: privacyRedactions(),
    riskFlags
  };
}

function normalizeApplications({ parsedApplications, parsedPrimaryApplication, observation }) {
  const applications = [];
  const primaryName = applicationName(parsedPrimaryApplication);
  const primaryWindowTitle = applicationWindowTitle(parsedPrimaryApplication);

  for (const [index, value] of optionalObjectArray(parsedApplications, "applications", 8).entries()) {
    const windowTitle = optionalText(value.windowTitle ?? value.title, `applications[${index}].windowTitle`, 160);
    const rawDomain = optionalApplicationHostname(value.domain, `applications[${index}].domain`);
    const rawName = requireText(value.name ?? value.appName ?? value.application, `applications[${index}].name`, 80);
    const name = canonicalApplicationName({ name: rawName, windowTitle, domain: rawDomain });
    const domain = normalizeApplicationDomain({
      name,
      windowTitle,
      domain: rawDomain
    });
    if (name === "Unknown" && applications.length > 0) continue;
    applications.push({
      name,
      windowTitle,
      domain,
      isPrimary: Boolean(value.isPrimary),
      primaryReason: optionalText(value.primaryReason ?? value.reason, `applications[${index}].primaryReason`, 180) ??
        "Visible application in the captured frame."
    });
  }

  if (primaryName) {
    const primaryDomain = optionalApplicationHostname(parsedPrimaryApplication?.domain, "primaryApplication.domain");
    const canonicalPrimaryName = canonicalApplicationName({
      name: primaryName,
      windowTitle: primaryWindowTitle,
      domain: primaryDomain
    });
    const index = applications.findIndex((application) => (
      sameText(application.name, canonicalPrimaryName) &&
      (!primaryWindowTitle || sameText(application.windowTitle, primaryWindowTitle))
    ));
    if (index === -1) {
      applications.unshift({
        name: canonicalPrimaryName,
        windowTitle: primaryWindowTitle,
        domain: normalizeApplicationDomain({
          name: canonicalPrimaryName,
          windowTitle: primaryWindowTitle,
          domain: primaryDomain
        }),
        isPrimary: true,
        primaryReason: optionalText(parsedPrimaryApplication?.primaryReason ?? parsedPrimaryApplication?.reason, "primaryApplication.primaryReason", 180) ??
          "Model identified this as the primary application."
      });
    } else {
      applications[index] = {
        ...applications[index],
        isPrimary: true,
        primaryReason: optionalText(parsedPrimaryApplication?.primaryReason ?? parsedPrimaryApplication?.reason, "primaryApplication.primaryReason", 180) ??
          applications[index].primaryReason
      };
    }
  }

  ensureObservationApplication(applications, observation);
  ensureSinglePrimary(applications, observation);
  const normalizedApplications = normalizeSlackDominantCommunicationMix(dedupeApplications(applications)).slice(0, 8);
  ensureSinglePrimary(normalizedApplications, observation);
  return normalizedApplications;
}

function ensureObservationApplication(applications, observation) {
  const name = canonicalApplicationName({
    name: observation.appName,
    windowTitle: observation.windowTitle,
    domain: observation.domain
  });
  if (name === "Unknown" && applications.length > 0) return;
  if (applications.some((application) => sameText(application.name, name))) return;
  applications.push({
    name,
    windowTitle: observation.windowTitle,
    domain: normalizeApplicationDomain({ name, windowTitle: observation.windowTitle, domain: observation.domain ?? null }),
    isPrimary: false,
    primaryReason: "Capture metadata named this as the active application."
  });
}

function ensureSinglePrimary(applications, observation) {
  let primaryIndex = applications.findIndex((application) => application.isPrimary);
  if (primaryIndex === -1) {
    const observationAppName = canonicalApplicationName({
      name: observation.appName,
      windowTitle: observation.windowTitle,
      domain: observation.domain
    });
    primaryIndex = applications.findIndex((application) => sameText(application.name, observationAppName));
  }
  if (primaryIndex === -1) primaryIndex = 0;

  for (const [index, application] of applications.entries()) {
    application.isPrimary = index === primaryIndex;
    if (application.isPrimary && !application.primaryReason) {
      application.primaryReason = "Cursor position was not visible; using focused active window metadata.";
    }
  }
}

function dedupeApplications(applications) {
  const seen = new Set();
  const deduped = [];
  for (const application of applications) {
    const key = application.name === "Slack"
      ? `${application.name.toLowerCase()}|${application.domain ?? "slack.com"}`
      : `${application.name.toLowerCase()}|${application.windowTitle?.toLowerCase() ?? ""}|${application.domain ?? ""}`;
    if (seen.has(key)) {
      const existing = deduped.find((item) => (
        (item.name === "Slack" && application.name === "Slack" && (item.domain ?? "slack.com") === (application.domain ?? "slack.com")) ||
        (
          item.name === application.name &&
          (item.windowTitle ?? "") === (application.windowTitle ?? "") &&
          (item.domain ?? "") === (application.domain ?? "")
        )
      ));
      if (existing?.isPrimary === false && application.isPrimary) {
        existing.isPrimary = true;
        existing.primaryReason = application.primaryReason;
        existing.windowTitle = application.windowTitle ?? existing.windowTitle;
      }
      continue;
    }
    seen.add(key);
    deduped.push(application);
  }
  return deduped;
}

function normalizeSlackDominantCommunicationMix(applications) {
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  const hasBrowser = applications.some((application) => isBrowserApplication(application.name));
  const hasAmbiguousTeamsOnlyChat = !hasSlack && !hasDiscord && hasTeams && !hasBrowser &&
    applications.some((application) => application.name === "Microsoft Teams" && !hasSpecificTeamsCue(application));
  if (!hasSlack && !(hasDiscord && hasTeams && !hasBrowser) && !hasAmbiguousTeamsOnlyChat) return applications;

  const slackCueText = applications.map(applicationSlackCueText).join(" ");
  const hasStrongSlackCue = (
    /\bslack\b/.test(slackCueText) ||
    /\bslack\.com\b/.test(slackCueText) ||
    /\bpurple workspace sidebar\b/.test(slackCueText) ||
    /\bworkspace sidebar\b/.test(slackCueText) ||
    /\b(arbor-data-and-ai|engineering slack)\b/.test(slackCueText)
  );
  const hasAmbiguousMixedChatHallucination = !hasSlack && hasDiscord && hasTeams && !hasBrowser;
  if (!hasStrongSlackCue && !hasAmbiguousMixedChatHallucination && !hasAmbiguousTeamsOnlyChat) return applications;
  if (applications.some((application) => application.name === "Discord" && application.isPrimary && hasSpecificDiscordCue(application))) {
    return applications;
  }

  const normalized = applications.map((application) => {
    if (application.name !== "Discord" && application.name !== "Microsoft Teams") return application;
    if (application.name === "Discord" && application.isPrimary && hasSpecificDiscordCue(application)) return application;
    if (application.name === "Microsoft Teams" && hasSpecificTeamsCue(application)) return application;
    return {
      ...application,
      name: "Slack",
      windowTitle: replaceCommunicationAppWithSlack(application.windowTitle),
      domain: application.domain?.includes("slack.com") ? application.domain : "slack.com",
      primaryReason: replaceCommunicationAppWithSlack(application.primaryReason)
    };
  });

  return dedupeApplications(normalized);
}

function applicationSlackCueText(application) {
  return `${application.name ?? ""} ${application.windowTitle ?? ""} ${application.domain ?? ""} ${application.primaryReason ?? ""}`.toLowerCase();
}

function hasSpecificDiscordCue(application) {
  const text = applicationSlackCueText(application);
  return (
    /\b(discordapp\.com|discord\.gg|server icon|voice channel|voice controls|discord branding)\b/.test(text) ||
    /\bcursor\b.*\bdiscord\b/.test(text) ||
    /\bdiscord\b.*\bcursor\b/.test(text)
  );
}

function hasSpecificTeamsCue(application) {
  const text = applicationSlackCueText(application);
  return /\b(teams navigation|teams tenant|calendar|calls|team list|teams list|activity feed)\b/.test(text);
}

function normalizeVisitedUrls({ parsedUrls, parsedApplications, applications, observation }) {
  const urls = [];

  for (const [index, value] of optionalUrlItems(parsedUrls, "visitedUrls", 12).entries()) {
    const url = optionalVisitedUrl(value, `visitedUrls[${index}]`);
    if (url) urls.push(url);
  }

  for (const [index, application] of optionalObjectArray(parsedApplications, "applications", 8).entries()) {
    for (const key of ["visitedUrl", "currentUrl", "pageUrl", "url"]) {
      if (application[key] !== undefined && application[key] !== null && application[key] !== "") {
        const url = optionalVisitedUrl(application[key], `applications[${index}].${key}`);
        if (url) urls.push(url);
      }
    }
  }

  for (const application of applications) {
    if (application.domain && isBrowserApplication(application.name)) {
      const url = optionalVisitedUrl(application.domain, "applications.domain");
      if (url) urls.push(url);
    }
  }

  if (observation.domain && isBrowserApplication(observation.appName)) {
    const url = optionalVisitedUrl(observation.domain, "observation.domain");
    if (url) urls.push(url);
  }

  return dedupeText(urls).slice(0, 12);
}

function optionalUrlItems(value, location, maxItems) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value.slice(0, maxItems).map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return item.url ?? item.href ?? item.visitedUrl ?? item.currentUrl ?? item.pageUrl ?? item.domain ?? item.hostname ?? item.host ?? item;
  });
}

function normalizeVisitedUrl(value, location) {
  const rawValue = requireText(value, location, 500);
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `https://${rawValue}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`${location}: expected a browser URL or hostname.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${location}: expected an HTTP(S) browser URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${location}: browser URLs must not include credentials.`);
  }
  url.search = "";
  url.hash = "";
  const hostname = optionalHostname(url.hostname, `${location}.hostname`);
  if (!isPlausibleVisitedHostname(hostname)) {
    throw new Error(`${location}: URL hostname is not plausible.`);
  }
  const pathname = normalizeUrlPathname(url.pathname, location);
  return `${url.protocol}//${hostname}${pathname}`;
}

function optionalVisitedUrl(value, location) {
  try {
    return normalizeVisitedUrl(value, location);
  } catch {
    return null;
  }
}

function isPlausibleVisitedHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.includes(".") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function normalizeUrlPathname(pathname, location) {
  if (!pathname || pathname === "/") return "/";
  const decoded = pathname.replace(/\/{2,}/g, "/");
  if (/[\s"'<>]/.test(decoded)) {
    throw new Error(`${location}: URL path contains unsupported characters.`);
  }
  return decoded;
}

function isBrowserApplication(name) {
  return /\b(browser|chrome|safari|firefox|edge|arc|brave|vivaldi|chromium)\b/i.test(String(name ?? ""));
}

function isVisitedUrlConsistentWithApplications(url, applications) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  const hasBrowserOnHostname = applications.some((application) => (
    isBrowserApplication(application.name) &&
    typeof application.domain === "string" &&
    (application.domain.toLowerCase() === hostname || application.domain.toLowerCase().endsWith(`.${hostname}`))
  ));

  if ((hostname === "discord.com" || hostname.endsWith(".discord.com")) && !hasDiscord && !hasBrowserOnHostname) return false;
  if ((hostname === "slack.com" || hostname.endsWith(".slack.com")) && !hasSlack && !hasBrowserOnHostname) return false;
  if ((hostname === "teams.microsoft.com" || hostname.endsWith(".teams.microsoft.com")) && !hasTeams && !hasBrowserOnHostname) return false;
  return true;
}

function dedupeText(values) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function applicationName(value) {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return optionalText(value.name ?? value.appName ?? value.application, "primaryApplication.name", 80);
}

function canonicalApplicationName({ name, windowTitle = null, domain = null }) {
  const rawName = requireText(name, "application.name", 80);
  const text = `${rawName} ${windowTitle ?? ""} ${domain ?? ""}`.toLowerCase();
  const normalizedDomain = String(domain ?? "").toLowerCase();

  if (looksLikeKnownSlackWorkspace(text)) {
    return "Slack";
  }

  if (
    normalizedDomain === "discord.com" ||
    normalizedDomain.endsWith(".discord.com") ||
    /\bdiscord\b/.test(text)
  ) {
    return "Discord";
  }

  if (
    normalizedDomain === "slack.com" ||
    normalizedDomain.endsWith(".slack.com") ||
    /\bslack\b/.test(text)
  ) {
    return "Slack";
  }

  if (
    normalizedDomain === "teams.microsoft.com" ||
    normalizedDomain.endsWith(".teams.microsoft.com") ||
    normalizedDomain === "teams.live.com" ||
    normalizedDomain.endsWith(".teams.live.com") ||
    /\bmicrosoft teams\b/.test(text) ||
    /\bms teams\b/.test(text) ||
    /\bteams\b/.test(rawName.toLowerCase())
  ) {
    return "Microsoft Teams";
  }

  return rawName;
}

function normalizeApplicationDomain({ name, windowTitle = null, domain = null }) {
  if (!domain) return null;
  const lowerName = String(name ?? "").toLowerCase();
  const lowerDomain = String(domain).toLowerCase();
  const text = `${name ?? ""} ${windowTitle ?? ""} ${domain ?? ""}`.toLowerCase();

  if (name === "Slack") {
    if (looksLikeKnownSlackWorkspace(text)) return "arbor-data-and-ai.slack.com";
    return lowerDomain.includes("slack.com") ? lowerDomain : null;
  }
  if (name === "Discord") return lowerDomain.includes("discord.com") ? lowerDomain : "discord.com";
  if (name === "Microsoft Teams") {
    return lowerDomain.includes("teams.microsoft.com") || lowerDomain.includes("teams.live.com")
      ? lowerDomain
      : "teams.microsoft.com";
  }
  if (["finder", "terminal", "iterm2", "visual studio code", "cursor"].includes(lowerName)) {
    return null;
  }
  if (isBrowserApplication(name) || ["github", "arbor"].includes(lowerName)) {
    return lowerDomain === "local" || lowerDomain === "unknown" ? null : lowerDomain;
  }
  return lowerDomain === "local" || lowerDomain === "unknown" ? null : lowerDomain;
}

function looksLikeKnownSlackWorkspace(text) {
  return (
    /\barbor-data-and-ai\b/.test(text) ||
    /\barbor\b.*\bdata\b.*\bai\b/.test(text) ||
    (/\barbor\b/.test(text) && /\bdiscord\.com\b/.test(text))
  );
}

function normalizeEvidenceSummariesForApplications(summaries, applications) {
  return normalizeTextArrayForApplications(summaries, applications);
}

function normalizeTextArrayForApplications(values, applications) {
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  if (!hasSlack || hasDiscord || hasTeams) return values;
  return values.map(replaceCommunicationAppWithSlack);
}

function replaceCommunicationAppWithSlack(text) {
  if (typeof text !== "string" || !/\b(discord|microsoft teams|teams)\b/i.test(text)) return text;
  return text
    .replace(/\bDiscord window\b/gi, "Slack window")
    .replace(/\bDiscord channel\b/gi, "Slack channel")
    .replace(/\bDiscord server\b/gi, "Slack workspace")
    .replace(/\bDiscord messages\b/gi, "Slack messages")
    .replace(/\bDiscord branding and server\/channel layout\b/gi, "Slack workspace layout")
    .replace(/\bMicrosoft Teams window\b/gi, "Slack window")
    .replace(/\bTeams chat window\b/gi, "Slack window")
    .replace(/\bTeams chat\b/gi, "Slack conversation")
    .replace(/\bMicrosoft Teams\b/g, "Slack")
    .replace(/\bTeams\b/g, "Slack")
    .replace(/\bteams\b/g, "Slack")
    .replace(/\bDiscord\b/g, "Slack")
    .replace(/\bdiscord\b/g, "Slack")
    .replace(/\bSlack and Slack are\b/g, "Slack is")
    .replace(/\bSlack and Slack\b/g, "Slack");
}

function applicationWindowTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return optionalText(value.windowTitle ?? value.title, "primaryApplication.windowTitle", 160);
}

function sameText(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
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

function optionalObjectArray(value, location, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${location}: expected an array.`);
  }
  return value.slice(0, maxItems).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${location}[${index}]: expected an object.`);
    }
    return item;
  });
}

function optionalText(value, location, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, location, maxLength);
}

function optionalHostname(value, location) {
  if (value === undefined || value === null || value === "") return null;
  let hostname = requireText(value, location, 500).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    let url;
    try {
      url = new URL(hostname);
    } catch {
      throw new Error(`${location}: expected a hostname only.`);
    }
    hostname = url.hostname;
  } else if (hostname.includes("/") && !/\s/.test(hostname)) {
    let url;
    try {
      url = new URL(`https://${hostname}`);
    } catch {
      throw new Error(`${location}: expected a hostname only.`);
    }
    hostname = url.hostname;
  }
  if (
    hostname.includes("/") ||
    hostname.includes("?") ||
    hostname.includes("#") ||
    hostname.includes("@") ||
    /\s/.test(hostname)
  ) {
    throw new Error(`${location}: expected a hostname only.`);
  }
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(hostname)) {
    throw new Error(`${location}: contains unsupported hostname characters.`);
  }
  return hostname;
}

function optionalApplicationHostname(value, location) {
  try {
    return optionalHostname(value, location);
  } catch {
    return null;
  }
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
