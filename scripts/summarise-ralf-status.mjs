#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { validateObservations } from "../src/analysis/observations.mjs";
import { assertPrivacySafe } from "../src/privacy/safety.mjs";

const root = process.env.LUCILLE_ROOT
  ? path.resolve(process.env.LUCILLE_ROOT)
  : process.cwd();

const checks = [
  ["README", "README.md"],
  ["Makefile", "Makefile"],
  ["RALF loop", "scripts/run-ralf-loop.sh"],
  ["V1 prompt", "prompts/v1-hardening-ralf.md"],
  ["Package", "package.json"],
  ["CLI", "src/cli.mjs"],
  ["Capture controller", "src/capture/controller.mjs"],
  ["Raw media lifecycle", "src/capture/rawMediaLifecycle.mjs"],
  ["Analysis runner", "src/analysis/runAnalysis.mjs"],
  ["Ollama provider", "src/analysis/ollamaProvider.mjs"],
  ["OpenAI synthesis", "src/analysis/openaiSynthesis.mjs"],
  ["Weekly reports", "src/reports/dailyReport.mjs"],
  ["Skill proposals", "src/skills/proposals.mjs"],
  ["Skill exporters", "src/skills/exporters.mjs"],
  ["Operator smoke", "scripts/operator-smoke.mjs"],
  ["Tests", "tests"]
];

const mmpChecks = [
  ["make capture loops frame ingestion", () => (
    makeTargetIncludes("capture", "$(NODE) \"$(CLI)\" capture once") &&
    makeTargetIncludes("capture", "sleep \"$(CAPTURE_INTERVAL)\"")
  )],
  ["Explicit capture-once ingestion", () => sourceIncludes("src/capture/controller.mjs", "captureVisibleScreen")],
  ["Day-scoped raw media", () => sourceIncludes("src/capture/controller.mjs", "storage\", \"captures\", captureDay")],
  ["Structured observations", () => sourceIncludes("src/analysis/observations.mjs", "redactedSignals")],
  ["Evidence IDs", () => sourceIncludes("src/analysis/observations.mjs", "evidenceIds")],
  ["Excluded apps/domains gate", () => (
    sourceIncludes("src/privacy/exclusions.mjs", "observationExclusionReason") &&
    sourceIncludes("src/capture/controller.mjs", "observationExclusionReason") &&
    sourceIncludes("src/analysis/runAnalysis.mjs", "enforceObservationExclusions")
  )],
  ["Failed capture raw media cleanup", () => sourceIncludes("src/capture/controller.mjs", "cleanupPartialRawMedia")],
  ["Default local model", () => sourceIncludes("Makefile", "moondream:1.8b")],
  ["Ollama local provider", () => sourceIncludes("src/analysis/ollamaProvider.mjs", "/api/generate")],
  ["Provider selection", () => sourceIncludes("src/analysis/runAnalysis.mjs", "validateProvider")],
  ["OpenAI redacted synthesis", () => sourceIncludes("src/analysis/openaiSynthesis.mjs", "redacted_structured")],
  ["Markdown report generation", () => sourceIncludes("src/reports/dailyReport.mjs", "daily-report.v1")],
  ["Approval-gated export", () => sourceIncludes("src/skills/exporters.mjs", "approve")],
  ["Operator smoke command", () => (
    sourceIncludes("Makefile", "operator-smoke") &&
    sourceIncludes("scripts/operator-smoke.mjs", "operator-smoke.v1") &&
    sourceIncludes("scripts/operator-smoke.mjs", "LUCILLE_REAL_CAPTURE_ACK")
  )]
];

const workflowChecks = [
  ["Capture observations JSONL", () => hasValidCaptureObservationDayFile()],
  ["Day-scoped raw media directory", () => hasRawMediaDirectory()],
  ["Frame analysis JSONL", () => hasValidJsonlDayFile("storage/analysis", "frame-analysis.jsonl")],
  ["Work patterns JSON", () => hasValidJsonDayFile("storage/analysis", "work-patterns.json", "work-patterns.v1")],
  ["Skill proposals JSON", () => hasValidJsonDayFile("storage/analysis", "skill-proposals.json", "skill-proposals.v1")],
  ["Daily report Markdown", () => hasReportMarkdown()],
  ["Approved export bundle", () => hasApprovedExportBundle()],
  ["Operator environment smoke", () => hasOperatorSmokeEvidence()]
];

console.log("");
console.log("Lucille 3 RALF status");
console.log("=====================");

let present = 0;
for (const [label, relativePath] of checks) {
  const fullPath = path.join(root, relativePath);
  const exists = existsSync(fullPath);
  if (exists) present += 1;
  const marker = exists ? "ok" : "--";
  const suffix = exists ? describePath(fullPath) : "";
  console.log(`${marker.padEnd(2)}  ${label.padEnd(18)} ${relativePath}${suffix}`);
}

console.log("");
console.log(`Scaffold readiness: ${present}/${checks.length}`);
console.log(`MMP source signals: ${countPassing(mmpChecks)}/${mmpChecks.length}`);
console.log(`MMP workflow evidence: ${countPassing(workflowChecks)}/${workflowChecks.length}`);
console.log(`MMP status: ${mmpStatus()}`);
console.log(`RALF logs: ${countFiles("logs/ralf", ".log")}`);
console.log(`Analysis days: ${countDirectories("storage/analysis")}`);
console.log(`Capture days: ${countDirectories("storage/captures")}`);
console.log(`Output files: ${countFiles("output")}`);

const loopPath = path.join(root, "scripts/run-ralf-loop.sh");
if (existsSync(loopPath)) {
  const executable = Boolean(statSync(loopPath).mode & 0o111);
  console.log(`Loop executable: ${executable ? "yes" : "no"}`);
}

const missing = checks.filter(([, relativePath]) => !existsSync(path.join(root, relativePath)));
if (missing.length > 0) {
  console.log("");
  console.log("Next likely missing slice:");
  for (const [label, relativePath] of missing.slice(0, 5)) {
    console.log(`- ${label}: ${relativePath}`);
  }
}

console.log("");
console.log("MMP readiness checks:");
for (const [label, check] of mmpChecks) {
  console.log(`${check() ? "ok" : "--"}  ${label}`);
}

console.log("");
console.log("Generated workflow evidence:");
for (const [label, check] of workflowChecks) {
  console.log(`${check() ? "ok" : "--"}  ${label}`);
}

console.log("");
console.log("Known remaining MMP blockers:");
if (!hasValidCaptureObservationDayFile()) {
  console.log("- No persisted capture observations found yet; run make capture in an operator-controlled environment.");
}
if (!hasRawMediaDirectory()) {
  console.log("- No day-scoped raw media directory found yet; capture may be blocked by platform or Screen Recording permission.");
}
if (!hasReportMarkdown()) {
  console.log("- No generated weekly report found yet; run make report DAY=<day> after analysis.");
}
if (!hasApprovedExportBundle()) {
  console.log("- No complete approved skill export bundle found yet; run make export-skill DAY=<day> APPROVE_EXPORT=1 after review.");
}
if (!hasOperatorSmokeEvidence()) {
  console.log("- Real macOS capture and Ollama provider paths are implemented, but MMP still needs operator-environment smoke evidence outside fixture injection.");
}

function describePath(fullPath) {
  const stat = statSync(fullPath);
  if (stat.isDirectory()) return "/";
  return ` (${formatBytes(stat.size)})`;
}

function countFiles(relativeDir, extension) {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return 0;
  return countFilesRecursive(dir, extension);
}

function countDirectories(relativeDir) {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()).length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function countPassing(items) {
  return items.filter(([, check]) => check()).length;
}

function mmpStatus() {
  const sourceReady = countPassing(mmpChecks) === mmpChecks.length;
  const workflowReady = countPassing(workflowChecks) === workflowChecks.length;
  return sourceReady && workflowReady ? "ready pending product signoff" : "not ready";
}

function sourceIncludes(relativePath, text) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) return false;
  return readdirOrFile(fullPath).includes(text);
}

function makeTargetIncludes(target, text) {
  const makefile = path.join(root, "Makefile");
  if (!existsSync(makefile)) return false;
  const source = readFileSync(makefile, "utf8");
  const targetMatch = source.match(new RegExp(`^${target}:.*(?:\\n\\t.*)*`, "m"));
  return Boolean(targetMatch?.[0].includes(text));
}

function readdirOrFile(fullPath) {
  if (statSync(fullPath).isDirectory()) {
    return readdirSync(fullPath)
      .map((name) => readdirOrFile(path.join(fullPath, name)))
      .join("\n");
  }

  return statSync(fullPath).isFile()
    ? readFileSync(fullPath, "utf8")
    : "";
}

function countFilesRecursive(dir, extension) {
  let count = 0;

  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      count += countFilesRecursive(fullPath, extension);
      continue;
    }

    if (stat.isFile() && (!extension || name.endsWith(extension))) {
      count += 1;
    }
  }

  return count;
}

function hasValidJsonlDayFile(relativeRoot, fileName, requiredDay = null) {
  return dayDirectories(relativeRoot, requiredDay).some((dayDir) => {
    const filePath = path.join(dayDir, fileName);
    if (!existsSync(filePath)) return false;
    return readJsonl(filePath).length > 0;
  });
}

function hasValidCaptureObservationDayFile(requiredDay = null) {
  return dayDirectories("storage/captures", requiredDay).some((dayDir) => {
    const day = path.basename(dayDir);
    const filePath = path.join(dayDir, "observations.jsonl");
    if (!existsSync(filePath)) return false;
    const observations = readValidatedObservations(filePath, day);
    return observations.length > 0 && isPrivacySafe(observations, "captureObservations");
  });
}

function hasValidJsonDayFile(relativeRoot, fileName, schemaVersion, requiredDay = null) {
  return dayDirectories(relativeRoot, requiredDay).some((dayDir) => {
    const filePath = path.join(dayDir, fileName);
    if (!existsSync(filePath)) return false;
    const value = readJson(filePath);
    return value?.schemaVersion === schemaVersion;
  });
}

function hasRawMediaDirectory(requiredDay = null) {
  return dayDirectories("storage/captures", requiredDay).some((dayDir) => {
    const day = path.basename(dayDir);
    const rawMediaDir = path.join(dayDir, "raw-media");
    const observationsPath = path.join(dayDir, "observations.jsonl");
    return existsSync(rawMediaDir) &&
      statSync(rawMediaDir).isDirectory() &&
      readValidatedObservations(observationsPath, day).length > 0;
  });
}

function hasReportMarkdown(requiredDay = null) {
  const reportsDir = path.join(root, "output", "reports");
  if (!existsSync(reportsDir)) return false;
  return readdirSync(reportsDir).some((name) => (
    /^\d{4}-\d{2}-\d{2}\.md$/.test(name) &&
    (!requiredDay || name === `${requiredDay}.md`) &&
    readFileSafely(path.join(reportsDir, name)).startsWith("# Lucille Weekly Efficiency Report:")
  ));
}

function hasApprovedExportBundle(requiredDay = null) {
  const skillsDir = path.join(root, "output", "skills");
  if (!existsSync(skillsDir)) return false;

  for (const day of safeDirNames(skillsDir)) {
    if (requiredDay && day !== requiredDay) continue;
    const dayDir = path.join(skillsDir, day);
    for (const proposal of safeDirNames(dayDir)) {
      const proposalDir = path.join(dayDir, proposal);
      const requiredFiles = [
        path.join(proposalDir, "claude", "SKILL.md"),
        path.join(proposalDir, "cursor", ".cursor", "rules", `${proposal}.mdc`),
        path.join(proposalDir, "chatgpt", "instructions.md"),
        path.join(proposalDir, "chatgpt", "knowledge.md"),
        path.join(proposalDir, "chatgpt", "actions.json")
      ];
      if (requiredFiles.every((filePath) => existsSync(filePath)) && hasPrivacySafeExportArtifacts(requiredFiles)) {
        return true;
      }
    }
  }

  return false;
}

function hasPrivacySafeExportArtifacts(requiredFiles) {
  const actions = readJson(requiredFiles.at(-1));
  if (!actions?.schemaVersion) return false;

  return isPrivacySafe({
    actions,
    artifacts: requiredFiles.map((filePath) => readFileSafely(filePath))
  }, "approvedSkillExportBundle");
}

function hasOperatorSmokeEvidence() {
  const smokePath = path.join(root, "logs", "ralf", "operator-smoke.json");
  const smoke = readJson(smokePath);
  if (!isPrivacySafe(smoke, "operatorSmoke")) return false;

  if (!(smoke?.schemaVersion === "operator-smoke.v1" &&
    smoke.realCaptureIngestion === true &&
    smoke.localVisualProvider === true &&
    smoke.privacyReview === true &&
    smoke.provider === "ollama" &&
    smoke.model === "moondream:1.8b" &&
    /^\d{4}-\d{2}-\d{2}$/.test(smoke.day ?? "") &&
    hasOperatorSmokeEvidenceSummary(smoke))) {
    return false;
  }

  return hasValidCaptureObservationDayFile(smoke.day) &&
    hasRawMediaDirectory(smoke.day) &&
    hasValidJsonlDayFile("storage/analysis", "frame-analysis.jsonl", smoke.day) &&
    hasValidJsonDayFile("storage/analysis", "work-patterns.json", "work-patterns.v1", smoke.day) &&
    hasValidJsonDayFile("storage/analysis", "skill-proposals.json", "skill-proposals.v1", smoke.day) &&
    hasReportMarkdown(smoke.day) &&
    hasApprovedExportBundle(smoke.day) &&
    hasStrictOperatorWorkflowEvidence(smoke.day, smoke.model);
}

function hasOperatorSmokeEvidenceSummary(smoke) {
  const evidence = smoke.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;

  return Number.isInteger(evidence.observations) &&
    evidence.observations > 0 &&
    Number.isInteger(evidence.rawMediaFilesCaptured) &&
    evidence.rawMediaFilesCaptured === evidence.observations &&
    Number.isInteger(evidence.frameAnalysis) &&
    evidence.frameAnalysis === evidence.observations &&
    typeof evidence.report === "string" &&
    evidence.report === `output/reports/${smoke.day}.md` &&
    typeof evidence.approvedExport === "string" &&
    evidence.approvedExport.startsWith(`output/skills/${smoke.day}/`);
}

function hasStrictOperatorWorkflowEvidence(day, model) {
  const observations = readValidatedObservations(
    path.join(root, "storage", "captures", day, "observations.jsonl"),
    day
  );
  const frames = readJsonl(path.join(root, "storage", "analysis", day, "frame-analysis.jsonl"));
  const patterns = readJson(path.join(root, "storage", "analysis", day, "work-patterns.json"));
  const proposals = readJson(path.join(root, "storage", "analysis", day, "skill-proposals.json"));
  const report = readFileSafely(path.join(root, "output", "reports", `${day}.md`));

  if (!isPrivacySafe({ observations, frames, patterns, proposals, report }, "operatorWorkflowEvidence")) {
    return false;
  }

  if (observations.length === 0 || frames.length === 0) return false;
  if (!frames.every((frame) => frame.provider === "ollama" && frame.model === model && frame.day === day)) {
    return false;
  }

  if (patterns?.provider !== "ollama" || patterns?.model !== model || patterns?.day !== day) {
    return false;
  }
  if (patterns?.synthesis?.rawScreenshotsSent !== false) return false;
  if (patterns?.synthesis?.rawMediaLifecycle?.action !== "retained_by_default") return false;

  if (proposals?.day !== day || !Array.isArray(proposals?.proposals) || proposals.proposals.length === 0) {
    return false;
  }

  if (!report.startsWith(`# Lucille Weekly Efficiency Report: ${day}`)) return false;
  if (countRawMediaFiles(path.join(root, "storage", "captures", day, "raw-media")) === 0) return false;

  return true;
}

function countRawMediaFiles(rawMediaDir) {
  if (!existsSync(rawMediaDir)) return 0;

  let count = 0;
  for (const entry of readdirSync(rawMediaDir, { withFileTypes: true })) {
    const fullPath = path.join(rawMediaDir, entry.name);
    if (entry.isDirectory()) {
      count += countRawMediaFiles(fullPath);
      continue;
    }
    if (entry.isFile() && /\.(bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(entry.name)) {
      count += 1;
    }
  }
  return count;
}

function isPrivacySafe(value, location) {
  try {
    assertPrivacySafe(value, location);
    return true;
  } catch {
    return false;
  }
}

function dayDirectories(relativeDir, requiredDay = null) {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return [];
  return safeDirNames(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .filter((name) => !requiredDay || name === requiredDay)
    .map((name) => path.join(dir, name));
}

function safeDirNames(dir) {
  try {
    return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());
  } catch {
    return [];
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(filePath) {
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readValidatedObservations(filePath, day) {
  try {
    return validateObservations(readJsonl(filePath), {
      day,
      source: "status.captureObservations"
    });
  } catch {
    return [];
  }
}

function readFileSafely(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
