import { assertPrivacySafe } from "../privacy/safety.mjs";

const maxItems = 12;
const maxEvidenceIds = 50;

export function buildSessionAnalysis({ day, frames, activityTimeline }) {
  const sessions = activityTimeline.segments.map((segment) => {
    const sessionFrames = framesInRange(frames, segment.startAt, segment.endAt);
    const primaryApplications = countValues(sessionFrames.map((frame) => frame.primaryApplication?.name));
    const applications = countValues(sessionFrames.flatMap((frame) => (
      Array.isArray(frame.applications) ? frame.applications.map((application) => application.name) : []
    )));
    const visitedUrls = countValues(sessionFrames.flatMap((frame) => (
      Array.isArray(frame.visitedUrls) ? frame.visitedUrls : []
    )));
    const commands = countValues(sessionFrames.flatMap(extractCommandsFromFrame));
    const focusApplication = primaryApplications[0]?.value ?? applications[0]?.value ?? "Unknown";

    return {
      id: segment.id,
      title: segment.title,
      startAt: segment.startAt,
      endAt: segment.endAt,
      durationSeconds: segment.dwellTimeSeconds,
      frameCount: segment.frameCount,
      focusApplication,
      applications: applications.slice(0, maxItems).map(toCountItem),
      primaryApplications: primaryApplications.slice(0, maxItems).map(toCountItem),
      visitedUrls: visitedUrls.slice(0, maxItems).map(toCountItem),
      commands: commands.slice(0, maxItems).map(toCountItem),
      contextSwitchCount: segment.surfaceSwitchCount,
      userIntent: segment.userIntent,
      focusSummary: buildFocusSummary({ focusApplication, segment, visitedUrls, commands }),
      keyTasks: countValues(segment.evidenceTrail.flatMap((entry) => entry.keyTasks)).slice(0, 8).map((item) => item.value),
      recommendationSeeds: segment.recommendationSeeds.slice(0, 8),
      evidenceIds: representativeEvidenceIds(segment.evidenceIds),
      confidence: segment.confidence
    };
  });

  const analysis = {
    schemaVersion: "session-analysis.v1",
    day,
    sourceFrameCount: frames.length,
    sourceTimelineSegmentCount: activityTimeline.segments.length,
    aggregationStrategy: "timeline_segments_enriched_with_frame_app_url_command_evidence",
    sessions,
    totals: buildTotals({ frames, sessions })
  };

  assertPrivacySafe(analysis, "sessionAnalysis");
  return analysis;
}

function framesInRange(frames, startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return frames.filter((frame) => {
    const timestamp = Date.parse(frame.capturedAt);
    return timestamp >= start && timestamp <= end;
  });
}

function buildTotals({ frames, sessions }) {
  return {
    sessionCount: sessions.length,
    analysedFrameCount: frames.length,
    totalDurationSeconds: sessions.reduce((sum, session) => sum + session.durationSeconds, 0),
    totalContextSwitchCount: sessions.reduce((sum, session) => sum + session.contextSwitchCount, 0),
    applications: countValues(sessions.flatMap((session) => (
      session.applications.flatMap((item) => Array.from({ length: item.count }, () => item.name))
    ))).slice(0, maxItems).map(toCountItem),
    visitedUrls: countValues(sessions.flatMap((session) => (
      session.visitedUrls.flatMap((item) => Array.from({ length: item.count }, () => item.url))
    ))).slice(0, maxItems).map(toCountItem),
    commands: countValues(sessions.flatMap((session) => (
      session.commands.flatMap((item) => Array.from({ length: item.count }, () => item.command))
    ))).slice(0, maxItems).map(toCountItem)
  };
}

function buildFocusSummary({ focusApplication, segment, visitedUrls, commands }) {
  const urlText = visitedUrls.length > 0 ? ` Visible browser context included ${visitedUrls.slice(0, 3).map((item) => item.value).join(", ")}.` : "";
  const commandText = commands.length > 0 ? ` Repeated command context included ${commands.slice(0, 3).map((item) => item.value).join(", ")}.` : "";
  return truncateText(
    `${segment.frameCount} frame(s) show focus around ${focusApplication}: ${segment.userIntent}${urlText}${commandText}`,
    500
  );
}

function extractCommandsFromFrame(frame) {
  const text = [
    frame.visibleIntent,
    ...(Array.isArray(frame.activities) ? frame.activities : []),
    ...(Array.isArray(frame.keyTasks) ? frame.keyTasks : []),
    ...(Array.isArray(frame.evidence) ? frame.evidence.map((item) => item.summary) : [])
  ].join(" ");
  const matches = text.match(/\b(?:npm|pnpm|yarn|node|python3?|make|git|gh|ollama|codex)\s+[a-z0-9:._/-]+(?:\s+[a-z0-9:._/-]+){0,4}/g) ?? [];
  return matches
    .map((match) => match.trim().replace(/\s+/g, " "))
    .filter((match) => !/[?&#]|password|token|cookie|authorization|secret/i.test(match))
    .map((match) => truncateText(match, 120));
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const clean = truncateText(value.trim().replace(/\s+/g, " "), 200);
    const key = clean.toLowerCase();
    const entry = counts.get(key) ?? { value: clean, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function toCountItem(item) {
  if (/^https?:\/\//i.test(item.value)) return { url: item.value, count: item.count };
  if (/^(?:npm|pnpm|yarn|node|python|python3|make|git|gh|ollama|codex)\b/i.test(item.value)) {
    return { command: item.value, count: item.count };
  }
  return { name: item.value, count: item.count };
}

function representativeEvidenceIds(evidenceIds) {
  if (evidenceIds.length <= maxEvidenceIds) return evidenceIds;
  const head = evidenceIds.slice(0, Math.floor(maxEvidenceIds / 2));
  const tail = evidenceIds.slice(evidenceIds.length - (maxEvidenceIds - head.length));
  return [...new Set([...head, ...tail])];
}

function truncateText(text, maxLength) {
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + "." : text;
}
