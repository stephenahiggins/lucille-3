#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const cliPath = path.join(distDir, "cli.js");

mkdirSync(distDir, { recursive: true });
writeFileSync(cliPath, "#!/usr/bin/env node\nimport \"../src/cli.mjs\";\n");
chmodSync(cliPath, 0o755);

console.log("Built dist/cli.js");
