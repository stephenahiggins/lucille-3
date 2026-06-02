import http from "node:http";
import path from "node:path";
import { assertPrivacySafe } from "../privacy/safety.mjs";
import { buildSkillArtifacts, exportSkillProposal } from "../skills/exporters.mjs";
import {
  readSkillProposalSet,
  selectSkillProposal,
  writeSkillProposalSet
} from "../skills/proposals.mjs";

const defaultPort = 4173;

export function createSkillUiServer(options = {}) {
  const root = options.root ?? process.cwd();
  const defaultDay = options.day ?? today();

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        return sendText(response, 200, renderPage({ defaultDay }), "text/html; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/api/proposals") {
        const day = requiredQuery(url, "day");
        const { proposalSet } = readSkillProposalSet({ root, day });
        return sendJson(response, 200, proposalSet);
      }

      if (request.method === "PUT" && url.pathname === "/api/proposals") {
        const day = requiredQuery(url, "day");
        const body = await readJsonBody(request);
        const { proposalSet } = writeSkillProposalSet({
          root,
          day,
          proposalSet: body
        });
        return sendJson(response, 200, proposalSet);
      }

      if (request.method === "POST" && url.pathname === "/api/generate") {
        const body = await readJsonBody(request);
        const result = exportSkillProposal({
          root,
          day: body.day,
          proposalId: body.proposalId,
          approve: true
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/api/download") {
        const day = requiredQuery(url, "day");
        const proposalId = requiredQuery(url, "proposalId");
        const bundle = buildDownloadBundle({ root, day, proposalId });
        return sendDownload(response, `${proposalId}-skill-bundle.json`, bundle);
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  });
}

export function startSkillUiServer(options = {}) {
  const port = Number(options.port ?? defaultPort);
  const host = options.host ?? "127.0.0.1";
  const server = createSkillUiServer(options);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}/`
      });
    });
  });
}

function buildDownloadBundle({ root, day, proposalId }) {
  const { proposals } = readSkillProposalSet({ root, day });
  const proposal = selectSkillProposal(proposals, proposalId);
  const exportRoot = path.join(root, "output", "skills", day, proposal.id);
  const artifacts = buildSkillArtifacts({ day, proposal, exportRoot });
  const bundle = {
    schemaVersion: "skill-download-bundle.v1",
    day,
    proposalId: proposal.id,
    title: proposal.title,
    files: artifacts.map((artifact) => ({
      target: artifact.target,
      path: path.relative(root, artifact.filePath),
      content: artifact.content
    }))
  };
  assertPrivacySafe(bundle, "skillDownloadBundle");
  return bundle;
}

function requiredQuery(url, key) {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`Missing query parameter "${key}".`);
  return value;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendDownload(response, filename, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendText(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function renderPage({ defaultDay }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lucille Skill Proposals</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172026;
      --muted: #65717b;
      --line: #d8dee4;
      --panel: #f7f9fb;
      --accent: #256f68;
      --accent-dark: #174f4a;
      --warn: #8a4b00;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: #fff; }
    button, input, textarea, select { font: inherit; }
    button { border: 1px solid var(--line); background: #fff; min-height: 34px; padding: 6px 10px; cursor: pointer; }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.primary:hover { background: var(--accent-dark); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .app { min-height: 100vh; display: grid; grid-template-columns: minmax(260px, 340px) 1fr; }
    aside { border-right: 1px solid var(--line); background: var(--panel); padding: 16px; overflow: auto; }
    main { padding: 18px 22px; overflow: auto; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    h2 { font-size: 16px; margin: 18px 0 10px; }
    label { display: grid; gap: 5px; font-size: 12px; font-weight: 700; color: #33414a; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); padding: 8px; background: #fff; color: var(--ink); }
    textarea { min-height: 84px; resize: vertical; line-height: 1.35; }
    .topbar { display: flex; gap: 8px; align-items: end; margin-bottom: 16px; }
    .topbar label { max-width: 160px; }
    .list { display: grid; gap: 8px; }
    .proposal-button { text-align: left; border-radius: 6px; padding: 10px; background: #fff; }
    .proposal-button.active { border-color: var(--accent); outline: 2px solid rgba(37,111,104,.12); }
    .proposal-title { font-weight: 800; margin-bottom: 4px; }
    .meta { color: var(--muted); font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .wide { grid-column: 1 / -1; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    .status { min-height: 22px; color: var(--muted); font-size: 13px; }
    .warning { color: var(--warn); }
    .files { display: grid; gap: 6px; margin-top: 8px; }
    .file { border: 1px solid var(--line); padding: 8px; background: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    @media (max-width: 820px) {
      .app { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>Lucille Skills</h1>
      <div class="topbar">
        <label>Day <input id="day" type="date"></label>
        <button id="load">Load</button>
      </div>
      <div id="summary" class="status"></div>
      <div id="proposal-list" class="list"></div>
    </aside>
    <main>
      <h1 id="editor-heading">Select a proposal</h1>
      <div class="actions">
        <button id="save" class="primary" disabled>Save edits</button>
        <button id="generate" disabled>Generate skill files</button>
        <button id="download" disabled>Download bundle</button>
      </div>
      <div id="status" class="status"></div>
      <section id="editor" class="grid" hidden>
        <label>ID <input id="id" disabled></label>
        <label>Category
          <select id="category">
            <option value="employee_weekly_report">Employee weekly report</option>
            <option value="workflow_automation">Workflow automation</option>
            <option value="ai_assistance">AI assistance</option>
            <option value="manager_monitoring">Manager monitoring</option>
            <option value="enterprise_rollout">Enterprise rollout</option>
          </select>
        </label>
        <label class="wide">Title <input id="title"></label>
        <label class="wide">Summary <textarea id="summary-field"></textarea></label>
        <label class="wide">Implementation steps <textarea id="steps"></textarea></label>
        <label class="wide">Expected outcome <textarea id="outcome"></textarea></label>
        <label>Estimated minutes per week <input id="minutes" type="number" min="1"></label>
        <label>Confidence <input id="confidence" type="number" min="0" max="1" step="0.01"></label>
        <label class="wide">Owner <input id="owner"></label>
        <label class="wide">Rollout metric <textarea id="metric"></textarea></label>
        <label class="wide">Prerequisites <textarea id="prerequisites"></textarea></label>
        <label class="wide">Evidence IDs <textarea id="evidence"></textarea></label>
      </section>
      <section>
        <h2>Generated Files</h2>
        <div id="files" class="files"></div>
      </section>
    </main>
  </div>
  <script>
    const fields = {};
    const state = { proposalSet: null, selected: 0, generated: null };
    const ids = ["id", "category", "title", "summary-field", "steps", "outcome", "minutes", "confidence", "owner", "metric", "prerequisites", "evidence"];
    for (const id of ids) fields[id] = document.getElementById(id);

    const dayInput = document.getElementById("day");
    dayInput.value = ${JSON.stringify(defaultDay)};
    document.getElementById("load").addEventListener("click", load);
    document.getElementById("save").addEventListener("click", save);
    document.getElementById("generate").addEventListener("click", generate);
    document.getElementById("download").addEventListener("click", downloadBundle);
    for (const field of Object.values(fields)) field.addEventListener("input", syncFromEditor);

    async function load() {
      setStatus("Loading proposals...");
      const response = await fetch("/api/proposals?day=" + encodeURIComponent(dayInput.value));
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      state.proposalSet = data;
      state.selected = 0;
      state.generated = null;
      render();
      setStatus("Loaded " + data.proposals.length + " proposal(s).");
    }

    function render() {
      const list = document.getElementById("proposal-list");
      const proposals = state.proposalSet?.proposals ?? [];
      document.getElementById("summary").textContent = proposals.length + " proposal(s)";
      list.innerHTML = "";
      proposals.forEach((proposal, index) => {
        const button = document.createElement("button");
        button.className = "proposal-button" + (index === state.selected ? " active" : "");
        button.innerHTML = '<div class="proposal-title"></div><div class="meta"></div>';
        button.querySelector(".proposal-title").textContent = proposal.title;
        button.querySelector(".meta").textContent = proposal.category + " · " + proposal.estimatedMinutesPerWeek + " min/week";
        button.addEventListener("click", () => { state.selected = index; state.generated = null; render(); });
        list.appendChild(button);
      });
      renderEditor();
      renderFiles();
    }

    function selectedProposal() {
      return state.proposalSet?.proposals?.[state.selected] ?? null;
    }

    function renderEditor() {
      const proposal = selectedProposal();
      document.getElementById("editor").hidden = !proposal;
      document.getElementById("save").disabled = !proposal;
      document.getElementById("generate").disabled = !proposal;
      document.getElementById("download").disabled = !proposal;
      document.getElementById("editor-heading").textContent = proposal ? proposal.title : "Select a proposal";
      if (!proposal) return;
      fields.id.value = proposal.id;
      fields.category.value = proposal.category;
      fields.title.value = proposal.title;
      fields["summary-field"].value = proposal.summary;
      fields.steps.value = proposal.implementationSteps.join("\\n");
      fields.outcome.value = proposal.expectedOutcome;
      fields.minutes.value = proposal.estimatedMinutesPerWeek;
      fields.confidence.value = proposal.confidence;
      fields.owner.value = proposal.owner;
      fields.metric.value = proposal.rolloutMetric;
      fields.prerequisites.value = proposal.prerequisites.join("\\n");
      fields.evidence.value = proposal.evidenceIds.join("\\n");
    }

    function syncFromEditor() {
      const proposal = selectedProposal();
      if (!proposal) return;
      proposal.category = fields.category.value;
      proposal.title = fields.title.value;
      proposal.summary = fields["summary-field"].value;
      proposal.implementationSteps = lines(fields.steps.value);
      proposal.expectedOutcome = fields.outcome.value;
      proposal.estimatedMinutesPerWeek = Number(fields.minutes.value);
      proposal.confidence = Number(fields.confidence.value);
      proposal.owner = fields.owner.value;
      proposal.rolloutMetric = fields.metric.value;
      proposal.prerequisites = lines(fields.prerequisites.value);
      proposal.evidenceIds = lines(fields.evidence.value);
      renderListOnly();
    }

    function renderListOnly() {
      const list = document.getElementById("proposal-list");
      [...list.children].forEach((button, index) => {
        const proposal = state.proposalSet.proposals[index];
        button.querySelector(".proposal-title").textContent = proposal.title;
        button.querySelector(".meta").textContent = proposal.category + " · " + proposal.estimatedMinutesPerWeek + " min/week";
      });
      document.getElementById("editor-heading").textContent = selectedProposal()?.title ?? "Select a proposal";
    }

    async function save() {
      syncFromEditor();
      setStatus("Saving edits...");
      const response = await fetch("/api/proposals?day=" + encodeURIComponent(dayInput.value), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.proposalSet)
      });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      state.proposalSet = data;
      render();
      setStatus("Saved proposal edits.");
    }

    async function generate() {
      const proposal = selectedProposal();
      if (!proposal) return;
      await save();
      setStatus("Generating skill files...");
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: dayInput.value, proposalId: proposal.id })
      });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      state.generated = data;
      renderFiles();
      setStatus("Generated " + data.filesWritten.length + " file(s).");
    }

    function downloadBundle() {
      const proposal = selectedProposal();
      if (!proposal) return;
      window.location.href = "/api/download?day=" + encodeURIComponent(dayInput.value) + "&proposalId=" + encodeURIComponent(proposal.id);
    }

    function renderFiles() {
      const files = document.getElementById("files");
      files.innerHTML = "";
      const items = state.generated?.filesWritten ?? [];
      if (items.length === 0) {
        files.innerHTML = '<div class="meta">Generate a proposal to write Claude, Codex, Cursor, and ChatGPT files.</div>';
        return;
      }
      for (const item of items) {
        const div = document.createElement("div");
        div.className = "file";
        div.textContent = item;
        files.appendChild(div);
      }
    }

    function lines(text) {
      return text.split("\\n").map((line) => line.trim()).filter(Boolean);
    }

    function setStatus(message, warning = false) {
      const status = document.getElementById("status");
      status.textContent = message;
      status.className = "status" + (warning ? " warning" : "");
    }

    load();
  </script>
</body>
</html>`;
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
