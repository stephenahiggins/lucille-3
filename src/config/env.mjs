import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadDotEnv(options = {}) {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  const filePath = options.filePath ?? path.join(root, ".env");

  if (!existsSync(filePath)) {
    return {
      loaded: false,
      filePath,
      keys: []
    };
  }

  const keys = [];
  const text = readFileSync(filePath, "utf8");
  for (const [lineNumber, rawLine] of text.split(/\r?\n/).entries()) {
    const parsed = parseDotEnvLine(rawLine, lineNumber + 1);
    if (!parsed) continue;
    if (env[parsed.key] === undefined) {
      env[parsed.key] = parsed.value;
    }
    keys.push(parsed.key);
  }

  return {
    loaded: true,
    filePath,
    keys
  };
}

function parseDotEnvLine(rawLine, lineNumber) {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) return null;

  const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) {
    throw new Error(`.env line ${lineNumber}: expected KEY=value.`);
  }

  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`.env line ${lineNumber}: invalid environment variable name.`);
  }

  const rawValue = withoutExport.slice(equalsIndex + 1).trim();
  return {
    key,
    value: unquoteValue(rawValue)
  };
}

function unquoteValue(value) {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s+#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}
