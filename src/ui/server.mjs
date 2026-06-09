import http from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildTaskSkillSummary, writeTaskSkillSummary } from "../analysis/taskSkillSummary.mjs";
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
  const reloadVersion = options.reloadVersion ?? `${Date.now()}`;

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        return sendText(response, 200, renderPage({ defaultDay, reloadVersion }), "text/html; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/api/analysis-days") {
        return sendJson(response, 200, {
          schemaVersion: "analysis-days.v1",
          days: listAnalysisDays(root)
        });
      }

      if (request.method === "GET" && url.pathname === "/api/reload-version") {
        return sendJson(response, 200, {
          schemaVersion: "ui-reload-version.v1",
          version: reloadVersion
        });
      }

      if (request.method === "GET" && url.pathname === "/api/proposals") {
        const day = requiredQuery(url, "day");
        const { proposalSet } = readSkillProposalSet({ root, day });
        return sendJson(response, 200, buildProposalUiData({ root, day, proposalSet }));
      }

      if (request.method === "PUT" && url.pathname === "/api/proposals") {
        const day = requiredQuery(url, "day");
        const body = await readJsonBody(request);
        const { proposalSet } = writeSkillProposalSet({
          root,
          day,
          proposalSet: body.proposalSet ?? body
        });
        writeTaskSkillSummary({ root, day });
        return sendJson(response, 200, buildProposalUiData({ root, day, proposalSet }));
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

      if (request.method === "POST" && url.pathname === "/api/preview") {
        const body = await readJsonBody(request);
        const bundle = buildPreviewBundle({
          root,
          day: body.day,
          proposalId: body.proposalId,
          proposalSet: body.proposalSet
        });
        return sendJson(response, 200, bundle);
      }

      if (request.method === "GET" && url.pathname === "/api/download") {
        const day = requiredQuery(url, "day");
        const proposalId = requiredQuery(url, "proposalId");
        const bundle = buildDownloadBundle({ root, day, proposalId });
        return sendDownload(response, `${proposalId}-skill-bundle.json`, bundle);
      }

      if (request.method === "GET" && url.pathname === "/api/raw-frame") {
        const day = validateDay(requiredQuery(url, "day"));
        const evidenceId = requiredEvidenceId(requiredQuery(url, "evidenceId"));
        const frame = findRawFrame({ root, day, evidenceId });
        return sendBinary(response, 200, frame.content, frame.contentType);
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

function listAnalysisDays(root) {
  const analysisDir = path.join(root, "storage", "analysis");
  if (!existsSync(analysisDir)) return [];
  return readdirSync(analysisDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((day) => existsSync(path.join(analysisDir, day, "skill-proposals.json")))
    .sort()
    .reverse();
}

function buildProposalUiData({ root, day, proposalSet }) {
  const commonTasks = readCommonTaskSummaries({ root, day });
  const payload = {
    schemaVersion: "proposal-ui-data.v1",
    day,
    proposalSet,
    proposals: proposalSet.proposals,
    commonTasks,
    rawFrameEvidenceIds: listRawFrameEvidenceIds({ root, day })
  };
  assertPrivacySafe(payload, "proposalUiData");
  return payload;
}

function listRawFrameEvidenceIds({ root, day }) {
  const rawMediaDir = path.join(root, "storage", "captures", day, "raw-media");
  if (!existsSync(rawMediaDir)) return [];
  return readdirSync(rawMediaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parsed = path.parse(entry.name);
      if (!contentTypeFor(parsed.ext)) return null;
      return `${parsed.name}-raw-frame`;
    })
    .filter(Boolean)
    .sort();
}

function readCommonTaskSummaries({ root, day }) {
  const timelinePath = path.join(root, "storage", "analysis", day, "activity-timeline.json");
  if (!existsSync(timelinePath)) return [];
  return buildTaskSkillSummary({ root, day }).commonTasks.map((task) => ({
    ...task,
    skills: task.skills.slice(0, 5).map(({ id, title, category, confidence }) => ({ id, title, category, confidence }))
  }));
}

function buildDownloadBundle({ root, day, proposalId }) {
  const { proposals } = readSkillProposalSet({ root, day });
  const bundle = buildArtifactBundle({ root, day, proposalId, proposals, schemaVersion: "skill-download-bundle.v1" });
  assertPrivacySafe(bundle, "skillDownloadBundle");
  return bundle;
}

function buildPreviewBundle({ root, day, proposalId, proposalSet }) {
  const source = proposalSet?.proposals ? proposalSet : readSkillProposalSet({ root, day }).proposalSet;
  const bundle = buildArtifactBundle({
    root,
    day,
    proposalId,
    proposals: source.proposals,
    schemaVersion: "skill-preview-bundle.v1"
  });
  assertPrivacySafe(bundle, "skillPreviewBundle");
  return bundle;
}

function buildArtifactBundle({ root, day, proposalId, proposals, schemaVersion }) {
  const proposal = selectSkillProposal(proposals, proposalId);
  const exportRoot = path.join(root, "output", "skills", day, proposal.id);
  const taskContexts = buildTaskSkillSummary({ root, day }).commonTasks.filter((task) => (
    task.skills.some((skill) => skill.id === proposal.id)
  ));
  const artifacts = buildSkillArtifacts({ day, proposal, exportRoot, taskContexts });
  const bundle = {
    schemaVersion,
    day,
    proposalId: proposal.id,
    title: proposal.title,
    repeatedTaskContexts: taskContexts,
    files: artifacts.map((artifact) => ({
      target: artifact.target,
      path: path.relative(root, artifact.filePath),
      content: artifact.content
    }))
  };
  return bundle;
}

function findRawFrame({ root, day, evidenceId }) {
  const rawMediaDir = path.join(root, "storage", "captures", day, "raw-media");
  const frameStem = evidenceId.replace(/-raw-frame$/i, "");
  const extensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"];
  for (const extension of extensions) {
    const filePath = path.join(rawMediaDir, `${frameStem}${extension}`);
    if (isSafeChildPath(rawMediaDir, filePath) && existsSync(filePath) && statSync(filePath).isFile()) {
      return {
        content: readFileSync(filePath),
        contentType: contentTypeFor(extension)
      };
    }
  }
  throw new Error(`No retained raw frame found for evidence ${evidenceId}.`);
}

function contentTypeFor(extension) {
  const normalized = extension.toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".bmp") return "image/bmp";
  if (normalized === ".tif" || normalized === ".tiff") return "image/tiff";
  if (normalized === ".heic") return "image/heic";
  return "image/png";
}

function isSafeChildPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requiredQuery(url, key) {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`Missing query parameter "${key}".`);
  return value;
}

function validateDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error(`Invalid day "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

function requiredEvidenceId(value) {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value ?? "")) {
    throw new Error("Invalid evidence ID.");
  }
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

function sendBinary(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "private, max-age=300"
  });
  response.end(body);
}

function renderPage({ defaultDay, reloadVersion }) {
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
    .app { min-height: 100vh; display: grid; grid-template-columns: minmax(260px, 340px) minmax(280px, 360px) minmax(420px, 1fr); }
    aside { border-right: 1px solid var(--line); background: var(--panel); padding: 16px; overflow: auto; }
    .proposal-sidebar { border-left: 0; }
    main { padding: 18px 22px; overflow: auto; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    h2 { font-size: 16px; margin: 18px 0 10px; }
    label { display: grid; gap: 5px; font-size: 12px; font-weight: 700; color: #33414a; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); padding: 8px; background: #fff; color: var(--ink); }
    textarea { min-height: 84px; resize: vertical; line-height: 1.35; }
    .field-frame-links { margin-top: -8px; }
    .field-frame-links:empty { display: none; }
    .topbar { display: flex; gap: 8px; align-items: end; margin-bottom: 16px; }
    .topbar label { max-width: 160px; }
    .filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .filters .wide { grid-column: 1 / -1; }
    .common-tasks { display: grid; gap: 8px; margin: 0 0 14px; }
    .task-card { border: 1px solid var(--line); border-radius: 6px; background: #fff; padding: 10px; }
    .task-title { font-weight: 800; margin-bottom: 5px; }
    .task-summary { color: #33414a; font-size: 12px; line-height: 1.35; }
    .evidence-links { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .evidence-link { position: relative; display: inline-flex; align-items: center; border: 1px solid var(--line); background: #fdfefe; color: var(--accent-dark); padding: 3px 6px; font-size: 12px; text-decoration: none; }
    .frame-preview { display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: 20; width: min(360px, 70vw); border: 1px solid var(--line); background: #fff; padding: 6px; box-shadow: 0 12px 30px rgba(23,32,38,.18); }
    .frame-preview img { display: block; width: 100%; height: auto; max-height: 260px; object-fit: contain; background: #f1f4f6; }
    .evidence-link:hover .frame-preview, .evidence-link:focus .frame-preview { display: block; }
    .task-tags { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .task-skills { display: grid; gap: 4px; margin-top: 8px; font-size: 12px; }
    .task-skill { border: 1px solid var(--line); background: #fdfefe; padding: 5px 6px; }
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
    .preview-toolbar { display: grid; grid-template-columns: minmax(220px, 420px) auto; gap: 8px; align-items: end; margin-bottom: 10px; }
    .preview-content { border: 1px solid var(--line); background: #fff; min-height: 420px; max-height: 70vh; overflow: auto; padding: 12px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45; }
    .preview-empty { border: 1px solid var(--line); background: #fff; padding: 12px; color: var(--muted); }
    .files { display: grid; gap: 6px; margin-top: 8px; }
    .file { border: 1px solid var(--line); padding: 8px; background: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    @media (max-width: 820px) {
      .app { grid-template-columns: 1fr; }
      aside, .proposal-sidebar { border-right: 0; border-left: 0; border-bottom: 1px solid var(--line); }
      .grid { grid-template-columns: 1fr; }
      .filters { grid-template-columns: 1fr; }
      .filters .wide { grid-column: auto; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>Lucille Skills</h1>
      <div class="topbar">
        <label>Day <select id="day"></select></label>
        <button id="load">Load</button>
      </div>
      <h2>Common Tasks</h2>
      <div id="common-tasks" class="common-tasks"></div>
    </aside>
    <aside class="proposal-sidebar">
      <h1>Proposals</h1>
      <div class="filters">
        <label>Sort
          <select id="sort">
            <option value="confidence-desc">Confidence high to low</option>
            <option value="confidence-asc">Confidence low to high</option>
            <option value="minutes-desc">Minutes high to low</option>
            <option value="minutes-asc">Minutes low to high</option>
            <option value="title-asc">Title A to Z</option>
            <option value="original">Original order</option>
          </select>
        </label>
        <label>Category
          <select id="category-filter">
            <option value="all">All categories</option>
            <option value="employee_weekly_report">Employee weekly report</option>
            <option value="workflow_automation">Workflow automation</option>
            <option value="ai_assistance">AI assistance</option>
            <option value="manager_monitoring">Manager monitoring</option>
            <option value="enterprise_rollout">Enterprise rollout</option>
          </select>
        </label>
        <label>Confidence
          <select id="confidence-filter">
            <option value="all">All confidence</option>
            <option value="high">High (0.80+)</option>
            <option value="medium">Medium (0.60-0.79)</option>
            <option value="low">Low (&lt;0.60)</option>
          </select>
        </label>
        <label class="wide">Search <input id="search" type="search" placeholder="Title, summary, evidence"></label>
      </div>
      <div id="summary" class="status"></div>
      <div id="proposal-list" class="list"></div>
    </aside>
    <main>
      <h1 id="editor-heading">Select a proposal</h1>
      <div class="actions">
        <button id="save" class="primary" disabled>Save edits</button>
        <button id="preview-skills" disabled>Preview skill files</button>
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
        <div id="summary-frame-links" class="wide evidence-links field-frame-links"></div>
        <label class="wide">Implementation steps <textarea id="steps"></textarea></label>
        <div id="steps-frame-links" class="wide evidence-links field-frame-links"></div>
        <label class="wide">Expected outcome <textarea id="outcome"></textarea></label>
        <div id="outcome-frame-links" class="wide evidence-links field-frame-links"></div>
        <label>Estimated minutes per week <input id="minutes" type="number" min="1"></label>
        <label>Confidence <input id="confidence" type="number" min="0" max="1" step="0.01"></label>
        <label class="wide">Owner <input id="owner"></label>
        <label class="wide">Rollout metric <textarea id="metric"></textarea></label>
        <div id="metric-frame-links" class="wide evidence-links field-frame-links"></div>
        <label class="wide">Prerequisites <textarea id="prerequisites"></textarea></label>
        <div id="prerequisites-frame-links" class="wide evidence-links field-frame-links"></div>
        <label class="wide">Evidence IDs <textarea id="evidence"></textarea></label>
        <div id="evidence-frame-links" class="wide evidence-links field-frame-links"></div>
        <div id="editor-frame-links" class="wide evidence-links"></div>
      </section>
      <section id="preview-panel" hidden>
        <div class="preview-toolbar">
          <label>Skill file <select id="preview-file"></select></label>
          <button id="refresh-preview" type="button" disabled>Refresh preview</button>
        </div>
        <pre id="preview-content" class="preview-content"></pre>
      </section>
      <section>
        <h2>Generated Files</h2>
        <div id="files" class="files"></div>
      </section>
    </main>
  </div>
  <script>
    const fields = {};
    const state = { proposalSet: null, commonTasks: [], rawFrameEvidenceIds: new Set(), selectedId: null, generated: null, preview: null, previewFilePath: null };
    const ids = ["id", "category", "title", "summary-field", "steps", "outcome", "minutes", "confidence", "owner", "metric", "prerequisites", "evidence"];
    for (const id of ids) fields[id] = document.getElementById(id);

    const dayInput = document.getElementById("day");
    const sortInput = document.getElementById("sort");
    const categoryFilter = document.getElementById("category-filter");
    const confidenceFilter = document.getElementById("confidence-filter");
    const searchInput = document.getElementById("search");
    const defaultDay = ${JSON.stringify(defaultDay)};
    const serverReloadVersion = ${JSON.stringify(reloadVersion)};
    document.getElementById("load").addEventListener("click", load);
    document.getElementById("save").addEventListener("click", save);
    document.getElementById("preview-skills").addEventListener("click", previewSkills);
    document.getElementById("generate").addEventListener("click", generate);
    document.getElementById("download").addEventListener("click", downloadBundle);
    document.getElementById("refresh-preview").addEventListener("click", previewSkills);
    document.getElementById("preview-file").addEventListener("change", (event) => {
      state.previewFilePath = event.target.value;
      renderPreviewContent();
    });
    sortInput.addEventListener("change", render);
    categoryFilter.addEventListener("change", render);
    confidenceFilter.addEventListener("change", render);
    searchInput.addEventListener("input", render);
    for (const field of Object.values(fields)) field.addEventListener("input", syncFromEditor);

    async function load() {
      setStatus("Loading proposals...");
      const response = await fetch("/api/proposals?day=" + encodeURIComponent(dayInput.value));
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      state.proposalSet = data.proposalSet ?? data;
      state.commonTasks = data.commonTasks ?? [];
      state.rawFrameEvidenceIds = new Set(data.rawFrameEvidenceIds ?? []);
      state.selectedId = state.proposalSet.proposals[0]?.id ?? null;
      state.generated = null;
      state.preview = null;
      state.previewFilePath = null;
      render();
      setStatus("Loaded " + state.proposalSet.proposals.length + " proposal(s).");
    }

    function render() {
      const list = document.getElementById("proposal-list");
      const proposals = visibleProposals();
      if (proposals.length > 0 && !proposals.some((proposal) => proposal.id === state.selectedId)) {
        state.selectedId = proposals[0].id;
        state.generated = null;
      } else if (proposals.length === 0) {
        state.selectedId = null;
        state.generated = null;
      }
      document.getElementById("summary").textContent = summaryText(proposals.length, state.proposalSet?.proposals?.length ?? 0);
      renderCommonTasks();
      list.innerHTML = "";
      proposals.forEach((proposal) => {
        const button = document.createElement("button");
        button.className = "proposal-button" + (proposal.id === state.selectedId ? " active" : "");
        button.innerHTML = '<div class="proposal-title"></div><div class="meta"></div>';
        button.querySelector(".proposal-title").textContent = proposal.title;
        button.querySelector(".meta").textContent = proposal.category + " · confidence " + formatConfidence(proposal.confidence) + " · " + proposal.estimatedMinutesPerWeek + " min/week";
        button.addEventListener("click", () => { state.selectedId = proposal.id; state.generated = null; state.preview = null; state.previewFilePath = null; render(); });
        list.appendChild(button);
      });
      renderEditor();
      renderPreview();
      renderFiles();
    }

    function renderCommonTasks() {
      const container = document.getElementById("common-tasks");
      container.innerHTML = "";
      const tasks = state.commonTasks ?? [];
      if (tasks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "status";
        empty.textContent = "No repeated tasks loaded.";
        container.appendChild(empty);
        return;
      }
      tasks.forEach((task) => {
        const card = document.createElement("section");
        card.className = "task-card";
        card.innerHTML = '<div class="task-title"></div><div class="task-summary"></div><div class="task-evidence meta evidence-links"></div><div class="task-tags"></div><div class="task-skills"></div>';
        card.querySelector(".task-title").textContent = task.title;
        card.querySelector(".task-summary").textContent = task.evidenceNarrative;
        renderEvidenceLinks(card.querySelector(".task-evidence"), task.evidenceIds ?? []);
        card.querySelector(".task-tags").textContent = task.evidenceCount + " frame(s) · " + task.segmentCount + " segment(s) · confidence " + formatConfidence(task.confidence) + " · " + task.dwellTimeSeconds + "s dwell";
        const skills = card.querySelector(".task-skills");
        (task.skills ?? []).forEach((skill) => {
          const skillRow = document.createElement("button");
          skillRow.className = "task-skill";
          skillRow.type = "button";
          skillRow.textContent = skill.title + " · " + skill.category + " · confidence " + formatConfidence(skill.confidence);
          skillRow.addEventListener("click", () => {
            state.selectedId = skill.id;
            state.generated = null;
            state.preview = null;
            state.previewFilePath = null;
            render();
          });
          skills.appendChild(skillRow);
        });
        container.appendChild(card);
      });
    }

    function selectedProposal() {
      return state.proposalSet?.proposals?.find((proposal) => proposal.id === state.selectedId) ?? null;
    }

    function visibleProposals() {
      const proposals = state.proposalSet?.proposals ?? [];
      const category = categoryFilter.value;
      const confidence = confidenceFilter.value;
      const query = searchInput.value.trim().toLowerCase();
      return proposals
        .map((proposal, index) => ({ proposal, index }))
        .filter(({ proposal }) => category === "all" || proposal.category === category)
        .filter(({ proposal }) => confidenceMatches(proposal.confidence, confidence))
        .filter(({ proposal }) => {
          if (!query) return true;
          return [
            proposal.title,
            proposal.category,
            proposal.summary,
            proposal.owner,
            proposal.rolloutMetric,
            ...(proposal.evidenceIds ?? [])
          ].join(" ").toLowerCase().includes(query);
        })
        .sort(compareProposalRows)
        .map(({ proposal }) => proposal);
    }

    function confidenceMatches(value, filter) {
      const confidence = Number(value ?? 0);
      if (filter === "high") return confidence >= 0.8;
      if (filter === "medium") return confidence >= 0.6 && confidence < 0.8;
      if (filter === "low") return confidence < 0.6;
      return true;
    }

    function compareProposalRows(left, right) {
      const sort = sortInput.value;
      if (sort === "confidence-desc") return numberDesc(left.proposal.confidence, right.proposal.confidence) || left.index - right.index;
      if (sort === "confidence-asc") return numberAsc(left.proposal.confidence, right.proposal.confidence) || left.index - right.index;
      if (sort === "minutes-desc") return numberDesc(left.proposal.estimatedMinutesPerWeek, right.proposal.estimatedMinutesPerWeek) || left.index - right.index;
      if (sort === "minutes-asc") return numberAsc(left.proposal.estimatedMinutesPerWeek, right.proposal.estimatedMinutesPerWeek) || left.index - right.index;
      if (sort === "title-asc") return left.proposal.title.localeCompare(right.proposal.title) || left.index - right.index;
      return left.index - right.index;
    }

    function renderEditor() {
      const proposal = selectedProposal();
      document.getElementById("editor").hidden = !proposal;
      document.getElementById("save").disabled = !proposal;
      document.getElementById("preview-skills").disabled = !proposal;
      document.getElementById("generate").disabled = !proposal;
      document.getElementById("download").disabled = !proposal;
      document.getElementById("refresh-preview").disabled = !proposal;
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
      renderEditorFrameLinks(proposal);
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
      state.preview = null;
      state.previewFilePath = null;
      renderListOnly();
      renderEditorFrameLinks(proposal);
      if (!document.getElementById("preview-panel").hidden) renderPreview();
    }

    function renderListOnly() {
      const list = document.getElementById("proposal-list");
      [...list.children].forEach((button, index) => {
        const proposal = visibleProposals()[index];
        if (!proposal) return;
        button.querySelector(".proposal-title").textContent = proposal.title;
        button.querySelector(".meta").textContent = proposal.category + " · confidence " + formatConfidence(proposal.confidence) + " · " + proposal.estimatedMinutesPerWeek + " min/week";
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
      state.proposalSet = data.proposalSet ?? data;
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

    async function previewSkills() {
      const proposal = selectedProposal();
      if (!proposal) return;
      syncFromEditor();
      setStatus("Building skill file preview...");
      const response = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: dayInput.value, proposalId: proposal.id, proposalSet: state.proposalSet })
      });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      state.preview = data;
      state.previewFilePath = data.files?.[0]?.path ?? null;
      document.getElementById("preview-panel").hidden = false;
      renderPreview();
      setStatus("Previewed " + (data.files?.length ?? 0) + " skill file(s). No files were written.");
    }

    function downloadBundle() {
      const proposal = selectedProposal();
      if (!proposal) return;
      window.location.href = "/api/download?day=" + encodeURIComponent(dayInput.value) + "&proposalId=" + encodeURIComponent(proposal.id);
    }

    function renderPreview() {
      const select = document.getElementById("preview-file");
      select.innerHTML = "";
      const files = state.preview?.files ?? [];
      if (files.length === 0) {
        document.getElementById("preview-content").textContent = selectedProposal()
          ? "Open this tab or click Refresh preview to render the skill files before generating them."
          : "Select a proposal to preview its skill files.";
        return;
      }
      for (const file of files) {
        const option = document.createElement("option");
        option.value = file.path;
        option.textContent = file.target + " · " + file.path;
        select.appendChild(option);
      }
      if (!files.some((file) => file.path === state.previewFilePath)) {
        state.previewFilePath = files[0].path;
      }
      select.value = state.previewFilePath;
      renderPreviewContent();
    }

    function renderPreviewContent() {
      const file = (state.preview?.files ?? []).find((item) => item.path === state.previewFilePath);
      document.getElementById("preview-content").textContent = file?.content ?? "No preview file selected.";
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

    function renderEditorFrameLinks(proposal) {
      const fieldReferences = [
        ["summary-frame-links", "Summary frames", idsFromText(fields["summary-field"].value, proposal.evidenceIds ?? [])],
        ["steps-frame-links", "Step frames", idsFromText(fields.steps.value, proposal.evidenceIds ?? [])],
        ["outcome-frame-links", "Outcome frames", idsFromText(fields.outcome.value, proposal.evidenceIds ?? [])],
        ["metric-frame-links", "Metric frames", idsFromText(fields.metric.value, proposal.evidenceIds ?? [])],
        ["prerequisites-frame-links", "Prerequisite frames", idsFromText(fields.prerequisites.value, proposal.evidenceIds ?? [])],
        ["evidence-frame-links", "Evidence frames", lines(fields.evidence.value)]
      ];
      for (const [containerId, label, evidenceIds] of fieldReferences) {
        renderEvidenceLinks(document.getElementById(containerId), evidenceIds, { label, hideWhenEmpty: true });
      }
      renderEvidenceLinks(document.getElementById("editor-frame-links"), unique([
        ...(proposal.evidenceIds ?? []),
        ...fieldReferences.flatMap(([, , evidenceIds]) => evidenceIds)
      ]), { label: "All referenced frames" });
    }

    function idsFromText(text, knownEvidenceIds = []) {
      const source = String(text ?? "");
      const exactKnownMatches = knownEvidenceIds.filter((id) => source.includes(id));
      const tokenMatches = source.match(/\\b[a-z0-9][a-z0-9._:-]*-raw-frame\\b/gi) ?? [];
      return unique([...exactKnownMatches, ...tokenMatches]);
    }

    function renderEvidenceLinks(container, evidenceIds, options = {}) {
      container.innerHTML = "";
      const ids = unique(evidenceIds ?? []);
      if (options.hideWhenEmpty && ids.length === 0) return;
      const label = document.createElement("span");
      label.textContent = (options.label ?? "Evidence") + ": ";
      container.appendChild(label);
      if (ids.length === 0) {
        const empty = document.createElement("span");
        empty.textContent = "none";
        container.appendChild(empty);
        return;
      }
      for (const evidenceId of ids) {
        const link = document.createElement("a");
        link.className = "evidence-link";
        link.href = rawFrameUrl(evidenceId);
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = evidenceId;
        if (!state.rawFrameEvidenceIds.has(evidenceId)) {
          link.title = "No retained raw screenshot found for this evidence ID.";
          container.appendChild(link);
          continue;
        }
        const preview = document.createElement("span");
        preview.className = "frame-preview";
        const image = document.createElement("img");
        image.alt = "Raw frame for " + evidenceId;
        image.loading = "lazy";
        link.addEventListener("mouseenter", () => {
          if (!image.src) image.src = rawFrameUrl(evidenceId);
        });
        link.addEventListener("focus", () => {
          if (!image.src) image.src = rawFrameUrl(evidenceId);
        });
        preview.appendChild(image);
        link.appendChild(preview);
        container.appendChild(link);
      }
    }

    function rawFrameUrl(evidenceId) {
      return "/api/raw-frame?day=" + encodeURIComponent(dayInput.value) + "&evidenceId=" + encodeURIComponent(evidenceId);
    }

    function unique(values) {
      return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
    }

    function setStatus(message, warning = false) {
      const status = document.getElementById("status");
      status.textContent = message;
      status.className = "status" + (warning ? " warning" : "");
    }

    loadDays();
    startReloadPolling();

    function startReloadPolling() {
      window.setInterval(async () => {
        try {
          const response = await fetch("/api/reload-version", { cache: "no-store" });
          if (!response.ok) return;
          const data = await response.json();
          if (data.version && data.version !== serverReloadVersion) {
            window.location.reload();
          }
        } catch {
          // The watched UI server may be between restarts; the next poll will reconnect.
        }
      }, 1500);
    }

    async function loadDays() {
      setStatus("Loading analysis days...");
      const response = await fetch("/api/analysis-days");
      const data = await response.json();
      if (!response.ok) return setStatus(data.error, true);
      dayInput.innerHTML = "";
      const days = data.days ?? [];
      for (const day of days) {
        const option = document.createElement("option");
        option.value = day;
        option.textContent = day;
        dayInput.appendChild(option);
      }
      if (days.includes(defaultDay)) {
        dayInput.value = defaultDay;
      } else if (days.length > 0) {
        dayInput.value = days[0];
      }
      document.getElementById("load").disabled = days.length === 0;
      if (days.length === 0) {
        state.proposalSet = null;
        state.selectedId = null;
        render();
        return setStatus("No analysis days found. Run analysis first.", true);
      }
      await load();
    }

    function numberDesc(left, right) {
      return Number(right ?? 0) - Number(left ?? 0);
    }

    function numberAsc(left, right) {
      return Number(left ?? 0) - Number(right ?? 0);
    }

    function formatConfidence(value) {
      return Number(value ?? 0).toFixed(2);
    }

    function summaryText(visibleCount, totalCount) {
      if (visibleCount === totalCount) return totalCount + " proposal(s)";
      return visibleCount + " of " + totalCount + " proposal(s)";
    }
  </script>
</body>
</html>`;
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
