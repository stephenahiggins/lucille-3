import { assertPrivacySafe } from "../privacy/safety.mjs";

const targetRecommendationCount = 10;

export function buildOptimizationWrapUp({ day, frames, sessionAnalysis, workPatterns, skillProposals, userMemory }) {
  const recommendations = buildRecommendations({
    workPatterns,
    sessionAnalysis,
    skillProposals,
    userMemory
  }).slice(0, targetRecommendationCount);
  const wrapUp = {
    schemaVersion: "optimization-wrap-up.v1",
    day,
    generatedAt: userMemory.updatedAt,
    headline: buildHeadline({ frames, sessionAnalysis, recommendations }),
    analysedFrameCount: frames.length,
    analysedSessionCount: sessionAnalysis.sessions.length,
    regularWorkMemory: {
      regularTaskCount: userMemory.regularTasks.length,
      frequentApplicationCount: userMemory.frequentApplications.length,
      frequentWebsiteCount: userMemory.frequentWebsites.length,
      frequentCommandCount: userMemory.frequentCommands.length
    },
    efficiencyRecommendations: recommendations,
    skillsCreated: skillProposals.proposals.slice(0, 10).map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      category: proposal.category,
      estimatedMinutesPerWeek: proposal.estimatedMinutesPerWeek,
      evidenceIds: proposal.evidenceIds.slice(0, 12),
      status: proposal.status
    })),
    softwareTips: buildSoftwareTips({ sessionAnalysis, userMemory }).slice(0, 10),
    procrastinationEstimate: buildProcrastinationEstimate(userMemory),
    privacySummary: "Wrap-up uses privacy-safe structured frame, session, pattern, proposal, and memory artifacts only; no raw screenshots, keystrokes, clipboard, audio, raw document bodies, raw message bodies, credentials, cookies, or query-string URLs are included."
  };

  assertPrivacySafe(wrapUp, "optimizationWrapUp");
  return wrapUp;
}

function buildHeadline({ frames, sessionAnalysis, recommendations }) {
  const minutes = Math.round(sessionAnalysis.totals.totalDurationSeconds / 60);
  return `${frames.length} frame(s) across ${sessionAnalysis.sessions.length} session(s) produced ${recommendations.length} reviewable efficiency recommendation(s) from about ${minutes} minute(s) of visible work.`;
}

function buildRecommendations({ workPatterns, sessionAnalysis, skillProposals, userMemory }) {
  const recommendations = [];
  for (const pattern of workPatterns.patterns) {
    recommendations.push({
      id: `recommendation-${pattern.id}`,
      title: pattern.title,
      type: "workflow_improvement",
      whyItMatters: pattern.summary,
      suggestedAction: pattern.recommendation,
      estimatedMinutesPerWeek: pattern.estimatedMinutesPerWeek,
      confidence: pattern.confidence,
      evidenceIds: pattern.repeatedAcrossEvidence.slice(0, 12)
    });
  }

  for (const session of sessionAnalysis.sessions) {
    if (session.contextSwitchCount > 0) {
      recommendations.push({
        id: `recommendation-${session.id}-context-queue`,
        title: `${session.title} next-action queue`,
        type: "context_switch_reduction",
        whyItMatters: `${session.contextSwitchCount} visible context switch(es) occurred while the user was trying to complete: ${session.userIntent}`,
        suggestedAction: "Create a lightweight checklist that captures current owner, blocker, next action, and the evidence URL or app before switching surfaces.",
        estimatedMinutesPerWeek: Math.min(120, Math.max(20, session.contextSwitchCount * 15)),
        confidence: session.confidence,
        evidenceIds: session.evidenceIds.slice(0, 12)
      });
    }
    if (session.commands.length > 0) {
      recommendations.push({
        id: `recommendation-${session.id}-command-memory`,
        title: `${session.focusApplication} command recap`,
        type: "command_reuse",
        whyItMatters: `Lucille saw repeated command context in this session: ${session.commands.map((item) => item.command).slice(0, 3).join(", ")}.`,
        suggestedAction: "Save the recurring commands as a reviewed command palette or Codex skill checklist with expected output and failure follow-ups.",
        estimatedMinutesPerWeek: Math.min(90, Math.max(15, session.commands.reduce((sum, item) => sum + item.count, 0) * 10)),
        confidence: session.confidence,
        evidenceIds: session.evidenceIds.slice(0, 12)
      });
    }
    if (session.visitedUrls.length > 0) {
      recommendations.push({
        id: `recommendation-${session.id}-site-shortcuts`,
        title: `${session.focusApplication} site shortcut pack`,
        type: "software_tip",
        whyItMatters: `The session repeatedly used browser context such as ${session.visitedUrls.map((item) => item.url).slice(0, 3).join(", ")}.`,
        suggestedAction: "Create bookmarks, saved filters, or a small launch checklist for the recurring pages used in this workflow.",
        estimatedMinutesPerWeek: Math.min(60, Math.max(10, session.visitedUrls.reduce((sum, item) => sum + item.count, 0) * 5)),
        confidence: session.confidence,
        evidenceIds: session.evidenceIds.slice(0, 12)
      });
    }
  }

  for (const skill of skillProposals.proposals) {
    recommendations.push({
      id: `recommendation-${skill.id}`,
      title: skill.title,
      type: "skill_recommendation",
      whyItMatters: skill.summary,
      suggestedAction: `Review and approve the proposed ${skill.category} skill for ${skill.targetTools.join(", ")}.`,
      estimatedMinutesPerWeek: skill.estimatedMinutesPerWeek,
      confidence: skill.confidence,
      evidenceIds: skill.evidenceIds.slice(0, 12)
    });
  }

  for (const task of userMemory.regularTasks) {
    recommendations.push({
      id: `recommendation-memory-${task.id}`,
      title: `${task.title} memory-backed habit`,
      type: "memory_backed_habit",
      whyItMatters: `${task.observedFrameCount} accumulated frame(s) and ${task.observedSessionCount} session(s) suggest this is regular work, not a one-off.`,
      suggestedAction: task.workflowImprovement,
      estimatedMinutesPerWeek: Math.min(180, Math.max(20, Math.round(task.totalDwellTimeSeconds / 12))),
      confidence: task.confidence,
      evidenceIds: task.evidenceIds.slice(0, 12)
    });
  }

  const padded = dedupeRecommendations(recommendations);
  for (const session of sessionAnalysis.sessions) {
    if (padded.length >= targetRecommendationCount) break;
    padded.push({
      id: `recommendation-${session.id}-wrap-up-review`,
      title: `${session.title} wrap-up note`,
      type: "wrap_up_review",
      whyItMatters: session.focusSummary,
      suggestedAction: "At wrap-up, turn the session intent, open apps, browser URLs, and next action into a short reviewed note before closing the work context.",
      estimatedMinutesPerWeek: Math.min(45, Math.max(10, Math.round(session.durationSeconds / 18))),
      confidence: session.confidence,
      evidenceIds: session.evidenceIds.slice(0, 12)
    });
  }
  for (const application of userMemory.frequentApplications) {
    if (padded.length >= targetRecommendationCount) break;
    padded.push({
      id: `recommendation-application-${application.id}`,
      title: `${application.name} workflow shortcut`,
      type: "application_tip",
      whyItMatters: `${application.name} appeared in ${application.count} analysed frame(s), so small setup improvements here can compound.`,
      suggestedAction: "Create a reviewed shortcut, checklist, or saved workspace for the recurring actions in this application.",
      estimatedMinutesPerWeek: Math.min(40, Math.max(10, application.count * 4)),
      confidence: 0.68,
      evidenceIds: application.evidenceIds.slice(0, 12)
    });
  }

  const finalRecommendations = padRecommendations({
    recommendations: dedupeRecommendations(padded),
    sessionAnalysis,
    userMemory
  });
  return finalRecommendations.sort((left, right) => (
    right.estimatedMinutesPerWeek - left.estimatedMinutesPerWeek || right.confidence - left.confidence
  ));
}

function padRecommendations({ recommendations, sessionAnalysis, userMemory }) {
  const padded = [...recommendations];
  const add = (item) => {
    if (padded.length >= targetRecommendationCount) return;
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) return;
    const key = `${item.type}|${item.title.toLowerCase()}`;
    if (padded.some((existing) => `${existing.type}|${existing.title.toLowerCase()}` === key)) return;
    padded.push(item);
  };

  for (const application of userMemory.frequentApplications) {
    add({
      id: `recommendation-application-review-${application.id}`,
      title: `Review ${application.name} setup friction`,
      type: "application_tip",
      whyItMatters: `${application.name} appeared in ${application.count} analysed frame(s), so small setup improvements may compound.`,
      suggestedAction: "Add a reviewed note for the first action, expected state, and common follow-up when this app appears in the workflow.",
      estimatedMinutesPerWeek: Math.min(35, Math.max(8, application.count * 3)),
      confidence: 0.64,
      evidenceIds: application.evidenceIds.slice(0, 12)
    });
  }

  for (const website of userMemory.frequentWebsites) {
    add({
      id: `recommendation-website-review-${website.id}`,
      title: `Review ${website.url} navigation friction`,
      type: "software_tip",
      whyItMatters: `${website.url} appeared in ${website.count} analysed frame(s), so it may be part of a repeated setup path.`,
      suggestedAction: "Create a bookmark, saved filter, or workflow note that opens this page with the correct context.",
      estimatedMinutesPerWeek: Math.min(30, Math.max(8, website.count * 3)),
      confidence: 0.64,
      evidenceIds: website.evidenceIds.slice(0, 12)
    });
  }

  let index = 1;
  for (const session of sessionAnalysis.sessions) {
    add({
      id: `recommendation-session-checkpoint-${session.id}-${index}`,
      title: `${session.title} checkpoint ${index}`,
      type: "wrap_up_review",
      whyItMatters: session.focusSummary,
      suggestedAction: "Capture the current status, next decision, and reopen path while this session is still fresh.",
      estimatedMinutesPerWeek: Math.min(25, Math.max(6, Math.round(session.durationSeconds / 24))),
      confidence: session.confidence,
      evidenceIds: session.evidenceIds.slice(0, 12)
    });
    index += 1;
  }

  return padded.slice(0, targetRecommendationCount);
}

function buildSoftwareTips({ sessionAnalysis, userMemory }) {
  const tips = [];
  for (const site of userMemory.frequentWebsites.slice(0, 5)) {
    tips.push({
      title: `Save a launch path for ${site.url}`,
      applicationOrWebsite: site.url,
      tip: "Use a bookmark, pinned tab, or reviewed shortcut so this recurring page opens with the right context before the workflow starts.",
      evidenceIds: site.evidenceIds.slice(0, 12)
    });
  }
  for (const command of userMemory.frequentCommands.slice(0, 5)) {
    tips.push({
      title: `Document the recurring command ${command.command}`,
      applicationOrWebsite: command.command,
      tip: "Turn this command into a checklist entry with when to run it, expected output, and the next action when it fails.",
      evidenceIds: command.evidenceIds.slice(0, 12)
    });
  }
  for (const session of sessionAnalysis.sessions.slice(0, 5)) {
    tips.push({
      title: `Reduce setup friction in ${session.focusApplication}`,
      applicationOrWebsite: session.focusApplication,
      tip: "Start this recurring session from a named checklist containing the required apps, browser pages, and first decision point.",
      evidenceIds: session.evidenceIds.slice(0, 12)
    });
  }
  return dedupeByTitle(tips);
}

function buildProcrastinationEstimate(userMemory) {
  const seconds = userMemory.procrastinationSignals.reduce((sum, signal) => sum + (signal.estimatedSeconds ?? 0), 0);
  if (seconds <= 0) {
    return {
      classification: "no_strong_signal",
      estimatedMinutes: 0,
      summary: "Lucille did not find strong visible evidence of procrastination in the analysed frames. Collaboration tools are not counted as procrastination without clearer evidence.",
      evidenceIds: []
    };
  }
  return {
    classification: "needs_user_review",
    estimatedMinutes: Math.round(seconds / 60),
    summary: "Lucille found possible non-work app or website focus. Treat this as a prompt for user review rather than a claim.",
    evidenceIds: [...new Set(userMemory.procrastinationSignals.flatMap((signal) => signal.evidenceIds))].slice(0, 12)
  };
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeRecommendations(items) {
  const byKey = new Map();
  for (const item of dedupeById(items)) {
    const key = `${item.type}|${item.title.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || item.estimatedMinutesPerWeek > existing.estimatedMinutesPerWeek) {
      byKey.set(key, {
        ...item,
        evidenceIds: existing
          ? [...new Set([...existing.evidenceIds, ...item.evidenceIds])].slice(0, 12)
          : item.evidenceIds
      });
    }
  }
  return [...byKey.values()];
}

function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
