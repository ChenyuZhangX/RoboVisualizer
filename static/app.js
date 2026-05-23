/* ══════════════════════════════════════════════════════════
   LeRobot Visualizer — app.js  v23
   ══════════════════════════════════════════════════════════ */

/* ── Constants ───────────────────────────────────────────── */
const PREFETCH_AHEAD = 8;
const SEARCH_DEBOUNCE_MS = 160;
const PALETTE = [
  "#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6",
  "#06B6D4","#F97316","#EC4899","#14B8A6","#6366F1",
];
const PALETTE_CMP = [
  "#F59E0B","#F97316","#EF4444","#8B5CF6","#EC4899",
  "#14B8A6","#6366F1","#06B6D4","#10B981","#3B82F6",
];

/* ── Application state ───────────────────────────────────── */
const state = {
  episode: null,
  normStats: null,
  frame: 0,
  playing: false,
  looping: false,
  speed: 1.0,
  rafId: null,
  lastTick: null,
  stateCharts: [],
  actionCharts: [],
  stateExpanded: false,
  actionExpanded: false,
  histState: false,
  histAction: false,
  activeDataset: null,
  activeEpIndex: null,
  episodeList: [],        // [{dsPath, epIndex, taskText, el}]
  currentEpListIdx: -1,
  frameCache: new Map(),
  prefetchPending: new Set(),
  compareEpisode: null,
  compareDataset: null,
  compareEpIndex: null,
  normalizeEnabled: true,
};

/* ── Utility helpers ─────────────────────────────────────── */
const el = id => document.getElementById(id);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function apiFetch(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function formatDuration(secs) {
  if (secs < 60) return secs.toFixed(1) + "s";
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function escapeHTML(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ── Dark mode ───────────────────────────────────────────── */
function initDarkMode() {
  const stored = localStorage.getItem("darkMode");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyDark(stored !== null ? stored === "1" : prefersDark, false);
}

function applyDark(isDark, save = true) {
  document.documentElement.classList.toggle("dark", isDark);
  el("dark-mode-btn").querySelector(".icon-moon").classList.toggle("hidden", isDark);
  el("dark-mode-btn").querySelector(".icon-sun").classList.toggle("hidden", !isDark);
  if (save) {
    localStorage.setItem("darkMode", isDark ? "1" : "0");
    if (state.episode) {
      buildCharts(state.episode);
      if (!el("timedim-card").classList.contains("hidden")) buildTimeDimHeatmap(state.episode);
      if (!el("corr-section").classList.contains("hidden")) buildCorrelationHeatmap(state.episode);
    }
  }
}

function toggleDarkMode() {
  applyDark(!document.documentElement.classList.contains("dark"));
}

/* ── Sidebar ─────────────────────────────────────────────── */
function toggleSidebar() {
  const collapsed = el("main").classList.toggle("sidebar-collapsed");
  el("sidebar-toggle").setAttribute("aria-pressed", collapsed);
  localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
}

function initSidebarState() {
  const stored = localStorage.getItem("sidebarCollapsed");
  if (stored === "1") {
    el("main").classList.add("sidebar-collapsed");
    el("sidebar-toggle").setAttribute("aria-pressed", "true");
  }
}

/* ── URL hash state (bookmarkable links) ─────────────────── */
const _saveHashDebounced = debounce(_doSaveHash, 400);

function _doSaveHash() {
  if (!state.activeDataset || state.activeEpIndex == null) return;
  const params = new URLSearchParams({
    ds: state.activeDataset,
    ep: state.activeEpIndex,
    f:  state.frame,
    n:  state.normalizeEnabled ? "1" : "0",
  });
  history.replaceState(null, "", "#" + params.toString());
}

function saveHashState() { _saveHashDebounced(); }

async function loadHashState() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  try {
    const params = new URLSearchParams(hash);
    const ds  = params.get("ds");
    const ep  = params.get("ep");
    const f   = params.get("f");
    if (!ds || ep == null) return;
    // Wait for episode list to be populated (sidebar must be open & dataset loaded)
    // We trigger the dataset tree to load the specific dataset
    const datasets = await apiFetch("/api/datasets");
    const dsInfo = datasets.find(d => d.path === ds || d.name === ds);
    if (!dsInfo) return;

    // Open the dataset node and load tasks
    const tasks = await apiFetch(`/api/datasets/${encodeURIComponent(ds)}/tasks`);
    const allLengths = tasks.flatMap(t => t.episodes.map(e => e.length)).sort((a, b) => a - b);

    // Build nodes silently so episodeList is populated
    const tree = el("dataset-tree");
    if (!tree.children.length || tree.querySelector(".loading-msg")) {
      tree.innerHTML = "";
      for (const d2 of datasets) tree.appendChild(buildDatasetNode(d2));
    }

    // Click the matching dataset node to load its tasks
    const dsNode = Array.from(tree.querySelectorAll(".ds-node")).find(n => {
      const nameEl = n.querySelector(".ds-name");
      return nameEl?.textContent === dsInfo.name;
    });
    if (dsNode && !dsNode.classList.contains("open")) {
      dsNode.querySelector(".ds-header").click();
      await new Promise(r => setTimeout(r, 300));
    }

    // Find the episode element in the list
    const epIndex = parseInt(ep, 10);
    const epEntry = state.episodeList.find(e => e.dsPath === ds && e.epIndex === epIndex);
    if (!epEntry) return;

    // Open the task group containing this episode
    epEntry.el.closest(".task-group")?.classList.add("open");
    // Restore normalize before loading so charts build with correct state
    const nParam = params.get("n");
    if (nParam !== null && (nParam === "1") !== state.normalizeEnabled) {
      state.normalizeEnabled = nParam === "1";
      el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
      el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
    }
    await selectEpisode(ds, epIndex, epEntry.taskText, epEntry.el);
    if (f != null) setFrame(parseInt(f, 10));
    epEntry.el.scrollIntoView({ block: "nearest" });
  } catch (_) {}
}

/* ── Normalization helpers ───────────────────────────────── */
function normalizeValue(v, q01, q99) {
  if (q99 === q01) return 0;
  return 2 * (Math.max(q01, Math.min(q99, v)) - q01) / (q99 - q01) - 1;
}

function normalizeData(data2d, ns) {
  if (!ns) return { data: data2d, normalized: false };
  return {
    data: data2d.map(row => row.map((v, d) => normalizeValue(v, ns.q01[d], ns.q99[d]))),
    normalized: true,
  };
}

function normalizeMeanStd(ns) {
  if (!ns?.mean || !ns?.std) return null;
  const { mean, std, q01, q99 } = ns;
  return {
    mean: mean.map((m, d) => normalizeValue(m, q01[d], q99[d])),
    std:  std.map((s, d) => q99[d] === q01[d] ? 0 : 2 * s / (q99[d] - q01[d])),
  };
}

/* ── Chart color theme (respects dark mode) ─────────────── */
function chartColors() {
  const dark = document.documentElement.classList.contains("dark");
  return {
    tick:   dark ? "#64748B" : "#94A3B8",
    grid:   dark ? "rgba(51,65,85,.35)" : "rgba(226,232,240,.5)",
    border: dark ? "rgba(51,65,85,.7)"  : "rgba(226,232,240,.8)",
  };
}

/* ── Chart.js plugins ────────────────────────────────────── */
const cursorPlugin = {
  id: "cursor",
  afterDraw(chart) {
    if (!state.episode) return;
    const { ctx, chartArea, scales } = chart;
    if (!scales?.x || !chartArea) return;
    const x = scales.x.getPixelForValue(state.frame);
    if (x < chartArea.left || x > chartArea.right) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.strokeStyle = "rgba(239,68,68,.75)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  },
};

const stdBandPlugin = {
  id: "stdBand",
  beforeDatasetsDraw(chart) {
    const band = chart.config.options?.stdBand;
    if (!band) return;
    const { ctx, chartArea, scales } = chart;
    if (!scales?.y || !chartArea) return;
    const yHigh = scales.y.getPixelForValue(band.mean + band.std);
    const yLow  = scales.y.getPixelForValue(band.mean - band.std);
    ctx.save();
    ctx.fillStyle = "rgba(148,163,184,0.13)";
    ctx.fillRect(chartArea.left, Math.min(yHigh, yLow),
      chartArea.right - chartArea.left, Math.abs(yLow - yHigh));
    const yMean = scales.y.getPixelForValue(band.mean);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yMean);
    ctx.lineTo(chartArea.right, yMean);
    ctx.strokeStyle = "rgba(148,163,184,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.restore();
  },
};

Chart.register(cursorPlugin, stdBandPlugin);

/* ── Frame navigation ────────────────────────────────────── */
function setFrame(f) {
  if (!state.episode) return;
  state.frame = Math.max(0, Math.min(f, state.episode.length - 1));
  updateScrubber();
  updateChartCursor();
  updateTimeDimCursor();
  updateFrameValues();
  updateImages();
}

/* ── Episode length colour coding ───────────────────────── */
function lengthClass(len, sortedLengths) {
  const n = sortedLengths.length;
  if (!n) return "";
  const pct = sortedLengths.filter(x => x <= len).length / n;
  if (pct < 0.20) return "len-short";
  if (pct < 0.40) return "len-med-short";
  if (pct < 0.60) return "len-medium";
  if (pct < 0.80) return "len-med-long";
  return "len-long";
}

/* ── Sidebar utilities ───────────────────────────────────── */
function collapseAllTasks() {
  document.querySelectorAll(".task-group.open").forEach(g => g.classList.remove("open"));
}

/* ── Sidebar dataset tree ────────────────────────────────── */
async function loadDatasets() {
  const tree = el("dataset-tree");
  tree.innerHTML = `<div class="loading-msg"><span class="spinner"></span> Loading…</div>`;
  try {
    const datasets = await apiFetch("/api/datasets");
    if (!datasets.length) {
      tree.innerHTML = `<div class="loading-msg">No datasets found in ./data/</div>`;
      updateSidebarFooter(0, 0);
      return;
    }
    tree.innerHTML = "";
    for (const ds of datasets) tree.appendChild(buildDatasetNode(ds));
    // Auto-open when there's only one dataset
    if (datasets.length === 1) {
      tree.querySelector(".ds-header")?.click();
    }
    const totalEps = datasets.reduce((s, d) => s + d.total_episodes, 0);
    updateSidebarFooter(datasets.length, totalEps);
  } catch (e) {
    tree.innerHTML = `<div class="error-msg">Failed: ${e.message}</div>`;
    updateSidebarFooter(0, 0);
  }
}

function updateSidebarFooter(numDatasets, totalEps) {
  let footer = document.getElementById("sidebar-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "sidebar-footer";
    footer.className = "sidebar-footer";
    el("sidebar")?.appendChild(footer);
  }
  footer.textContent = numDatasets > 0
    ? `${numDatasets} dataset${numDatasets > 1 ? "s" : ""} · ${totalEps} episodes`
    : "";
  footer.classList.toggle("hidden", numDatasets === 0);
}

function buildDatasetNode(ds) {
  const node = document.createElement("div");
  node.className = "ds-node";
  const robotStr = ds.robot_type && ds.robot_type !== "unknown" ? ` • ${escapeHTML(ds.robot_type)}` : "";
  const metaTitle = `${ds.name}${robotStr} • ${ds.total_episodes} episodes • ${ds.fps} fps`;
  const subtitleParts = [`${ds.fps} fps`];
  if (ds.robot_type && ds.robot_type !== "unknown") subtitleParts.push(escapeHTML(ds.robot_type));
  if (ds.total_tasks > 1) subtitleParts.push(`${ds.total_tasks} tasks`);
  node.innerHTML = `
    <div class="ds-header" title="${metaTitle}">
      <svg class="ds-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <svg class="ds-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="ds-name">${ds.name}</span>
      <span class="ds-badge">${ds.total_episodes} ep</span>
    </div>
    <div class="ds-subtitle">${subtitleParts.join(" · ")}</div>
    <div class="ds-children">
      <div class="loading-msg"><span class="spinner"></span></div>
    </div>`;

  const header = node.querySelector(".ds-header");
  const children = node.querySelector(".ds-children");
  let loaded = false;

  header.addEventListener("click", async () => {
    node.classList.toggle("open");
    if (!loaded) {
      loaded = true;
      try {
        const tasks = await apiFetch(`/api/datasets/${encodeURIComponent(ds.path)}/tasks`);
        children.innerHTML = "";
        const allLengths = tasks
          .flatMap(t => t.episodes.map(e => e.length))
          .sort((a, b) => a - b);
        for (const task of tasks) {
          children.appendChild(buildTaskNode(ds.path, task, allLengths));
        }
        // Auto-expand when only one task
        if (tasks.length === 1) {
          children.querySelector(".task-group")?.classList.add("open");
        }
      } catch (e) {
        children.innerHTML = `<div class="error-msg">Failed to load tasks: ${e.message}</div>`;
      }
    }
  });

  return node;
}

function buildTaskNode(dsPath, task, allLengths = []) {
  const group = document.createElement("div");
  group.className = "task-group";
  const shortTask = task.task.length > 72 ? task.task.slice(0, 72) + "…" : task.task;
  group.dataset.task = task.task.toLowerCase();

  group.innerHTML = `
    <div class="task-header" title="${task.task.replace(/"/g, '&quot;')}">
      <svg class="task-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="task-name">${shortTask}</span>
      <span class="ep-count">${task.episodes.length}</span>
    </div>
    <div class="task-eps"></div>`;

  const header = group.querySelector(".task-header");
  const epsContainer = group.querySelector(".task-eps");

  for (const ep of task.episodes) {
    const cls = lengthClass(ep.length, allLengths);
    const item = document.createElement("div");
    item.className = "ep-item";
    item.dataset.dataset = dsPath;
    item.dataset.episode = ep.episode_index;
    item.innerHTML = `
      <span class="ep-dot"></span>
      <span>ep_${String(ep.episode_index).padStart(6, "0")}</span>
      <span class="ep-len ${cls}">${ep.length}f</span>`;

    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.setAttribute("aria-label", `Episode ${ep.episode_index}, ${ep.length} frames`);

    const handleActivate = (ctrlKey = false) => {
      if (ctrlKey) selectCompareEpisode(dsPath, ep.episode_index, item);
      else selectEpisode(dsPath, ep.episode_index, task.task, item);
    };

    item.addEventListener("click", e => handleActivate(e.ctrlKey || e.metaKey));
    item.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleActivate(e.ctrlKey || e.metaKey);
      }
    });

    state.episodeList.push({ dsPath, epIndex: ep.episode_index, taskText: task.task, el: item });
    epsContainer.appendChild(item);
  }

  header.addEventListener("click", () => group.classList.toggle("open"));
  return group;
}

/* ── Search / filter ─────────────────────────────────────── */
const applySearchDebounced = debounce(applySearch, SEARCH_DEBOUNCE_MS);

function highlightText(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return text.slice(0, idx) +
    `<mark class="search-hl">${text.slice(idx, idx + query.length)}</mark>` +
    highlightText(text.slice(idx + query.length), query);
}

function applySearch(query) {
  const q = query.trim().toLowerCase();
  el("search-clear").classList.toggle("hidden", !q);

  document.querySelectorAll(".task-group").forEach(group => {
    const taskMatches = !q || group.dataset.task?.includes(q);

    // Also check if any ep-item label matches (episode index search)
    let anyEpMatch = false;
    group.querySelectorAll(".ep-item").forEach(item => {
      const epLabel = item.querySelector("span:nth-child(2)")?.textContent ?? "";
      const epMatches = taskMatches || epLabel.toLowerCase().includes(q);
      item.classList.toggle("ep-search-hidden", q && !epMatches);
      if (!q || epMatches) anyEpMatch = true;
    });

    const groupVisible = taskMatches || anyEpMatch;
    group.classList.toggle("search-hidden", !groupVisible);
    if (groupVisible && q) group.classList.add("open");

    const nameEl = group.querySelector(".task-name");
    if (nameEl) {
      const orig = group.dataset.taskOrig ?? (group.dataset.taskOrig = nameEl.textContent);
      nameEl.innerHTML = q && taskMatches ? highlightText(orig, query.trim()) : orig;
    }
  });

  let totalVisible = 0;
  document.querySelectorAll(".ds-node").forEach(node => {
    const children = node.querySelector(".ds-children");
    if (!children) return;
    const total   = children.querySelectorAll(".task-group").length;
    const visible = children.querySelectorAll(".task-group:not(.search-hidden)").length;
    if (total > 0) {
      node.style.display = visible ? "" : "none";
      if (q && visible && !node.classList.contains("open")) {
        node.querySelector(".ds-header")?.click();
      }
      totalVisible += visible;
    }
  });

  // Show/hide search result count
  let countEl = document.getElementById("search-count");
  if (!countEl) {
    countEl = document.createElement("div");
    countEl.id = "search-count";
    countEl.className = "search-count";
    el("dataset-tree").before(countEl);
  }
  countEl.textContent = q ? `${totalVisible} task${totalVisible !== 1 ? "s" : ""} found` : "";
  countEl.classList.toggle("hidden", !q);
}

/* ── Episode loading ─────────────────────────────────────── */
let _loadingEpKey = null;

async function selectEpisode(dsPath, epIndex, taskText, clickedEl) {
  const key = `${dsPath}::${epIndex}`;
  if (_loadingEpKey === key) return;
  _loadingEpKey = key;

  document.querySelectorAll(".ep-item.active").forEach(e => e.classList.remove("active"));
  clickedEl?.classList.add("active");
  clickedEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  stopPlayback();

  state.currentEpListIdx = state.episodeList.findIndex(
    e => e.dsPath === dsPath && e.epIndex === epIndex
  );

  if (dsPath !== state.activeDataset) {
    state.normStats = null;
    try {
      state.normStats = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/norm_stats`);
    } catch (_) {}
  }

  state.activeDataset = dsPath;
  state.activeEpIndex = epIndex;
  state.frameCache.clear();
  state.prefetchPending.clear();

  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) clearCompare();

  el("welcome").classList.add("hidden");
  el("viewer").classList.remove("hidden");
  const displayTask = taskText?.length > 80 ? taskText.slice(0, 77) + "…" : (taskText ?? "");
  el("task-label").textContent = displayTask;
  el("task-label").title = taskText?.length > 80 ? taskText : "";
  el("ep-info-strip").innerHTML = `<span class="spinner"></span><span style="color:var(--text-3)"> Loading…</span>`;
  el("ep-info-strip").classList.remove("hidden");
  el("charts-area").style.opacity = "0.4";
  el("charts-area").style.pointerEvents = "none";

  updatePrevNextButtons();

  try {
    const ep = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/episodes/${epIndex}`);
    state.episode = ep;
    state.frame = 0;
    updateEpInfoStrip(ep);
    // Update normalize btn tooltip based on stats availability
    const hasNormStats = !!state.normStats;
    el("btn-normalize")?.setAttribute("title",
      hasNormStats
        ? "Toggle normalization  N"
        : "Toggle normalization  N  (no norm_stats.json found)"
    );
    buildCharts(ep);
    buildCorrelationHeatmap(ep);
    buildTimeDimHeatmap(ep);
    buildFrameValuesPanel(ep);
    buildCameraGrid(ep);
    setupControls(ep);
    updateScrubber();
    updateImages();
    updateTopbarBreadcrumb();
    saveHashState();
    const taskShort = taskText?.length > 48 ? taskText.slice(0, 45) + "…" : taskText;
    document.title = taskShort
      ? `ep_${String(epIndex).padStart(6, "0")} — ${taskShort} • LeRobot Visualizer`
      : `ep_${String(epIndex).padStart(6, "0")} • ${dsPath} • LeRobot Visualizer`;
    el("charts-area").style.opacity = "";
    el("charts-area").style.pointerEvents = "";
  } catch (e) {
    const retryBtn = `<button onclick="selectEpisode(${JSON.stringify(dsPath)},${epIndex},${JSON.stringify(taskText)},document.querySelector('.ep-item.active'))" style="margin-left:10px;background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:1px 8px;font-size:11px;cursor:pointer;color:var(--text-2)">Retry</button>`;
    el("task-label").innerHTML =
      `<span style="color:var(--amber-dk)">Load failed:</span>` +
      `<span style="font-weight:400;color:var(--text-2);margin-left:6px">${escapeHTML(e.message)}</span>` +
      retryBtn;
    el("ep-info-strip").classList.add("hidden");
    el("charts-area").style.opacity = "";
    el("charts-area").style.pointerEvents = "";
    state.episode = null;
  } finally {
    if (_loadingEpKey === key) _loadingEpKey = null;
  }
}

function updateEpInfoStrip(ep) {
  const strip = el("ep-info-strip");
  if (!strip) return;

  const lastTs = ep.timestamps?.[ep.timestamps.length - 1] ?? null;
  const dur = lastTs !== null ? formatDuration(lastTs) : "—";
  const sDims = ep.state?.[0]?.length ?? 0;
  const aDims = ep.actions?.[0]?.length ?? 0;
  const nCams = ep.image_keys?.length ?? 0;
  const hasVideo = (ep.video_keys?.length ?? 0) > 0;

  // Task context: position within task
  const currentEntry = state.episodeList[state.currentEpListIdx];
  const samTaskEps = state.episodeList.filter(
    e => e.dsPath === currentEntry?.dsPath && e.taskText === currentEntry?.taskText
  );
  const posInTask = samTaskEps.findIndex(e => e.epIndex === state.activeEpIndex);
  const taskCtx = samTaskEps.length > 1 && posInTask >= 0
    ? `ep ${posInTask + 1} / ${samTaskEps.length}`
    : null;

  strip.innerHTML =
    (taskCtx ? `<span class="info-chip info-chip-blue">${taskCtx}</span>` : "") +
    (ep.robot_type && ep.robot_type !== "unknown"
      ? `<span class="info-chip info-chip-orange">${escapeHTML(ep.robot_type)}</span>` : "") +
    `<span class="info-chip">${ep.fps} fps</span>` +
    `<span class="info-chip">${ep.length} frames</span>` +
    `<span class="info-chip">${dur}</span>` +
    (nCams > 0 ? `<span class="info-chip info-chip-green">${nCams} cam${nCams > 1 ? "s" : ""}${hasVideo ? " (video)" : ""}</span>` : "") +
    (sDims ? `<span class="info-chip">state ${sDims}D</span>` : "") +
    (aDims ? `<span class="info-chip">action ${aDims}D</span>` : "");
}

function prevEpisode() {
  const idx = state.currentEpListIdx;
  if (idx <= 0) return;
  const entry = state.episodeList[idx - 1];
  entry.el.closest(".task-group")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
}

function nextEpisode() {
  const idx = state.currentEpListIdx;
  if (idx < 0 || idx >= state.episodeList.length - 1) return;
  const entry = state.episodeList[idx + 1];
  entry.el.closest(".task-group")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
}

function updatePrevNextButtons() {
  const idx = state.currentEpListIdx;
  el("btn-prev-ep").disabled = idx <= 0;
  el("btn-next-ep").disabled = idx < 0 || idx >= state.episodeList.length - 1;
}

/* ── Comparison episode ──────────────────────────────────── */
async function selectCompareEpisode(dsPath, epIndex, clickedEl) {
  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) {
    clearCompare(); return;
  }
  document.querySelectorAll(".ep-item.compare").forEach(e => e.classList.remove("compare"));
  clickedEl.classList.add("compare");
  state.compareDataset = dsPath;
  state.compareEpIndex = epIndex;
  try {
    state.compareEpisode = await apiFetch(
      `/api/datasets/${encodeURIComponent(dsPath)}/episodes/${epIndex}`
    );
    buildCharts(state.episode);
    el("compare-banner").classList.remove("hidden");
    const cmpEp = state.compareEpisode;
    const cmpLastTs = cmpEp.timestamps?.[cmpEp.timestamps.length - 1] ?? null;
    const cmpDurStr = cmpLastTs !== null ? ` / ${formatDuration(cmpLastTs)}` : "";
    const cmpDs = dsPath !== state.activeDataset ? ` (${dsPath})` : "";
    el("compare-label").textContent =
      `Comparing ep_${String(epIndex).padStart(6, "0")}${cmpDs} — ${cmpEp.length}f${cmpDurStr} — dashed overlay`;
  } catch (_) {
    state.compareEpisode = null;
  }
}

function clearCompare() {
  state.compareEpisode = null;
  state.compareDataset = null;
  state.compareEpIndex = null;
  document.querySelectorAll(".ep-item.compare").forEach(e => e.classList.remove("compare"));
  el("compare-banner").classList.add("hidden");
  if (state.episode) buildCharts(state.episode);
}

const MAX_CAMS = 6;

/* ── Camera grid ─────────────────────────────────────────── */
function buildCameraGrid(ep) {
  const cameras = el("cameras");
  const count = Math.min(ep.has_images ? ep.image_keys.length : 0, MAX_CAMS) || 0;
  cameras.className = count > 0 ? `cams-${count}` : "";
  cameras.innerHTML = "";
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const slot = document.createElement("div");
    slot.className = "cam-slot";
    slot.id = `cam-${i}`;
    slot.innerHTML = `<div class="cam-placeholder"><span>No camera</span></div>`;
    cameras.appendChild(slot);
  }
}

function resetCam(i) {
  const slot = el(`cam-${i}`);
  if (slot) slot.innerHTML = `<div class="cam-placeholder"><span>No camera</span></div>`;
}

/* ── Frame prefetch cache ────────────────────────────────── */
function prefetchFrames() {
  const ep = state.episode;
  if (!ep?.has_images) return;
  const { activeDataset: ds, activeEpIndex: epIdx } = state;
  const end = Math.min(state.frame + PREFETCH_AHEAD, ep.length - 1);
  for (let f = state.frame + 1; f <= end; f++) {
    if (state.frameCache.has(f) || state.prefetchPending.has(f)) continue;
    state.prefetchPending.add(f);
    apiFetch(`/api/datasets/${encodeURIComponent(ds)}/episodes/${epIdx}/frame/${f}`)
      .then(data => { state.frameCache.set(f, data); state.prefetchPending.delete(f); })
      .catch(() => state.prefetchPending.delete(f));
  }
  for (const k of state.frameCache.keys()) {
    if (k < state.frame - 2) state.frameCache.delete(k);
  }
}

/* ── Camera rendering ────────────────────────────────────── */
function openLightbox(src, label, camIdx = -1) {
  el("lightbox-img").src = src;
  el("lightbox-label").textContent = label;
  el("cam-lightbox").classList.remove("hidden");
  el("cam-lightbox").dataset.camIdx = camIdx;

  // Update camera counter and nav visibility
  const keys = state.episode?.image_keys?.slice(0, MAX_CAMS) ?? [];
  const total = keys.length;
  const counter = el("lightbox-counter");
  if (counter) counter.textContent = total > 1 ? `${camIdx + 1} / ${total}` : "";
  const showNav = total > 1;
  document.querySelectorAll(".lightbox-nav").forEach(btn => {
    btn.style.display = showNav ? "" : "none";
  });
}

function lightboxNavigate(delta) {
  const overlay = el("cam-lightbox");
  if (overlay.classList.contains("hidden")) return;
  const ep = state.episode;
  if (!ep?.has_images) return;
  const keys = ep.image_keys.slice(0, MAX_CAMS);
  const cur = parseInt(overlay.dataset.camIdx ?? "-1", 10);
  const next = (cur + delta + keys.length) % keys.length;
  const slot = el(`cam-${next}`);
  const img = slot?.querySelector("img");
  if (img) openLightbox(img.src, keys[next].replace(/_/g, " "), next);
}

function renderFrameData(keys, frames) {
  keys.forEach((key, i) => {
    const slot = el(`cam-${i}`);
    if (!slot) return;
    const src = frames[key];
    if (!src) { resetCam(i); return; }

    let img = slot.querySelector("img");
    if (!img) {
      slot.innerHTML = "";
      img = document.createElement("img");
      img.alt = key;
      img.draggable = false;
      slot.appendChild(img);
      const lbl = document.createElement("div");
      lbl.className = "cam-label";
      lbl.textContent = key.replace(/_/g, " ");
      slot.appendChild(lbl);
    }
    img.src = src;
    slot.title = key.replace(/_/g, " ") + " — click to expand";
    slot.onclick = () => openLightbox(src, key.replace(/_/g, " "), i);
  });
}

async function updateImages() {
  const ep = state.episode;
  if (!ep?.has_images) return;
  const keys = ep.image_keys.slice(0, MAX_CAMS);

  const f = state.frame;
  if (state.frameCache.has(f)) {
    renderFrameData(keys, state.frameCache.get(f));
  } else {
    // Dim existing images to signal loading
    keys.forEach((_, i) => {
      const img = el(`cam-${i}`)?.querySelector("img");
      if (img) img.style.opacity = "0.5";
    });
    try {
      const frames = await apiFetch(
        `/api/datasets/${encodeURIComponent(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${f}`
      );
      if (state.frame === f) {
        state.frameCache.set(f, frames);
        renderFrameData(keys, frames);
        keys.forEach((_, i) => {
          const img = el(`cam-${i}`)?.querySelector("img");
          if (img) img.style.opacity = "";
        });
      }
    } catch (e) {
      if (state.frame === f) {
        keys.forEach((_, i) => {
          const img = el(`cam-${i}`)?.querySelector("img");
          if (img) img.style.opacity = "";
          const slot = el(`cam-${i}`);
          if (slot && !slot.querySelector("img")) {
            slot.innerHTML = `<div class="cam-placeholder"><span style="font-size:10px;color:var(--text-3)">Failed</span></div>`;
          }
        });
      }
    }
  }
  prefetchFrames();
}

/* ── Export current frame as PNG ─────────────────────────── */
function exportFrame() {
  if (!state.episode?.has_images) return;
  const imgs = [];
  for (let i = 0; i < MAX_CAMS; i++) {
    const img = el(`cam-${i}`)?.querySelector("img");
    if (img?.src) imgs.push({ img, label: img.alt });
  }
  if (!imgs.length) return;

  const W = 480, H = Math.round(W * 3 / 4);
  const canvas = document.createElement("canvas");
  canvas.width = imgs.length * W;
  canvas.height = H + 28;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0F172A";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let loaded = 0;
  imgs.forEach(({ img, label }, i) => {
    const tmp = new Image();
    tmp.crossOrigin = "anonymous";
    tmp.onload = () => {
      ctx.drawImage(tmp, i * W, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.fillRect(i * W, H - 20, W, 20);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(label.toUpperCase(), i * W + 8, H - 7);
      if (++loaded === imgs.length) {
        ctx.fillStyle = "rgba(255,255,255,.6)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(
          `ep_${String(state.activeEpIndex).padStart(6,"0")}  frame ${state.frame}`,
          canvas.width - 8, H + 18
        );
        canvas.toBlob(blob => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `frame_${String(state.activeEpIndex).padStart(6,"0")}_${String(state.frame).padStart(4,"0")}.png`;
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }
    };
    tmp.src = img.src;
  });
}

/* ── Export episode as CSV ───────────────────────────────── */
function exportCSV() {
  const ep = state.episode;
  if (!ep) return;

  const sNames = ep.state_names ?? ep.state?.[0]?.map((_, i) => `state_${i}`) ?? [];
  const aNames = ep.action_names ?? ep.actions?.[0]?.map((_, i) => `action_${i}`) ?? [];

  const headerParts = ["frame_index", "timestamp", ...sNames.map(n => `state.${n}`), ...aNames.map(n => `action.${n}`)];
  const rows = [headerParts.join(",")];

  for (let f = 0; f < ep.length; f++) {
    const ts = ep.timestamps?.[f]?.toFixed(6) ?? "";
    const sRow = ep.state?.[f]?.map(v => v.toFixed(6)).join(",") ?? "";
    const aRow = ep.actions?.[f]?.map(v => v.toFixed(6)).join(",") ?? "";
    rows.push([f, ts, sRow, aRow].filter(x => x !== "").join(","));
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.activeDataset}__ep_${String(state.activeEpIndex).padStart(6,"0")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ── Copy episode URL to clipboard ───────────────────────── */
async function copyEpisodeURL() {
  if (!state.activeDataset || state.activeEpIndex == null) return;
  const params = new URLSearchParams({
    ds: state.activeDataset,
    ep: state.activeEpIndex,
    f:  state.frame,
  });
  const url = location.origin + location.pathname + "#" + params.toString();
  try {
    await navigator.clipboard.writeText(url);
    showCopyToast("✓ URL copied to clipboard");
  } catch (_) {
    prompt("Copy this URL:", url);
  }
}

function showCopyToast(msg = "Copied to clipboard") {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.className = "copy-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove("hidden", "fade-out");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add("fade-out"), 1800);
}

/* ── Charts ─────────────────────────────────────────────── */
function buildCharts(ep) {
  if (!ep) return;
  const ns = state.normalizeEnabled ? state.normStats : null;
  const { data: stateData,  normalized: sNorm } = normalizeData(ep.state,   ns?.state);
  const { data: actionData, normalized: aNorm } = normalizeData(ep.actions, ns?.action);

  const cmp = state.compareEpisode;
  const cmpState  = cmp ? normalizeData(cmp.state,   ns?.state).data  : null;
  const cmpAction = cmp ? normalizeData(cmp.actions, ns?.action).data : null;

  const nsState  = sNorm ? normalizeMeanStd(ns?.state)  : null;
  const nsAction = aNorm ? normalizeMeanStd(ns?.action) : null;

  state.stateCharts  = buildChartCard("state",  stateData,  ep.state_names,  sNorm, ep, cmpState,  nsState);
  state.actionCharts = buildChartCard("action", actionData, ep.action_names, aNorm, ep, cmpAction, nsAction);
}

/**
 * Rebuild charts for one type using current state. Eliminates duplicated
 * boilerplate from toggleExpand and toggleHistogram.
 */
function rebuildChartsFor(type) {
  const ep = state.episode;
  if (!ep) return;
  const ns = state.normalizeEnabled ? state.normStats : null;
  const nsKey = type;
  const raw   = type === "state" ? ep.state   : ep.actions;
  const names = type === "state" ? ep.state_names : ep.action_names;
  const { data: normData, normalized } = normalizeData(raw, ns?.[nsKey]);
  const cmp = state.compareEpisode;
  const cmpRaw  = cmp ? (type === "state" ? cmp.state : cmp.actions) : null;
  const cmpData = cmpRaw ? normalizeData(cmpRaw, ns?.[nsKey]).data : null;
  const nsNorm  = normalized ? normalizeMeanStd(ns?.[nsKey]) : null;
  state[`${type}Charts`] = buildChartCard(type, normData, names, normalized, ep, cmpData, nsNorm);
}

function toggleNormalize() {
  state.normalizeEnabled = !state.normalizeEnabled;
  el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
  el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
  if (state.episode) {
    buildCharts(state.episode);
    updateFrameValues();
  }
}

function toggleExpand(type) {
  state[`${type}Expanded`] = !state[`${type}Expanded`];
  rebuildChartsFor(type);
}

function toggleHistogram(type) {
  const key = `hist${type[0].toUpperCase() + type.slice(1)}`;
  state[key] = !state[key];
  rebuildChartsFor(type);
}

function buildChartCard(type, data2d, names, normalized, ep, cmpData2d = null, normBand = null) {
  const expanded = state[`${type}Expanded`];
  const isHist   = state[`hist${type[0].toUpperCase() + type.slice(1)}`];
  const body    = el(`chart-body-${type}`);
  const titleEl = el(`chart-title-${type}`);
  const btn     = el(`expand-${type}`);
  const histBtn = el(`hist-${type}`);

  if (!body) return [];

  const frames = ep.state?.length || ep.actions?.length || 0;
  const labels = Array.from({ length: frames }, (_, i) => i);
  const dims = data2d[0]?.length ?? 0;

  (state[`${type}Charts`] ?? []).forEach(c => c?.destroy());

  const badge = normalized
    ? `<span class="norm-badge">normalized [−1, 1]</span>` : "";
  if (titleEl) {
    titleEl.innerHTML =
      (type === "state" ? "State" : "Action") +
      `<span style="color:var(--text-3);font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;margin-left:4px;">(${dims}D)</span>` +
      (badge ? " " + badge : "");
  }

  btn.classList.toggle("active", expanded);
  btn.querySelector(".icon-expand").classList.toggle("hidden", expanded);
  btn.querySelector(".icon-collapse").classList.toggle("hidden", !expanded);
  histBtn?.classList.toggle("active", isHist);

  if (dims === 0) {
    body.innerHTML = `<div class="chart-no-data">No ${type} data</div>`;
    return [];
  }

  const charts = [];

  if (isHist) {
    if (!expanded) {
      body.innerHTML = `<div class="hist-wrap"><canvas id="${type}-chart"></canvas></div>`;
      charts.push(makeHistChart(`${type}-chart`, data2d, names, dims));
    } else {
      body.innerHTML = `<div class="hist-grid" id="${type}-grid"></div>`;
      const grid = el(`${type}-grid`);
      for (let d = 0; d < dims; d++) {
        const color = PALETTE[d % PALETTE.length];
        const id = `${type}-chart-${d}`;
        const item = document.createElement("div");
        item.className = "mini-chart-item";
        item.innerHTML = `
          <div class="mini-chart-label" style="color:${color}">${names[d] ?? `dim_${d}`}</div>
          <div class="mini-chart-wrap"><canvas id="${id}"></canvas></div>`;
        grid.appendChild(item);
        charts.push(makeHistChart(id, data2d, names, 1, d));
      }
    }
  } else if (!expanded) {
    body.innerHTML = `<div class="chart-wrap"><canvas id="${type}-chart"></canvas></div>`;
    const mainChart = makeChart(`${type}-chart`, labels, data2d, names, normalized, dims, null, cmpData2d, null);
    charts.push(mainChart);
    // Compact legend below chart — click to toggle series visibility
    if (dims > 0 && dims <= 12) {
      const legendDiv = document.createElement("div");
      legendDiv.className = "chart-legend";
      const maxShow = 10;
      for (let d = 0; d < Math.min(dims, maxShow); d++) {
        const item = document.createElement("span");
        item.className = "legend-item";
        item.title = `Click to show/hide ${names[d] ?? `dim_${d}`}`;
        item.style.cursor = "pointer";
        item.dataset.dim = d;
        item.innerHTML = `<span class="legend-dot" style="background:${PALETTE[d % PALETTE.length]}"></span>${names[d] ?? `dim_${d}`}`;
        item.addEventListener("click", () => {
          if (!mainChart) return;
          const meta = mainChart.getDatasetMeta(d);
          meta.hidden = !meta.hidden;
          mainChart.update("none");
          item.classList.toggle("legend-hidden", !!meta.hidden);
        });
        legendDiv.appendChild(item);
      }
      if (dims > maxShow) {
        const more = document.createElement("span");
        more.className = "legend-item legend-more";
        more.textContent = `+${dims - maxShow} more`;
        legendDiv.appendChild(more);
      }
      body.appendChild(legendDiv);
    }
  } else {
    body.innerHTML = `<div class="chart-grid" id="${type}-grid"></div>`;
    const grid = el(`${type}-grid`);
    for (let d = 0; d < dims; d++) {
      const color = PALETTE[d % PALETTE.length];
      const id = `${type}-chart-${d}`;
      const item = document.createElement("div");
      item.className = "mini-chart-item";
      item.innerHTML = `
        <div class="mini-chart-label" style="color:${color}">${names[d] ?? `dim_${d}`}</div>
        <div class="mini-chart-wrap"><canvas id="${id}"></canvas></div>`;
      grid.appendChild(item);
      const band = normBand ? { mean: normBand.mean[d], std: normBand.std[d] } : null;
      charts.push(makeChart(id, labels, data2d, names, normalized, 1, d, cmpData2d, band));
    }
  }

  return charts;
}

function makeChart(canvasId, labels, data2d, names, normalized, dims,
                   dimIndex = null, cmpData2d = null, stdBand = null) {
  const canvas = el(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const isMini = dimIndex !== null;

  const makePrimaryDS = () => isMini
    ? [{ label: names[dimIndex] ?? `dim_${dimIndex}`,
         data: data2d.map(r => r[dimIndex]),
         borderColor: PALETTE[dimIndex % PALETTE.length],
         borderWidth: 1.5, pointRadius: 0, tension: 0.2 }]
    : Array.from({ length: dims }, (_, d) => ({
        label: names[d] ?? `dim_${d}`,
        data: data2d.map(r => r[d]),
        borderColor: PALETTE[d % PALETTE.length],
        borderWidth: 1.5, pointRadius: 0, tension: 0.2,
      }));

  const makeCmpDS = () => !cmpData2d ? [] :
    isMini
      ? [{ label: `B: ${names[dimIndex] ?? `dim_${dimIndex}`}`,
           data: cmpData2d.map(r => r[dimIndex]),
           borderColor: PALETTE_CMP[dimIndex % PALETTE_CMP.length],
           borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3] }]
      : Array.from({ length: dims }, (_, d) => ({
          label: `B: ${names[d] ?? `dim_${d}`}`,
          data: cmpData2d.map(r => r[d]),
          borderColor: PALETTE_CMP[d % PALETTE_CMP.length],
          borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3],
        }));

  const cc = chartColors();
  const fmtTick = v => {
    const a = Math.abs(v);
    if (a === 0) return "0";
    if (a >= 1000) return (v / 1000).toFixed(1) + "k";
    if (a >= 1)    return v.toFixed(2).replace(/\.?0+$/, "");
    if (a >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
    return v.toExponential(1);
  };
  const yConfig = normalized
    ? { min: -1.05, max: 1.05,
        ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: cc.tick,
                 callback: v => v.toFixed(1) },
        grid: { color: cc.grid }, border: { color: cc.border } }
    : { ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: cc.tick,
                 callback: fmtTick },
        grid: { color: cc.grid }, border: { color: cc.border } };

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [...makePrimaryDS(), ...makeCmpDS()] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      stdBand: stdBand ?? undefined,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: {
            title: items => {
              const ts = state.episode?.timestamps;
              const f = parseInt(items[0].label, 10);
              const t = ts?.[f] ?? null;
              const tsStr = t != null
                ? `  (${t >= 60 ? formatDuration(t) : t.toFixed(3) + "s"})`
                : "";
              return `Frame ${f}${tsStr}`;
            },
            label: item => {
              const v = item.raw;
              const a = Math.abs(v);
              const fmt = a === 0 ? "0"
                : a >= 1    ? v.toFixed(4)
                : a >= 0.01 ? v.toFixed(5)
                : v.toExponential(3);
              return ` ${item.dataset.label}: ${fmt}`;
            },
          },
          bodyFont: { size: 11 }, padding: 6,
        },
        cursor: {}, stdBand: {},
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: isMini ? 4 : 8, font: { size: 9 }, color: cc.tick },
          grid: { color: cc.grid }, border: { color: cc.border },
        },
        y: yConfig,
      },
    },
  });

  canvas.addEventListener("click", e => {
    const pts = chart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (pts.length) setFrame(pts[0].index);
  });

  return chart;
}

/* ── Histogram charts ────────────────────────────────────── */
function computeBins(values, nBins = 22) {
  if (!values.length) return { edges: [], counts: [] };
  const mn = Math.min(...values), mx = Math.max(...values);
  const w = (mx - mn || 1) / nBins;
  const counts = Array(nBins).fill(0);
  for (const v of values) {
    counts[Math.min(Math.floor((v - mn) / w), nBins - 1)]++;
  }
  return {
    edges: Array.from({ length: nBins }, (_, i) => (mn + (i + 0.5) * w).toFixed(3)),
    counts,
  };
}

function makeHistChart(canvasId, data2d, names, dims, dimIndex = null) {
  const canvas = el(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const isMini = dimIndex !== null;

  const datasets = isMini
    ? (() => {
        const { edges, counts } = computeBins(data2d.map(r => r[dimIndex]));
        return [{ label: names[dimIndex] ?? `dim_${dimIndex}`,
          data: counts, backgroundColor: PALETTE[dimIndex % PALETTE.length] + "99",
          borderColor: PALETTE[dimIndex % PALETTE.length], borderWidth: 1,
          _edges: edges }];
      })()
    : Array.from({ length: dims }, (_, d) => {
        const { edges, counts } = computeBins(data2d.map(r => r[d]));
        return { label: names[d] ?? `dim_${d}`,
          data: counts, backgroundColor: PALETTE[d % PALETTE.length] + "66",
          borderColor: PALETTE[d % PALETTE.length], borderWidth: 1, _edges: edges };
      });

  const cc = chartColors();
  return new Chart(ctx, {
    type: "bar",
    data: { labels: datasets[0]._edges, datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: !isMini && dims <= 6,
          labels: { font: { size: 9 }, boxWidth: 10, padding: 6, color: cc.tick } },
        tooltip: {
          callbacks: {
            title: items => `≈${items[0].label}`,
            label: item => ` ${item.dataset.label}: ${item.raw}`,
          },
          bodyFont: { size: 11 }, padding: 6,
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 9 }, color: cc.tick },
             grid: { display: false }, border: { color: cc.border } },
        y: { ticks: { maxTicksLimit: 4, font: { size: 9 }, color: cc.tick },
             grid: { color: cc.grid }, border: { color: cc.border } },
      },
    },
  });
}

function updateChartCursor() {
  state.stateCharts.forEach(c => c?.update("none"));
  state.actionCharts.forEach(c => c?.update("none"));
}

/* ── Correlation heatmap ─────────────────────────────────── */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (!n) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]; sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] ** 2; sumY2 += ys[i] ** 2;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  return den === 0 ? 0 : num / den;
}

function corrColor(r) {
  const t = Math.abs(r);
  if (r >= 0) return `rgb(255,${Math.round(255*(1-t))},${Math.round(255*(1-t))})`;
  return `rgb(${Math.round(255*(1-t))},${Math.round(255*(1-t))},255)`;
}

function buildCorrelationHeatmap(ep) {
  const section = el("corr-section");
  const body = el("corr-body");
  if (!ep?.actions?.length) { section.classList.add("hidden"); return; }

  const dims = ep.actions[0].length;
  if (dims < 2) { section.classList.add("hidden"); return; }

  // Defer render until expanded (avoids computing Pearson on every episode switch)
  if (body.classList.contains("corr-collapsed")) {
    section.classList.remove("hidden");
    body.innerHTML = "";
    return;
  }

  const cols = Array.from({ length: dims }, (_, d) => ep.actions.map(r => r[d]));
  const rawNames = ep.action_names ?? [];
  const labels = Array.from({ length: dims }, (_, d) => {
    const n = rawNames[d] ?? `a${d}`;
    return n.length > 7 ? n.slice(0, 6) + "…" : n;
  });

  const CELL = 24, LABEL_W = 56, TOP_H = 22, PAD = 2;
  const COLORBAR_H = 12, COLORBAR_GAP = 8, COLORBAR_LABEL_H = 12;
  const W = LABEL_W + dims * CELL + PAD;
  const H = TOP_H + dims * CELL + PAD;
  const H_TOTAL = H + COLORBAR_GAP + COLORBAR_H + COLORBAR_LABEL_H;

  body.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.id = "corr-canvas";
  canvas.width = W; canvas.height = H_TOTAL;
  canvas.style.cssText = `width:${W}px;height:${H_TOTAL}px;`;
  body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "middle";

  for (let i = 0; i < dims; i++) {
    for (let j = 0; j < dims; j++) {
      const r = pearson(cols[i], cols[j]);
      ctx.fillStyle = corrColor(r);
      ctx.fillRect(LABEL_W + j * CELL, TOP_H + i * CELL, CELL - 1, CELL - 1);
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillStyle = Math.abs(r) > 0.55 ? "rgba(255,255,255,.92)" : "rgba(0,0,0,.65)";
      ctx.textAlign = "center";
      ctx.fillText(r.toFixed(2), LABEL_W + j * CELL + CELL / 2, TOP_H + i * CELL + CELL / 2);
    }
  }

  const isDark = document.documentElement.classList.contains("dark");
  ctx.font = "9px -apple-system, sans-serif";
  ctx.fillStyle = isDark ? "#94A3B8" : "#64748B";
  ctx.textAlign = "right";
  for (let i = 0; i < dims; i++) {
    ctx.fillText(labels[i], LABEL_W - 4, TOP_H + i * CELL + CELL / 2);
  }
  ctx.textAlign = "center";
  for (let j = 0; j < dims; j++) {
    ctx.fillText(labels[j], LABEL_W + j * CELL + CELL / 2, TOP_H / 2);
  }

  // Colorbar (−1 → 0 → +1 gradient)
  const barX = LABEL_W, barY = H + COLORBAR_GAP, barW = dims * CELL;
  for (let x = 0; x < barW; x++) {
    ctx.fillStyle = corrColor(x / barW * 2 - 1);
    ctx.fillRect(barX + x, barY, 1, COLORBAR_H);
  }
  ctx.font = "8px -apple-system, sans-serif";
  ctx.fillStyle = isDark ? "#94A3B8" : "#64748B";
  ctx.textAlign = "left";  ctx.fillText("−1", barX, barY + COLORBAR_H + 9);
  ctx.textAlign = "center"; ctx.fillText("0",  barX + barW / 2, barY + COLORBAR_H + 9);
  ctx.textAlign = "right";  ctx.fillText("+1", barX + barW,     barY + COLORBAR_H + 9);

  // Pre-compute all pearson values for tooltip
  const corrMatrix = Array.from({ length: dims }, (_, i) =>
    Array.from({ length: dims }, (_, j) => pearson(cols[i], cols[j]))
  );

  const rawLabels = Array.from({ length: dims }, (_, d) => rawNames[d] ?? `a${d}`);

  canvas.addEventListener("mousemove", e => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width, scaleY = H_TOTAL / rect.height;
    const cx = (e.clientX - rect.left) * scaleX, cy = (e.clientY - rect.top) * scaleY;
    const j = Math.floor((cx - LABEL_W) / CELL);
    const i = Math.floor((cy - TOP_H) / CELL);
    if (i >= 0 && i < dims && j >= 0 && j < dims) {
      const r = corrMatrix[i][j];
      const strength = Math.abs(r) < 0.3 ? "weak" : Math.abs(r) < 0.7 ? "moderate" : "strong";
      const dir = r >= 0 ? "positive" : "negative";
      showTimeDimTooltip(e.clientX, e.clientY,
        `<b>${rawLabels[j]}</b> ↔ <b>${rawLabels[i]}</b><br>` +
        `r = ${r.toFixed(4)} <span style="color:#94A3B8">(${strength} ${dir})</span>`);
    } else {
      hideTimeDimTooltip();
    }
  });
  canvas.addEventListener("mouseleave", hideTimeDimTooltip);

  section.classList.remove("hidden");
  if (!section.dataset.open) body.classList.add("corr-collapsed");
}

/* ── Time × Dimension heatmap ────────────────────────────── */
const TIMEDIM_CELL_H = 18;   // pixels per dimension row
const TIMEDIM_LABEL_W = 60;  // left label column width

function buildTimeDimHeatmap(ep) {
  const card = el("timedim-card");
  const body = el("timedim-body");
  if (!card || !body) return;

  if (!ep?.actions?.length || ep.actions[0].length < 1) {
    card.classList.add("hidden"); return;
  }

  // Defer render until expanded (avoids heavy canvas work on every episode switch)
  if (body.classList.contains("timedim-collapsed")) {
    card.classList.remove("hidden");
    body.innerHTML = "";
    return;
  }

  const dims = ep.actions[0].length;
  const frames = ep.length;
  const rawNames = ep.action_names ?? [];
  const labels = Array.from({ length: dims }, (_, d) => {
    const n = rawNames[d] ?? `a${d}`;
    return n.length > 9 ? n.slice(0, 8) + "…" : n;
  });

  // Pre-compute min/max per dimension for scaling
  const dimMin = Array(dims).fill(Infinity);
  const dimMax = Array(dims).fill(-Infinity);
  for (const row of ep.actions) {
    for (let d = 0; d < dims; d++) {
      if (row[d] < dimMin[d]) dimMin[d] = row[d];
      if (row[d] > dimMax[d]) dimMax[d] = row[d];
    }
  }

  const CANVAS_W = Math.min(frames, 900);
  const CANVAS_H = dims * TIMEDIM_CELL_H;
  const TOTAL_W  = TIMEDIM_LABEL_W + CANVAS_W;

  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "timedim-wrap";
  body.appendChild(wrap);

  const canvas = document.createElement("canvas");
  canvas.width  = TOTAL_W;
  canvas.height = CANVAS_H;
  canvas.style.cssText = `width:${TOTAL_W}px;height:${CANVAS_H}px;cursor:crosshair;`;
  canvas.id = "timedim-canvas";
  wrap.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const cellW = CANVAS_W / frames;

  for (let d = 0; d < dims; d++) {
    const lo = dimMin[d], hi = dimMax[d], range = hi - lo || 1;
    const y0 = d * TIMEDIM_CELL_H;

    for (let f = 0; f < frames; f++) {
      const t = (ep.actions[f][d] - lo) / range;  // 0…1
      const r = Math.round(Math.min(255, t * 510));
      const b = Math.round(Math.min(255, (1 - t) * 510));
      const g = Math.round(120 * (1 - Math.abs(t - 0.5) * 2));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(TIMEDIM_LABEL_W + f * cellW, y0, Math.ceil(cellW), TIMEDIM_CELL_H - 1);
    }

    const isDark = document.documentElement.classList.contains("dark");
    ctx.font = "9px -apple-system, sans-serif";
    ctx.fillStyle = isDark ? "#94A3B8" : "#64748B";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[d], TIMEDIM_LABEL_W - 4, y0 + TIMEDIM_CELL_H / 2);
  }

  // Drag and click to seek + hover tooltip
  const getFrameFromPointer = e => {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (TOTAL_W / rect.width) - TIMEDIM_LABEL_W;
    return { f: Math.min(Math.max(0, Math.floor(px / cellW)), frames - 1), px };
  };
  const getDimFromPointer = e => {
    const rect = canvas.getBoundingClientRect();
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    return Math.floor(py / TIMEDIM_CELL_H);
  };

  let dragging = false;
  canvas.addEventListener("pointerdown", e => {
    const { f, px } = getFrameFromPointer(e);
    if (px < 0) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    setFrame(f);
  });
  canvas.addEventListener("pointermove", e => {
    const { f, px } = getFrameFromPointer(e);
    if (dragging && px >= 0) setFrame(f);
    // Tooltip
    if (px < 0) { hideTimeDimTooltip(); return; }
    const d = getDimFromPointer(e);
    if (d >= 0 && d < dims && ep.actions[f]) {
      const val = ep.actions[f][d]?.toFixed(4) ?? "—";
      const ts = ep.timestamps?.[f];
      const tsStr = ts != null ? ` • ${ts.toFixed(3)}s` : "";
      showTimeDimTooltip(e.clientX, e.clientY,
        `<b>${labels[d]}</b>  ${val}<br><span style="color:#94A3B8">frame ${f}${tsStr}</span>`);
    } else {
      hideTimeDimTooltip();
    }
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointerleave", () => { dragging = false; hideTimeDimTooltip(); });

  card.classList.remove("hidden");
  if (!card.dataset.open) body.classList.add("timedim-collapsed");
}

let _timeDimRafPending = false;

function updateTimeDimCursor() {
  if (_timeDimRafPending) return;
  _timeDimRafPending = true;
  requestAnimationFrame(_doUpdateTimeDimCursor);
}

function _doUpdateTimeDimCursor() {
  _timeDimRafPending = false;
  const canvas = el("timedim-canvas");
  if (!canvas || !state.episode) return;

  const ep = state.episode;
  const dims = ep.actions[0]?.length ?? 0;
  const frames = ep.length;
  const CANVAS_W = Math.min(frames, 900);
  const TOTAL_W  = TIMEDIM_LABEL_W + CANVAS_W;
  const CANVAS_H = dims * TIMEDIM_CELL_H;

  const ctx = canvas.getContext("2d");
  // Redraw cursor overlay using a separate canvas layer approach is complex;
  // instead we overlay a thin vertical line with clearRect trick.
  // We store the last cursor x and restore the heatmap column on each move.
  const cellW = CANVAS_W / frames;
  const cursorX = TIMEDIM_LABEL_W + state.frame * cellW;

  // Draw cursor line
  if (canvas._prevCursorX != null) {
    // Restore a thin strip — already baked into the static heatmap so just redraw cursor
    // Actually: draw a semi-transparent overlay rect for cursor
  }
  canvas._prevCursorX = cursorX;

  // Use an overlay canvas approach: draw cursor on a separate <canvas> layered on top
  let overlay = el("timedim-overlay");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.id = "timedim-overlay";
    overlay.width  = TOTAL_W;
    overlay.height = CANVAS_H;
    overlay.style.cssText = `position:absolute;top:0;left:0;width:${TOTAL_W}px;height:${CANVAS_H}px;pointer-events:none;`;
    canvas.parentElement.style.position = "relative";
    canvas.parentElement.appendChild(overlay);
  }

  const oc = overlay.getContext("2d");
  oc.clearRect(0, 0, TOTAL_W, CANVAS_H);
  oc.fillStyle = "rgba(255,255,255,0.55)";
  oc.fillRect(cursorX, 0, Math.max(2, cellW), CANVAS_H);
}

/* ── Topbar breadcrumb ───────────────────────────────────── */
function updateTopbarBreadcrumb() {
  const crumb = el("topbar-ep-info");
  if (!crumb) return;
  if (!state.activeDataset || state.activeEpIndex == null) {
    crumb.textContent = "";
    crumb.classList.add("hidden");
    return;
  }
  const epStr = `ep_${String(state.activeEpIndex).padStart(6, "0")}`;
  crumb.innerHTML =
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ds" title="${escapeHTML(state.activeDataset)}">${escapeHTML(state.activeDataset)}</span>` +
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ep" title="Click to copy URL  C" style="cursor:pointer">${epStr}</span>`;
  crumb.classList.remove("hidden");
  crumb.querySelector(".crumb-ep")?.addEventListener("click", copyEpisodeURL);
}

/* ── Frame counter jump ──────────────────────────────────── */
function initFrameCounterJump() {
  const counter = el("frame-counter");
  if (!counter) return;
  counter.title = "Click to jump to frame";
  counter.style.cursor = "pointer";
  counter.addEventListener("click", () => {
    if (!state.episode) return;
    const current = state.frame;
    const max = state.episode.length - 1;
    // Create inline input
    const input = document.createElement("input");
    input.type = "number";
    input.min = 0;
    input.max = max;
    input.value = current;
    input.className = "frame-jump-input";
    input.style.cssText = `width:${Math.max(60, counter.offsetWidth)}px;`;
    counter.replaceWith(input);
    input.select();

    const commit = () => {
      const f = Math.max(0, Math.min(parseInt(input.value, 10) || 0, max));
      input.replaceWith(counter);
      stopPlayback();
      setFrame(f);
      saveHashState();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { input.replaceWith(counter); }
    });
    input.addEventListener("blur", commit);
  });
}

/* ── Frame values panel toggle ───────────────────────────── */
function toggleFrameValuesPanel() {
  const panel = el("frame-values-panel");
  if (!panel) return;
  const hidden = panel.classList.toggle("fv-collapsed");
  el("btn-frame-values")?.classList.toggle("active", !hidden);
}

/* ── TimeDim tooltip ─────────────────────────────────────── */
function showTimeDimTooltip(x, y, html) {
  let tt = document.getElementById("timedim-tooltip");
  if (!tt) {
    tt = document.createElement("div");
    tt.id = "timedim-tooltip";
    tt.className = "timedim-tooltip";
    document.body.appendChild(tt);
  }
  tt.innerHTML = html;
  tt.classList.remove("hidden");
  // Defer positioning until next frame so width is calculated
  requestAnimationFrame(() => {
    const w = tt.offsetWidth, h = tt.offsetHeight;
    let px = x + 14, py = y - 10;
    if (px + w > window.innerWidth - 8) px = x - w - 8;
    if (py + h > window.innerHeight - 8) py = y + 14;
    tt.style.left = Math.max(0, px) + "px";
    tt.style.top = Math.max(0, py) + "px";
  });
}

function hideTimeDimTooltip() {
  document.getElementById("timedim-tooltip")?.classList.add("hidden");
}

/* ── Episode per-dim statistics ─────────────────────────── */
function dimMinMax(data2d, d) {
  let min = Infinity, max = -Infinity;
  for (const row of data2d) {
    const v = row[d];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/* ── Frame values panel ──────────────────────────────────── */
function buildFrameValuesPanel(ep) {
  const panel = el("frame-values-panel");
  if (!panel) return;

  const sDims = ep.state?.[0]?.length ?? 0;
  const aDims = ep.actions?.[0]?.length ?? 0;

  if (!sDims && !aDims) { panel.classList.add("hidden"); return; }

  panel.innerHTML = "";

  const makeChips = (data2d, dims, names, prefix) => {
    const section = document.createElement("div");
    section.className = "fv-section";
    const labelText = prefix === "s" ? "State" : "Action";
    section.innerHTML = `<div class="fv-label">${labelText}</div><div class="fv-grid" id="fv-${prefix}-grid"></div>`;
    panel.appendChild(section);
    const grid = section.querySelector(`#fv-${prefix}-grid`);
    for (let d = 0; d < dims; d++) {
      const { min, max } = dimMinMax(data2d, d);
      const chip = document.createElement("div");
      chip.className = "fv-chip";
      chip.id = `fv-${prefix}-${d}`;
      chip.title = `min: ${min.toFixed(4)}  max: ${max.toFixed(4)}`;
      chip.innerHTML = `<span class="fv-dim" style="color:${PALETTE[d % PALETTE.length]}">${names[d] ?? `${prefix}${d}`}</span><span class="fv-val" id="fv-${prefix}v-${d}">—</span>`;
      grid.appendChild(chip);
    }
  };

  if (sDims) makeChips(ep.state, sDims, ep.state_names, "s");
  if (aDims) makeChips(ep.actions, aDims, ep.action_names, "a");

  panel.classList.remove("hidden");
  updateFrameValues();
}

function updateFrameValues() {
  const ep = state.episode;
  if (!ep) return;
  const f = state.frame;
  const ns = state.normalizeEnabled ? state.normStats : null;

  const applyNorm = (v, nsKey, d) => {
    if (!ns?.[nsKey]?.q01 || !ns?.[nsKey]?.q99) return v;
    return normalizeValue(v, ns[nsKey].q01[d], ns[nsKey].q99[d]);
  };

  const sRow = ep.state?.[f];
  if (sRow) {
    sRow.forEach((v, d) => {
      const span = document.getElementById(`fv-sv-${d}`);
      if (span) span.textContent = applyNorm(v, "state", d).toFixed(4);
    });
  }

  const aRow = ep.actions?.[f];
  if (aRow) {
    aRow.forEach((v, d) => {
      const span = document.getElementById(`fv-av-${d}`);
      if (span) span.textContent = applyNorm(v, "action", d).toFixed(4);
    });
  }
}

/* ── Playback ────────────────────────────────────────────── */
function setupControls(ep) {
  el("scrubber").max = ep.length - 1;
  el("scrubber").value = 0;
  el("frame-counter").textContent = `0 / ${ep.length - 1}`;
}

function updateScrubber() {
  const ep = state.episode;
  if (!ep) return;
  el("scrubber").value = state.frame;
  const ts = ep.timestamps;
  const tsCurRaw = ts?.[state.frame] ?? null;
  const tsEndRaw = ts?.[ep.length - 1] ?? null;
  const fmt = v => v >= 60 ? formatDuration(v) : v.toFixed(2) + "s";
  const tsStr = tsCurRaw !== null ? `  •  ${fmt(tsCurRaw)} / ${fmt(tsEndRaw)}` : "";
  el("frame-counter").textContent = `${state.frame} / ${ep.length - 1}${tsStr}`;
  el("scrubber").title = tsCurRaw != null ? fmt(tsCurRaw) : `frame ${state.frame}`;
  // Fill the scrubber track to show playback progress
  const pct = ep.length > 1 ? (state.frame / (ep.length - 1)) * 100 : 0;
  el("scrubber").style.background =
    `linear-gradient(to right, var(--blue) ${pct}%, var(--border) ${pct}%)`;
}

function stopPlayback() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.playing = false;
  state.rafId = null;
  state.lastTick = null;
  el("play-icon")?.classList.remove("hidden");
  el("pause-icon")?.classList.add("hidden");
  el("fps-badge")?.classList.add("hidden");
}

function startPlayback() {
  if (!state.episode) return;
  state.playing = true;
  el("play-icon").classList.add("hidden");
  el("pause-icon").classList.remove("hidden");

  const interval = 1000 / ((state.episode.fps || 10) * state.speed);
  let fpsBucket = 0, fpsLast = 0;

  function tick(ts) {
    if (!state.playing) return;
    if (!state.lastTick) { state.lastTick = ts; fpsLast = ts; }
    if (ts - state.lastTick >= interval) {
      state.lastTick = ts;
      fpsBucket++;
      if (ts - fpsLast >= 1000) {
        const badge = el("fps-badge");
        if (badge) {
          const targetFps = (state.episode.fps || 10) * state.speed;
          const diff = fpsBucket - Math.round(targetFps);
          const lagStr = diff < -2 ? ` ⚠${diff}` : "";
          badge.textContent = `${fpsBucket}/${Math.round(targetFps)} fps${lagStr}`;
          badge.classList.remove("hidden");
        }
        fpsBucket = 0;
        fpsLast = ts;
      }
      const next = state.frame + 1;
      if (next >= state.episode.length) {
        if (state.looping) setFrame(0);
        else { stopPlayback(); return; }
      } else {
        setFrame(next);
      }
    }
    state.rafId = requestAnimationFrame(tick);
  }
  state.rafId = requestAnimationFrame(tick);
}

/* ── Restore saved playback preferences ──────────────────── */
function initPlaybackPreferences() {
  const savedSpeed = parseFloat(localStorage.getItem("speed") || "1");
  const validSpeeds = [0.25, 0.5, 1, 2, 4];
  if (validSpeeds.includes(savedSpeed)) {
    state.speed = savedSpeed;
    el("speed-select").value = savedSpeed;
  }
  const savedLoop = localStorage.getItem("loop") === "1";
  state.looping = savedLoop;
  el("btn-loop").classList.toggle("active", savedLoop);
  el("btn-loop").setAttribute("aria-pressed", savedLoop);
}

/* ── Platform detection ──────────────────────────────────── */
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/* ── Event wiring ────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  initDarkMode();
  initSidebarState();
  initFrameCounterJump();
  initPlaybackPreferences();

  // Update welcome hint modifier key for platform
  const hint = document.querySelector(".welcome-hint");
  if (hint) hint.innerHTML = hint.innerHTML.replace(/Ctrl/g, MOD_KEY);

  // Update topbar shortcuts hint
  const ctrlClickHint = document.querySelector("#shortcuts-modal td kbd");
  document.querySelectorAll("#shortcuts-modal kbd").forEach(kbd => {
    if (kbd.textContent === "Ctrl") kbd.textContent = MOD_KEY;
  });

  loadDatasets().then(() => loadHashState());

  // Pause playback when tab becomes hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) stopPlayback();
  });

  el("sidebar-toggle").addEventListener("click", toggleSidebar);
  el("dark-mode-btn").addEventListener("click", toggleDarkMode);

  el("btn-play").addEventListener("click", () => {
    if (state.playing) stopPlayback(); else startPlayback();
  });
  el("btn-rewind").addEventListener("click", () => { stopPlayback(); setFrame(0); });
  el("btn-loop").addEventListener("click", () => {
    state.looping = !state.looping;
    el("btn-loop").classList.toggle("active", state.looping);
    el("btn-loop").setAttribute("aria-pressed", state.looping);
    localStorage.setItem("loop", state.looping ? "1" : "0");
  });
  el("btn-prev-ep").addEventListener("click", prevEpisode);
  el("btn-next-ep").addEventListener("click", nextEpisode);
  el("btn-export").addEventListener("click", exportFrame);
  el("btn-frame-values").addEventListener("click", toggleFrameValuesPanel);
  el("btn-normalize")?.addEventListener("click", toggleNormalize);
  el("btn-csv")?.addEventListener("click", exportCSV);
  el("btn-copy-url")?.addEventListener("click", copyEpisodeURL);

  el("speed-select").addEventListener("change", e => {
    state.speed = parseFloat(e.target.value);
    localStorage.setItem("speed", state.speed);
    if (state.playing) { stopPlayback(); startPlayback(); }
  });

  el("scrubber").addEventListener("input", e => {
    stopPlayback();
    setFrame(parseInt(e.target.value, 10));
    saveHashState();
  });

  el("expand-state").addEventListener("click",  () => toggleExpand("state"));
  el("expand-action").addEventListener("click", () => toggleExpand("action"));
  el("hist-state").addEventListener("click",   () => toggleHistogram("state"));
  el("hist-action").addEventListener("click",  () => toggleHistogram("action"));

  el("compare-clear").addEventListener("click", clearCompare);

  el("corr-close").addEventListener("click", () => {
    const body = el("corr-body");
    const nowCollapsed = body.classList.toggle("corr-collapsed");
    el("corr-section").dataset.open = nowCollapsed ? "" : "1";
    el("corr-close").classList.toggle("active", !nowCollapsed);
    if (!nowCollapsed && state.episode) buildCorrelationHeatmap(state.episode);
  });

  el("timedim-toggle").addEventListener("click", () => {
    const card = el("timedim-card");
    const body = el("timedim-body");
    const nowCollapsed = body.classList.toggle("timedim-collapsed");
    card.dataset.open = nowCollapsed ? "" : "1";
    el("timedim-toggle").classList.toggle("active", !nowCollapsed);
    if (!nowCollapsed && state.episode) buildTimeDimHeatmap(state.episode);
  });

  // Search
  el("search-input").addEventListener("input", e => {
    applySearchDebounced(e.target.value);
  });
  el("search-clear").addEventListener("click", () => {
    el("search-input").value = "";
    applySearch("");
    el("search-input").focus();
  });

  // ── Keyboard shortcuts ────────────────────────────────────
  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

    if (e.key === "?" && !inInput) {
      e.preventDefault();
      el("shortcuts-modal").classList.toggle("hidden");
      return;
    }

    if (inInput) return;

    if (e.key === "b" || e.key === "B") {
      e.preventDefault(); toggleSidebar(); return;
    }

    const modKey = e.ctrlKey || e.metaKey;
    if (e.key === "g" || e.key === "G" || (modKey && e.key === "k")) {
      e.preventDefault();
      el("search-input").focus();
      el("search-input").select();
      return;
    }

    if (modKey && e.key === "s") {
      e.preventDefault();
      exportFrame();
      return;
    }

    if (!state.episode && !["[", "]"].includes(e.key)) return;

    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      const speeds = [0.25, 0.5, 1, 2, 4];
      const cur = speeds.indexOf(state.speed);
      if (cur < speeds.length - 1) {
        state.speed = speeds[cur + 1];
        el("speed-select").value = state.speed;
        if (state.playing) { stopPlayback(); startPlayback(); }
      }
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      const speeds = [0.25, 0.5, 1, 2, 4];
      const cur = speeds.indexOf(state.speed);
      if (cur > 0) {
        state.speed = speeds[cur - 1];
        el("speed-select").value = state.speed;
        if (state.playing) { stopPlayback(); startPlayback(); }
      }
      return;
    }
    if (e.key === "l" || e.key === "L") {
      e.preventDefault();
      state.looping = !state.looping;
      el("btn-loop").classList.toggle("active", state.looping);
      return;
    }
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleHistogram(e.shiftKey ? "action" : "state");
      return;
    }
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      el("timedim-toggle")?.click();
      return;
    }
    if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      el("corr-close")?.click();
      return;
    }
    if (e.key === "v" || e.key === "V" || e.key === "p" || e.key === "P") {
      e.preventDefault();
      toggleFrameValuesPanel();
      return;
    }

    // 0–9: jump to 0%, 10%, …, 90% of episode
    if (e.key >= "0" && e.key <= "9" && state.episode) {
      e.preventDefault();
      stopPlayback();
      setFrame(Math.round(parseInt(e.key) / 10 * (state.episode.length - 1)));
      return;
    }
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      toggleNormalize();
      return;
    }
    if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      copyEpisodeURL();
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (state.playing) stopPlayback(); else startPlayback();
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!el("cam-lightbox").classList.contains("hidden")) {
          lightboxNavigate(-1);
        } else {
          stopPlayback();
          setFrame(state.frame - (e.shiftKey ? 10 : 1));
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!el("cam-lightbox").classList.contains("hidden")) {
          lightboxNavigate(1);
        } else {
          stopPlayback();
          setFrame(state.frame + (e.shiftKey ? 10 : 1));
        }
        break;
      case "r": case "R": case "Home":
        e.preventDefault();
        stopPlayback(); setFrame(0);
        break;
      case "End":
        e.preventDefault();
        stopPlayback(); setFrame(state.episode.length - 1);
        break;
      case "[":
        e.preventDefault(); prevEpisode(); break;
      case "]":
        e.preventDefault(); nextEpisode(); break;
      case "Escape":
        if (state.compareEpisode) { e.preventDefault(); clearCompare(); }
        el("shortcuts-modal").classList.add("hidden");
        el("cam-lightbox").classList.add("hidden");
        break;
    }
  });

  el("btn-shortcuts").addEventListener("click", () => {
    el("shortcuts-modal").classList.toggle("hidden");
  });
  el("shortcuts-modal").addEventListener("click", e => {
    if (e.target === el("shortcuts-modal")) el("shortcuts-modal").classList.add("hidden");
  });
  el("cam-lightbox").addEventListener("click", e => {
    if (e.target === el("cam-lightbox")) el("cam-lightbox").classList.add("hidden");
  });
});
