#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageName = "lucille-ui-recorder";
const version = packageJson.version ?? "0.0.0";
const stamp = localDateStamp();
const distRoot = path.join(root, "dist");
const bundleRoot = path.join(distRoot, packageName);
const archivePath = path.join(distRoot, `${packageName}-${version}-${stamp}.tar.gz`);

const runtimeEntries = [
  "fixtures",
  "src"
];

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
  cwd: root,
  stdio: "inherit"
});

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });

for (const entry of runtimeEntries) {
  const source = path.join(root, entry);
  if (!existsSync(source)) continue;
  cpSync(source, path.join(bundleRoot, entry), {
    recursive: true,
    filter: shouldCopy
  });
}

mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
cpSync(path.join(root, "scripts", "build.mjs"), path.join(bundleRoot, "scripts", "build.mjs"));
mkdirSync(path.join(bundleRoot, "dist"), { recursive: true });
cpSync(path.join(root, "dist", "cli.js"), path.join(bundleRoot, "dist", "cli.js"));
writeFileSync(path.join(bundleRoot, "Makefile"), recorderMakefile(), "utf8");
writeFileSync(path.join(bundleRoot, "README.md"), workComputerReadme(), "utf8");
writeFileSync(path.join(bundleRoot, ".env.example"), recorderDotEnvExample(), "utf8");
writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify(recorderPackageJson(), null, 2) + "\n", "utf8");
writeFileSync(path.join(bundleRoot, ".gitignore"), recorderGitignore(), "utf8");

rmSync(archivePath, { force: true });
execFileSync("tar", ["-czf", archivePath, "-C", distRoot, packageName], {
  cwd: root,
  stdio: "inherit"
});

console.log(`Created ${path.relative(root, bundleRoot)}/`);
console.log(`Created ${path.relative(root, archivePath)}`);

function shouldCopy(source) {
  const relative = path.relative(root, source);
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === ".DS_Store")) return false;
  return !parts.some((part) => new Set([
    ".git",
    "dist",
    "logs",
    "node_modules",
    "output",
    "storage"
  ]).has(part));
}

function recorderPackageJson() {
  return {
    name: packageName,
    version,
    private: true,
    type: "module",
    description: "Portable local-first UI screen recorder for Lucille.",
    scripts: {
      build: "node scripts/build.mjs"
    },
    engines: {
      node: ">=20"
    }
  };
}

function recorderMakefile() {
  return `DAY ?= $(shell date +%F)
-include .env
CAPTURE_INTERVAL ?= 3
MODEL ?= $(LUCILLE_LOCAL_MODEL)
PROVIDER ?= auto
ANALYSE_LIMIT ?=
ANALYSE_OFFSET ?= 0
OPENAI ?= 0
OPENAI_MODEL ?= $(LUCILLE_OPENAI_MODEL)
REASONING_EFFORT ?= high
DELETE_RAW_MEDIA ?= 0
NODE ?= node
NPM ?= npm
CLI ?= dist/cli.js

.PHONY: help dirs build capture analyse

help:
\t@echo "Lucille UI Recorder"
\t@echo "  make capture        # capture visible frames every $(CAPTURE_INTERVAL)s; Ctrl-C to stop"
\t@echo "  make analyse"

dirs:
\t@mkdir -p storage output logs/ralf

build: dirs
\t@$(NPM) run build --if-present

capture: build
\t@echo "Capturing visible frames every $(CAPTURE_INTERVAL)s for DAY=$(DAY). Press Ctrl-C to stop."; \\
\twhile true; do \\
\t\t$(NODE) "$(CLI)" capture once --day "$(DAY)" --ack-real-capture || exit $$?; \\
\t\tsleep "$(CAPTURE_INTERVAL)"; \\
\tdone

analyse: build
\t@ARGS="analyse --day $(DAY) --provider $(PROVIDER)"; \\
\tif [ -n "$(MODEL)" ]; then \\
\t\tARGS="$$ARGS --model $(MODEL)"; \\
\tfi; \\
\tif [ -n "$(ANALYSE_LIMIT)" ]; then \\
\t\tARGS="$$ARGS --limit $(ANALYSE_LIMIT) --offset $(ANALYSE_OFFSET)"; \\
\tfi; \\
\tif [ "$(DELETE_RAW_MEDIA)" = "1" ]; then \\
\t\tARGS="$$ARGS --delete-raw-media"; \\
\tfi; \\
\tif [ "$(OPENAI)" = "1" ]; then \\
\t\tARGS="$$ARGS --openai --reasoning-effort $(REASONING_EFFORT)"; \\
\t\tif [ -n "$(OPENAI_MODEL)" ]; then \\
\t\t\tARGS="$$ARGS --openai-model $(OPENAI_MODEL)"; \\
\t\tfi; \\
\tfi; \\
\techo "$(NODE) $(CLI) $$ARGS"; \\
\t$(NODE) "$(CLI)" $$ARGS
`;
}

function recorderGitignore() {
  return `.env
logs/
node_modules/
output/
storage/
`;
}

function recorderDotEnvExample() {
  return `LUCILLE_LOCAL_MODEL=
LUCILLE_OPENAI_MODEL=
LUCILLE_EVAL_MODELS=
LUCILLE_EVAL_BASELINE_MODEL=
`;
}

function workComputerReadme() {
  return `# Lucille UI Recorder

This is the portable Lucille recorder bundle for a macOS work computer.

## Requirements

- macOS
- Node.js 20 or newer
- Make, included with Apple command line tools
- Optional but recommended for real local visual analysis: Ollama with the model named in \`.env\`

## Run

\`\`\`bash
cd lucille-ui-recorder
cp .env.example .env
make capture
make analyse
\`\`\`

\`make capture\` runs in the foreground and captures one visible frame every 3 seconds. Stop it with Ctrl-C. Override the interval with \`CAPTURE_INTERVAL=5 make capture\`. If macOS Screen Recording permission is not available, Lucille asks the OS for permission and opens System Settings to Privacy & Security > Screen Recording. Grant permission to the app running the command, such as Terminal, iTerm, VS Code, or Codex, then quit and reopen that app before rerunning \`make capture\`.

\`make analyse\` uses \`LUCILLE_LOCAL_MODEL\` from \`.env\` and \`PROVIDER=auto\`. Install the local model named there with:

\`\`\`bash
ollama pull "$LUCILLE_LOCAL_MODEL"
\`\`\`

For a quick local vision test, run a small chunk first:

\`\`\`bash
make analyse PROVIDER=ollama ANALYSE_LIMIT=5
make analyse PROVIDER=ollama ANALYSE_LIMIT=5 ANALYSE_OFFSET=5
\`\`\`

To try a different local vision model, update \`LUCILLE_LOCAL_MODEL\` in \`.env\` or pass \`MODEL=<name>\` for one run:

\`\`\`bash
make analyse PROVIDER=ollama MODEL=<model-name> ANALYSE_LIMIT=5
\`\`\`

Captured frames are stored under \`storage/captures/<DAY>/raw-media/\` and retained by default after analysis. Set \`DELETE_RAW_MEDIA=1\` only when you explicitly want analysis to delete day-scoped raw media after producing structured local analysis artifacts.

## Outputs

- \`storage/captures/<DAY>/observations.jsonl\`
- \`storage/analysis/<DAY>/frame-analysis.jsonl\`
- \`storage/analysis/<DAY>/work-patterns.json\`
- \`storage/analysis/<DAY>/skill-proposals.json\`

No keystrokes, clipboard contents, audio, cookies, tokens, full URLs with query strings, raw document bodies, or raw message bodies are captured.
`;
}

function localDateStamp() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10).replace(/-/g, "");
}
