const genericVisibleIntentPattern = /\b(?:analy[sz](?:e|ing)|review(?:ing)?)\b.*\b(?:locally imported|local)?\s*(?:screen capture|screen frame|captured frame|visible work surface)\b/i;
const genericActivityPattern = /^(?:archived_screen_capture|imported_screen_capture|local_screen_capture|analy[sz]e?_?(?:local_)?screen_?frame)$/i;

export function normalizeFrameWorkSummary(frame) {
  const repositoryHostCleanup = normalizeRepositoryHostHallucinations(
    normalizeBrowserSurfaceApplications(Array.isArray(frame.applications) ? frame.applications : [])
  );
  const applications = repositoryHostCleanup.applications;
  const primaryApplication = frame.primaryApplication && applications.some((application) => application.name === frame.primaryApplication.name)
    ? frame.primaryApplication
    : applications.find((application) => application.isPrimary) ?? applications[0];
  if (!primaryApplication || primaryApplication.name === "No visible application") return frame;

  const normalized = {
    ...frame,
    applications,
    primaryApplication,
    visitedUrls: normalizeVisitedUrlsForRepositoryHostCleanup(frame.visitedUrls, repositoryHostCleanup)
  };
  if (isGenericVisibleIntent(frame.visibleIntent)) {
    normalized.visibleIntent = buildVisibleIntent({ frame, primaryApplication, applications });
  }
  if (repositoryHostCleanup.droppedGitLab) {
    normalized.visibleIntent = normalizeVersionControlText(normalized.visibleIntent);
    normalized.keyTasks = Array.isArray(frame.keyTasks)
      ? frame.keyTasks.map(normalizeVersionControlText)
      : frame.keyTasks;
    normalized.riskFlags = Array.isArray(frame.riskFlags)
      ? frame.riskFlags.map(normalizeVersionControlText)
      : frame.riskFlags;
  }
  if (Array.isArray(frame.activities)) {
    normalized.activities = frame.activities.map((activity) => (
      isGenericActivity(activity)
        ? buildActivityLabel({ primaryApplication, applications })
        : activity
    ));
  }
  if (Array.isArray(frame.evidence)) {
    normalized.evidence = normalizeEvidenceForPrivacy(frame.evidence, applications);
  }
  return normalized;
}

function normalizeBrowserSurfaceApplications(applications) {
  return dedupeApplications(applications.map((application) => {
    if (!/^browser$/i.test(application.name)) {
      return application;
    }
    const name = browserSurfaceName(application.domain ?? application.windowTitle);
    if (!name) return application;
    return {
      ...application,
      name,
      domain: name === "GitHub" ? "github.com" : application.domain
    };
  }));
}

function browserSurfaceName(value) {
  const text = String(value ?? "").toLowerCase();
  if (/(^|\.)github\.com\b|\bgithub\b/.test(text)) return "GitHub";
  if (/(^|\.)linkedin\.com\b|\blinkedin\b/.test(text)) return "LinkedIn";
  if (/(^|\.)(google\.com|google\.co\.)\b|\bgoogle\b/.test(text)) return "Google";
  if (/(^|\.)temu\.com\b|\btemu\b/.test(text)) return "Temu";
  return null;
}

function dedupeApplications(applications) {
  const seen = new Set();
  const deduped = [];
  for (const application of applications) {
    const key = application.domain
      ? `${application.name ?? ""}|${application.domain}`.toLowerCase()
      : `${application.name ?? ""}|${application.windowTitle ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(application);
  }
  return deduped;
}

function normalizeRepositoryHostHallucinations(applications) {
  const hasGitLab = applications.some((application) => application.name === "GitLab");
  const hasBrowser = applications.some((application) => /\b(browser|chrome|safari|firefox|edge|arc|brave|vivaldi|chromium)\b/i.test(application.name));
  const hasLocalGitSurface = applications.some((application) => /^(?:visual studio code|cursor|terminal|gitlens)$/i.test(application.name));
  if (!hasGitLab || hasBrowser || !hasLocalGitSurface) {
    return { applications, droppedGitLab: false };
  }
  return {
    applications: applications.filter((application) => application.name !== "GitLab"),
    droppedGitLab: true
  };
}

function normalizeVisitedUrlsForRepositoryHostCleanup(visitedUrls, cleanup) {
  if (!Array.isArray(visitedUrls)) return visitedUrls;
  if (!cleanup.droppedGitLab) return visitedUrls;
  return visitedUrls.filter((url) => {
    try {
      return new URL(url).hostname.toLowerCase() !== "gitlab.com";
    } catch {
      return true;
    }
  });
}

function isGenericVisibleIntent(value) {
  return typeof value === "string" && genericVisibleIntentPattern.test(value);
}

function isGenericActivity(value) {
  return typeof value === "string" && genericActivityPattern.test(value);
}

function buildVisibleIntent({ frame, primaryApplication, applications }) {
  const task = firstSpecificTask(frame.keyTasks);
  const secondaryApplications = applications
    .map((application) => application.name)
    .filter((name) => name && name !== primaryApplication.name && name !== "Unknown" && name !== "No visible application");
  const secondaryText = secondaryApplications.length > 0
    ? ` with ${unique(secondaryApplications).slice(0, 2).join(" and ")} also visible`
    : "";
  return `${task} in ${primaryApplication.name}${secondaryText}.`;
}

function firstSpecificTask(keyTasks) {
  const task = Array.isArray(keyTasks)
    ? keyTasks.find((item) => (
      typeof item === "string" &&
      item.trim() !== "" &&
      !/\b(?:screen capture|screen frame|visible work surface|raw media|archive|imported)\b/i.test(item)
    ))
    : null;
  return sentenceCase(task ?? "Working on the visible task");
}

function buildActivityLabel({ primaryApplication, applications }) {
  const appText = `${primaryApplication.name} ${applications.map((application) => application.name).join(" ")}`;
  if (/\bslack|teams|discord\b/i.test(appText)) return "team_communication";
  if (/\bvisual studio code|cursor|terminal|git|github\b/i.test(appText)) return "engineering_work";
  if (/\bchrome|safari|browser|firefox|edge|arc\b/i.test(appText)) return "browser_work";
  if (/\bcalendar\b/i.test(appText)) return "calendar_review";
  return "visible_work";
}

function normalizeEvidenceForPrivacy(evidence, applications) {
  const hasCommunicationApp = applications.some((application) => (
    /^(?:slack|discord|microsoft teams)$/i.test(application.name)
  ));

  return evidence.map((item) => {
    if (!item || typeof item.summary !== "string") return item;
    const summary = normalizeVersionControlText(item.summary);
    return {
      ...item,
      summary: hasCommunicationApp ? redactCommunicationEvidence(summary) : summary
    };
  });
}

function normalizeVersionControlText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\bworking with GitLab\b/gi, "working with version control")
    .replace(/\bGitLab interface\b/gi, "version-control branch or commit UI")
    .replace(/\bGitLab\b/g, "version control");
}

function redactCommunicationEvidence(summary) {
  if (/\b(?:github|pull request|pr|code review|changeset)\b/i.test(summary)) {
    return "A code review or pull request surface is visible for engineering coordination.";
  }
  if (/\b(?:visual studio code|code editor|code file|code snippet)\b/i.test(summary)) {
    return "A code editor is visible with engineering work in progress.";
  }
  if (/\b(?:slack|direct message|dm|conversation|message|chat|teams|discord)\b/i.test(summary)) {
    return "A communication app is visible with team collaboration context; message text and personal names are not stored.";
  }
  return summary;
}

function sentenceCase(value) {
  const text = String(value).trim().replace(/\s+/g, " ");
  if (text === "") return "Working on the visible task";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unique(values) {
  return [...new Set(values)];
}
