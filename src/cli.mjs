#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { debugFrameAnalysis } from "./analysis/debugFrame.mjs";
import { evaluateOpenAIModels } from "./analysis/modelEvaluation.mjs";
import { readAnalysisSummary, runAnalysis } from "./analysis/runAnalysis.mjs";
import { buildTaskSkillSummary } from "./analysis/taskSkillSummary.mjs";
import { handleCaptureAction } from "./capture/controller.mjs";
import { requestScreenCapturePermission } from "./capture/permissions.mjs";
import { loadDotEnv } from "./config/env.mjs";
import { resolveLocalModel, resolveOpenAIModel } from "./config/models.mjs";
import { generateDailyReport } from "./reports/dailyReport.mjs";
import { exportSkillProposal } from "./skills/exporters.mjs";
import { startSkillUiServer } from "./ui/server.mjs";

loadDotEnv();

const args = process.argv.slice(2);

main(args).catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

async function main(argv) {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "analyse") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const model = resolveLocalModel({ value: flags.model });
    const openaiModel = flags.openai
      ? resolveOpenAIModel({ value: flags.openaiModel })
      : flags.openaiModel ?? undefined;
    const result = await runAnalysis({
      day: flags.day ?? today(),
      model,
      provider: flags.provider ?? process.env.LUCILLE_ANALYSIS_PROVIDER ?? "auto",
      limit: flags.limit,
      offset: flags.offset,
      slides: flags.slides,
      openai: Boolean(flags.openai),
      openaiModel,
      reasoningEffort: flags.reasoningEffort ?? "high",
      deleteRawMedia: Boolean(flags.deleteRawMedia),
      onFrameProgress: (event) => {
        if (event.status === "cached") {
          console.log(`Frame ${event.number}/${event.total}: ${event.observation.id} from cache`);
        } else if (event.status === "analysing") {
          console.log(`Frame ${event.number}/${event.total}: analysing ${event.observation.id}`);
        } else if (event.status === "analysed") {
          console.log(`Frame ${event.number}/${event.total}: cached ${event.observation.id}`);
        }
      }
    });

    console.log(`Analysed ${result.frameCount} frame observation(s) for ${result.day}.`);
    console.log(`Local provider: ${result.provider}. Model: ${model}.`);
    console.log(`Sessions: ${result.sessionCount}. Timeline segments: ${result.timelineSegmentCount}. Patterns: ${result.patternCount}. Skill proposals: ${result.proposalCount}.`);
    console.log(`Memory tasks: ${result.memoryRegularTaskCount}. Wrap-up recommendations: ${result.wrapUpRecommendationCount}.`);
    console.log(`Wrote ${path.relative(process.cwd(), result.analysisDir)}`);
    if (flags.debugOutput) {
      writeDebugJson(flags.debugOutput, buildDebugAnalysisOutput(result));
    }
    return;
  }

  if (command === "eval-models") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const result = await evaluateOpenAIModels({
      day: flags.day ?? today(),
      models: flags.models ? flags.models.split(",") : undefined,
      reasoningEffort: flags.reasoningEffort ?? "high"
    });

    console.log(`Evaluated ${result.models.length} model(s) for ${result.day}.`);
    console.log(`Recommended model: ${result.recommendation.model ?? "none"}.`);
    for (const model of result.models) {
      console.log(`- ${model.model}: score ${model.score.total}, ok=${model.ok}`);
    }
    console.log(`Report: ${result.outputPath}`);
    return;
  }

  if (command === "debug-frame") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const model = resolveLocalModel({ value: flags.model });
    const result = await debugFrameAnalysis({
      day: flags.day ?? today(),
      model,
      frameId: flags.frameId,
      offset: flags.offset,
      env: process.env
    });

    console.log(`Debugged one frame for ${result.day}.`);
    console.log(`Model: ${result.model}. Provider: ${result.provider}.`);
    console.log(`Frame: ${result.selected.frameId} at offset ${result.selected.index}.`);
    console.log(`Evidence: ${result.selected.evidenceIds.join(", ")}`);
    console.log(`Raw media: ${result.selected.rawMediaPath}`);
    console.log(`Prompt source: ${result.promptSource}`);
    console.log("\n--- Prompt ---");
    console.log(result.prompt);
    console.log("\n--- Normalized Frame Analysis ---");
    console.log(JSON.stringify(result.frame, null, 2));
    if (flags.debugOutput) {
      writeDebugJson(flags.debugOutput, result);
    }
    return;
  }

  if (command === "review") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const day = flags.day ?? today();
    const summary = readAnalysisSummary(process.cwd(), day);
    if (!summary.exists) {
      console.log(`No skill proposals found for ${day}. Run make analyse DAY=${day} first.`);
      return;
    }

    console.log(`Skill proposals for ${day}`);
    for (const proposal of summary.proposals) {
      console.log(`- ${proposal.title} (${proposal.confidence}): ${proposal.evidenceIds.join(", ")}`);
    }
    return;
  }

  if (command === "tasks") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const day = flags.day ?? today();
    const summary = buildTaskSkillSummary({ day });
    console.log(`Common tasks for ${day}`);
    if (summary.commonTasks.length === 0) {
      console.log("No common tasks found.");
      return;
    }
    for (const task of summary.commonTasks) {
      console.log(`- ${task.title} (confidence ${task.confidence}, ${task.evidenceCount} frame(s), ${task.segmentCount} segment(s), ${task.dwellTimeSeconds}s dwell)`);
      console.log(`  Evidence: ${task.evidenceNarrative}`);
      console.log(`  Representative evidence IDs: ${task.evidenceIds.join(", ")}`);
      console.log(`  Key tasks: ${task.topTasks.join("; ")}`);
      const skills = task.skills.slice(0, 5);
      if (skills.length === 0) {
        console.log("  Skills: none matched");
      } else {
        console.log("  Skills:");
        for (const skill of skills) {
          console.log(`  - ${skill.title} [${skill.category}] confidence ${skill.confidence}, overlap ${skill.overlap}, saves ${skill.estimatedMinutesPerWeek} min/week`);
        }
      }
    }
    return;
  }

  if (command === "report") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const result = generateDailyReport({
      day: flags.day ?? today()
    });

    console.log(result.message);
    console.log(`Frames: ${result.frameCount}. Patterns: ${result.patternCount}. Skill proposals: ${result.proposalCount}.`);
    console.log(`Report: ${result.reportPath}`);
    return;
  }

  if (command === "export") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const result = exportSkillProposal({
      day: flags.day ?? today(),
      proposalId: flags.proposalId,
      approve: Boolean(flags.approveExport)
    });

    console.log(result.message);
    console.log(`Proposal: ${result.proposalId}`);
    console.log(`Export root: ${result.exportRoot}`);
    const files = result.approved ? result.filesWritten : result.filesPlanned;
    for (const file of files) {
      console.log(`- ${file}`);
    }
    return;
  }

  if (command === "ui") {
    const flags = parseFlags([subcommand, ...rest].filter(Boolean));
    const day = flags.day ?? today();
    const result = await startSkillUiServer({
      day,
      port: flags.port ?? process.env.PORT ?? 4173,
      host: flags.host ?? "127.0.0.1"
    });

    console.log(`Lucille skill UI running at ${result.url}`);
    console.log(`Editing proposals for ${day}. Press Ctrl-C to stop.`);
    return;
  }

  if (command === "capture") {
    handleCapture(subcommand, rest);
    return;
  }

  throw new Error(`Unknown command "${command}". Run lucille --help for usage.`);
}

function handleCapture(action = "status", argv = []) {
  const flags = parseFlags(argv);

  if (action === "permission") {
    const result = requestScreenCapturePermission({
      openSettings: !flags.noOpenSettings,
      requestAccess: !flags.noRequestAccess
    });
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const result = handleCaptureAction({
    action,
    day: flags.day,
    realCaptureAck: Boolean(flags.ackRealCapture)
  });
  console.log(result.message);
}

function parseFlags(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (["openai", "retainRawMedia", "deleteRawMedia", "approveExport", "ackRealCapture", "noOpenSettings", "noRequestAccess"].includes(name)) {
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

function writeDebugJson(outputPath, payload) {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Debug JSON: ${path.relative(process.cwd(), resolvedPath)}`);
}

function buildDebugAnalysisOutput(result) {
  const analysisDir = result.analysisDir;
  return {
    schemaVersion: "debug-analysis.v1",
    generatedAt: new Date().toISOString(),
    result: {
      ...result,
      analysisDir: path.relative(process.cwd(), analysisDir)
    },
    artifacts: {
      frameAnalysis: readJsonl(path.join(analysisDir, "frame-analysis.jsonl")),
      activityTimeline: readJson(path.join(analysisDir, "activity-timeline.json")),
      sessionAnalysis: readJson(path.join(analysisDir, "session-analysis.json")),
      workPatterns: readJson(path.join(analysisDir, "work-patterns.json")),
      skillProposals: readJson(path.join(analysisDir, "skill-proposals.json")),
      taskSkillSummary: readJson(path.join(analysisDir, "task-skill-summary.json")),
      memoryUpdate: readJson(path.join(analysisDir, "memory-update.json")),
      optimizationWrapUp: readJson(path.join(analysisDir, "optimization-wrap-up.json"))
    }
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function printHelp() {
  console.log(`Lucille 3

Usage:
  lucille analyse [--day YYYY-MM-DD] [--model MODEL] [--provider auto|ollama] [--limit N] [--offset N] [--slides 1-3,7,10-12] [--delete-raw-media] [--debug-output PATH]
  lucille debug-frame [--day YYYY-MM-DD] [--frame-id OBS_OR_EVIDENCE_ID] [--offset N] [--model MODEL] [--debug-output PATH]
  lucille analyse --openai [--openai-model MODEL]
  lucille eval-models [--day YYYY-MM-DD] [--models MODEL[,MODEL...]] [--reasoning-effort high]
  lucille capture permission [--no-open-settings] [--no-request-access]
  lucille capture start|pause|resume|stop|once|status [--day YYYY-MM-DD] [--ack-real-capture]
  lucille report --day YYYY-MM-DD
  lucille tasks --day YYYY-MM-DD
  lucille review --day YYYY-MM-DD
  lucille export --day YYYY-MM-DD [--proposal-id skill-id] [--approve-export]
  lucille ui [--day YYYY-MM-DD] [--port 4173]

Defaults are local-first and model names come from .env unless explicit flags are passed. The analyse command requires real captured observations with day-scoped raw media and a local Ollama visual provider; mock fixture analysis is disabled. If captured observations, raw media, or Ollama are unavailable, analysis fails clearly. Real capture requires LUCILLE_REAL_CAPTURE_ACK=1 or --ack-real-capture. Use lucille capture permission to request/check macOS Screen Recording access before operator smoke. Analysis retains day-scoped raw media by default and deletes it only when --delete-raw-media is set. Analysis stores no raw screenshots in structured artifacts, keystrokes, clipboard, audio, raw document bodies, or raw message bodies.`);
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
