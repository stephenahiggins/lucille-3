import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPrivacySafe } from "../privacy/safety.mjs";

const memorySchemaVersion = "user-memory.v1";
const updateSchemaVersion = "memory-update.v1";
const maxEntries = 20;
const maxEvidenceIds = 50;

export function updateUserMemory({ root, day, frames, sessionAnalysis, activityTimeline, workPatterns, skillProposals }) {
  const memoryPath = path.join(root, "storage", "memory", "user-memory.json");
  const previous = readExistingMemory(memoryPath);
  const generatedAt = new Date().toISOString();
  const dayProfile = buildDayProfile({ day, frames, sessionAnalysis, activityTimeline, workPatterns, skillProposals });
  const memory = mergeMemory(previous, dayProfile, generatedAt);
  const update = {
    schemaVersion: updateSchemaVersion,
    day,
    generatedAt,
    memoryPath: path.relative(root, memoryPath),
    dayProfile,
    memorySummary: {
      analysedDayCount: memory.analysedDays.length,
      regularTaskCount: memory.regularTasks.length,
      frequentApplicationCount: memory.frequentApplications.length,
      frequentWebsiteCount: memory.frequentWebsites.length,
      frequentCommandCount: memory.frequentCommands.length,
      workflowImprovementCount: memory.workflowImprovements.length,
      skillRecommendationCount: memory.skillRecommendations.length
    }
  };

  assertPrivacySafe(update, "memoryUpdate");
  assertPrivacySafe(memory, "userMemory");
  mkdirSync(path.dirname(memoryPath), { recursive: true });
  writeFileSync(memoryPath, JSON.stringify(memory, null, 2) + "\n");
  return { memory, update };
}

function readExistingMemory(memoryPath) {
  if (!existsSync(memoryPath)) return emptyMemory();
  const parsed = JSON.parse(readFileSync(memoryPath, "utf8"));
  if (parsed.schemaVersion !== memorySchemaVersion) {
    throw new Error(`Unsupported user memory schema: ${parsed.schemaVersion}`);
  }
  assertPrivacySafe(parsed, "existingUserMemory");
  return parsed;
}

function emptyMemory() {
  return {
    schemaVersion: memorySchemaVersion,
    createdAt: null,
    updatedAt: null,
    learningPolicy: "Updates only from privacy-safe structured analysis artifacts; no raw screenshots, keystrokes, clipboard, audio, raw document bodies, raw message bodies, credentials, cookies, or query-string URLs.",
    analysedDays: [],
    dayProfiles: [],
    regularTasks: [],
    frequentApplications: [],
    frequentWebsites: [],
    frequentCommands: [],
    workflowImprovements: [],
    skillRecommendations: [],
    procrastinationSignals: []
  };
}

function buildDayProfile({ day, frames, sessionAnalysis, activityTimeline, workPatterns, skillProposals }) {
  return {
    day,
    frameCount: frames.length,
    sessionCount: sessionAnalysis.sessions.length,
    analysedAtRange: {
      firstAt: frames.map((frame) => frame.capturedAt).sort()[0] ?? null,
      lastAt: frames.map((frame) => frame.capturedAt).sort().at(-1) ?? null
    },
    taskSignals: activityTimeline.commonTasks.slice(0, maxEntries).map((task) => ({
      id: stableId(task.title),
      title: task.title,
      day,
      lastUserIntent: task.userIntent,
      observedFrameCount: task.frameCount,
      observedSessionCount: task.segmentCount,
      totalDwellTimeSeconds: task.totalDwellTimeSeconds,
      confidence: task.confidence,
      applications: topNamesFromSessions(sessionAnalysis.sessions, task.segmentIds),
      websites: topUrlsFromSessions(sessionAnalysis.sessions, task.segmentIds),
      commands: topCommandsFromSessions(sessionAnalysis.sessions, task.segmentIds),
      evidenceIds: representativeEvidenceIds(task.evidenceIds),
      workflowImprovement: task.recommendationSeeds[0] ?? "Review this repeated workflow for a template, checklist, or automation."
    })),
    applicationSignals: countApplications(frames),
    websiteSignals: countWebsites(frames),
    commandSignals: countCommands(sessionAnalysis.sessions),
    workflowImprovements: workPatterns.patterns.slice(0, maxEntries).map((pattern) => ({
      id: stableId(pattern.title),
      title: pattern.title,
      firstSeenDay: day,
      lastSeenDay: day,
      recommendation: pattern.recommendation,
      estimatedMinutesPerWeek: pattern.estimatedMinutesPerWeek,
      confidence: pattern.confidence,
      evidenceIds: representativeEvidenceIds(pattern.repeatedAcrossEvidence)
    })),
    skillRecommendations: skillProposals.proposals.slice(0, maxEntries).map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      firstSeenDay: day,
      lastSeenDay: day,
      category: proposal.category,
      estimatedMinutesPerWeek: proposal.estimatedMinutesPerWeek,
      confidence: proposal.confidence,
      evidenceIds: representativeEvidenceIds(proposal.evidenceIds)
    })),
    procrastinationSignals: inferProcrastinationSignals(frames, sessionAnalysis)
  };
}

function mergeMemory(previous, dayProfile, generatedAt) {
  const createdAt = previous.createdAt ?? generatedAt;
  const dayProfiles = [
    ...(previous.dayProfiles ?? []).filter((profile) => profile.day !== dayProfile.day),
    dayProfile
  ].sort((left, right) => left.day.localeCompare(right.day)).slice(-30);
  const analysedDays = dayProfiles.map((profile) => profile.day);
  const regularTasks = [];
  const frequentApplications = [];
  const frequentWebsites = [];
  const frequentCommands = [];
  const workflowImprovements = [];
  const skillRecommendations = [];
  const procrastinationSignals = [];
  const taskDayCounts = countTaskDays(dayProfiles);

  for (const profile of dayProfiles) {
    const regularTaskSignals = profile.taskSignals.filter((signal) => (
      signal.observedFrameCount > 1 || (taskDayCounts.get(signal.id) ?? 0) > 1
    ));
    regularTasks.splice(0, regularTasks.length, ...mergeSignals(regularTasks, regularTaskSignals, mergeTaskSignal).slice(0, maxEntries));
    frequentApplications.splice(0, frequentApplications.length, ...mergeSignals(frequentApplications, profile.applicationSignals, mergeCountSignal).slice(0, maxEntries));
    frequentWebsites.splice(0, frequentWebsites.length, ...mergeSignals(frequentWebsites, profile.websiteSignals, mergeCountSignal).slice(0, maxEntries));
    frequentCommands.splice(0, frequentCommands.length, ...mergeSignals(frequentCommands, profile.commandSignals, mergeCountSignal).slice(0, maxEntries));
    workflowImprovements.splice(0, workflowImprovements.length, ...mergeSignals(workflowImprovements, profile.workflowImprovements, mergeImprovementSignal).slice(0, maxEntries));
    skillRecommendations.splice(0, skillRecommendations.length, ...mergeSignals(skillRecommendations, profile.skillRecommendations, mergeSkillSignal).slice(0, maxEntries));
    procrastinationSignals.splice(0, procrastinationSignals.length, ...mergeSignals(procrastinationSignals, profile.procrastinationSignals, mergeCountSignal).slice(0, maxEntries));
  }

  return {
    schemaVersion: memorySchemaVersion,
    createdAt,
    updatedAt: generatedAt,
    learningPolicy: previous.learningPolicy,
    analysedDays,
    dayProfiles,
    regularTasks,
    frequentApplications,
    frequentWebsites,
    frequentCommands,
    workflowImprovements,
    skillRecommendations,
    procrastinationSignals
  };
}

function countTaskDays(dayProfiles) {
  const counts = new Map();
  for (const profile of dayProfiles) {
    for (const signal of profile.taskSignals) {
      counts.set(signal.id, (counts.get(signal.id) ?? 0) + 1);
    }
  }
  return counts;
}

function mergeSignals(existing, incoming, merger) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    byId.set(item.id, merger(byId.get(item.id), item));
  }
  return [...byId.values()].sort((left, right) => signalScore(right) - signalScore(left) || left.title.localeCompare(right.title));
}

function mergeTaskSignal(previous, incoming) {
  return {
    id: incoming.id,
    title: incoming.title,
    firstSeenDay: previous?.firstSeenDay ?? incoming.day ?? null,
    lastSeenDay: incoming.day ?? previous?.lastSeenDay ?? null,
    lastUserIntent: incoming.lastUserIntent,
    observedFrameCount: (previous?.observedFrameCount ?? 0) + incoming.observedFrameCount,
    observedSessionCount: (previous?.observedSessionCount ?? 0) + incoming.observedSessionCount,
    totalDwellTimeSeconds: (previous?.totalDwellTimeSeconds ?? 0) + incoming.totalDwellTimeSeconds,
    confidence: Math.max(previous?.confidence ?? 0, incoming.confidence),
    typicalApplications: mergeLists(previous?.typicalApplications, incoming.applications, "name"),
    typicalWebsites: mergeLists(previous?.typicalWebsites, incoming.websites, "url"),
    typicalCommands: mergeLists(previous?.typicalCommands, incoming.commands, "command"),
    evidenceIds: representativeEvidenceIds([...(previous?.evidenceIds ?? []), ...incoming.evidenceIds]),
    workflowImprovement: incoming.workflowImprovement
  };
}

function mergeCountSignal(previous, incoming) {
  return {
    ...incoming,
    count: (previous?.count ?? 0) + incoming.count,
    firstSeenDay: previous?.firstSeenDay ?? incoming.firstSeenDay,
    lastSeenDay: incoming.lastSeenDay,
    evidenceIds: representativeEvidenceIds([...(previous?.evidenceIds ?? []), ...(incoming.evidenceIds ?? [])])
  };
}

function mergeImprovementSignal(previous, incoming) {
  return {
    ...incoming,
    observedCount: (previous?.observedCount ?? 0) + 1,
    firstSeenDay: previous?.firstSeenDay ?? incoming.firstSeenDay,
    lastSeenDay: incoming.lastSeenDay,
    confidence: Math.max(previous?.confidence ?? 0, incoming.confidence),
    evidenceIds: representativeEvidenceIds([...(previous?.evidenceIds ?? []), ...incoming.evidenceIds])
  };
}

function mergeSkillSignal(previous, incoming) {
  return mergeImprovementSignal(previous, incoming);
}

function topNamesFromSessions(sessions, segmentIds) {
  return countItems(sessionsForSegments(sessions, segmentIds).flatMap((session) => session.applications), "name").slice(0, 8);
}

function topUrlsFromSessions(sessions, segmentIds) {
  return countItems(sessionsForSegments(sessions, segmentIds).flatMap((session) => session.visitedUrls), "url").slice(0, 8);
}

function topCommandsFromSessions(sessions, segmentIds) {
  return countItems(sessionsForSegments(sessions, segmentIds).flatMap((session) => session.commands), "command").slice(0, 8);
}

function sessionsForSegments(sessions, segmentIds) {
  const wanted = new Set(segmentIds);
  return sessions.filter((session) => wanted.has(session.id));
}

function countApplications(frames) {
  return countItems(frames.flatMap((frame) => (
    Array.isArray(frame.applications)
      ? frame.applications.map((application) => ({
        name: application.name,
        count: 1,
        evidenceIds: [frame.evidenceId],
        firstSeenDay: frame.day,
        lastSeenDay: frame.day
      }))
      : []
  )), "name");
}

function countWebsites(frames) {
  return countItems(frames.flatMap((frame) => (
    Array.isArray(frame.visitedUrls)
      ? frame.visitedUrls.map((url) => ({
        url,
        count: 1,
        evidenceIds: [frame.evidenceId],
        firstSeenDay: frame.day,
        lastSeenDay: frame.day
      }))
      : []
  )), "url");
}

function countCommands(sessions) {
  return countItems(sessions.flatMap((session) => (
    session.commands.map((command) => ({
      command: command.command,
      count: command.count,
      evidenceIds: session.evidenceIds,
      firstSeenDay: session.startAt.slice(0, 10),
      lastSeenDay: session.endAt.slice(0, 10)
    }))
  )), "command");
}

function countItems(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item?.[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const id = stableId(value);
    const existing = counts.get(id) ?? {
      id,
      [key]: value,
      title: value,
      count: 0,
      firstSeenDay: item.firstSeenDay,
      lastSeenDay: item.lastSeenDay,
      evidenceIds: []
    };
    existing.count += item.count ?? 1;
    existing.evidenceIds = representativeEvidenceIds([...existing.evidenceIds, ...(item.evidenceIds ?? [])]);
    existing.lastSeenDay = item.lastSeenDay ?? existing.lastSeenDay;
    counts.set(id, existing);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.title.localeCompare(right.title));
}

function mergeLists(existing = [], incoming = [], key) {
  return countItems([...existing, ...incoming], key).slice(0, 8);
}

function inferProcrastinationSignals(frames, sessionAnalysis) {
  const distractingPattern = /\b(youtube|netflix|tiktok|instagram|facebook|reddit|x\.com|twitter|shopping|game|games|news)\b/i;
  const signals = countItems(frames.flatMap((frame) => {
    const text = [
      frame.primaryApplication?.name,
      frame.primaryApplication?.domain,
      ...(Array.isArray(frame.visitedUrls) ? frame.visitedUrls : [])
    ].join(" ");
    if (!distractingPattern.test(text)) return [];
    return [{
      name: frame.primaryApplication?.name ?? "Potential distraction",
      count: 1,
      evidenceIds: [frame.evidenceId],
      firstSeenDay: frame.day,
      lastSeenDay: frame.day
    }];
  }), "name");
  const totalSeconds = sessionAnalysis.sessions
    .filter((session) => distractingPattern.test(`${session.focusApplication} ${session.visitedUrls.map((item) => item.url).join(" ")}`))
    .reduce((sum, session) => sum + session.durationSeconds, 0);
  return signals.map((signal) => ({
    ...signal,
    estimatedSeconds: totalSeconds,
    title: `${signal.name} possible non-work focus`,
    interpretation: totalSeconds > 0
      ? "Possible distraction signal based on visible app or URL context; requires user review."
      : "Weak possible distraction signal based on visible app or URL context; requires user review."
  }));
}

function signalScore(item) {
  return item.observedFrameCount ?? item.totalDwellTimeSeconds ?? item.estimatedMinutesPerWeek ?? item.count ?? item.confidence ?? 0;
}

function stableId(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown";
}

function representativeEvidenceIds(evidenceIds) {
  const clean = [...new Set(evidenceIds.filter((id) => typeof id === "string" && id.trim() !== ""))];
  if (clean.length <= maxEvidenceIds) return clean;
  const head = clean.slice(0, Math.floor(maxEvidenceIds / 2));
  const tail = clean.slice(clean.length - (maxEvidenceIds - head.length));
  return [...new Set([...head, ...tail])];
}
