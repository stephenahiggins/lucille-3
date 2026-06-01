#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", "dist", "node_modules", "storage", "output", "logs"]);
const files = [];

collect(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript file(s).`);

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) collect(path.join(dir, entry.name));
      continue;
    }

    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
}
