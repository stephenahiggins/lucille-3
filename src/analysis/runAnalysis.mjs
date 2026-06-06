import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyseObservationWithOllama,
  isLocalVisualProviderUnavailable
} from "./ollamaProvider.mjs";
import { buildActivityTimeline } from "./activityTimeline.mjs";
import { buildSessionAnalysis } from "./sessionAnalysis.mjs";
import { synthesizeWithOpenAI } from "./openaiSynthesis.mjs";
import { buildTaskSkillSummaryFromArtifacts } from "./taskSkillSummary.mjs";
import { updateUserMemory } from "./userMemory.mjs";
import { buildOptimizationWrapUp } from "./wrapUp.mjs";
import { validateObservations } from "./observations.mjs";
import { normalizeFrameWorkSummary } from "./frameWorkSummary.mjs";
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
  root: process.cwd(),
  onFrameProgress: null
};
const frameCacheVersion = "frame-analysis-cache.v1";
const framePromptVersion = "frame-analysis-visual-app-url-memory-1536-primary-url-2026-06-06";
const legacyFramePromptVersions = [
  "frame-analysis-visual-app-url-memory-1536-2026-06-06"
];

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
    env: config.env,
    ollamaEndpoint: config.ollamaEndpoint ?? config.env.OLLAMA_HOST,
    onFrameProgress: config.onFrameProgress
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
  const sessionAnalysis = buildSessionAnalysis({
    day,
    frames: frameAnalysis,
    activityTimeline
  });
  assertPrivacySafe(sessionAnalysis, "sessionAnalysis");

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
  const { memory: userMemory, update: memoryUpdate } = updateUserMemory({
    root: config.root,
    day,
    frames: frameAnalysis,
    sessionAnalysis,
    activityTimeline,
    workPatterns,
    skillProposals
  });
  assertPrivacySafe(userMemory, "userMemory");
  assertPrivacySafe(memoryUpdate, "memoryUpdate");
  const optimizationWrapUp = buildOptimizationWrapUp({
    day,
    frames: frameAnalysis,
    sessionAnalysis,
    workPatterns,
    skillProposals,
    userMemory
  });
  assertPrivacySafe(optimizationWrapUp, "optimizationWrapUp");

  writeFileSync(
    path.join(analysisDir, "frame-analysis.jsonl"),
    frameAnalysis.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
  );
  writeJson(path.join(analysisDir, "activity-timeline.json"), activityTimeline);
  writeJson(path.join(analysisDir, "session-analysis.json"), sessionAnalysis);
  writeJson(path.join(analysisDir, "work-patterns.json"), workPatterns);
  writeJson(path.join(analysisDir, "skill-proposals.json"), skillProposals);
  writeJson(path.join(analysisDir, "task-skill-summary.json"), taskSkillSummary);
  writeJson(path.join(analysisDir, "memory-update.json"), memoryUpdate);
  writeJson(path.join(analysisDir, "optimization-wrap-up.json"), optimizationWrapUp);

  return {
    day,
    analysisDir,
    frameCount: frameAnalysis.length,
    sessionCount: sessionAnalysis.sessions.length,
    timelineSegmentCount: activityTimeline.segments.length,
    patternCount: workPatterns.patterns.length,
    proposalCount: skillProposals.proposals.length,
    commonTaskCount: taskSkillSummary.commonTasks.length,
    memoryRegularTaskCount: userMemory.regularTasks.length,
    wrapUpRecommendationCount: optimizationWrapUp.efficiencyRecommendations.length,
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
  env,
  ollamaEndpoint,
  onFrameProgress
}) {
  try {
    const frameAnalysis = [];
    for (const [index, observation] of observations.entries()) {
      const cached = readCachedFrameAnalysis({ root, day, model, observation });
      if (cached) {
        reportFrameProgress(onFrameProgress, {
          index,
          total: observations.length,
          observation,
          status: "cached"
        });
        frameAnalysis.push(cached);
        continue;
      }
      reportFrameProgress(onFrameProgress, {
        index,
        total: observations.length,
        observation,
        status: "analysing"
      });
      const frame = await analyseObservationWithOllama({
        root,
        day,
        observation,
        evidenceNumber: index + 1,
        model,
        fetchImpl,
        env,
        endpoint: ollamaEndpoint
      });
      writeCachedFrameAnalysis({ root, day, model, observation, frame });
      reportFrameProgress(onFrameProgress, {
        index,
        total: observations.length,
        observation,
        status: "analysed"
      });
      frameAnalysis.push(frame);
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

function reportFrameProgress(onFrameProgress, event) {
  if (typeof onFrameProgress !== "function") return;
  onFrameProgress({
    ...event,
    number: event.index + 1
  });
}

function readCachedFrameAnalysis({ root, day, model, observation }) {
  for (const cachePath of frameCachePaths({ root, day, model, observation })) {
    if (!existsSync(cachePath)) continue;
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      cached.schemaVersion !== frameCacheVersion ||
      ![framePromptVersion, ...legacyFramePromptVersions].includes(cached.promptVersion) ||
      cached.model !== model ||
      cached.frameId !== observation.id ||
      cached.frame?.schemaVersion !== "frame-analysis.v1"
    ) {
      continue;
    }
    assertPrivacySafe(cached, "frameAnalysisCache");
    return normalizeCachedFrame(cached.frame);
  }
  return null;
}

function writeCachedFrameAnalysis({ root, day, model, observation, frame }) {
  const cachePath = frameCachePath({ root, day, model, observation });
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const cached = {
    schemaVersion: frameCacheVersion,
    promptVersion: framePromptVersion,
    provider: "ollama",
    model,
    day,
    frameId: observation.id,
    evidenceId: frame.evidenceId,
    cachedAt: new Date().toISOString(),
    frame
  };
  assertPrivacySafe(cached, "frameAnalysisCache");
  writeFileSync(cachePath, JSON.stringify(cached, null, 2) + "\n");
}

function frameCachePath({ root, day, model, observation }) {
  return frameCachePathForVersion({ root, day, model, observation, promptVersion: framePromptVersion });
}

function frameCachePaths({ root, day, model, observation }) {
  return [framePromptVersion, ...legacyFramePromptVersions].map((promptVersion) => (
    frameCachePathForVersion({ root, day, model, observation, promptVersion })
  ));
}

function frameCachePathForVersion({ root, day, model, observation, promptVersion }) {
  return path.join(
    root,
    "storage",
    "analysis",
    day,
    "frame-cache",
    slugify(model),
    promptVersion,
    `${observation.id}.json`
  );
}

function normalizeCachedFrame(frame) {
  if (isGenericUnknownCachedFrame(frame)) {
    return normalizeGenericUnknownCachedFrame(frame);
  }

  const rawApplications = Array.isArray(frame.applications)
    ? frame.applications.map((application) => {
      const text = applicationSlackDiscordCueText(application);
      if (application.name === "Discord" && /\barbor\b/.test(text)) {
        return {
          ...application,
          name: "Slack",
          domain: "arbor-data-and-ai.slack.com",
          primaryReason: replaceCommunicationAppWithSlack(application.primaryReason)
        };
      }
      return {
        ...application,
        domain: application.name === "GitHub" ? "github.com" : application.domain,
        primaryReason: application.name === "Slack"
          ? replaceCommunicationAppWithSlack(application.primaryReason)
          : application.primaryReason
      };
    })
    : [];
  let applications = normalizeCachedSlackDominantCommunicationMix(
    normalizeCachedCalendarApplicationMix(rawApplications)
  );
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  const hasGoogleCalendar = applications.some((application) => application.name === "Google Calendar");
  const shouldCleanSlackText = hasSlack && !hasDiscord && !hasTeams;
  const shouldCleanCalendarText = hasGoogleCalendar && !hasTeams;
  const primaryApplication = normalizeCachedPrimaryApplication(frame.primaryApplication, applications);
  applications = ensureCachedSinglePrimary(applications, primaryApplication);
  const normalizeCachedText = (text) => {
    let normalized = text;
    if (shouldCleanSlackText) normalized = replaceCommunicationAppWithSlack(normalized);
    if (shouldCleanCalendarText) normalized = replaceTeamsWithGoogleCalendar(normalized);
    return normalized;
  };

  return normalizeFrameWorkSummary({
    ...frame,
    applications,
    primaryApplication,
    visitedUrls: normalizeCachedVisitedUrls(frame.visitedUrls, applications),
    keyTasks: (shouldCleanSlackText || shouldCleanCalendarText) && Array.isArray(frame.keyTasks)
      ? frame.keyTasks.map(normalizeCachedText)
      : frame.keyTasks,
    evidence: (shouldCleanSlackText || shouldCleanCalendarText) && Array.isArray(frame.evidence)
      ? frame.evidence.map((item) => ({
        ...item,
        summary: normalizeCachedText(item.summary)
      }))
      : frame.evidence,
    riskFlags: (shouldCleanSlackText || shouldCleanCalendarText) && Array.isArray(frame.riskFlags)
      ? frame.riskFlags.map(normalizeCachedText)
      : frame.riskFlags
  });
}

function isGenericUnknownCachedFrame(frame) {
  const applications = Array.isArray(frame.applications) ? frame.applications : [];
  const evidence = Array.isArray(frame.evidence) ? frame.evidence : [];
  const allApplicationsUnknown = applications.length === 0 || applications.every((application) => application?.name === "Unknown");
  const text = [
    frame.visibleIntent,
    ...(Array.isArray(frame.activities) ? frame.activities : []),
    ...(Array.isArray(frame.keyTasks) ? frame.keyTasks : []),
    ...evidence.map((item) => item?.summary)
  ].join(" ").toLowerCase();
  return allApplicationsUnknown && /imported|archive|raw media|structured metadata|screen frame/.test(text);
}

function normalizeGenericUnknownCachedFrame(frame) {
  const application = {
    name: "No visible application",
    windowTitle: null,
    domain: null,
    isPrimary: true,
    primaryReason: "The frame is blank, obscured, or contains no identifiable application UI."
  };
  return {
    ...frame,
    activities: ["blank_or_obscured_screen"],
    visibleIntent: "No visible application or work surface can be identified in this frame.",
    applications: [application],
    primaryApplication: {
      name: application.name,
      windowTitle: application.windowTitle,
      domain: application.domain,
      primaryReason: application.primaryReason
    },
    visitedUrls: [],
    keyTasks: ["No visible work surface identified"],
    evidence: [
      {
        id: frame.evidenceId ?? frame.frameId,
        kind: "local_visual_summary",
        summary: "The captured frame is blank, obscured, or too dark to identify an application."
      }
    ],
    riskFlags: []
  };
}

function normalizeCachedVisitedUrls(visitedUrls, applications) {
  const urls = Array.isArray(visitedUrls)
    ? visitedUrls.filter(isPlausibleVisitedUrl)
    : [];
  for (const application of applications) {
    const url = applicationDomainVisitedUrl(application);
    if (url) urls.push(url);
  }
  return unique(urls)
    .filter(isPlausibleVisitedUrl)
    .filter((url) => isVisitedUrlConsistentWithApplications(url, applications))
    .slice(0, 12);
}

function applicationDomainVisitedUrl(application) {
  if (!application?.domain || !isWebApplicationWithUrl(application.name)) return null;
  const value = String(application.domain);
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.hostname}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

function isWebApplicationWithUrl(name) {
  return /\b(browser|chrome|safari|firefox|edge|arc|brave|vivaldi|chromium)\b/i.test(String(name ?? "")) ||
    /^(github|jira|google calendar)$/i.test(String(name ?? ""));
}

function ensureCachedSinglePrimary(applications, primaryApplication) {
  if (applications.length === 0) return applications;
  let primaryIndex = primaryApplication
    ? applications.findIndex((application) => (
      application.name === primaryApplication.name &&
      (
        !primaryApplication.windowTitle ||
        !application.windowTitle ||
        application.windowTitle === primaryApplication.windowTitle
      )
    ))
    : -1;
  if (primaryIndex === -1) {
    primaryIndex = applications.findIndex((application) => application.isPrimary);
  }
  if (primaryIndex === -1) primaryIndex = 0;
  return applications.map((application, index) => ({
    ...application,
    isPrimary: index === primaryIndex
  }));
}

function normalizeCachedPrimaryApplication(primaryApplication, applications) {
  if (!primaryApplication) return primaryApplication;
  const primaryFromApplications = applications.find((application) => application.isPrimary);
  if (
    primaryFromApplications &&
    (primaryApplication.name === "Discord" || primaryApplication.name === "Microsoft Teams") &&
    primaryFromApplications.name === "Slack"
  ) {
    return {
      name: primaryFromApplications.name,
      windowTitle: primaryFromApplications.windowTitle,
      domain: primaryFromApplications.domain,
      primaryReason: replaceCommunicationAppWithSlack(primaryFromApplications.primaryReason)
    };
  }
  if (
    primaryFromApplications &&
    primaryApplication.name === "Microsoft Teams" &&
    primaryFromApplications.name === "Google Calendar"
  ) {
    return {
      name: primaryFromApplications.name,
      windowTitle: primaryFromApplications.windowTitle,
      domain: primaryFromApplications.domain,
      primaryReason: replaceTeamsWithGoogleCalendar(primaryFromApplications.primaryReason)
    };
  }
  return primaryApplication.name === "Discord" && /\barbor\b/i.test(`${primaryApplication.windowTitle ?? ""} ${primaryApplication.domain ?? ""}`)
    ? {
      ...primaryApplication,
      name: "Slack",
      domain: "arbor-data-and-ai.slack.com",
      primaryReason: replaceCommunicationAppWithSlack(primaryApplication.primaryReason)
    }
    : primaryApplication.name === "GitHub"
      ? {
        ...primaryApplication,
        domain: "github.com"
      }
    : primaryApplication.name === "Slack"
      ? {
        ...primaryApplication,
        primaryReason: replaceCommunicationAppWithSlack(primaryApplication.primaryReason)
      }
      : primaryApplication;
}

function normalizeCachedSlackDominantCommunicationMix(applications) {
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  const hasBrowser = applications.some((application) => /\b(browser|chrome|safari|firefox|edge|arc|brave|vivaldi|chromium)\b/i.test(String(application.name ?? "")));
  const hasAmbiguousTeamsOnlyChat = !hasSlack && !hasDiscord && hasTeams && !hasBrowser &&
    applications.some((application) => application.name === "Microsoft Teams" && !hasSpecificTeamsCue(application));
  if (!hasSlack && !(hasDiscord && hasTeams && !hasBrowser) && !hasAmbiguousTeamsOnlyChat) return dedupeCachedApplications(applications);
  const slackCueText = applications.map(applicationSlackDiscordCueText).join(" ");
  const hasStrongSlackCue = (
    /\bslack\b/.test(slackCueText) ||
    /\bslack\.com\b/.test(slackCueText) ||
    /\bpurple workspace sidebar\b/.test(slackCueText) ||
    /\bworkspace sidebar\b/.test(slackCueText) ||
    /\b(arbor-data-and-ai|engineering slack)\b/.test(slackCueText)
  );
  const hasAmbiguousMixedChatHallucination = !hasSlack && hasDiscord && hasTeams && !hasBrowser;
  if (!hasStrongSlackCue && !hasAmbiguousMixedChatHallucination && !hasAmbiguousTeamsOnlyChat) return dedupeCachedApplications(applications);
  if (applications.some((application) => application.name === "Discord" && application.isPrimary && hasSpecificDiscordCue(application))) {
    return dedupeCachedApplications(applications);
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
  return dedupeCachedApplications(normalized);
}

function normalizeCachedCalendarApplicationMix(applications) {
  const normalized = applications.map((application) => {
    if (application.name !== "Microsoft Teams" || !looksLikeCalendarSurface(application) || hasSpecificTeamsCue(application)) {
      return application;
    }
    return {
      ...application,
      name: "Google Calendar",
      windowTitle: "Google Calendar",
      domain: "calendar.google.com",
      primaryReason: replaceTeamsWithGoogleCalendar(application.primaryReason)
    };
  });
  return dedupeCachedApplications(normalized);
}

function applicationSlackDiscordCueText(application) {
  return `${application?.name ?? ""} ${application?.windowTitle ?? ""} ${application?.domain ?? ""} ${application?.primaryReason ?? ""}`.toLowerCase();
}

function hasSpecificDiscordCue(application) {
  const text = applicationSlackDiscordCueText(application);
  return (
    /\b(discordapp\.com|discord\.gg|server icon|voice channel|voice controls|discord branding)\b/.test(text) ||
    /\bcursor\b.*\bdiscord\b/.test(text) ||
    /\bdiscord\b.*\bcursor\b/.test(text)
  );
}

function hasSpecificTeamsCue(application) {
  const text = applicationSlackDiscordCueText(application);
  return /\b(teams navigation|teams tenant|calls|team list|teams list|activity feed)\b/.test(text);
}

function looksLikeCalendarSurface(application) {
  const text = applicationSlackDiscordCueText(application);
  return /\b(calendar|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(text);
}

function replaceTeamsWithGoogleCalendar(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\bMicrosoft Teams calendar\b/gi, "Google Calendar")
    .replace(/\bTeams calendar\b/gi, "Google Calendar")
    .replace(/\bMicrosoft Teams\b/g, "Google Calendar")
    .replace(/\bTeams\b/g, "Google Calendar")
    .replace(/\bteams\b/g, "Google Calendar");
}

function dedupeCachedApplications(applications) {
  const seen = new Set();
  const deduped = [];
  for (const application of applications) {
    const key = application.name === "Slack"
      ? `${application.name.toLowerCase()}|${application.domain ?? "slack.com"}`
      : `${application.name?.toLowerCase() ?? ""}|${application.windowTitle?.toLowerCase() ?? ""}|${application.domain ?? ""}`;
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

function isPlausibleVisitedUrl(value) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (
        url.hostname === "localhost" ||
        url.hostname.endsWith(".local") ||
        url.hostname.includes(".") ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
      ) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isVisitedUrlConsistentWithApplications(value, applications) {
  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hasSlack = applications.some((application) => application.name === "Slack");
  const hasDiscord = applications.some((application) => application.name === "Discord");
  const hasTeams = applications.some((application) => application.name === "Microsoft Teams");
  const hasBrowserOnHostname = applications.some((application) => (
    /\b(browser|chrome|safari|firefox|edge|arc|brave|vivaldi|chromium)\b/i.test(String(application.name ?? "")) &&
    typeof application.domain === "string" &&
    (application.domain.toLowerCase() === hostname || application.domain.toLowerCase().endsWith(`.${hostname}`))
  ));

  if ((hostname === "discord.com" || hostname.endsWith(".discord.com")) && !hasDiscord && !hasBrowserOnHostname) return false;
  if ((hostname === "slack.com" || hostname.endsWith(".slack.com")) && !hasSlack && !hasBrowserOnHostname) return false;
  if ((hostname === "teams.microsoft.com" || hostname.endsWith(".teams.microsoft.com")) && !hasTeams && !hasBrowserOnHostname) return false;
  return true;
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
  const repeatedTasks = tasks.filter((task) => task.frameCount > 1 || task.segmentCount > 1);
  const candidateTasks = repeatedTasks.length > 0 ? repeatedTasks : tasks;
  const usedIds = new Set();

  return candidateTasks.slice(0, 5).map((task) => {
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
