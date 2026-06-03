#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateObservations } from "../src/analysis/observations.mjs";
import { requestScreenCapturePermission } from "../src/capture/permissions.mjs";
import { loadDotEnv } from "../src/config/env.mjs";
import { resolveLocalModel } from "../src/config/models.mjs";
import { assertPrivacySafe } from "../src/privacy/safety.mjs";
import { verifyMmpReadiness } from "./verify-mmp-readiness.mjs";

const root = process.cwd();
loadDotEnv({ root });
const args = parseArgs(process.argv.slice(2));
const day = validateDay(args.day ?? process.env.DAY ?? today());
const provider = args.provider ?? process.env.PROVIDER ?? "ollama";
const ack = args.ackRealCapture === true || process.env.LUCILLE_REAL_CAPTURE_ACK === "1";
const preflight = args.preflight === true;
const fromExistingEvidence = args.fromExistingEvidence === true;
const captureCount = parsePositiveInteger(
  args.captureCount ?? process.env.LUCILLE_OPERATOR_SMOKE_CAPTURE_COUNT ?? "3",
  "capture-count"
);
const captureIntervalSeconds = parseNonNegativeInteger(
  args.captureInterval ?? process.env.LUCILLE_OPERATOR_SMOKE_CAPTURE_INTERVAL ?? process.env.CAPTURE_INTERVAL ?? "3",
  "capture-interval"
);
const make = process.env.MAKE ?? "make";
const ollamaEndpoint = normalizeEndpoint(process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434");

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

function main() {
  if (preflight) {
    const model = resolveLocalModel({ value: args.model ?? process.env.MODEL });
    if (provider !== "ollama") {
      throw new Error("operator-smoke preflight requires PROVIDER=ollama so local visual provider checks are real.");
    }

    run(make, ["build"]);
    awaitLocalVisualProvider({ endpoint: ollamaEndpoint, model });
    console.log(`operator-smoke preflight passed for Ollama model ${model}. No capture was run and no smoke evidence was written.`);
    return;
  }

  if (fromExistingEvidence) {
    const model = resolveLocalModel({ value: args.model ?? process.env.MODEL });
    if (provider !== "ollama") {
      throw new Error("operator-smoke existing evidence mode requires PROVIDER=ollama so local visual provider evidence is real.");
    }

    run(make, ["build"]);
    awaitLocalVisualProvider({ endpoint: ollamaEndpoint, model });
    run(make, ["verify-mmp", `DAY=${day}`]);
    writeSmokeRecord({
      model,
      captureMode: "existing_day_evidence",
      captureEvidence: validateCaptureEvidence(day),
      workflowEvidence: validateWorkflowEvidence({ day, model }),
      mmpReadiness: verifyMmpReadiness({ root, day })
    });
    console.log(`operator-smoke recorded existing validated evidence for ${day} without new capture.`);
    return;
  }

  if (!ack) {
    throw new Error(
      "operator-smoke refuses to capture without explicit acknowledgement. Set LUCILLE_REAL_CAPTURE_ACK=1 or pass --ack-real-capture."
    );
  }

  if (provider !== "ollama") {
    throw new Error("operator-smoke requires PROVIDER=ollama so local visual provider evidence is real.");
  }

  run(make, ["build"]);
  const model = resolveLocalModel({ value: args.model ?? process.env.MODEL });
  awaitLocalVisualProvider({ endpoint: ollamaEndpoint, model });
  requireScreenCapturePermission();

  captureSmokeSequence({ day, count: captureCount, intervalSeconds: captureIntervalSeconds });

  const captureEvidence = validateCaptureEvidence(day);

  run(make, ["analyse", `DAY=${day}`, `PROVIDER=${provider}`, `MODEL=${model}`]);
  run(make, ["report", `DAY=${day}`]);
  run(make, ["export-skill", `DAY=${day}`, "APPROVE_EXPORT=1"]);
  run(make, ["verify-mmp", `DAY=${day}`]);

  writeSmokeRecord({
    model,
    captureMode: "fresh_capture_sequence",
    captureEvidence,
    workflowEvidence: validateWorkflowEvidence({ day, model }),
    mmpReadiness: verifyMmpReadiness({ root, day })
  });

  console.log(`operator-smoke completed for ${day} with real capture and local Ollama analysis.`);
}

function writeSmokeRecord({ model, captureMode, captureEvidence, workflowEvidence, mmpReadiness }) {
  const smoke = {
    schemaVersion: "operator-smoke.v1",
    day,
    completedAt: new Date().toISOString(),
    captureMode,
    realCaptureIngestion: true,
    localVisualProvider: true,
    privacyReview: true,
    provider,
    model,
    captureCountRequested: captureCount,
    captureIntervalSeconds,
    mmpReady: mmpReadiness.ready,
    mmpReadiness: {
      frameCount: mmpReadiness.frameCount,
      commonTaskCount: mmpReadiness.commonTaskCount,
      taskSkillSummaryCount: mmpReadiness.taskSkillSummaryCount,
      repeatedTaskFrameCount: mmpReadiness.repeatedTaskFrameCount,
      patternCount: mmpReadiness.patternCount,
      proposalCount: mmpReadiness.proposalCount,
      proposalCategories: mmpReadiness.proposalCategories
    },
    evidence: {
      observations: captureEvidence.observations,
      rawMediaFilesCaptured: captureEvidence.rawMediaFilesCaptured,
      frameAnalysis: workflowEvidence.frameAnalysis,
      report: workflowEvidence.report,
      approvedExport: workflowEvidence.approvedExport
    }
  };

  assertPrivacySafe(smoke, "operatorSmoke");
  mkdirSync(path.join(root, "logs", "ralf"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "ralf", "operator-smoke.json"),
    JSON.stringify(smoke, null, 2) + "\n"
  );
}

function captureSmokeSequence({ day: smokeDay, count, intervalSeconds }) {
  for (let index = 0; index < count; index += 1) {
    run(make, ["capture-once", `DAY=${smokeDay}`], { LUCILLE_REAL_CAPTURE_ACK: "1" });
    if (index < count - 1 && intervalSeconds > 0) {
      sleepSeconds(intervalSeconds);
    }
  }
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function requireScreenCapturePermission() {
  const permission = requestScreenCapturePermission();
  console.log(permission.message);

  if (!permission.ok) {
    throw new Error("operator-smoke cannot continue until Screen Recording permission is granted for this execution context.");
  }
}

function run(command, commandArgs, env = {}) {
  console.log(`operator-smoke: ${command} ${commandArgs.join(" ")}`);
  try {
    execFileSync(command, commandArgs, {
      cwd: root,
      env: {
        ...process.env,
        ...env
      },
      stdio: "inherit"
    });
  } catch {
    throw new Error(`operator-smoke failed while running "${command} ${commandArgs.join(" ")}". See command output above.`);
  }
}

function awaitLocalVisualProvider({ endpoint, model: expectedModel }) {
  console.log(`operator-smoke: checking Ollama model ${expectedModel} at ${endpoint}`);
  let response;
  try {
    response = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "const endpoint = process.argv[1];",
          "const model = process.argv[2];",
          "const response = await fetch(`${endpoint}/api/tags`);",
          "if (!response.ok) throw new Error(`Ollama /api/tags returned status ${response.status}`);",
          "const payload = await response.json();",
          "const models = Array.isArray(payload.models) ? payload.models.map((item) => item.name) : [];",
          "if (!models.includes(model)) throw new Error(`Ollama model ${model} is not installed`);"
        ].join("\n"),
        endpoint,
        expectedModel
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000
      }
    );
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || "").trim();
    throw new Error(
      `Ollama local visual provider is unavailable before capture. ` +
      `Start Ollama at ${endpoint} and install model ${expectedModel}.` +
      (detail ? ` Detail: ${detail}` : "")
    );
  }

  return response;
}

function validateCaptureEvidence(captureDay) {
  const captureDir = path.join(root, "storage", "captures", captureDay);
  const observationsPath = path.join(captureDir, "observations.jsonl");
  const rawMediaDir = path.join(captureDir, "raw-media");
  const observations = validateObservations(
    readJsonl(observationsPath, "capture observations"),
    { day: captureDay, source: "operatorSmoke.captureObservations" }
  );
  assertPrivacySafe(observations, "operatorSmoke.captureObservations");

  if (observations.length === 0) {
    throw new Error(`No observations found for operator smoke day ${captureDay}.`);
  }

  if (!existsSync(rawMediaDir) || !statSync(rawMediaDir).isDirectory()) {
    throw new Error(`No day-scoped raw media directory found at storage/captures/${captureDay}/raw-media/.`);
  }

  const rawMediaStems = listRawMediaStems(rawMediaDir);
  const observationIds = new Set(observations.map((observation) => observation.id));
  const missingMedia = observations
    .map((observation) => observation.id)
    .filter((id) => !rawMediaStems.includes(id));
  const unmatchedMedia = rawMediaStems.filter((stem) => !observationIds.has(stem));

  if (missingMedia.length > 0) {
    throw new Error("Each captured observation must have a matching raw media frame before local analysis.");
  }

  if (unmatchedMedia.length > 0) {
    throw new Error("Every raw media frame must have a structured observation before local analysis.");
  }

  return {
    observations: observations.length,
    rawMediaFilesCaptured: rawMediaStems.length
  };
}

function validateWorkflowEvidence({ day: workflowDay, model: expectedModel }) {
  const analysisDir = path.join(root, "storage", "analysis", workflowDay);
  const frames = readJsonl(path.join(analysisDir, "frame-analysis.jsonl"), "frame analysis");
  const patterns = readJson(path.join(analysisDir, "work-patterns.json"), "work patterns");
  const proposals = readJson(path.join(analysisDir, "skill-proposals.json"), "skill proposals");
  const reportPath = path.join(root, "output", "reports", `${workflowDay}.md`);
  const approvedExport = findApprovedExport(workflowDay);

  assertPrivacySafe(frames, "operatorSmoke.frameAnalysis");
  assertPrivacySafe(patterns, "operatorSmoke.workPatterns");
  assertPrivacySafe(proposals, "operatorSmoke.skillProposals");

  if (frames.length === 0) {
    throw new Error(`No frame-analysis.jsonl records found for ${workflowDay}.`);
  }

  if (!frames.every((frame) => frame.provider === "ollama" && frame.model === expectedModel)) {
    throw new Error(`Frame analysis must come from Ollama model ${expectedModel}.`);
  }

  if (patterns.provider !== "ollama" || patterns.model !== expectedModel) {
    throw new Error(`work-patterns.json must record Ollama model ${expectedModel}.`);
  }

  if (patterns.synthesis?.rawScreenshotsSent !== false) {
    throw new Error("work-patterns.json must confirm rawScreenshotsSent is false.");
  }

  if (patterns.synthesis?.rawMediaLifecycle?.action !== "retained_by_default") {
    throw new Error("Raw media must be retained after analysis unless deletion is explicitly requested.");
  }

  if (countRawMediaFiles(path.join(root, "storage", "captures", workflowDay, "raw-media")) === 0) {
    throw new Error("Raw media files were deleted even though deletion was not explicitly requested.");
  }

  if (!existsSync(reportPath) || !readFileSync(reportPath, "utf8").startsWith(`# Lucille Weekly Efficiency Report: ${workflowDay}`)) {
    throw new Error(`No generated daily report found for ${workflowDay}.`);
  }
  assertPrivacySafe(readFileSync(reportPath, "utf8"), "operatorSmoke.reportMarkdown");

  return {
    frameAnalysis: frames.length,
    report: path.relative(root, reportPath),
    approvedExport
  };
}

function findApprovedExport(exportDay) {
  const skillsDayDir = path.join(root, "output", "skills", exportDay);
  if (!existsSync(skillsDayDir)) {
    throw new Error(`No approved skill export directory found for ${exportDay}.`);
  }

  for (const proposal of readdirSync(skillsDayDir)) {
    const proposalDir = path.join(skillsDayDir, proposal);
    if (!statSync(proposalDir).isDirectory()) continue;
    const requiredFiles = [
      path.join(proposalDir, "claude", "SKILL.md"),
      path.join(proposalDir, "cursor", ".cursor", "rules", `${proposal}.mdc`),
      path.join(proposalDir, "chatgpt", "instructions.md"),
      path.join(proposalDir, "chatgpt", "knowledge.md"),
      path.join(proposalDir, "chatgpt", "actions.json")
    ];

    if (requiredFiles.every((filePath) => existsSync(filePath))) {
      const actions = readJson(requiredFiles.at(-1), "ChatGPT actions");
      assertPrivacySafe({
        actions,
        artifacts: requiredFiles.map((filePath) => readFileSync(filePath, "utf8"))
      }, "operatorSmoke.skillExportArtifacts");
      return path.relative(root, proposalDir);
    }
  }

  throw new Error(`No complete approved skill export bundle found for ${exportDay}.`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${path.relative(root, filePath)}: ${error.message}`);
  }
}

function readJsonl(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label} at ${path.relative(root, filePath)}.`);
  }

  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`Invalid ${label} JSONL at ${path.relative(root, filePath)}: ${error.message}`);
  }
}

function countRawMediaFiles(rawMediaDir) {
  return listRawMediaStems(rawMediaDir).length;
}

function listRawMediaStems(rawMediaDir) {
  if (!existsSync(rawMediaDir)) return [];
  const stems = [];
  for (const entry of readdirSync(rawMediaDir, { withFileTypes: true })) {
    const fullPath = path.join(rawMediaDir, entry.name);
    if (entry.isDirectory()) {
      stems.push(...listRawMediaStems(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(entry.name)) {
      stems.push(path.basename(entry.name, path.extname(entry.name)));
    }
  }
  return stems;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (name === "ackRealCapture" || name === "preflight" || name === "fromExistingEvidence") {
      flags[name] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}.`);
    }
    flags[name] = value;
    if (inlineValue === undefined) index += 1;
  }
  return flags;
}

function validateDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error(`Invalid day "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizeEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("OLLAMA_HOST must be an HTTP(S) endpoint.");
  }
  return url.origin;
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
