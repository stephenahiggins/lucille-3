import { assertPrivacySafe } from "../privacy/safety.mjs";

const timelineFields = new Set([
  "schemaVersion",
  "day",
  "textCapturePolicy",
  "privacyBoundary",
  "scaleSummary",
  "snapshots",
  "segments",
  "commonTasks"
]);
const scaleSummaryFields = new Set([
  "frameCount",
  "snapshotCount",
  "segmentCount",
  "commonTaskCount",
  "representativeSnapshotCap",
  "representativeEvidenceIdCap",
  "evidenceTrailCap",
  "aggregationStrategy"
]);
const snapshotFields = new Set([
  "id",
  "frameId",
  "evidenceId",
  "capturedAt",
  "surface",
  "visibleContext",
  "keyTasks",
  "visibleTextSnippets",
  "observedActions",
  "intentHypotheses",
  "problemSignals"
]);
const surfaceFields = new Set(["appName", "windowTitle", "domain"]);
const segmentFields = new Set([
  "id",
  "title",
  "startAt",
  "endAt",
  "dwellTimeSeconds",
  "evidenceIds",
  "frameCount",
  "surfaceSwitchCount",
  "userIntent",
  "evidenceTrail",
  "actionsTaken",
  "cognitiveHurdles",
  "recommendationSeeds",
  "confidence"
]);
const commonTaskFields = new Set([
  "id",
  "title",
  "segmentIds",
  "segmentCount",
  "evidenceIds",
  "frameCount",
  "firstAt",
  "lastAt",
  "totalDwellTimeSeconds",
  "surfaceSwitchCount",
  "userIntent",
  "evidenceNarrative",
  "evidenceTrail",
  "commonActions",
  "cognitiveHurdles",
  "recommendationSeeds",
  "confidence"
]);
const evidenceTrailFields = new Set([
  "evidenceId",
  "capturedAt",
  "surface",
  "keyTasks",
  "signals"
]);

const maxGapSeconds = 10 * 60;
const dwellIntervalCapSeconds = 120;
const maxRepresentativeSnapshots = 50;
const maxRepresentativeSegmentIds = 40;
const maxRepresentativeEvidenceIds = 50;
const maxEvidenceTrailEntries = 20;
const queryUrlPattern = /\bhttps?:\/\/[^\s"'<>?]+\/?[^\s"'<>]*\?[^\s"'<>]+/i;
const sensitiveSnippetPattern = /\b(password|passcode|token|cookie|authorization|api[_ -]?key|secret|bearer|session[_ -]?id)\b/i;

export function buildActivityTimeline(options = {}) {
  const day = validateDay(options.day);
  const frames = requireArray(options.frames, "frames");
  const allSnapshots = frames
    .map((frame, index) => buildSnapshot(frame, index))
    .sort((a, b) => timestampMs(a.capturedAt) - timestampMs(b.capturedAt));
  const segments = buildSegments(allSnapshots, day);
  const commonTasks = buildCommonTasks(segments, day);
  const snapshots = representativeSnapshots(allSnapshots);
  const timeline = {
    schemaVersion: "activity-timeline.v1",
    day,
    textCapturePolicy: "visible_text_ocr_only",
    privacyBoundary: "Stores bounded visible screen text snippets only; excludes hidden input capture, clipboard, audio, raw document bodies, raw message bodies, credentials, cookies, and full query URLs.",
    scaleSummary: buildScaleSummary({ frames, snapshots, segments, commonTasks }),
    snapshots,
    segments,
    commonTasks
  };

  assertPrivacySafe(timeline, "activityTimeline");
  return validateActivityTimeline(timeline, { day, source: "activityTimeline" });
}

export function validateActivityTimeline(value, { day, source = "activityTimeline" } = {}) {
  requireObject(value, source);
  rejectUnexpectedFields(value, timelineFields, source);

  const validatedDay = validateDay(day ?? value.day);
  const timeline = {
    schemaVersion: requireLiteral(value.schemaVersion, "activity-timeline.v1", `${source}.schemaVersion`),
    day: requireLiteral(value.day, validatedDay, `${source}.day`),
    textCapturePolicy: requireLiteral(value.textCapturePolicy, "visible_text_ocr_only", `${source}.textCapturePolicy`),
    privacyBoundary: requireText(value.privacyBoundary, `${source}.privacyBoundary`, 360),
    scaleSummary: validateScaleSummary(value.scaleSummary, `${source}.scaleSummary`),
    snapshots: requireArray(value.snapshots, `${source}.snapshots`).map((snapshot, index) => (
      validateSnapshot(snapshot, { day: validatedDay, source: `${source}.snapshots[${index}]` })
    )),
    segments: requireArray(value.segments, `${source}.segments`).map((segment, index) => (
      validateSegment(segment, { day: validatedDay, source: `${source}.segments[${index}]` })
    )),
    commonTasks: requireArray(value.commonTasks, `${source}.commonTasks`).map((task, index) => (
      validateCommonTask(task, { day: validatedDay, source: `${source}.commonTasks[${index}]` })
    ))
  };

  validateScaleSummaryMatchesTimeline(timeline, source);

  assertPrivacySafe(timeline, source);
  return timeline;
}

function buildScaleSummary({ frames, snapshots, segments, commonTasks }) {
  return {
    frameCount: frames.length,
    snapshotCount: snapshots.length,
    segmentCount: segments.length,
    commonTaskCount: commonTasks.length,
    representativeSnapshotCap: maxRepresentativeSnapshots,
    representativeEvidenceIdCap: maxRepresentativeEvidenceIds,
    evidenceTrailCap: maxEvidenceTrailEntries,
    aggregationStrategy: "common_tasks_group_repeated_timeline_segments_with_bounded_representative_evidence"
  };
}

function buildSnapshot(frame, index) {
  requireObject(frame, `frames[${index}]`);
  const surface = normalizeSurface(frame.surface, `frames[${index}].surface`);
  const candidates = [
    frame.visibleIntent,
    ...(Array.isArray(frame.activities) ? frame.activities : []),
    ...(Array.isArray(frame.evidence) ? frame.evidence.map((item) => item?.summary) : [])
  ];
  const visibleTextSnippets = unique(candidates
    .map((item) => sanitizeVisibleSnippet(item, 160))
    .filter(Boolean))
    .slice(0, 8);
  const primaryContextText = `${surface.appName} ${surface.windowTitle} ${surface.domain ?? ""} ${frame.visibleIntent ?? ""} ${(Array.isArray(frame.activities) ? frame.activities : []).join(" ")}`;
  const contextKey = classifyText(primaryContextText);
  const combinedText = `${primaryContextText} ${visibleTextSnippets.join(" ")}`;
  const observedActions = inferObservedActions(combinedText, contextKey);
  const intentHypotheses = inferIntentHypotheses(frame, combinedText, observedActions);
  const problemSignals = inferProblemSignals(frame, combinedText);
  const keyTasks = Array.isArray(frame.keyTasks) && frame.keyTasks.length > 0
    ? unique(frame.keyTasks.map((item) => sanitizeVisibleSnippet(item, 120)).filter(Boolean)).slice(0, 6)
    : inferKeyTasks(combinedText, observedActions, contextKey);

  return {
    id: `snapshot-${slugify(frame.frameId ?? `frame-${index + 1}`)}`,
    frameId: requireText(frame.frameId, `frames[${index}].frameId`, 160),
    evidenceId: requireEvidenceId(frame.evidenceId, `frames[${index}].evidenceId`),
    capturedAt: requireIsoTimestamp(frame.capturedAt, `frames[${index}].capturedAt`, frame.day),
    surface,
    visibleContext: inferVisibleContext(surface, visibleTextSnippets),
    keyTasks,
    visibleTextSnippets,
    observedActions,
    intentHypotheses,
    problemSignals
  };
}

function buildSegments(snapshots, day) {
  const groups = [];
  let current = null;

  for (const snapshot of snapshots) {
    const key = classifyWorkContext(snapshot);
    if (!current) {
      current = { contextKey: key, snapshots: [snapshot] };
      continue;
    }

    const previous = current.snapshots.at(-1);
    const gapSeconds = secondsBetween(previous.capturedAt, snapshot.capturedAt);
    if (gapSeconds > maxGapSeconds || key !== current.contextKey) {
      groups.push(current);
      current = { contextKey: key, snapshots: [snapshot] };
      continue;
    }

    current.snapshots.push(snapshot);
  }

  if (current) groups.push(current);
  return groups.map((group, index) => buildSegment(group, { day, index }));
}

function buildSegment(group, { day, index }) {
  const snapshots = group.snapshots;
  const allEvidenceIds = unique(snapshots.map((snapshot) => snapshot.evidenceId));
  const actionsTaken = unique(snapshots.flatMap((snapshot) => snapshot.observedActions)).slice(0, 8);
  const baseHurdles = unique(snapshots.flatMap((snapshot) => snapshot.problemSignals));
  const dwellTimeSeconds = calculateDwellTimeSeconds(snapshots);
  const surfaceSwitchCount = calculateSurfaceSwitchCount(snapshots);
  const cognitiveHurdles = inferCognitiveHurdles({
    contextKey: group.contextKey,
    actionsTaken,
    baseHurdles,
    dwellTimeSeconds,
    surfaceSwitchCount
  });
  const recommendationSeeds = inferRecommendationSeeds({
    contextKey: group.contextKey,
    actionsTaken,
    cognitiveHurdles,
    surfaceSwitchCount
  });
  const title = titleForContext(group.contextKey);

  return {
    id: `segment-${day}-${String(index + 1).padStart(3, "0")}`,
    title,
    startAt: snapshots[0].capturedAt,
    endAt: snapshots.at(-1).capturedAt,
    dwellTimeSeconds,
    evidenceIds: representativeEvidenceIds(allEvidenceIds),
    frameCount: snapshots.length,
    surfaceSwitchCount,
    userIntent: inferSegmentIntent(group.contextKey, snapshots),
    evidenceTrail: buildSnapshotEvidenceTrail(snapshots).slice(0, maxEvidenceTrailEntries),
    actionsTaken,
    cognitiveHurdles,
    recommendationSeeds,
    confidence: confidenceFor(snapshots.length)
  };
}

function buildCommonTasks(segments, day) {
  const groups = new Map();
  for (const segment of segments) {
    const key = slugify(segment.title);
    const group = groups.get(key) ?? {
      key,
      title: segment.title,
      segments: []
    };
    group.segments.push(segment);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group, index) => buildCommonTask(group, { day, index }))
    .sort((left, right) => taskFrictionScore(right) - taskFrictionScore(left));
}

function buildCommonTask(group, { day, index }) {
  const segments = group.segments;
  const allEvidenceIds = unique(segments.flatMap((segment) => segment.evidenceIds));
  const segmentIds = segments.map((segment) => segment.id);
  const commonActions = unique(segments.flatMap((segment) => segment.actionsTaken)).slice(0, 8);
  const cognitiveHurdles = unique(segments.flatMap((segment) => segment.cognitiveHurdles)).slice(0, 8);
  const recommendationSeeds = unique(segments.flatMap((segment) => segment.recommendationSeeds)).slice(0, 8);
  const firstAt = segments.map((segment) => segment.startAt).sort()[0];
  const lastAt = segments.map((segment) => segment.endAt).sort().at(-1);
  const frameCount = segments.reduce((sum, segment) => sum + segment.frameCount, 0);
  const totalDwellTimeSeconds = segments.reduce((sum, segment) => sum + segment.dwellTimeSeconds, 0);
  const surfaceSwitchCount = segments.reduce((sum, segment) => sum + segment.surfaceSwitchCount, 0);
  const evidenceTrail = buildEvidenceTrail(segments);
  const userIntent = inferCommonTaskIntent(group.title, segments, frameCount);

  return {
    id: `task-${day}-${String(index + 1).padStart(3, "0")}-${group.key}`.slice(0, 120).replace(/-+$/g, ""),
    title: group.title,
    segmentIds: representativeTextIds(segmentIds, maxRepresentativeSegmentIds),
    segmentCount: segments.length,
    evidenceIds: representativeEvidenceIds(allEvidenceIds),
    frameCount,
    firstAt,
    lastAt,
    totalDwellTimeSeconds,
    surfaceSwitchCount,
    userIntent,
    evidenceNarrative: inferEvidenceNarrative({
      title: group.title,
      userIntent,
      evidenceTrail,
      segments,
      totalDwellTimeSeconds
    }),
    evidenceTrail,
    commonActions,
    cognitiveHurdles,
    recommendationSeeds,
    confidence: confidenceForCommonTask(segments.length, frameCount)
  };
}

function buildEvidenceTrail(segments) {
  const entries = [];
  const seen = new Set();
  for (const segment of segments) {
    for (const entry of segment.evidenceTrail ?? []) {
      if (seen.has(entry.evidenceId)) continue;
      seen.add(entry.evidenceId);
      entries.push(entry);
    }
  }
  return entries.slice(0, maxEvidenceTrailEntries);
}

function representativeEvidenceIds(evidenceIds) {
  if (evidenceIds.length <= maxRepresentativeEvidenceIds) return evidenceIds;
  const head = evidenceIds.slice(0, Math.floor(maxRepresentativeEvidenceIds / 2));
  const tail = evidenceIds.slice(evidenceIds.length - (maxRepresentativeEvidenceIds - head.length));
  return unique([...head, ...tail]);
}

function representativeTextIds(ids, cap) {
  if (ids.length <= cap) return ids;
  const head = ids.slice(0, Math.floor(cap / 2));
  const tail = ids.slice(ids.length - (cap - head.length));
  return unique([...head, ...tail]);
}

function representativeSnapshots(snapshots) {
  if (snapshots.length <= maxRepresentativeSnapshots) return snapshots;
  const head = snapshots.slice(0, Math.floor(maxRepresentativeSnapshots / 2));
  const tail = snapshots.slice(snapshots.length - (maxRepresentativeSnapshots - head.length));
  const seen = new Set();
  return [...head, ...tail].filter((snapshot) => {
    if (seen.has(snapshot.evidenceId)) return false;
    seen.add(snapshot.evidenceId);
    return true;
  });
}

function buildSnapshotEvidenceTrail(snapshots) {
  return snapshots.map((snapshot) => ({
    evidenceId: snapshot.evidenceId,
    capturedAt: snapshot.capturedAt,
    surface: inferSurfaceLabel(snapshot.surface),
    keyTasks: snapshot.keyTasks.slice(0, 4),
    signals: unique([
      ...snapshot.problemSignals,
      ...snapshot.observedActions
    ]).slice(0, 4)
  }));
}

function inferEvidenceNarrative({ title, userIntent, evidenceTrail, segments, totalDwellTimeSeconds }) {
  const taskTerms = mostCommonTerms(evidenceTrail.flatMap((entry) => entry.keyTasks), 3);
  const surfaceTerms = mostCommonTerms(evidenceTrail.map((entry) => entry.surface), 3);
  const taskText = taskTerms.length > 0 ? taskTerms.join("; ") : title.toLowerCase();
  const surfaceText = surfaceTerms.length > 0 ? surfaceTerms.join(", ") : "visible work surfaces";
  return truncateText(
    `${evidenceTrail.length} frame(s) across ${segments.length} separated timeline segment(s) repeat ${taskText} on ${surfaceText}; total observed dwell is ${totalDwellTimeSeconds} second(s). ${userIntent}`,
    500
  );
}

function inferSurfaceLabel(surface) {
  const domain = surface.domain ? ` on ${surface.domain}` : "";
  return truncateText(`${surface.appName}: ${surface.windowTitle}${domain}`, 120);
}

function mostCommonTerms(values, limit) {
  const counts = new Map();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function inferCommonTaskIntent(title, segments, frameCount) {
  const segmentCount = segments.length;
  const intent = segments.find((segment) => segment.userIntent)?.userIntent ?? `The user is repeatedly doing ${title.toLowerCase()}.`;
  return truncateText(
    `${frameCount} screenshot-backed evidence item(s) across ${segmentCount} timeline segment(s) show a repeated task: ${intent}`,
    320
  );
}

function taskFrictionScore(task) {
  return (
    task.totalDwellTimeSeconds +
    task.surfaceSwitchCount * 60 +
    task.cognitiveHurdles.length * 45 +
    task.segmentCount * 30 +
    task.evidenceIds.length * 10
  );
}

function inferVisibleContext(surface, visibleTextSnippets) {
  const snippet = visibleTextSnippets[0] ?? "visible work surface";
  const domain = surface.domain ? ` on ${surface.domain}` : "";
  return truncateText(`${surface.appName} (${surface.windowTitle}${domain}): ${snippet}`, 220);
}

function inferObservedActions(text, contextKey = null) {
  const normalized = text.toLowerCase();
  const actions = [];
  const attendanceDominant = contextKey === "attendance_report_review";
  const developmentDominant = contextKey === "development_review_reporting";

  if (!attendanceDominant && /\b(github|pull request|\bpr\b|code review|cursor|codex|repository|commit|diff)\b/.test(normalized)) {
    actions.push("Reviewed code, pull request, or engineering work");
  }
  if (!attendanceDominant && /\b(terminal|console|command|npm|make|test|build|stack trace|exception|error)\b/.test(normalized)) {
    actions.push("Inspected command output or local automation state");
  }
  if (!developmentDominant && /\b(report|dashboard|chart|metric|attendance|spreadsheet|export|reconciliation|table)\b/.test(normalized)) {
    actions.push("Reviewed report, dashboard, or spreadsheet evidence");
  }
  if (/\b(email|message|draft|slack|teams|discord|chat|follow-up|communication)\b/.test(normalized)) {
    actions.push("Drafted or reviewed communication follow-up");
  }
  if (/\b(template|checklist|queue|todo|next action|status)\b/.test(normalized)) {
    actions.push("Organised next actions or reusable workflow structure");
  }

  return actions.length > 0 ? actions : ["Reviewed a visible work surface"];
}

function inferKeyTasks(text, observedActions, contextKey = null) {
  const normalized = text.toLowerCase();
  const tasks = [];
  const attendanceDominant = contextKey === "attendance_report_review";
  const developmentDominant = contextKey === "development_review_reporting";

  if (/\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(normalized)) {
    tasks.push("Review attendance report evidence");
  }
  if (/\b(reconcile|reconciliation|check|qa|manual|review)\b/.test(normalized)) {
    tasks.push("Reconcile visible evidence and quality checks");
  }
  if (/\b(email|message|draft|follow-up|communication|slack|teams|chat)\b/.test(normalized)) {
    tasks.push("Draft or review follow-up communication");
  }
  if (!attendanceDominant && /\b(github|pull request|\bpr\b|code|diff|repository|cursor|codex)\b/.test(normalized)) {
    tasks.push("Review engineering work and code context");
  }
  if (!attendanceDominant && /\b(terminal|console|command|npm|make|test|build|error|failed|exception)\b/.test(normalized)) {
    tasks.push("Inspect command output and troubleshoot blockers");
  }
  if (!developmentDominant && /\b(report|dashboard|chart|metric|spreadsheet|table|export)\b/.test(normalized)) {
    tasks.push("Review report or dashboard state");
  }
  if (/\b(template|checklist|queue|todo|next action|status)\b/.test(normalized)) {
    tasks.push("Organize next actions into reusable workflow structure");
  }

  return unique(tasks.length > 0 ? tasks : observedActions).slice(0, 6);
}

function inferIntentHypotheses(frame, combinedText, observedActions) {
  const hypotheses = [];
  const visibleIntent = sanitizeVisibleSnippet(frame.visibleIntent, 220);
  if (visibleIntent) hypotheses.push(visibleIntent);

  const contextKey = classifyText(combinedText);
  if (contextKey === "attendance_report_review") {
    hypotheses.push("Resolve attendance follow-up and reporting work");
  } else if (contextKey === "development_review_reporting") {
    hypotheses.push("Move engineering or report analysis work toward reviewable completion");
  } else if (contextKey === "report_building_review") {
    hypotheses.push("Validate report content and identify next review actions");
  } else if (contextKey === "collaboration_followup") {
    hypotheses.push("Turn collaboration context into clear follow-up actions");
  }

  if (hypotheses.length === 0 && observedActions.length > 0) {
    hypotheses.push(`Continue the workflow: ${observedActions[0].toLowerCase()}`);
  }

  return unique(hypotheses).slice(0, 4);
}

function inferProblemSignals(frame, text) {
  const normalized = text.toLowerCase();
  const signals = [];
  const riskFlags = Array.isArray(frame.riskFlags) ? frame.riskFlags : [];

  if (/\b(error|failed|failure|exception|blocked|stuck|unresolved|warning|not found|traceback|merge conflict)\b/.test(normalized)) {
    signals.push("Visible unresolved error or blocker");
  }
  if (/\b(manual|copy|reconcile|reconciliation|repeated|review|check|qa)\b/.test(normalized)) {
    signals.push("Manual review or reconciliation effort");
  }
  if (/\b(switching|cross-system|context switch|mis and email|spreadsheet after switching)\b/.test(normalized)) {
    signals.push("Context switching across systems");
  }
  if (riskFlags.some((flag) => String(flag).toLowerCase().includes("sensitive"))) {
    signals.push("Sensitive visible context requires bounded evidence and human review");
  }

  return unique(signals).slice(0, 6);
}

function inferCognitiveHurdles({ contextKey, actionsTaken, baseHurdles, dwellTimeSeconds, surfaceSwitchCount }) {
  const hurdles = [...baseHurdles];

  if (dwellTimeSeconds >= 180) {
    hurdles.push("Sustained dwell over the same work context suggests a review burden or decision point");
  }
  if (surfaceSwitchCount > 0) {
    hurdles.push("Surface switching increases the effort to reconstruct status and next actions");
  }
  if (actionsTaken.some((action) => /command output|automation state/i.test(action))) {
    hurdles.push("Command or automation output needs summarising into a next-step checklist");
  }
  if (contextKey === "attendance_report_review") {
    hurdles.push("Attendance follow-up requires connecting report review, communication, and reconciliation");
  }

  return unique(hurdles).slice(0, 8);
}

function inferRecommendationSeeds({ contextKey, actionsTaken, cognitiveHurdles, surfaceSwitchCount }) {
  const seeds = [
    "Generate a weekly efficiency report section from this timeline segment and its cited evidence"
  ];

  if (surfaceSwitchCount > 0 || cognitiveHurdles.some((hurdle) => /status and next actions/i.test(hurdle))) {
    seeds.push("Create a lightweight workflow queue that preserves owners, blockers, and next actions");
  }
  if (actionsTaken.some((action) => /communication/i.test(action))) {
    seeds.push("Draft review-only follow-up messages from approved templates and cited visible context");
  }
  if (actionsTaken.some((action) => /command output|automation state/i.test(action))) {
    seeds.push("Summarize visible command results into a troubleshooting checklist and next command suggestion");
  }
  if (contextKey === "attendance_report_review") {
    seeds.push("Prepare an attendance report QA checklist that links evidence, follow-up questions, and reconciliation checks");
  }

  return unique(seeds).slice(0, 8);
}

function inferSegmentIntent(contextKey, snapshots) {
  const firstIntent = snapshots
    .flatMap((snapshot) => snapshot.intentHypotheses)
    .find(Boolean);
  const evidenceText = `${snapshots.length} screenshot-backed snapshots`;

  if (contextKey === "attendance_report_review") {
    return truncateText(`${evidenceText} show the user trying to complete attendance review, follow-up drafting, and reconciliation as one workflow.`, 320);
  }
  if (contextKey === "development_review_reporting") {
    return truncateText(`${evidenceText} show the user trying to move engineering, review, or report analysis work toward a concrete next action.`, 320);
  }
  if (contextKey === "report_building_review") {
    return truncateText(`${evidenceText} show the user reviewing report state and looking for the next quality or delivery step.`, 320);
  }
  if (contextKey === "collaboration_followup") {
    return truncateText(`${evidenceText} show the user turning collaboration context into follow-up actions.`, 320);
  }

  return truncateText(firstIntent ?? `${evidenceText} show a repeated visible desktop workflow.`, 320);
}

function classifyWorkContext(snapshot) {
  return classifyText(`${snapshot.surface.appName} ${snapshot.surface.windowTitle} ${snapshot.surface.domain ?? ""} ${snapshot.intentHypotheses.join(" ")} ${snapshot.keyTasks.join(" ")} ${snapshot.visibleTextSnippets.slice(0, 2).join(" ")}`);
}

function classifyText(text) {
  const normalized = text.toLowerCase();
  const primaryText = normalized.slice(0, 340);
  const primary = primaryContext(primaryText);
  if (primary === "attendance" || (primary !== "development" && /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.test(normalized))) {
    return "attendance_report_review";
  }
  if (primary === "development") return "development_review_reporting";
  if (/\b(github|pull request|\bpr\b|code|cursor|codex|terminal|console|commit|diff|repository|npm|make|test)\b/.test(normalized)) {
    return "development_review_reporting";
  }
  if (/\b(report|dashboard|chart|spreadsheet|excel|metric|table|reconciliation|export)\b/.test(normalized)) {
    return "report_building_review";
  }
  if (/\b(slack|teams|discord|email|message|chat|communication|follow-up)\b/.test(normalized)) {
    return "collaboration_followup";
  }
  return `surface_${slugify(normalized).slice(0, 40) || "unknown"}`;
}

function primaryContext(text) {
  const attendanceMatch = /\b(attendance|absence|parent|student|pupil|mis|sims)\b/.exec(text);
  const developmentMatch = /\b(debugging|code review|reviewing code|testing code|observations\.mjs|hostname|pull request|terminal|console|npm|make|test)\b/.exec(text);
  if (attendanceMatch && (!developmentMatch || attendanceMatch.index < developmentMatch.index)) return "attendance";
  if (developmentMatch) return "development";
  return "unknown";
}

function titleForContext(contextKey) {
  if (contextKey === "attendance_report_review") return "Attendance report review workflow";
  if (contextKey === "development_review_reporting") return "Development review and reporting workflow";
  if (contextKey === "report_building_review") return "Report building and review workflow";
  if (contextKey === "collaboration_followup") return "Collaboration and context-switching workflow";
  return "Repeated desktop workflow";
}

function calculateDwellTimeSeconds(snapshots) {
  const intervals = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const delta = secondsBetween(snapshots[index - 1].capturedAt, snapshots[index].capturedAt);
    intervals.push(Math.max(0, Math.min(dwellIntervalCapSeconds, delta)));
  }

  const finalContribution = intervals.length > 0 ? median(intervals) : 0;
  return Math.round(intervals.reduce((sum, value) => sum + value, 0) + finalContribution);
}

function calculateSurfaceSwitchCount(snapshots) {
  let switches = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    if (surfaceSignature(snapshots[index - 1].surface) !== surfaceSignature(snapshots[index].surface)) {
      switches += 1;
    }
  }
  return switches;
}

function normalizeSurface(value, source) {
  requireObject(value, source);
  return {
    appName: requireText(value.appName, `${source}.appName`, 80),
    windowTitle: requireText(value.windowTitle, `${source}.windowTitle`, 160),
    domain: value.domain === null || value.domain === undefined
      ? null
      : requireHostnameOnly(value.domain, `${source}.domain`)
  };
}

function sanitizeVisibleSnippet(value, maxLength) {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  if (queryUrlPattern.test(text) || sensitiveSnippetPattern.test(text)) return null;
  text = text.replace(/\bhttps?:\/\/([a-z0-9.-]+)(?:\/[^\s"'<>]*)?/gi, "$1");
  return truncateText(text, maxLength);
}

function validateSnapshot(value, { day, source }) {
  requireObject(value, source);
  rejectUnexpectedFields(value, snapshotFields, source);
  return {
    id: requireSlug(value.id, `${source}.id`),
    frameId: requireText(value.frameId, `${source}.frameId`, 160),
    evidenceId: requireEvidenceId(value.evidenceId, `${source}.evidenceId`),
    capturedAt: requireIsoTimestamp(value.capturedAt, `${source}.capturedAt`, day),
    surface: validateSurface(value.surface, `${source}.surface`),
    visibleContext: requireText(value.visibleContext, `${source}.visibleContext`, 220),
    keyTasks: requireTextArray(value.keyTasks, `${source}.keyTasks`, 6, 120),
    visibleTextSnippets: requireTextArray(value.visibleTextSnippets, `${source}.visibleTextSnippets`, 8, 160),
    observedActions: requireTextArray(value.observedActions, `${source}.observedActions`, 8, 160),
    intentHypotheses: requireTextArray(value.intentHypotheses, `${source}.intentHypotheses`, 4, 220),
    problemSignals: requireTextArray(value.problemSignals, `${source}.problemSignals`, 6, 180)
  };
}

function validateSegment(value, { day, source }) {
  requireObject(value, source);
  rejectUnexpectedFields(value, segmentFields, source);
  return {
    id: requireSlug(value.id, `${source}.id`),
    title: requireText(value.title, `${source}.title`, 120),
    startAt: requireIsoTimestamp(value.startAt, `${source}.startAt`, day),
    endAt: requireIsoTimestamp(value.endAt, `${source}.endAt`, day),
    dwellTimeSeconds: requireNonNegativeInteger(value.dwellTimeSeconds, `${source}.dwellTimeSeconds`),
    evidenceIds: requireArray(value.evidenceIds, `${source}.evidenceIds`).map((id, index) => (
      requireEvidenceId(id, `${source}.evidenceIds[${index}]`)
    )),
    frameCount: requireNonNegativeInteger(value.frameCount, `${source}.frameCount`),
    surfaceSwitchCount: requireNonNegativeInteger(value.surfaceSwitchCount, `${source}.surfaceSwitchCount`),
    userIntent: requireText(value.userIntent, `${source}.userIntent`, 320),
    evidenceTrail: requireEvidenceTrail(value.evidenceTrail, `${source}.evidenceTrail`, maxEvidenceTrailEntries),
    actionsTaken: requireTextArray(value.actionsTaken, `${source}.actionsTaken`, 8, 160),
    cognitiveHurdles: requireTextArray(value.cognitiveHurdles, `${source}.cognitiveHurdles`, 8, 220),
    recommendationSeeds: requireTextArray(value.recommendationSeeds, `${source}.recommendationSeeds`, 8, 220),
    confidence: requireConfidence(value.confidence, `${source}.confidence`)
  };
}

function validateCommonTask(value, { day, source }) {
  requireObject(value, source);
  rejectUnexpectedFields(value, commonTaskFields, source);
  const task = {
    id: requireSlug(value.id, `${source}.id`),
    title: requireText(value.title, `${source}.title`, 120),
    segmentIds: requireTextArray(value.segmentIds, `${source}.segmentIds`, maxRepresentativeSegmentIds, 160),
    segmentCount: requireNonNegativeInteger(value.segmentCount, `${source}.segmentCount`),
    evidenceIds: requireArray(value.evidenceIds, `${source}.evidenceIds`).map((id, index) => (
      requireEvidenceId(id, `${source}.evidenceIds[${index}]`)
    )),
    frameCount: requireNonNegativeInteger(value.frameCount, `${source}.frameCount`),
    firstAt: requireIsoTimestamp(value.firstAt, `${source}.firstAt`, day),
    lastAt: requireIsoTimestamp(value.lastAt, `${source}.lastAt`, day),
    totalDwellTimeSeconds: requireNonNegativeInteger(value.totalDwellTimeSeconds, `${source}.totalDwellTimeSeconds`),
    surfaceSwitchCount: requireNonNegativeInteger(value.surfaceSwitchCount, `${source}.surfaceSwitchCount`),
    userIntent: requireText(value.userIntent, `${source}.userIntent`, 320),
    evidenceNarrative: requireText(value.evidenceNarrative, `${source}.evidenceNarrative`, 500),
    evidenceTrail: requireEvidenceTrail(value.evidenceTrail, `${source}.evidenceTrail`, maxEvidenceTrailEntries),
    commonActions: requireTextArray(value.commonActions, `${source}.commonActions`, 8, 160),
    cognitiveHurdles: requireTextArray(value.cognitiveHurdles, `${source}.cognitiveHurdles`, 8, 220),
    recommendationSeeds: requireTextArray(value.recommendationSeeds, `${source}.recommendationSeeds`, 8, 220),
    confidence: requireConfidence(value.confidence, `${source}.confidence`)
  };
  if (task.segmentCount < task.segmentIds.length) {
    throw new Error(`${source}.segmentCount must be at least segmentIds.length.`);
  }
  return task;
}

function requireEvidenceTrail(value, source, maxItems) {
  const items = requireArray(value, source);
  if (items.length === 0) {
    throw new Error(`${source}: expected at least one item.`);
  }
  if (items.length > maxItems) {
    throw new Error(`${source}: exceeds ${maxItems} items.`);
  }
  return items.map((item, index) => validateEvidenceTrailEntry(item, `${source}[${index}]`));
}

function validateEvidenceTrailEntry(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, evidenceTrailFields, source);
  return {
    evidenceId: requireEvidenceId(value.evidenceId, `${source}.evidenceId`),
    capturedAt: requireIsoTimestamp(value.capturedAt, `${source}.capturedAt`),
    surface: requireText(value.surface, `${source}.surface`, 120),
    keyTasks: requireTextArray(value.keyTasks, `${source}.keyTasks`, 6, 120),
    signals: requireTextArray(value.signals, `${source}.signals`, 6, 160)
  };
}

function validateSurface(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, surfaceFields, source);
  return normalizeSurface(value, source);
}

function validateScaleSummary(value, source) {
  requireObject(value, source);
  rejectUnexpectedFields(value, scaleSummaryFields, source);
  return {
    frameCount: requireNonNegativeInteger(value.frameCount, `${source}.frameCount`),
    snapshotCount: requireNonNegativeInteger(value.snapshotCount, `${source}.snapshotCount`),
    segmentCount: requireNonNegativeInteger(value.segmentCount, `${source}.segmentCount`),
    commonTaskCount: requireNonNegativeInteger(value.commonTaskCount, `${source}.commonTaskCount`),
    representativeSnapshotCap: requireLiteral(value.representativeSnapshotCap, maxRepresentativeSnapshots, `${source}.representativeSnapshotCap`),
    representativeEvidenceIdCap: requireLiteral(value.representativeEvidenceIdCap, maxRepresentativeEvidenceIds, `${source}.representativeEvidenceIdCap`),
    evidenceTrailCap: requireLiteral(value.evidenceTrailCap, maxEvidenceTrailEntries, `${source}.evidenceTrailCap`),
    aggregationStrategy: requireLiteral(
      value.aggregationStrategy,
      "common_tasks_group_repeated_timeline_segments_with_bounded_representative_evidence",
      `${source}.aggregationStrategy`
    )
  };
}

function validateScaleSummaryMatchesTimeline(timeline, source) {
  if (timeline.scaleSummary.frameCount < timeline.snapshots.length) {
    throw new Error(`${source}.scaleSummary.frameCount must be at least snapshots.length.`);
  }
  if (timeline.scaleSummary.snapshotCount !== timeline.snapshots.length) {
    throw new Error(`${source}.scaleSummary.snapshotCount must match snapshots.length.`);
  }
  if (timeline.scaleSummary.snapshotCount > timeline.scaleSummary.representativeSnapshotCap) {
    throw new Error(`${source}.scaleSummary.snapshotCount exceeds representativeSnapshotCap.`);
  }
  if (timeline.scaleSummary.segmentCount !== timeline.segments.length) {
    throw new Error(`${source}.scaleSummary.segmentCount must match segments.length.`);
  }
  if (timeline.scaleSummary.commonTaskCount !== timeline.commonTasks.length) {
    throw new Error(`${source}.scaleSummary.commonTaskCount must match commonTasks.length.`);
  }
}

function rejectUnexpectedFields(value, allowedFields, source) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${source}: unexpected field "${key}".`);
    }
  }
}

function requireObject(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected an object.`);
  }
}

function requireArray(value, source) {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: expected an array.`);
  }
  return value;
}

function requireLiteral(value, expected, source) {
  if (value !== expected) {
    throw new Error(`${source}: expected ${JSON.stringify(expected)}.`);
  }
  return value;
}

function requireTextArray(value, source, maxItems, maxLength) {
  const items = requireArray(value, source);
  if (items.length > maxItems) {
    throw new Error(`${source}: exceeds ${maxItems} items.`);
  }
  return items.map((item, index) => requireText(item, `${source}[${index}]`, maxLength));
}

function requireText(value, source, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: expected a non-empty string.`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > maxLength) {
    throw new Error(`${source}: exceeds ${maxLength} characters.`);
  }
  return text;
}

function requireSlug(value, source) {
  const text = requireText(value, source, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    throw new Error(`${source}: expected lowercase slug text.`);
  }
  return text;
}

function requireEvidenceId(value, source) {
  const text = requireText(value, source, 160);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(text)) {
    throw new Error(`${source}: expected an evidence ID.`);
  }
  return text;
}

function requireConfidence(value, source) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${source}: expected a number from 0 to 1.`);
  }
  return Number(value.toFixed(2));
}

function requireNonNegativeInteger(value, source) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${source}: expected a non-negative integer.`);
  }
  return value;
}

function requireIsoTimestamp(value, source, day) {
  const timestamp = requireText(value, source, 40);
  const parsed = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(timestamp) || Number.isNaN(parsed.getTime())) {
    throw new Error(`${source}: expected an ISO-8601 UTC timestamp.`);
  }
  const canonical = parsed.toISOString();
  if (day && !canonical.startsWith(`${day}T`)) {
    throw new Error(`${source}: must belong to day ${day}.`);
  }
  return canonical;
}

function requireHostnameOnly(value, source) {
  const domain = requireText(value, source, 253).toLowerCase();
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes("?") ||
    domain.includes("#") ||
    domain.includes("@") ||
    /\s/.test(domain)
  ) {
    throw new Error(`${source}: expected a hostname only.`);
  }
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain)) {
    throw new Error(`${source}: contains unsupported hostname characters.`);
  }
  return domain;
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}

function confidenceFor(snapshotCount) {
  return Number(Math.min(0.86, 0.62 + snapshotCount * 0.04).toFixed(2));
}

function confidenceForCommonTask(segmentCount, frameCount) {
  return Number(Math.min(0.9, 0.64 + segmentCount * 0.05 + frameCount * 0.015).toFixed(2));
}

function secondsBetween(startAt, endAt) {
  return Math.max(0, Math.round((timestampMs(endAt) - timestampMs(startAt)) / 1000));
}

function timestampMs(value) {
  return new Date(value).getTime();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function surfaceSignature(surface) {
  return `${surface.appName}|${surface.windowTitle}|${surface.domain ?? ""}`;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

function truncateText(text, maxLength) {
  const normalized = String(text).trim().replace(/\s+/g, " ");
  return normalized.length > maxLength ? normalized.slice(0, maxLength - 1).trimEnd() + "." : normalized;
}
