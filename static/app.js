/* ══════════════════════════════════════════════════════════
   LeRobot Visualizer — app.js  v44
   ══════════════════════════════════════════════════════════ */

/* ── Constants ───────────────────────────────────────────── */
const PREFETCH_AHEAD = 8;
const SEARCH_DEBOUNCE_MS = 160;
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const SIDEBAR_BREAKPOINT = 720;
const MAX_RECENT = 8;
const FRAME_HISTORY_MAX = 40;
const MAX_LEGEND_DIMS = 20;
const CHART_MINI_DIMS_THRESHOLD = 22;
const FRAME_EXPORT_WIDTH = 480;
const FRAME_EXPORT_HEIGHT_RATIO = 3 / 4;
const FRAME_LABEL_HEIGHT = 28;
const FRAME_LABEL_SIZE_PX = 11;
const FULLSCREEN_LABEL_HEIGHT = 20;
const HISTOGRAM_BIN_COUNT = 22;
const API_TIMEOUT_MS = 30000;
const FRAME_RETRY_DELAY_MS = 700;
const FRAME_RETRY_DEBOUNCE_MS = 120;
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
  loopCount: 0,
  recentEpisodes: [],     // [{dsPath, epIndex, taskText}] - last 8 visited
};

/* ── Frame navigation history ────────────────────────────── */
const _frameHistory = [];        // positions visited via explicit navigation
let _frameHistoryPos = -1;       // current index in _frameHistory (-1 = empty)
let _navigatingHistory = false;  // true while traversing history (prevents re-push)

/* ── Mirror mode ─────────────────────────────────────────── */
let _mirrorMode = false;

/* ── Frame values throttle ───────────────────────────────── */
let _lastFvUpdateMs = 0;

/* ── Chart visibility (IntersectionObserver) ────────────── */
const _visibleCharts = new Set();
let _chartIntersectObs = null;
let _allChartsCache = [];  // updated in _refreshChartObserver to avoid repeated spread

function _refreshChartObserver() {
  _visibleCharts.clear();
  _chartIntersectObs?.disconnect();
  _chartIntersectObs = null;
  _allChartsCache = [...state.stateCharts, ...state.actionCharts].filter(c => c?.canvas);
  const allCharts = _allChartsCache;
  if (!('IntersectionObserver' in window)) return;
  if (!allCharts.length) return;
  // Build a canvas→chart map once for O(1) lookup in the callback
  const canvasMap = new Map(allCharts.map(c => [c.canvas, c]));
  _chartIntersectObs = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const chart = canvasMap.get(entry.target);
      if (!chart) continue;
      if (entry.isIntersecting) _visibleCharts.add(chart);
      else _visibleCharts.delete(chart);
    }
  }, { threshold: 0, rootMargin: '80px 0px' });
  allCharts.forEach(c => _chartIntersectObs.observe(c.canvas));
}

/* ── Lightbox focus tracking ─────────────────────────────── */
let _lbPrevFocus = null;  // element to restore focus to when lightbox closes

/* ── Scrubber hover tooltip ──────────────────────────────── */
let _scrubTooltipEl = null;

/* ── Frame fetch auto-retry tracking ────────────────────── */
const _frameRetryPending = new Set();

/* ── Utility helpers ─────────────────────────────────────── */
const el = id => document.getElementById(id);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function apiFetch(path, timeoutMs = API_TIMEOUT_MS, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Propagate external cancellation
  externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  let r;
  try {
    r = await fetch(path, { signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      // If the external signal triggered it, propagate as AbortError so callers can skip
      if (externalSignal?.aborted) throw e;
      throw new Error("Request timed out");
    }
    throw new Error(`Network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).detail ?? ""; } catch (_) {}
    throw new Error(`${r.status}${detail ? `: ${detail}` : ` ${r.statusText}`}`);
  }
  return r.json();
}

function formatDuration(secs) {
  if (secs < 60) return secs.toFixed(1) + "s";
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function escapeHTML(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ── Recent episodes tracking ───────────────────────────── */
function loadRecentEpisodes() {
  try {
    const stored = localStorage.getItem("recentEpisodes");
    if (stored) state.recentEpisodes = JSON.parse(stored).slice(0, MAX_RECENT);
  } catch (_) {}
}

function addToRecent(dsPath, epIndex, taskText) {
  const entry = { dsPath, epIndex, taskText };
  // Remove existing same entry
  state.recentEpisodes = state.recentEpisodes.filter(
    r => !(r.dsPath === dsPath && r.epIndex === epIndex)
  );
  // Prepend new entry
  state.recentEpisodes.unshift(entry);
  state.recentEpisodes = state.recentEpisodes.slice(0, MAX_RECENT);
  try {
    localStorage.setItem("recentEpisodes", JSON.stringify(state.recentEpisodes));
  } catch (_) {}
  updateRecentSection();
}

function clearRecentEpisodes() {
  state.recentEpisodes = [];
  try { localStorage.removeItem("recentEpisodes"); } catch (_) {}
  updateRecentSection();
}

function updateRecentSection() {
  const section = document.getElementById("sidebar-recent");
  if (!section || !state.recentEpisodes.length) {
    if (section) section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  const list = section.querySelector(".recent-list");
  if (!list) return;
  list.innerHTML = "";
  // Add clear button to header
  const header = section.querySelector(".recent-header");
  if (header && !header.querySelector(".recent-clear")) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "recent-clear";
    clearBtn.title = "Clear recent";
    clearBtn.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    clearBtn.addEventListener("click", e => { e.stopPropagation(); clearRecentEpisodes(); });
    header.appendChild(clearBtn);
  }
  for (const r of state.recentEpisodes) {
    const item = document.createElement("div");
    item.className = "recent-item";
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.setAttribute("aria-label", `Recent: ${r.dsPath} episode ${r.epIndex}${r.taskText ? ` - ${r.taskText}` : ""}`);
    const epStr = `ep_${String(r.epIndex).padStart(6, "0")}`;
    const shortTask = r.taskText?.length > 48 ? r.taskText.slice(0, 45) + "…" : (r.taskText ?? "");
    item.innerHTML =
      `<span class="recent-ep">${epStr}</span>` +
      `<span class="recent-task">${escapeHTML(shortTask)}</span>`;
    item.title = `${r.dsPath} › ${epStr}` + (r.taskText ? `\n${r.taskText}` : "");
    const handleSelect = () => {
      const entry = state.episodeList.find(e => e.dsPath === r.dsPath && e.epIndex === r.epIndex);
      if (entry) {
        entry.el.closest(".task-group")?.classList.add("open");
        entry.el.closest(".ds-node")?.classList.add("open");
        selectEpisode(r.dsPath, r.epIndex, r.taskText, entry.el);
      } else {
        selectEpisode(r.dsPath, r.epIndex, r.taskText, null);
      }
    };
    item.addEventListener("click", handleSelect);
    item.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelect(); }
    });
    list.appendChild(item);
  }
}

/* ── Dark mode ───────────────────────────────────────────── */
function initDarkMode() {
  const stored = localStorage.getItem("darkMode");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyDark(stored !== null ? stored === "1" : prefersDark, false);

  // Follow system theme changes only when the user hasn't overridden manually
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
    if (localStorage.getItem("darkMode") === null) applyDark(e.matches, false);
  });
}

function applyDark(isDark, save = true) {
  document.documentElement.classList.toggle("dark", isDark);
  el("dark-mode-btn").querySelector(".icon-moon").classList.toggle("hidden", isDark);
  el("dark-mode-btn").querySelector(".icon-sun").classList.toggle("hidden", !isDark);
  el("dark-mode-btn").setAttribute("aria-pressed", isDark);
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
  const narrow = window.innerWidth < SIDEBAR_BREAKPOINT;
  // Auto-collapse on narrow viewports when no stored preference
  const shouldCollapse = stored === "1" || (stored === null && narrow);
  if (shouldCollapse) {
    el("main").classList.add("sidebar-collapsed");
    el("sidebar-toggle").setAttribute("aria-pressed", "true");
  }
}

/* ── URL hash state (bookmarkable links) ─────────────────── */
const _saveHashDebounced = debounce(_doSaveHash, 600);

function _doSaveHash() {
  if (!state.activeDataset || state.activeEpIndex == null) return;
  const params = new URLSearchParams({
    ds: state.activeDataset,
    ep: state.activeEpIndex,
    f:  state.frame,
  });
  if (!state.normalizeEnabled) params.set("n", "0");  // only serialize when non-default
  if (state.speed !== 1.0) params.set("speed", state.speed);
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
    let f     = params.get("f");
    const t   = params.get("t");  // time offset HH:MM:SS
    if (!ds || ep == null) return;
    // Wait for episode list to be populated (sidebar must be open & dataset loaded)
    // We trigger the dataset tree to load the specific dataset
    const datasets = await apiFetch("/api/datasets");
    const dsInfo = datasets.find(d => d.path === ds || d.name === ds);
    if (!dsInfo) return;

    // Open the dataset node and load tasks
    const tasks = await apiFetch(`/api/datasets/${encodeURIComponent(ds)}/tasks`);

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
    // Restore speed from URL if specified
    const speedParam = parseFloat(params.get("speed") ?? "");
    if (!isNaN(speedParam) && SPEEDS.includes(speedParam)) {
      state.speed = speedParam;
      el("speed-select").value = speedParam;
      localStorage.setItem("speed", speedParam);
    }
    // Restore normalize before loading so charts build with correct state
    const nParam = params.get("n");
    if (nParam !== null && (nParam === "1") !== state.normalizeEnabled) {
      state.normalizeEnabled = nParam === "1";
      el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
      el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
    }
    await selectEpisode(ds, epIndex, epEntry.taskText, epEntry.el);
    // Parse frame: prefer 't' (time), fallback to 'f' (frame index)
    if (t) {
      // Parse HH:MM:SS or MM:SS or just seconds
      const parts = t.split(":").map(parseFloat);
      let seconds = 0;
      if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
      else seconds = parts[0];
      // Convert seconds to frame index
      const loadedEp = state.episode;
      if (loadedEp?.timestamps?.length) {
        const frameIdx = loadedEp.timestamps.findIndex(ts => ts >= seconds);
        if (frameIdx >= 0) setFrame(frameIdx);
      }
    } else if (f != null) {
      setFrame(parseInt(f, 10));
    }
    epEntry.el.scrollIntoView({ block: "nearest" });
    if (params.get("play") === "1") setTimeout(() => startPlayback(), 200);
  } catch (_) {}
}

/* ── Normalization helpers ───────────────────────────────── */
function normalizeValue(v, q01, q99) {
  if (q99 === q01) return 0;
  return 2 * (clamp(v, q01, q99) - q01) / (q99 - q01) - 1;
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
    // Tooltip theme
    ttBg:       dark ? "#1E293B" : "#FFFFFF",
    ttBorder:   dark ? "rgba(51,65,85,.8)" : "rgba(226,232,240,.8)",
    ttTitle:    dark ? "#E2E8F0" : "#1E293B",
    ttBody:     dark ? "#94A3B8" : "#475569",
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
    // Solid vertical line — more legible than dashed
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.strokeStyle = "rgba(239,68,68,.88)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
    // Small anchor dot at top of cursor
    ctx.beginPath();
    ctx.arc(x, chartArea.top + 3, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(239,68,68,.88)";
    ctx.fill();
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
  const newF = clamp(Math.round(f), 0, state.episode.length - 1);
  if (!state.playing && !_navigatingHistory && newF !== state.frame) {
    // Truncate any forward history, then push the current position before moving
    _frameHistory.splice(_frameHistoryPos + 1);
    _frameHistory.push(state.frame);
    if (_frameHistory.length > FRAME_HISTORY_MAX) _frameHistory.shift();
    else _frameHistoryPos++;
  }
  state.frame = newF;
  updateScrubber();
  updateTopbarFrame();
  updateChartCursor();
  updateTimeDimCursor();
  updateFrameValues();
  updateImages();
}

function navigateFrameHistory(delta) {
  if (!state.episode || state.playing) return;
  const newPos = _frameHistoryPos + delta;
  if (newPos < 0 || newPos >= _frameHistory.length) return;
  _frameHistoryPos = newPos;
  _navigatingHistory = true;
  setFrame(_frameHistory[_frameHistoryPos]);
  _navigatingHistory = false;
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

/* ── Mirror mode ─────────────────────────────────────────── */
function _applyMirrorMode(on) {
  el("task-label")?.classList.toggle("hidden", on);
  if (state.episode) el("ep-info-strip")?.classList.toggle("hidden", on);
  // Restore compare banner when turning off only if comparison is active
  if (on) el("compare-banner")?.classList.add("hidden");
  else if (state.compareEpisode) el("compare-banner")?.classList.remove("hidden");
  document.querySelectorAll(".cam-label").forEach(lbl => lbl.classList.toggle("hidden", on));
}

/* ── Sidebar utilities ───────────────────────────────────── */
function collapseAllTasks() {
  document.querySelectorAll(".task-group.open").forEach(g => g.classList.remove("open"));
}

/* ── Sidebar dataset tree ────────────────────────────────── */
async function loadDatasets() {
  const tree = el("dataset-tree");
  const refreshBtn = el("refresh-btn");
  tree.innerHTML = `<div class="loading-msg"><span class="spinner"></span> Loading…</div>`;
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add("spinning"); }
  try {
    const datasets = await apiFetch("/api/datasets");
    if (!datasets.length) {
      tree.innerHTML = `<div style="padding:12px;color:var(--text-3);font-size:11px;text-align:center;">
        No datasets found in <code style="background:var(--bg-3);padding:2px 4px;border-radius:3px">./data/</code><br>
        <span style="font-size:10px;margin-top:4px;display:block">Create dataset folders with <code>meta/</code> and <code>data/</code> subdirectories</span>
      </div>`;
      updateSidebarFooter(0, 0);
      return;
    }
    tree.innerHTML = "";
    for (const ds of datasets) {
      const node = buildDatasetNode(ds);
      // Restore expansion state from localStorage
      const dsExpandKey = `ds-expand-${ds.path}`;
      if (localStorage.getItem(dsExpandKey) === "1") {
        node.classList.add("open");
        // Trigger load
        node.querySelector(".ds-header")?.click();
      }
      tree.appendChild(node);
    }
    // Auto-open when there's only one dataset
    if (datasets.length === 1) {
      tree.querySelector(".ds-header")?.click();
    }
    const totalEps = datasets.reduce((s, d) => s + d.total_episodes, 0);
    updateSidebarFooter(datasets.length, totalEps, datasets);
  } catch (e) {
    const msg = e.message || "Unknown error";
    const errDiv = document.createElement("div");
    errDiv.className = "error-msg";
    errDiv.setAttribute("role", "alert");
    errDiv.innerHTML =
      `Failed to load datasets<br>` +
      `<span style="font-size:10px;color:var(--text-3);margin-top:4px;display:block">${escapeHTML(msg)}</span>`;
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Retry";
    retryBtn.style.cssText = "margin-top:6px;padding:2px 8px;font-size:11px;background:var(--blue);color:#fff;border:none;border-radius:3px;cursor:pointer";
    retryBtn.addEventListener("click", loadDatasets);
    errDiv.appendChild(retryBtn);
    tree.innerHTML = "";
    tree.appendChild(errDiv);
    updateSidebarFooter(0, 0);
    console.error("Load datasets error:", e);
  } finally {
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
  }
}

function updateSidebarFooter(numDatasets, totalEps, datasets = []) {
  let footer = document.getElementById("sidebar-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "sidebar-footer";
    footer.className = "sidebar-footer";
    footer.setAttribute("role", "status");
    footer.setAttribute("aria-live", "polite");
    el("sidebar")?.appendChild(footer);
  }
  if (numDatasets > 0) {
    const knownFrames = datasets.reduce((s, d) => d.total_frames != null ? s + d.total_frames : s, 0);
    const framesHint = knownFrames > 0 ? ` · ${(knownFrames / 1e6).toFixed(1)}M f` : "";
    const taskCount = datasets.reduce((s, d) => s + d.total_tasks, 0);
    const taskHint = taskCount > 0 && taskCount > 1 ? ` · ${taskCount} tasks` : "";
    footer.textContent = `${numDatasets} dataset${numDatasets > 1 ? "s" : ""} · ${totalEps} ep${totalEps !== 1 ? "s" : ""}${taskHint}${framesHint}`;
    footer.title = datasets.map(d => `${d.name}: ${d.total_episodes} eps${d.total_frames != null ? ` · ${(d.total_frames / 1e6).toFixed(1)}M f` : ""}`).join("\n");
  } else {
    footer.textContent = "";
  }
  footer.classList.toggle("hidden", numDatasets === 0);
}

function buildDatasetNode(ds) {
  const node = document.createElement("div");
  node.className = "ds-node";
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-label", ds.name);
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

  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", "false");
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); header.click(); }
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!node.classList.contains("open")) header.click();
      else {
        const first = children.querySelector(".task-header");
        first?.focus();
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (node.classList.contains("open")) header.click();
    }
  });

  header.addEventListener("click", async () => {
    header.setAttribute("aria-expanded", node.classList.contains("open") ? "false" : "true");
    const isOpening = !node.classList.contains("open");
    node.classList.toggle("open");
    // Persist dataset expansion state
    const dsExpandKey = `ds-expand-${ds.path}`;
    localStorage.setItem(dsExpandKey, isOpening ? "1" : "0");
    if (!loaded) {
      loaded = true;
      try {
        const tasks = await apiFetch(`/api/datasets/${encodeURIComponent(ds.path)}/tasks`);
        children.innerHTML = "";
        const allLengths = tasks
          .flatMap(t => t.episodes.map(e => e.length))
          .sort((a, b) => a - b);
        for (const task of tasks) {
          children.appendChild(buildTaskNode(ds.path, task, allLengths, ds.fps));
        }
        // Update badge to reflect actual valid episode count (episodes with parquet files)
        const actualEpCount = tasks.reduce((s, t) => s + t.episodes.length, 0);
        const badge = node.querySelector(".ds-badge");
        if (badge) badge.textContent = `${actualEpCount} ep`;
        // Auto-expand when only one task
        if (tasks.length === 1) {
          children.querySelector(".task-group")?.classList.add("open");
        }
      } catch (e) {
        children.innerHTML = `<div class="error-msg">Failed to load tasks: ${escapeHTML(e.message ?? String(e))}</div>`;
      }
    }
  });

  return node;
}

function buildTaskNode(dsPath, task, allLengths = [], fps = 10) {
  const group = document.createElement("div");
  group.className = "task-group";
  const _tgKey = `tg-${dsPath}-${task.task_index ?? task.task.slice(0, 32)}`;
  if (localStorage.getItem(_tgKey) === "1") group.classList.add("open");
  const shortTask = task.task.length > 72 ? task.task.slice(0, 72) + "…" : task.task;
  group.dataset.task = task.task.toLowerCase();
  const epLengths = task.episodes.map(e => e.length);
  const avgLen = epLengths.length ? Math.round(epLengths.reduce((a, b) => a + b, 0) / epLengths.length) : 0;
  const minLen = epLengths.length ? Math.min(...epLengths) : 0;
  const maxLen = epLengths.length ? Math.max(...epLengths) : 0;
  const avgDur = formatDuration(avgLen / fps);
  const totalFrames = epLengths.reduce((s, l) => s + l, 0);
  const totalDur = formatDuration(totalFrames / fps);
  const statsTitle = `${task.task}\n\n${task.episodes.length} episodes · avg ${avgLen}f (${avgDur}) · min ${minLen}f · max ${maxLen}f\nTotal: ${totalFrames}f (${totalDur})`;

  group.innerHTML = `
    <div class="task-header" title="${statsTitle.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}">
      <svg class="task-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="task-name">${shortTask}</span>
      <span class="task-avg-len" title="Average episode length">${avgLen}f</span>
      <span class="ep-count">${task.episodes.length}</span>
    </div>
    <div class="task-eps" role="listbox" aria-label="Episodes for task"></div>`;

  const header = group.querySelector(".task-header");
  const epsContainer = group.querySelector(".task-eps");

  task.episodes.forEach((ep, epIdx) => {
    const cls = lengthClass(ep.length, allLengths);
    const item = document.createElement("div");
    item.className = "ep-item";
    item.dataset.dataset = dsPath;
    item.dataset.episode = ep.episode_index;
    item.innerHTML = `
      <span class="ep-dot"></span>
      <span>ep_${String(ep.episode_index).padStart(6, "0")}</span>
      <span class="ep-len ${cls}">${ep.length}f</span>`;

    const epPosInTask = epIdx + 1;
    const epTotalInTask = task.episodes.length;
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.setAttribute("aria-label", `Episode ${ep.episode_index}, ${ep.length} frames, ${epPosInTask} of ${epTotalInTask} in task`);
    item.dataset.length = ep.length;
    const epDurStr = formatDuration(ep.length / fps);
    item.title = `ep_${String(ep.episode_index).padStart(6,"0")} · ${ep.length}f · ${epDurStr} · ep ${epPosInTask}/${epTotalInTask} in task · double-click to play`;

    const handleActivate = (ctrlKey = false, autoPlay = false) => {
      if (ctrlKey) selectCompareEpisode(dsPath, ep.episode_index, item);
      else {
        selectEpisode(dsPath, ep.episode_index, task.task, item);
        if (autoPlay) {
          setTimeout(() => startPlayback(), 100);
        }
      }
    };

    item.addEventListener("click", e => handleActivate(e.ctrlKey || e.metaKey, false));
    item.addEventListener("auxclick", e => {
      if (e.button === 1) { e.preventDefault(); handleActivate(true, false); }
    });
    item.addEventListener("mousedown", e => {
      if (e.button === 1) e.preventDefault(); // prevent middle-click scroll
    });
    item.addEventListener("dblclick", e => {
      e.preventDefault();
      handleActivate(false, true);
    });
    item.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleActivate(e.ctrlKey || e.metaKey, false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const allItems = Array.from(document.querySelectorAll(".ep-item:not(.ep-search-hidden):not(.search-hidden .ep-item)"));
        const idx = allItems.indexOf(item);
        let target;
        if (e.key === "ArrowDown") target = allItems[idx + 1];
        else if (e.key === "ArrowUp") target = allItems[idx - 1];
        else if (e.key === "Home") target = allItems[0];
        else if (e.key === "End") target = allItems[allItems.length - 1];
        if (target) { target.focus(); target.scrollIntoView({ block: "nearest" }); }
      }
    });

    state.episodeList.push({ dsPath, epIndex: ep.episode_index, taskText: task.task, el: item });
    epsContainer.appendChild(item);
  });

  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", group.classList.contains("open") ? "true" : "false");
  header.addEventListener("click", () => {
    const open = group.classList.toggle("open");
    header.setAttribute("aria-expanded", open ? "true" : "false");
    try { localStorage.setItem(_tgKey, open ? "1" : "0"); } catch (_) {}
  });
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const wasOpen = group.classList.contains("open");
      header.click();
      // Move focus to first episode only when expanding via keyboard
      if (!wasOpen && group.classList.contains("open")) {
        const first = group.querySelector(".ep-item:not(.ep-search-hidden)");
        first?.focus();
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!group.classList.contains("open")) {
        header.click();
        const first = group.querySelector(".ep-item:not(.ep-search-hidden)");
        first?.focus();
      } else {
        const first = group.querySelector(".ep-item:not(.ep-search-hidden)");
        first?.focus();
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (group.classList.contains("open")) header.click();
    }
  });
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

/* ── Search: parse frame-count / duration filter tokens ─────
   Supports: >Nf  <Nf  >=Nf  <=Nf  (N is a frame count)
   Tokens are stripped from the text query before text matching.        */
function parseSearchFilters(raw) {
  const filters = [];
  const cleaned = raw.replace(/(>=?|<=?)(\d+)f\b/gi, (_, op, n) => {
    filters.push({ op, n: parseInt(n, 10) });
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { text: cleaned, filters };
}

function matchesLengthFilter(len, filters) {
  return filters.every(({ op, n }) => {
    if (op === ">")  return len > n;
    if (op === ">=") return len >= n;
    if (op === "<")  return len < n;
    if (op === "<=") return len <= n;
    return true;
  });
}

function applySearch(query) {
  const q = query.trim().toLowerCase();
  el("search-clear").classList.toggle("hidden", !q);

  const { text: textQ, filters } = parseSearchFilters(q);
  const hasFilter = filters.length > 0;
  const isNumericQuery = textQ.length > 0 && /^\d+$/.test(textQ);
  const textQPadded = isNumericQuery ? textQ.padStart(6, "0") : "";

  document.querySelectorAll(".task-group").forEach(group => {
    const taskMatches = !textQ || (group.dataset.task?.includes(textQ) ?? false);

    // Also check if any ep-item label matches (episode index search or length filter)
    let anyEpMatch = false;
    const items = group.querySelectorAll(".ep-item");
    for (const item of items) {
      const epLabel = item.querySelector("span:nth-child(2)")?.textContent ?? "";
      // Also match episode index as plain number or padded (e.g. "42" or "000042")
      const epNum = String(parseInt(item.dataset.episode ?? "", 10));
      const textMatches = taskMatches || !textQ || epLabel.toLowerCase().includes(textQ) ||
        (isNumericQuery && (epNum === textQ || epNum.padStart(6, "0") === textQPadded));
      const lenOk = !hasFilter || matchesLengthFilter(parseInt(item.dataset.length ?? "0", 10), filters);
      const epMatches = textMatches && lenOk;
      const isHidden = q && !epMatches;
      item.classList.toggle("ep-search-hidden", isHidden);
      if (!isHidden) anyEpMatch = true;
    }

    const groupVisible = taskMatches || anyEpMatch;
    const wasHidden = group.classList.contains("search-hidden");
    group.classList.toggle("search-hidden", !groupVisible);
    if (groupVisible && q && !group.classList.contains("open")) {
      group.classList.add("open");
    }

    const nameEl = group.querySelector(".task-name");
    if (nameEl) {
      const orig = group.dataset.taskOrig ?? (group.dataset.taskOrig = nameEl.textContent);
      nameEl.innerHTML = (textQ && taskMatches) ? highlightText(orig, textQ) : orig;
    }
  });

  let totalVisible = 0;
  document.querySelectorAll(".ds-node").forEach(node => {
    const children = node.querySelector(".ds-children");
    if (!children) return;
    const taskGroups = children.querySelectorAll(".task-group");
    const total = taskGroups.length;
    const visible = Array.from(taskGroups).filter(g => !g.classList.contains("search-hidden")).length;
    if (total > 0) {
      const show = (q && visible) || !q;
      node.style.display = show ? "" : "none";
      const isOpen = node.classList.contains("open");
      if (q && visible && !isOpen) {
        node.querySelector(".ds-header")?.click();
      } else if (!q && isOpen) {
        // Optionally: auto-close on clear — disabled for now, user prefers manual
      }
      if (show && visible) totalVisible += visible;
    }
  });

  // Show/hide search result count
  let countEl = document.getElementById("search-count");
  if (!countEl) {
    countEl = document.createElement("div");
    countEl.id = "search-count";
    countEl.className = "search-count";
    countEl.setAttribute("aria-live", "polite");
    countEl.setAttribute("aria-atomic", "true");
    el("dataset-tree").before(countEl);
  }
  let visibleEps = 0;
  if (q) {
    document.querySelectorAll(".ep-item").forEach(item => {
      if (!item.classList.contains("ep-search-hidden") &&
          !item.closest(".task-group")?.classList.contains("search-hidden")) {
        visibleEps++;
      }
    });
  }
  const filterHint = filters.map(({ op, n }) => `${op}${n}f`).join(" ");
  const textPart = textQ ? `"${textQ}" ` : "";
  const hasResults = totalVisible > 0 || visibleEps > 0;
  if (q && !hasResults) {
    countEl.textContent = `No results${filterHint ? ` for [${filterHint}]` : ""}${textQ ? ` matching "${textQ}"` : ""}`;
    countEl.dataset.empty = "1";
  } else {
    countEl.textContent = q
      ? `${textPart}${filterHint ? `[${filterHint}] ` : ""}→ ${totalVisible} task${totalVisible !== 1 ? "s" : ""} · ${visibleEps} ep${visibleEps !== 1 ? "s" : ""}`
      : "";
    delete countEl.dataset.empty;
  }
  countEl.classList.toggle("hidden", !q);
}

/* ── Episode loading ─────────────────────────────────────── */
let _loadingEpKey = null;

async function selectEpisode(dsPath, epIndex, taskText, clickedEl) {
  const key = `${dsPath}::${epIndex}`;
  if (_loadingEpKey === key) return;
  _loadingEpKey = key;

  document.querySelectorAll(".ep-item.active").forEach(e => {
    e.classList.remove("active");
    e.setAttribute("aria-selected", "false");
  });
  if (clickedEl) {
    clickedEl.classList.add("active");
    clickedEl.setAttribute("aria-selected", "true");
    clickedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
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
  _imageUpdateController?.abort();
  _imageUpdateController = null;
  _frameHistory.length = 0;
  _frameHistoryPos = -1;

  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) clearCompare();

  el("welcome").classList.add("hidden");
  el("viewer").classList.remove("hidden");
  el("viewer").setAttribute("aria-busy", "true");
  el("viewer-loader")?.classList.remove("hidden");
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
    // Restore task text (replacing any prior error message markup)
    el("task-label").textContent = displayTask;
    el("task-label").title = taskText?.length > 80 ? taskText : "";
    el("task-label").classList.toggle("hidden", _mirrorMode);
    updateEpInfoStrip(ep);
    if (_mirrorMode) el("ep-info-strip").classList.add("hidden");
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
    addToRecent(dsPath, epIndex, taskText);
    const taskShort = taskText?.length > 48 ? taskText.slice(0, 45) + "…" : taskText;
    document.title = taskShort
      ? `ep_${String(epIndex).padStart(6, "0")} — ${taskShort} • LeRobot Visualizer`
      : `ep_${String(epIndex).padStart(6, "0")} • ${dsPath} • LeRobot Visualizer`;
    el("charts-area").style.opacity = "";
    el("charts-area").style.pointerEvents = "";
    el("viewer-loader")?.classList.add("hidden");
    el("viewer").setAttribute("aria-busy", "false");
    // Enable export buttons now that episode is loaded
    el("btn-export").disabled = false;
    el("btn-csv").disabled = false;
    el("btn-frame-values").disabled = false;
  } catch (e) {
    el("viewer-loader")?.classList.add("hidden");
    el("viewer").setAttribute("aria-busy", "false");
    const taskLbl = el("task-label");
    taskLbl.innerHTML =
      `<span style="color:var(--amber-dk)">Load failed:</span>` +
      `<span style="font-weight:400;color:var(--text-2);margin-left:6px">${escapeHTML(e.message)}</span>`;
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Retry";
    retryBtn.style.cssText = "margin-left:10px;background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:1px 8px;font-size:11px;cursor:pointer;color:var(--text-2)";
    retryBtn.addEventListener("click", () =>
      selectEpisode(dsPath, epIndex, taskText, document.querySelector(".ep-item.active"))
    );
    taskLbl.appendChild(retryBtn);
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

function randomEpisode() {
  const list = state.episodeList;
  if (!list.length) return;
  const excludeIdx = state.currentEpListIdx;
  // Pick uniformly from all episodes except the current one (O(1), no retry loop)
  let idx;
  if (list.length > 1) {
    idx = Math.floor(Math.random() * (list.length - 1));
    if (idx >= excludeIdx) idx++;
  } else {
    idx = 0;
  }
  const entry = list[idx];
  entry.el?.closest(".task-group")?.classList.add("open");
  entry.el?.closest(".ds-node")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
  requestAnimationFrame(() => entry.el?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

function prevEpisode() {
  const idx = state.currentEpListIdx;
  if (idx <= 0) return;
  const entry = state.episodeList[idx - 1];
  entry.el.closest(".task-group")?.classList.add("open");
  entry.el.closest(".ds-node")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
  requestAnimationFrame(() => entry.el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

function nextEpisode() {
  const idx = state.currentEpListIdx;
  if (idx < 0 || idx >= state.episodeList.length - 1) return;
  const entry = state.episodeList[idx + 1];
  entry.el.closest(".task-group")?.classList.add("open");
  entry.el.closest(".ds-node")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
  requestAnimationFrame(() => entry.el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

function updatePrevNextButtons() {
  const idx = state.currentEpListIdx;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < state.episodeList.length - 1;
  el("btn-prev-ep").disabled = !hasPrev;
  el("btn-prev-ep").setAttribute("aria-disabled", !hasPrev);
  el("btn-next-ep").disabled = !hasNext;
  el("btn-next-ep").setAttribute("aria-disabled", !hasNext);
  if (hasPrev) {
    const prev = state.episodeList[idx - 1];
    el("btn-prev-ep").title = `Previous episode: ep_${String(prev.epIndex).padStart(6, "0")}  [`;
  } else {
    el("btn-prev-ep").title = "Previous episode  [";
  }
  if (hasNext) {
    const next = state.episodeList[idx + 1];
    el("btn-next-ep").title = `Next episode: ep_${String(next.epIndex).padStart(6, "0")}  ]`;
  } else {
    el("btn-next-ep").title = "Next episode  ]";
  }
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
    const cmpTaskEp = state.episodeList.find(e => e.dsPath === dsPath && e.epIndex === epIndex);
    const cmpTaskStr = cmpTaskEp?.taskText?.length > 36 ? cmpTaskEp.taskText.slice(0, 33) + "…" : (cmpTaskEp?.taskText ?? "");
    const taskHint = cmpTaskStr ? ` · ${cmpTaskStr}` : "";
    const mainLen = state.episode?.length ?? cmpEp.length;
    const lenDiff = cmpEp.length - mainLen;
    const lenDiffStr = lenDiff !== 0 ? ` (${lenDiff > 0 ? "+" : ""}${lenDiff}f, ${lenDiff > 0 ? "+" : ""}${Math.round(lenDiff / mainLen * 100)}%)` : "";
    el("compare-label").textContent =
      `Comparing ep_${String(epIndex).padStart(6, "0")}${cmpDs} — ${cmpEp.length}f${cmpDurStr}${lenDiffStr}${taskHint} — dashed overlay`;
    showCopyToast(`✓ Comparing ep_${String(epIndex).padStart(6, "0")}`, "success");
  } catch (e) {
    state.compareEpisode = null;
    showCopyToast(`Failed to load compare episode: ${e.message}`, "error");
  }
}

function clearCompare() {
  state.compareEpisode = null;
  state.compareDataset = null;
  state.compareEpIndex = null;
  document.querySelectorAll(".ep-item.compare").forEach(e => e.classList.remove("compare"));
  el("compare-banner").classList.add("hidden");
  if (state.episode) {
    buildCharts(state.episode);
    showCopyToast("✓ Comparison cleared", "success");
  }
}

const MAX_CAMS = 6;

/* ── Camera grid ─────────────────────────────────────────── */
function buildCameraGrid(ep) {
  const cameras = el("cameras");
  const count = Math.min(ep.has_images ? ep.image_keys.length : 0, MAX_CAMS) || 0;
  cameras.className = count > 0 ? `cams-${count}` : "";
  cameras.innerHTML = "";
  if (count === 0) {
    if (ep.video_keys?.length > 0 && !ep.has_images) {
      cameras.innerHTML = `<div class="no-cam-notice">
        Video cameras detected but frame extraction unavailable<br>
        <span style="font-size:10px">Install opencv-python for video support</span>
      </div>`;
    } else if ((ep.image_keys?.length ?? 0) === 0) {
      cameras.innerHTML = `<div class="no-cam-notice" style="color:var(--text-3)">
        No camera data in this episode
      </div>`;
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    const slot = document.createElement("div");
    slot.className = "cam-slot";
    slot.id = `cam-${i}`;
    slot.innerHTML = CAM_PLACEHOLDER_HTML;
    cameras.appendChild(slot);
  }
}

const CAM_PLACEHOLDER_HTML = `<div class="cam-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.3"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></div>`;

function resetCam(i) {
  const slot = el(`cam-${i}`);
  if (slot) {
    slot.innerHTML = CAM_PLACEHOLDER_HTML;
    slot.classList.remove("loading");
  }
}

/* ── Frame prefetch cache ────────────────────────────────── */
const _scheduleIdle = typeof requestIdleCallback !== "undefined"
  ? (fn) => requestIdleCallback(fn, { timeout: 200 })
  : (fn) => setTimeout(fn, 0);

function _doPrefetch(ds, epIdx, frame, speed) {
  const ep = state.episode;
  if (!ep?.has_images || state.activeEpIndex !== epIdx) return;
  const ahead = Math.round(PREFETCH_AHEAD * Math.max(1, speed));
  const end = Math.min(frame + ahead, ep.length - 1);
  for (let f = frame + 1; f <= end; f++) {
    if (state.frameCache.has(f) || state.prefetchPending.has(f)) continue;
    state.prefetchPending.add(f);
    const frameNo = f;
    apiFetch(`/api/datasets/${encodeURIComponent(ds)}/episodes/${epIdx}/frame/${frameNo}`)
      .then(data => {
        if (state.activeEpIndex === epIdx) state.frameCache.set(frameNo, data);
        state.prefetchPending.delete(frameNo);
      })
      .catch(() => state.prefetchPending.delete(frameNo));
  }
  // Evict stale entries from cache
  for (const k of state.frameCache.keys()) {
    if (k < frame - 2) state.frameCache.delete(k);
  }
}

function prefetchFrames() {
  if (!state.episode?.has_images) return;
  const { activeDataset: ds, activeEpIndex: epIdx, frame, speed } = state;
  // Schedule on idle to avoid blocking current-frame rendering
  _scheduleIdle(() => _doPrefetch(ds, epIdx, frame, speed));
}

/* ── Camera rendering ────────────────────────────────────── */
function openLightbox(src, label, camIdx = -1) {
  _lbPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  _lbResetZoom();
  el("lightbox-img").src = src;
  const ts = state.episode?.timestamps?.[state.frame];
  const tsStr = ts != null
    ? ` · ${ts >= 60 ? formatDuration(ts) : ts.toFixed(3) + "s"}  (f${state.frame})`
    : ` (f${state.frame})`;
  el("lightbox-label").textContent = label + tsStr;
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

  // Move focus into lightbox for keyboard accessibility
  requestAnimationFrame(() => el("lightbox-close-btn")?.focus());
}

function downloadLightboxFrame() {
  const img = el("lightbox-img");
  if (!img?.src) return;
  const camIdx = parseInt(el("cam-lightbox")?.dataset.camIdx ?? "-1", 10);
  const key = state.episode?.image_keys?.[camIdx] ?? "frame";
  _downloadDataURI(img.src, `${key}_ep${state.activeEpIndex}_f${state.frame}.jpg`);
  showCopyToast(`✓ Saved ${key} frame ${state.frame}`, "success");
}

/* ── Lightbox zoom ───────────────────────────────────────── */
let _lbZoom = 1.0;

function _lbSetZoom(z, originX, originY) {
  _lbZoom = clamp(z, 1, 8);
  const img = el("lightbox-img");
  if (!img) return;
  if (_lbZoom <= 1.001) {
    _lbZoom = 1;
    img.style.transform = "";
    img.style.transformOrigin = "";
    img.style.cursor = "";
  } else {
    img.style.transform = `scale(${_lbZoom.toFixed(2)})`;
    if (originX != null) img.style.transformOrigin = `${originX.toFixed(1)}% ${originY.toFixed(1)}%`;
    img.style.cursor = "zoom-out";
  }
  let badge = el("lightbox-zoom-badge");
  if (_lbZoom === 1) {
    if (badge) badge.classList.add("hidden");
  } else {
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "lightbox-zoom-badge";
      badge.className = "lightbox-zoom-badge";
      el("cam-lightbox")?.appendChild(badge);
    }
    badge.textContent = `${_lbZoom.toFixed(1)}×`;
    badge.classList.remove("hidden");
  }
}

function _lbResetZoom() { _lbSetZoom(1); }

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
    slot.classList.remove("loading");
    const src = frames[key];
    if (!src) { resetCam(i); return; }

    const keyDisplay = key.replace(/_/g, " ");

    let img = slot.querySelector("img");
    if (!img) {
      slot.innerHTML = "";
      img = document.createElement("img");
      img.alt = key;
      img.draggable = false;
      slot.appendChild(img);
      const lbl = document.createElement("div");
      lbl.className = "cam-label";
      lbl.textContent = keyDisplay;
      slot.appendChild(lbl);
    }
    img.src = src;
    slot.tabIndex = 0;
    slot.setAttribute("role", "button");
    slot.setAttribute("aria-label", `Camera view: ${keyDisplay} — press Enter to expand`);
    slot.title = keyDisplay + " — click to expand · Ctrl+click to download · double-click for fullscreen · Enter to expand";

    if (!slot.dataset.camEventsSet) {
      slot.addEventListener("click", e => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const curKey = el(`cam-${i}`)?.querySelector("img")?.alt;
          const curSrc = frames[curKey];
          if (curSrc) {
            _downloadDataURI(curSrc, `${curKey}_ep${state.activeEpIndex}_f${state.frame}.jpg`);
            showCopyToast(`✓ Saved ${curKey} frame ${state.frame}`, "success");
          }
        } else {
          openLightbox(src, keyDisplay, i);
        }
      });

      slot.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(src, keyDisplay, i); }
      });

      slot.addEventListener("dblclick", e => {
        e.stopPropagation();
        if (document.fullscreenEnabled) {
          if (document.fullscreenElement) document.exitFullscreen();
          else slot.requestFullscreen?.();
        }
      });

      slot.dataset.camEventsSet = "true";
    }
  });
}

let _lastImageUpdateFrame = -1;
let _imageUpdateController = null;  // AbortController for in-flight frame fetch

async function updateImages() {
  const ep = state.episode;
  if (!ep?.has_images) return;
  if (_lastImageUpdateFrame === state.frame && state.frameCache.has(state.frame)) return;
  _lastImageUpdateFrame = state.frame;
  const keys = ep.image_keys.slice(0, MAX_CAMS);

  // Update lightbox label if open (shows current frame timestamp)
  if (!el("cam-lightbox").classList.contains("hidden")) {
    const lbl = el("lightbox-label");
    if (lbl && state.episode) {
      const camIdx = parseInt(el("cam-lightbox").dataset.camIdx ?? "-1", 10);
      const key = camIdx >= 0 ? keys[camIdx] : null;
      const ts = state.episode.timestamps?.[state.frame];
      const tsStr = ts != null
        ? ` · ${ts >= 60 ? formatDuration(ts) : ts.toFixed(3) + "s"}  (f${state.frame})`
        : ` (f${state.frame})`;
      if (key) lbl.textContent = key.replace(/_/g, " ") + tsStr;
    }
  }

  const f = state.frame;
  if (state.frameCache.has(f)) {
    renderFrameData(keys, state.frameCache.get(f));
  } else {
    // Dim existing images to signal loading
    keys.forEach((_, i) => {
      const slot = el(`cam-${i}`);
      if (slot) { slot.classList.add("loading"); }
    });
    el("fps-badge")?.classList.add("loading");
    // Cancel any previous in-flight frame request
    _imageUpdateController?.abort();
    _imageUpdateController = new AbortController();
    const fetchController = _imageUpdateController;
    try {
      const frames = await apiFetch(
        `/api/datasets/${encodeURIComponent(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${f}`,
        API_TIMEOUT_MS, fetchController.signal
      );
      if (fetchController.signal.aborted) return;
      if (state.frame === f) {
        state.frameCache.set(f, frames);
        renderFrameData(keys, frames);
        keys.forEach((_, i) => {
          const slot = el(`cam-${i}`);
          if (slot) { slot.classList.remove("loading"); }
        });
        el("fps-badge")?.classList.remove("loading");
      }
    } catch (e) {
      if (e.name === "AbortError") return;  // request was superseded by a newer frame
      if (state.frame === f) {
        el("fps-badge")?.classList.remove("loading");
        // Auto-retry once after FRAME_RETRY_DELAY_MS (transient network or server hiccup)
        if (!_frameRetryPending.has(f)) {
          _frameRetryPending.add(f);
          setTimeout(() => {
            _frameRetryPending.delete(f);
            if (state.frame === f && !state.frameCache.has(f)) updateImages();
          }, FRAME_RETRY_DELAY_MS);
        } else {
          // Retry already failed — show error state
          keys.forEach((_, i) => {
            const slot = el(`cam-${i}`);
            if (slot) { slot.classList.remove("loading"); }
            if (slot && !slot.querySelector("img")) {
              slot.innerHTML = `<div class="cam-placeholder"><span class="cam-error-msg">Failed to load</span></div>`;
            }
          });
        }
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
  if (!imgs.length) { showCopyToast("No camera images loaded yet", "error"); return; }

  const W = FRAME_EXPORT_WIDTH, H = Math.round(W * FRAME_EXPORT_HEIGHT_RATIO);
  const canvas = document.createElement("canvas");
  canvas.width = imgs.length * W;
  canvas.height = H + FRAME_LABEL_HEIGHT;
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
      ctx.fillRect(i * W, H - FULLSCREEN_LABEL_HEIGHT, W, FULLSCREEN_LABEL_HEIGHT);
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${FRAME_LABEL_SIZE_PX}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(label.toUpperCase(), i * W + 8, H - 7);
      if (++loaded === imgs.length) {
        ctx.fillStyle = "rgba(255,255,255,.6)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(
          `ep_${String(state.activeEpIndex).padStart(6,"0")}  frame ${state.frame}`,
          canvas.width - 8, H + FULLSCREEN_LABEL_HEIGHT - 10
        );
        canvas.toBlob(blob => {
          if (!blob) { showCopyToast("Export failed: could not create image", "error"); return; }
          const objectURL = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = objectURL;
          const dsSlug = (state.activeDataset ?? "").replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
          const dlName = `${dsSlug}__ep${String(state.activeEpIndex).padStart(6,"0")}_f${String(state.frame).padStart(4,"0")}.png`;
          a.download = dlName;
          a.click();
          setTimeout(() => URL.revokeObjectURL(objectURL), 5000);
          showCopyToast(`✓ Saved ${dlName}`, "success");
        });
      }
    };
    tmp.src = img.src;
  });
}

/* ── Export episode as JSON ──────────────────────────────── */
function exportJSON() {
  const ep = state.episode;
  if (!ep) return;
  const payload = {
    dataset: state.activeDataset,
    episode_index: state.activeEpIndex,
    length: ep.length,
    fps: ep.fps,
    robot_type: ep.robot_type,
    image_keys: ep.image_keys,
    video_keys: ep.video_keys,
    timestamps: ep.timestamps,
    state_names: ep.state_names,
    action_names: ep.action_names,
    state: ep.state,
    actions: ep.actions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const dsSlug = (state.activeDataset ?? "").replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
  a.download = `${dsSlug}__ep${String(state.activeEpIndex).padStart(6,"0")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showCopyToast("✓ JSON exported", "success");
}

/* ── Export episode timestamps ───────────────────────────– */
function exportTimestamps() {
  const ep = state.episode;
  if (!ep?.timestamps?.length) return;
  const lines = ep.timestamps.map((t, i) => `${i}\t${t.toFixed(6)}`);
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.activeDataset}__ep${String(state.activeEpIndex).padStart(6,"0")}_timestamps.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showCopyToast("✓ Timestamps exported", "success");
}

/* ── Export episode as CSV ───────────────────────────────── */
function exportCSV() {
  const ep = state.episode;
  if (!ep) return;

  // Proper CSV quoting: wrap in quotes if contains comma, quote, or newline
  const csvCell = v => {
    const s = String(v);
    return (s.includes(",") || s.includes('"') || s.includes("\n"))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const sNames = ep.state_names ?? ep.state?.[0]?.map((_, i) => `state_${i}`) ?? [];
  const aNames = ep.action_names ?? ep.actions?.[0]?.map((_, i) => `action_${i}`) ?? [];

  const header = ["frame_index", "timestamp",
    ...sNames.map(n => `state.${n}`),
    ...aNames.map(n => `action.${n}`),
  ].map(csvCell).join(",");

  const lines = [header];
  for (let f = 0; f < ep.length; f++) {
    const row = [f, ep.timestamps?.[f]?.toFixed(6) ?? ""];
    ep.state?.[f]?.forEach(v => row.push(v.toFixed(6)));
    ep.actions?.[f]?.forEach(v => row.push(v.toFixed(6)));
    lines.push(row.map(csvCell).join(","));
  }

  const dsSlug = (state.activeDataset ?? "").replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const fname = `${dsSlug}__ep${String(state.activeEpIndex).padStart(6,"0")}.csv`;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showCopyToast(`✓ Exported ${fname}`, "success");
}

/* ── Copy episode URL to clipboard ───────────────────────── */
async function copyEpisodeURL() {
  if (!state.activeDataset || state.activeEpIndex == null) return;
  const ep = state.episode;
  const ts = ep?.timestamps?.[state.frame];
  const params = new URLSearchParams({
    ds: state.activeDataset,
    ep: state.activeEpIndex,
    f:  state.frame,
  });
  if (!state.normalizeEnabled) params.set("n", "0");
  if (ts != null) {
    // Format as MM:SS for readability
    const mins = Math.floor(ts / 60);
    const secs = Math.floor(ts % 60);
    params.set("t", `${mins}:${String(secs).padStart(2, "0")}`);
  }
  if (state.playing) params.set("play", "1");
  if (state.speed !== 1.0) params.set("speed", state.speed);
  const url = location.origin + location.pathname + "#" + params.toString();
  try {
    await navigator.clipboard.writeText(url);
    showCopyToast("✓ URL copied to clipboard", "success");
  } catch (_) {
    // Fallback: select text in a temporary input for manual copy
    const inp = document.createElement("input");
    inp.value = url;
    inp.style.cssText = "position:fixed;top:-9999px;opacity:0;";
    document.body.appendChild(inp);
    inp.select();
    try { document.execCommand("copy"); showCopyToast("✓ URL copied to clipboard", "success"); }
    catch (_2) { showCopyToast("URL: " + url.slice(0, 60) + "…"); }
    document.body.removeChild(inp);
  }
}

/* ── Copy current frame values as JSON ───────────────────── */
async function copyCurrentFrameJSON() {
  const ep = state.episode;
  if (!ep) return;
  const f = state.frame;
  const ns = state.normalizeEnabled ? state.normStats : null;
  const applyNorm = (v, nsKey, d) => {
    if (!ns?.[nsKey]?.q01 || !ns?.[nsKey]?.q99) return v;
    return normalizeValue(v, ns[nsKey].q01[d], ns[nsKey].q99[d]);
  };

  const obj = {
    dataset: state.activeDataset,
    episode: state.activeEpIndex,
    frame: f,
    timestamp: ep.timestamps?.[f] ?? null,
    normalized: state.normalizeEnabled && !!state.normStats,
    state: ep.state?.[f] ? Object.fromEntries(
      ep.state[f].map((v, d) => [ep.state_names?.[d] ?? `state_${d}`, applyNorm(v, "state", d)])
    ) : null,
    action: ep.actions?.[f] ? Object.fromEntries(
      ep.actions[f].map((v, d) => [ep.action_names?.[d] ?? `action_${d}`, applyNorm(v, "action", d)])
    ) : null,
  };
  const json = JSON.stringify(obj, null, 2);
  const sizeKb = (json.length / 1024).toFixed(1);
  try {
    await navigator.clipboard.writeText(json);
    showCopyToast(`✓ Frame ${f} copied (${sizeKb} KB)`, "success");
  } catch (_) {
    const inp = document.createElement("textarea");
    inp.value = json;
    inp.style.cssText = "position:fixed;top:-9999px;opacity:0;";
    document.body.appendChild(inp);
    inp.select();
    try { document.execCommand("copy"); showCopyToast(`✓ Frame ${f} copied (${sizeKb} KB)`, "success"); }
    catch (_2) { showCopyToast("Failed to copy", "error"); }
    document.body.removeChild(inp);
  }
}

/* ── Download chart as PNG ───────────────────────────────── */
function downloadChart(type) {
  const charts = type === "state" ? state.stateCharts : state.actionCharts;
  const ep = state.episode;
  const suffix = ep
    ? `_${state.activeDataset || "dataset"}_ep${String(state.activeEpIndex ?? 0).padStart(6, "0")}`
    : "";
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  // If expanded (multiple mini-charts), zip them or just export each
  if (!charts.length) { showCopyToast("No chart to download", "error"); return; }

  if (charts.length === 1) {
    const filename = `lerobot_${type}${suffix}_${ts}.png`;
    _exportCanvasPNG(charts[0].canvas, filename);
    showCopyToast(`✓ Downloaded ${filename.split("/").pop()}`, "success");
  } else {
    // Export all mini-charts as separate PNGs
    charts.forEach((c, i) => {
      const name = ep?.[`${type === "state" ? "state" : "action"}_names`]?.[i] ?? `dim_${i}`;
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      setTimeout(() => _exportCanvasPNG(c.canvas, `lerobot_${type}_${safe}${suffix}_${ts}.png`), i * 30);
    });
    showCopyToast(`✓ Downloading ${charts.length} charts…`, "success");
  }
}

function downloadCorr() {
  const canvas = el("corr-canvas");
  if (!canvas) { showCopyToast("Show the correlation matrix first", "error"); return; }
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const fname = `lerobot_corr_${state.activeDataset || "dataset"}_ep${state.activeEpIndex ?? 0}_${ts}.png`;
  _exportCanvasPNG(canvas, fname);
  showCopyToast(`✓ Downloaded ${fname.split("/").pop()}`, "success");
}

function downloadTimedim() {
  const canvas = el("timedim-canvas");
  if (!canvas) { showCopyToast("Show the action heatmap first", "error"); return; }
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const fname = `lerobot_heatmap_${state.activeDataset || "dataset"}_ep${state.activeEpIndex ?? 0}_${ts}.png`;
  _exportCanvasPNG(canvas, fname);
  showCopyToast(`✓ Downloaded ${fname.split("/").pop()}`, "success");
}

function _exportCanvasPNG(canvas, filename) {
  if (!canvas) return;
  try {
    const url = canvas.toDataURL("image/png");
    _downloadDataURI(url, filename);
  } catch (e) {
    showCopyToast("Export failed: " + e.message, "error");
  }
}

function _downloadDataURI(dataURI, filename) {
  const a = document.createElement("a");
  a.href = dataURI;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showCopyToast(msg = "Copied to clipboard", type = "info") {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.className = "copy-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.dataset.type = type;
  toast.classList.remove("hidden", "fade-out");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add("fade-out"), 1800);
}

/* ── Charts ─────────────────────────────────────────────── */

// Shared axis/tick number formatter (compact: 1k, 1.23, 1.234e-5, …)
function fmtAxisTick(v) {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return (v / 1000).toFixed(1) + "k";
  if (a >= 1)    return v.toFixed(2).replace(/\.?0+$/, "");
  if (a >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
  return v.toExponential(1);
}

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
  _visibleCharts.clear();
  _refreshChartObserver();
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
  _visibleCharts.clear();
  _refreshChartObserver();
}

function toggleNormalize() {
  state.normalizeEnabled = !state.normalizeEnabled;
  localStorage.setItem("normalize", state.normalizeEnabled ? "1" : "0");
  el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
  el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
  if (state.episode) {
    buildCharts(state.episode);
    updateFrameValues();
    saveHashState();
  }
}

function toggleExpand(type) {
  state[`${type}Expanded`] = !state[`${type}Expanded`];
  localStorage.setItem(`expand_${type}`, state[`${type}Expanded`] ? "1" : "0");
  rebuildChartsFor(type);
}

function toggleHistogram(type) {
  const key = `hist${type[0].toUpperCase() + type.slice(1)}`;
  state[key] = !state[key];
  localStorage.setItem(`hist_${type}`, state[key] ? "1" : "0");
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

  if (expanded && dims > 64) {
    body.innerHTML = `<div class="chart-no-data" style="padding:14px">
      ${dims}D — too many to split (max 64). Use the combined view.
    </div>`;
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
    // Compact legend below chart — click to toggle, Ctrl+click to isolate, dbl-click to show all
    if (dims > 0 && dims <= MAX_LEGEND_DIMS) {
      const legendDiv = document.createElement("div");
      legendDiv.className = "chart-legend";
      const maxShow = MAX_LEGEND_DIMS;
      const legendItems = [];
      const setAllVisible = () => {
        for (let i = 0; i < dims; i++) {
          const m = mainChart?.getDatasetMeta(i);
          if (m) m.hidden = false;
        }
        legendItems.forEach(li => li.classList.remove("legend-hidden"));
        mainChart?.update("none");
      };
      for (let d = 0; d < Math.min(dims, maxShow); d++) {
        const item = document.createElement("span");
        item.className = "legend-item";
        item.title = `Click to show/hide · ${MOD_KEY}+click to isolate · dbl-click to show all`;
        item.style.cursor = "pointer";
        item.dataset.dim = d;
        item.innerHTML = `<span class="legend-dot" style="background:${PALETTE[d % PALETTE.length]}"></span>${names[d] ?? `dim_${d}`}`;
        item.addEventListener("click", e => {
          if (!mainChart) return;
          if (e.ctrlKey || e.metaKey) {
            // Isolate: hide all except this one
            for (let i = 0; i < dims; i++) {
              const m = mainChart.getDatasetMeta(i);
              if (m) m.hidden = i !== d;
            }
            legendItems.forEach((li, i) => li.classList.toggle("legend-hidden", i !== d));
          } else {
            const meta = mainChart.getDatasetMeta(d);
            meta.hidden = !meta.hidden;
            item.classList.toggle("legend-hidden", !!meta.hidden);
          }
          mainChart.update("none");
        });
        item.addEventListener("dblclick", setAllVisible);
        legendItems.push(item);
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
  const yConfig = normalized
    ? { min: -1.05, max: 1.05,
        ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: cc.tick,
                 callback: v => v.toFixed(1) },
        grid: { color: cc.grid }, border: { color: cc.border } }
    : { ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: cc.tick,
                 callback: fmtAxisTick },
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
          backgroundColor: cc.ttBg,
          borderColor: cc.ttBorder,
          borderWidth: 1,
          titleColor: cc.ttTitle,
          bodyColor: cc.ttBody,
          titleFont: { size: 11, weight: "600" },
          cornerRadius: 5,
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

  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label",
    isMini
      ? `${names[dimIndex] ?? `dim_${dimIndex}`} over ${labels.length} frames`
      : `${dims} dimensions over ${labels.length} frames${cmpData2d ? " with comparison overlay" : ""}`
  );

  canvas.addEventListener("click", e => {
    const pts = chart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (pts.length) setFrame(pts[0].index);
  });

  // Drag-to-scrub: hold and drag across chart to seek
  let _chartDragging = false;
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    _chartDragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "ew-resize";
    stopPlayback();
  });
  canvas.addEventListener("pointermove", e => {
    if (!_chartDragging) return;
    const pts = chart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (pts.length) { stopPlayback(); setFrame(pts[0].index); }
  });
  canvas.addEventListener("pointerup", () => {
    _chartDragging = false;
    canvas.style.cursor = "";
  });
  canvas.addEventListener("pointercancel", () => {
    _chartDragging = false;
    canvas.style.cursor = "";
  });

  return chart;
}

/* ── Histogram charts ────────────────────────────────────── */
function computeBins(values, nBins = HISTOGRAM_BIN_COUNT) {
  if (!values.length) return { edges: [], counts: [] };
  let mn = values[0], mx = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < mn) mn = values[i];
    if (values[i] > mx) mx = values[i];
  }
  const w = (mx - mn || 1) / nBins;
  const counts = Array(nBins).fill(0);
  for (const v of values) {
    counts[Math.min(Math.floor((v - mn) / w), nBins - 1)]++;
  }
  return {
    edges: Array.from({ length: nBins }, (_, i) => mn + (i + 0.5) * w),
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
            title: items => `≈${fmtAxisTick(parseFloat(items[0].label))}`,
            label: item => ` ${item.dataset.label}: ${item.raw}`,
          },
          bodyFont: { size: 11 }, padding: 6,
          backgroundColor: cc.ttBg,
          borderColor: cc.ttBorder,
          borderWidth: 1,
          titleColor: cc.ttTitle,
          bodyColor: cc.ttBody,
          cornerRadius: 5,
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 9 }, color: cc.tick,
                      callback: v => fmtAxisTick(parseFloat(datasets[0]._edges[v] ?? v)) },
             grid: { display: false }, border: { color: cc.border } },
        y: { ticks: { maxTicksLimit: 4, font: { size: 9 }, color: cc.tick },
             grid: { color: cc.grid }, border: { color: cc.border } },
      },
    },
  });
}

let _lastChartUpdateFrame = -1;
let _titleUpdateThrottle = 0;

let _chartCursorThrottleMs = 0;

function updateChartCursor() {
  if (_lastChartUpdateFrame === state.frame) return;
  // At 2× speed or higher, throttle chart updates to ~15fps
  if (state.playing && state.speed >= 2) {
    const now = performance.now();
    if (now - _chartCursorThrottleMs < 66) return;
    _chartCursorThrottleMs = now;
  }
  _lastChartUpdateFrame = state.frame;
  // Use cached chart list; fall back to all charts when IntersectionObserver unavailable
  const toUpdate = _chartIntersectObs !== null
    ? _allChartsCache.filter(c => _visibleCharts.has(c))
    : _allChartsCache;
  toUpdate.forEach(c => c.update("none"));
  // Update document title with frame info during playback (throttled)
  if (state.playing) {
    const now = performance.now();
    if (now - _titleUpdateThrottle > 500) {
      _titleUpdateThrottle = now;
      const base = document.title.replace(/^\[\d+\] /, "");
      document.title = `[${state.frame}] ${base}`;
    }
  }
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
  const lo = Math.round(255 * (1 - t));
  return r >= 0 ? `rgb(255,${lo},${lo})` : `rgb(${lo},${lo},255)`;
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
  const rawLabels = Array.from({ length: dims }, (_, d) => rawNames[d] ?? `a${d}`);
  const labels = rawLabels.map(n => n.length > 7 ? n.slice(0, 6) + "…" : n);

  const CELL = 24, LABEL_W = 56, TOP_H = 22, PAD = 2;
  const COLORBAR_H = 12, COLORBAR_GAP = 8, COLORBAR_LABEL_H = 12;
  const W = LABEL_W + dims * CELL + PAD;
  const H = TOP_H + dims * CELL + PAD;
  const H_TOTAL = H + COLORBAR_GAP + COLORBAR_H + COLORBAR_LABEL_H;

  body.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.id = "corr-canvas";
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H_TOTAL * dpr;
  canvas.style.cssText = `width:${W}px;height:${H_TOTAL}px;`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Action correlation matrix (${dims}×${dims})`);
  body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.textBaseline = "middle";

  // Pre-compute matrix once (used for both rendering and tooltip)
  const corrMatrix = Array.from({ length: dims }, (_, i) =>
    Array.from({ length: dims }, (_, j) => pearson(cols[i], cols[j]))
  );

  for (let i = 0; i < dims; i++) {
    for (let j = 0; j < dims; j++) {
      const r = corrMatrix[i][j];
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

// Blue→green→red heatmap: t=0 is blue, t=0.5 green, t=1 red (per-dim normalised)
function _heatmapColor(t) {
  const r = Math.round(Math.min(255, t * 510));
  const b = Math.round(Math.min(255, (1 - t) * 510));
  const g = Math.round(120 * (1 - Math.abs(t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

const TIMEDIM_LABEL_W = 60;  // left label column width
// Cell height adapts: 18px for ≤20 dims, 12px for ≤40, 8px for more
function timedimCellH(dims) {
  if (dims <= 20) return 18;
  if (dims <= 40) return 12;
  return 8;
}

const TIMEDIM_MAX_DIMS = 128;  // hard limit to avoid canvas OOM

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

  const dimsRaw = ep.actions[0].length;
  const truncated = dimsRaw > TIMEDIM_MAX_DIMS;
  const dims = Math.min(dimsRaw, TIMEDIM_MAX_DIMS);
  const CELL_H = timedimCellH(dims);
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

  const CANVAS_W  = Math.min(frames, 900);
  const CANVAS_H  = dims * CELL_H;
  const TIME_AX_H = 18;                    // time axis row at bottom
  const TOTAL_W   = TIMEDIM_LABEL_W + CANVAS_W;
  const TOTAL_H   = CANVAS_H + TIME_AX_H;

  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "timedim-wrap";
  body.appendChild(wrap);

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width  = TOTAL_W * dpr;
  canvas.height = TOTAL_H * dpr;
  canvas.style.cssText = `width:${TOTAL_W}px;height:${TOTAL_H}px;cursor:crosshair;`;
  canvas.id = "timedim-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Action heatmap: time × ${dims} dimensions`);
  canvas.setAttribute("tabindex", "0");
  wrap.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cellW = CANVAS_W / frames;
  const isDark = document.documentElement.classList.contains("dark");

  for (let d = 0; d < dims; d++) {
    const lo = dimMin[d], hi = dimMax[d], range = hi - lo || 1;
    const y0 = d * CELL_H;

    for (let f = 0; f < frames; f++) {
      const t = (ep.actions[f][d] - lo) / range;  // 0…1
      ctx.fillStyle = _heatmapColor(t);
      ctx.fillRect(TIMEDIM_LABEL_W + f * cellW, y0, Math.ceil(cellW), CELL_H - 1);
    }

    ctx.font = "9px -apple-system, sans-serif";
    ctx.fillStyle = isDark ? "#94A3B8" : "#64748B";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[d], TIMEDIM_LABEL_W - 4, y0 + CELL_H / 2);
  }

  // Draw time axis
  {
    const axY = CANVAS_H + 2;
    ctx.font = "8px -apple-system, sans-serif";
    ctx.fillStyle = isDark ? "#64748B" : "#94A3B8";
    ctx.textBaseline = "top";
    const nTicks = Math.min(8, frames);
    for (let t = 0; t <= nTicks; t++) {
      const fi = Math.round(t / nTicks * (frames - 1));
      const x = TIMEDIM_LABEL_W + fi * cellW;
      ctx.fillStyle = isDark ? "#475569" : "#CBD5E1";
      ctx.fillRect(x, CANVAS_H, 1, 4);
      ctx.fillStyle = isDark ? "#64748B" : "#94A3B8";
      ctx.textAlign = t === 0 ? "left" : t === nTicks ? "right" : "center";
      const ts = ep.timestamps?.[fi] ?? (fi / (ep.fps || 10));
      ctx.fillText(ts >= 60 ? formatDuration(ts) : ts.toFixed(1) + "s", x, axY + 4);
    }
  }

  // Drag and click to seek + hover tooltip
  const getFrameFromPointer = e => {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (TOTAL_W / rect.width) - TIMEDIM_LABEL_W;
    return { f: Math.min(Math.max(0, Math.floor(px / cellW)), frames - 1), px };
  };
  const getDimFromPointer = e => {
    const rect = canvas.getBoundingClientRect();
    const py = (e.clientY - rect.top) * (TOTAL_H / rect.height);
    return Math.floor(py / CELL_H);
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
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  canvas.addEventListener("pointerleave", () => { dragging = false; hideTimeDimTooltip(); });

  // Colorbar legend (per-dimension normalization, so labels are generic)
  {
    const legend = document.createElement("div");
    legend.className = "timedim-colorbar";
    const isDark = document.documentElement.classList.contains("dark");
    legend.style.cssText = `display:flex;align-items:center;gap:6px;padding:3px 0 0 ${TIMEDIM_LABEL_W}px;font-size:9px;color:${isDark ? "#64748B" : "#94A3B8"};`;
    // Draw gradient swatch using a small canvas
    const swatch = document.createElement("canvas");
    swatch.width = 80; swatch.height = 8;
    swatch.style.cssText = "width:80px;height:8px;border-radius:2px;flex-shrink:0;";
    const sc = swatch.getContext("2d");
    for (let x = 0; x < 80; x++) {
      sc.fillStyle = _heatmapColor(x / 79);
      sc.fillRect(x, 0, 1, 8);
    }
    legend.appendChild(Object.assign(document.createElement("span"), { textContent: "low" }));
    legend.appendChild(swatch);
    legend.appendChild(Object.assign(document.createElement("span"), { textContent: "high (per dim)" }));
    body.appendChild(legend);
  }

  if (truncated) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:10px;color:var(--text-3);padding:2px 8px 4px;";
    note.textContent = `Showing first ${TIMEDIM_MAX_DIMS} of ${dimsRaw} dimensions`;
    body.appendChild(note);
  }

  card.classList.remove("hidden");
  if (!card.dataset.open) body.classList.add("timedim-collapsed");
}

let _timeDimRafPending = false;
let _lastTimeDimFrame = -1;

function updateTimeDimCursor() {
  if (_timeDimRafPending || _lastTimeDimFrame === state.frame) return;
  _timeDimRafPending = true;
  requestAnimationFrame(_doUpdateTimeDimCursor);
}

function _doUpdateTimeDimCursor() {
  _timeDimRafPending = false;
  const canvas = el("timedim-canvas");
  if (!canvas || !state.episode) return;
  _lastTimeDimFrame = state.frame;

  const ep = state.episode;
  const dims = ep.actions[0]?.length ?? 0;
  const CELL_H = timedimCellH(dims);
  const frames = ep.length;
  const CANVAS_W  = Math.min(frames, 900);
  const TOTAL_W   = TIMEDIM_LABEL_W + CANVAS_W;
  const CANVAS_H  = dims * CELL_H;
  const TIME_AX_H = 18;
  const TOTAL_H   = CANVAS_H + TIME_AX_H;

  const cellW = CANVAS_W / frames;
  const cursorX = TIMEDIM_LABEL_W + state.frame * cellW;

  // Overlay canvas: only covers the heatmap rows (not the time axis)
  let overlay = el("timedim-overlay");
  if (!overlay) {
    const dpr2 = window.devicePixelRatio || 1;
    overlay = document.createElement("canvas");
    overlay.id = "timedim-overlay";
    overlay.width  = TOTAL_W * dpr2;
    overlay.height = CANVAS_H * dpr2;
    overlay.style.cssText = `position:absolute;top:0;left:0;width:${TOTAL_W}px;height:${CANVAS_H}px;pointer-events:none;`;
    canvas.parentElement.style.position = "relative";
    canvas.parentElement.appendChild(overlay);
    overlay.getContext("2d").scale(dpr2, dpr2);
  }

  const oc = overlay.getContext("2d");
  oc.clearRect(0, 0, TOTAL_W, CANVAS_H);
  oc.fillStyle = "rgba(255,255,255,0.55)";
  oc.fillRect(cursorX, 0, Math.max(2, cellW), CANVAS_H);
}

/* ── Topbar breadcrumb ───────────────────────────────────── */
let _crumbEpListenerAttached = false;

function updateTopbarBreadcrumb() {
  const crumb = el("topbar-ep-info");
  if (!crumb) return;
  if (!state.activeDataset || state.activeEpIndex == null) {
    crumb.textContent = "";
    crumb.classList.add("hidden");
    return;
  }
  const epStr = `ep_${String(state.activeEpIndex).padStart(6, "0")}`;
  const dsShort = state.activeDataset.length > 24
    ? state.activeDataset.slice(0, 21) + "…"
    : state.activeDataset;
  const ep = state.episode;
  const frameStr = ep ? `<span class="crumb-sep">·</span><span class="crumb-frame">${state.frame} / ${ep.length - 1}</span>` : "";
  crumb.innerHTML =
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ds" title="${escapeHTML(state.activeDataset)}">${escapeHTML(dsShort)}</span>` +
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ep" title="Click to copy URL  (C)" style="cursor:pointer">${epStr}</span>` +
    frameStr;
  crumb.classList.remove("hidden");
  if (!_crumbEpListenerAttached) {
    crumb.addEventListener("click", e => {
      if (e.target.classList.contains("crumb-ep")) copyEpisodeURL();
    });
    _crumbEpListenerAttached = true;
  }
}

function updateTopbarFrame() {
  const crumb = el("topbar-ep-info");
  if (!crumb || crumb.classList.contains("hidden")) return;
  const frameEl = crumb.querySelector(".crumb-frame");
  const ep = state.episode;
  if (frameEl && ep) frameEl.textContent = `${state.frame} / ${ep.length - 1}`;
}

/* ── Frame counter jump ──────────────────────────────────── */
function initFrameCounterJump() {
  const counter = el("frame-counter");
  if (!counter) return;
  counter.title = "Click to jump to frame or timestamp (e.g. 1:30 = 1 min 30s)  Ctrl+J";
  counter.style.cursor = "pointer";
  counter.tabIndex = 0;
  counter.setAttribute("role", "button");
  counter.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); counter.click(); }
  });
  counter.addEventListener("click", () => {
    if (!state.episode || state.playing) return;
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

    let _jumpCancelled = false;
    const commit = (andPlay = false) => {
      if (_jumpCancelled) return;
      const raw = input.value.trim();
      let f;
      // Support "M:SS" or "H:MM:SS" timestamp formats as well as frame numbers
      if (/^\d+:\d+/.test(raw)) {
        const parts = raw.split(":").map(parseFloat);
        let secs = 0;
        if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else secs = parts[0] * 60 + parts[1];
        const ep = state.episode;
        const frameIdx = ep?.timestamps?.findIndex(ts => ts >= secs) ?? -1;
        f = frameIdx >= 0 ? frameIdx : max;
      } else {
        const parsed = parseInt(raw, 10);
        if (isNaN(parsed)) { input.replaceWith(counter); return; }
        f = clamp(parsed, 0, max);
      }
      input.replaceWith(counter);
      stopPlayback();
      setFrame(f);
      saveHashState();
      if (andPlay) setTimeout(() => startPlayback(), 50);
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(e.ctrlKey || e.metaKey);
      }
      if (e.key === "Escape") { _jumpCancelled = true; input.replaceWith(counter); }
    });
    input.addEventListener("blur", commit);
  });
}

/* ── Frame values sort ───────────────────────────────────── */
let _fvSortActive = false;

/* ── Frame values DOM element cache ─────────────────────── */
// Rebuilt by buildFrameValuesPanel to avoid repeated getElementById in hot path
let _fvCache = { s: /** @type {Array<{span:Element,bar:Element,chip:Element,mn:number,mx:number}>} */ ([]), a: [] };

function toggleFrameValuesSort() {
  _fvSortActive = !_fvSortActive;
  localStorage.setItem("fvSort", _fvSortActive ? "1" : "0");
  const btn = el("fv-sort-btn");
  if (btn) {
    btn.classList.toggle("active", _fvSortActive);
    btn.title = _fvSortActive ? "Sort by |value| (click to restore order)" : "Sort by absolute value";
  }
  updateFrameValues();
}

/* ── Frame values panel toggle ───────────────────────────── */
function toggleFrameValuesPanel() {
  const panel = el("frame-values-panel");
  if (!panel) return;
  const hidden = panel.classList.toggle("fv-collapsed");
  el("btn-frame-values")?.classList.toggle("active", !hidden);
  el("btn-frame-values")?.setAttribute("aria-pressed", String(!hidden));
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
function dimStats(data2d, d) {
  const n = data2d.length;
  if (!n) return { min: 0, max: 0, mean: 0, std: 0 };
  let min = Infinity, max = -Infinity;
  // Welford's online algorithm — numerically stable mean + variance
  let mean = 0, M2 = 0;
  for (let i = 0; i < n; i++) {
    const v = data2d[i][d];
    if (v < min) min = v;
    if (v > max) max = v;
    const delta = v - mean;
    mean += delta / (i + 1);
    M2 += delta * (v - mean);
  }
  const std = n > 1 ? Math.sqrt(M2 / n) : 0;
  return { min, max, mean, std };
}

/* ── Frame values panel ──────────────────────────────────── */
function buildFrameValuesPanel(ep) {
  const panel = el("frame-values-panel");
  if (!panel) return;

  const sDims = ep.state?.[0]?.length ?? 0;
  const aDims = ep.actions?.[0]?.length ?? 0;

  if (!sDims && !aDims) { panel.classList.add("hidden"); return; }

  _fvCache = { s: [], a: [] };  // invalidate stale element references
  panel.innerHTML = "";

  // Panel header with sort + copy buttons
  {
    const hdr = document.createElement("div");
    hdr.className = "fv-panel-header";
    hdr.innerHTML =
      `<span class="fv-panel-title">Frame Values</span>` +
      `<div style="display:flex;gap:4px;align-items:center;">` +
        `<button class="fv-copy-all-btn${_fvSortActive ? " active" : ""}" id="fv-sort-btn" title="Sort by absolute value">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>` +
          ` Sort` +
        `</button>` +
        `<button class="fv-copy-all-btn" title="Copy all current frame values as JSON  Ctrl+Shift+C" id="fv-copy-all">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
          ` Copy all` +
        `</button>` +
      `</div>`;
    panel.appendChild(hdr);
    hdr.querySelector("#fv-copy-all").addEventListener("click", copyCurrentFrameJSON);
    hdr.querySelector("#fv-sort-btn").addEventListener("click", toggleFrameValuesSort);
  }

  const makeChips = (data2d, dims, names, prefix) => {
    _fvCache[prefix] = [];
    const section = document.createElement("div");
    section.className = "fv-section";
    const labelText = prefix === "s" ? "State" : "Action";
    section.innerHTML = `<div class="fv-label">${labelText}</div><div class="fv-grid" id="fv-${prefix}-grid"></div>`;
    panel.appendChild(section);
    const grid = section.querySelector(`#fv-${prefix}-grid`);
    for (let d = 0; d < dims; d++) {
      const { min, max, mean, std } = dimStats(data2d, d);
      const chip = document.createElement("div");
      chip.className = "fv-chip";
      chip.id = `fv-${prefix}-${d}`;
      chip.title = `min: ${min.toFixed(4)}  max: ${max.toFixed(4)}\nmean: ${mean.toFixed(4)}  std: ${std.toFixed(4)}\nClick to copy current value`;
      chip.style.cursor = "pointer";
      const span = document.createElement("span");
      span.className = "fv-val";
      span.textContent = "—";
      const barFill = document.createElement("div");
      barFill.className = "fv-bar-fill";
      barFill.style.background = PALETTE[d % PALETTE.length];
      chip.innerHTML = `<div class="fv-top"><span class="fv-dim" style="color:${PALETTE[d % PALETTE.length]}">${names[d] ?? `${prefix}${d}`}</span></div><div class="fv-bar"></div>`;
      chip.querySelector(".fv-top").appendChild(span);
      chip.querySelector(".fv-bar").appendChild(barFill);
      // Cache direct element references for fast hot-path updates
      _fvCache[prefix][d] = { span, bar: barFill, chip, mn: min, mx: max };
      chip.addEventListener("click", async () => {
        const val = span.textContent;
        if (val && val !== "—") {
          try { await navigator.clipboard.writeText(val); } catch (_) {}
          showCopyToast(`✓ ${names[d] ?? `${prefix}${d}`}: ${val}`, "success");
        }
      });
      grid.appendChild(chip);
    }
  };

  if (sDims) makeChips(ep.state, sDims, ep.state_names, "s");
  if (aDims) makeChips(ep.actions, aDims, ep.action_names, "a");

  panel.classList.remove("hidden", "fv-collapsed");
  updateFrameValues();
}

function updateFrameValues() {
  const ep = state.episode;
  if (!ep) return;
  // Throttle at high playback speeds to avoid layout thrash
  if (state.playing && state.speed >= 2) {
    const now = performance.now();
    if (now - _lastFvUpdateMs < FRAME_RETRY_DEBOUNCE_MS) return;
    _lastFvUpdateMs = now;
  }
  const f = state.frame;
  const ns = state.normalizeEnabled ? state.normStats : null;

  const applyNorm = (v, nsKey, d) => {
    if (!ns?.[nsKey]?.q01 || !ns?.[nsKey]?.q99) return v;
    return normalizeValue(v, ns[nsKey].q01[d], ns[nsKey].q99[d]);
  };

  const updateDim = (prefix, row, nsKey) => {
    if (!row) return;
    const cache = _fvCache[prefix];
    if (!cache?.length) return;
    const vals = [];
    row.forEach((v, d) => {
      const entry = cache[d];
      if (!entry) return;
      const nv = applyNorm(v, nsKey, d);
      entry.span.textContent = nv.toFixed(4);
      const { mn, mx } = entry;
      const pct = mx !== mn ? clamp((v - mn) / (mx - mn), 0, 1) * 100 : 50;
      entry.bar.style.width = pct + "%";
      vals.push({ d, abs: Math.abs(nv) });
    });
    // Apply CSS ordering when sort is active
    if (_fvSortActive) {
      vals.sort((a, b) => b.abs - a.abs);
      vals.forEach(({ d }, order) => {
        const entry = cache[d];
        if (entry) entry.chip.style.order = order;
      });
    } else {
      vals.forEach(({ d }) => {
        const entry = cache[d];
        if (entry) entry.chip.style.order = "";
      });
    }
  };

  updateDim("s", ep.state?.[f], "state");
  updateDim("a", ep.actions?.[f], "action");
}

/* ── Playback ────────────────────────────────────────────── */
function setupControls(ep) {
  const scrubber = el("scrubber");
  scrubber.max = ep.length - 1;
  scrubber.value = 0;
  scrubber.setAttribute("aria-valuemin", "0");
  scrubber.setAttribute("aria-valuemax", ep.length - 1);
  scrubber.setAttribute("aria-valuenow", "0");
  scrubber.setAttribute("aria-valuetext", "frame 0");
  el("frame-counter").textContent = `0 / ${ep.length - 1}`;
  // Update speed select tooltip with per-speed effective fps
  const speedSel = el("speed-select");
  if (speedSel && ep.fps) {
    speedSel.title = `Playback speed · Base: ${ep.fps} fps`;
    Array.from(speedSel.options).forEach(opt => {
      const s = parseFloat(opt.value);
      opt.title = `${s}× speed = ${Math.round(ep.fps * s)} fps`;
    });
  }
}

function updateScrubber() {
  const ep = state.episode;
  if (!ep) return;
  const scrubber = el("scrubber");
  scrubber.value = state.frame;
  const ts = ep.timestamps;
  const tsCurRaw = ts?.[state.frame] ?? null;
  const tsEndRaw = ts?.[ep.length - 1] ?? null;
  const fmt = v => v >= 60 ? formatDuration(v) : v.toFixed(2) + "s";
  const tsStr = (tsCurRaw !== null && tsEndRaw !== null && tsEndRaw > 0.1) ? `  •  ${fmt(tsCurRaw)} / ${fmt(tsEndRaw)}` : "";
  el("frame-counter").textContent = `${state.frame} / ${ep.length - 1}${tsStr}`;
  const titleStr = tsCurRaw != null ? `${fmt(tsCurRaw)} (frame ${state.frame})` : `frame ${state.frame}`;
  scrubber.title = titleStr;
  scrubber.setAttribute("aria-valuenow", state.frame);
  scrubber.setAttribute("aria-valuetext", titleStr);
  // Fill the scrubber track to show playback progress
  const pct = ep.length > 1 ? (state.frame / (ep.length - 1)) * 100 : 0;
  scrubber.style.background =
    `linear-gradient(to right, var(--blue) ${pct}%, var(--border) ${pct}%)`;
}

function stopPlayback() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.playing = false;
  state.rafId = null;
  state.lastTick = null;
  el("play-icon")?.classList.remove("hidden");
  el("pause-icon")?.classList.add("hidden");
  const fpsBadge = el("fps-badge");
  if (fpsBadge) { fpsBadge.classList.add("hidden"); fpsBadge.dataset.fast = ""; }
  document.body.classList.remove("is-playing");
  // Strip frame prefix from title when stopped
  document.title = document.title.replace(/^\[\d+\] /, "");
  saveHashState();
}

function startPlayback() {
  if (!state.episode) return;
  state.playing = true;
  state.loopCount = 0;
  el("play-icon").classList.add("hidden");
  el("pause-icon").classList.remove("hidden");
  document.body.classList.add("is-playing");

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
          const loopStr = state.looping && state.loopCount > 0 ? ` ×${state.loopCount}` : "";
          const speedStr = state.speed !== 1 ? ` @${state.speed}×` : "";
          badge.textContent = `${fpsBucket}/${Math.round(targetFps)}fps${speedStr}${lagStr}${loopStr}`;
          badge.dataset.fast = state.speed >= 2 ? "1" : "";
          badge.title = `Actual / target fps${speedStr ? ` @ ${state.speed}× speed` : ""}${lagStr ? " — ⚠ rendering lag" : ""}${loopStr ? `  •  looped ${state.loopCount}×` : ""}`;
          badge.classList.remove("hidden");
        }
        fpsBucket = 0;
        fpsLast = ts;
      }
      const next = state.frame + 1;
      if (next >= state.episode.length) {
        if (state.looping) {
          state.loopCount++;
          setFrame(0);
        } else {
          stopPlayback();
          return;
        }
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
  if (SPEEDS.includes(savedSpeed)) {
    state.speed = savedSpeed;
    el("speed-select").value = savedSpeed;
  }
  const savedLoop = localStorage.getItem("loop") === "1";
  state.looping = savedLoop;
  el("btn-loop").classList.toggle("active", savedLoop);
  el("btn-loop").setAttribute("aria-pressed", savedLoop);

  // Restore normalize preference (hash URL takes priority, but localStorage covers no-hash case)
  const savedNorm = localStorage.getItem("normalize");
  if (savedNorm !== null) {
    state.normalizeEnabled = savedNorm === "1";
    el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
    el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
  }
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
  loadRecentEpisodes();
  updateRecentSection();
  // Restore mirror mode
  _mirrorMode = localStorage.getItem("mirrorMode") === "1";
  if (_mirrorMode) _applyMirrorMode(true);

  // Restore persisted chart UI states
  state.stateExpanded  = localStorage.getItem("expand_state")  === "1";
  state.actionExpanded = localStorage.getItem("expand_action") === "1";
  state.histState  = localStorage.getItem("hist_state")  === "1";
  state.histAction = localStorage.getItem("hist_action") === "1";

  // Restore frame values sort preference
  _fvSortActive = localStorage.getItem("fvSort") === "1";

  // Restore corr/timedim open state (will take effect after episode loads)
  if (localStorage.getItem("corrOpen") === "1") {
    el("corr-body")?.classList.remove("corr-collapsed");
    if (el("corr-section")) el("corr-section").dataset.open = "1";
    el("corr-close")?.classList.add("active");
    el("corr-close")?.setAttribute("aria-expanded", "true");
  }
  if (localStorage.getItem("timedimOpen") === "1") {
    el("timedim-body")?.classList.remove("timedim-collapsed");
    if (el("timedim-card")) el("timedim-card").dataset.open = "1";
    el("timedim-toggle")?.classList.add("active");
    el("timedim-toggle")?.setAttribute("aria-expanded", "true");
  }

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
    el("btn-play").setAttribute("aria-label", state.playing ? "Pause playback" : "Start playback");
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

  // FPS badge click toggles loop (convenient during playback)
  el("fps-badge")?.addEventListener("click", () => {
    el("btn-loop").click();
    showCopyToast(state.looping ? "Loop on" : "Loop off");
  });
  el("fps-badge").style.cursor = "pointer";
  el("fps-badge").title = "Click to toggle loop";
  el("btn-export").addEventListener("click", exportFrame);
  el("btn-frame-values").addEventListener("click", toggleFrameValuesPanel);
  el("btn-normalize")?.addEventListener("click", toggleNormalize);
  el("btn-csv")?.addEventListener("click", exportCSV);
  el("btn-copy-url")?.addEventListener("click", copyEpisodeURL);

  // Disable export buttons initially
  el("btn-export").disabled = true;
  el("btn-csv").disabled = true;
  el("btn-frame-values").disabled = true;

  el("speed-select").addEventListener("change", e => {
    state.speed = parseFloat(e.target.value);
    localStorage.setItem("speed", state.speed);
    const effectiveFps = state.episode ? Math.round((state.episode.fps || 10) * state.speed) : null;
    const fpsHint = effectiveFps ? ` (${effectiveFps} fps)` : "";
    showCopyToast(`Speed: ${state.speed}×${fpsHint}`);
    if (state.playing) {
      stopPlayback();
      startPlayback();
    }
  });

  el("scrubber").addEventListener("input", e => {
    stopPlayback();
    setFrame(parseInt(e.target.value, 10));
    saveHashState();
  });

  // Scrubber hover tooltip — shows frame number + timestamp
  el("scrubber").addEventListener("mousemove", e => {
    const ep = state.episode;
    if (!ep) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const hoverFrame = Math.round(pct * (ep.length - 1));
    const ts = ep.timestamps?.[hoverFrame];
    const fmt = v => v >= 60 ? formatDuration(v) : v.toFixed(2) + "s";
    const tsStr = ts != null ? ` · ${fmt(ts)}` : "";
    if (!_scrubTooltipEl) {
      _scrubTooltipEl = document.createElement("div");
      _scrubTooltipEl.className = "scrub-tooltip hidden";
      document.body.appendChild(_scrubTooltipEl);
    }
    _scrubTooltipEl.textContent = `Frame ${hoverFrame}${tsStr}`;
    _scrubTooltipEl.style.left = `${e.clientX}px`;
    _scrubTooltipEl.style.top = `${rect.top - 30}px`;
    _scrubTooltipEl.classList.remove("hidden");
  });
  el("scrubber").addEventListener("mouseleave", () => {
    _scrubTooltipEl?.classList.add("hidden");
  });

  el("expand-state").addEventListener("click",  () => toggleExpand("state"));
  el("expand-action").addEventListener("click", () => toggleExpand("action"));
  el("hist-state").addEventListener("click",   () => toggleHistogram("state"));
  el("hist-action").addEventListener("click",  () => toggleHistogram("action"));

  el("compare-clear").addEventListener("click", clearCompare);

  // Click / Enter task-label to copy the task description
  const _copyTaskLabel = async () => {
    const txt = el("task-label").textContent.trim();
    if (!txt || state.episode == null) return;
    try { await navigator.clipboard.writeText(txt); } catch (_) {}
    showCopyToast("✓ Task copied", "success");
  };
  el("task-label").addEventListener("click", _copyTaskLabel);
  el("task-label").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); _copyTaskLabel(); }
  });
  el("task-label").title = "Click to copy task description";

  el("corr-close").addEventListener("click", () => {
    const body = el("corr-body");
    const nowCollapsed = body.classList.toggle("corr-collapsed");
    el("corr-section").dataset.open = nowCollapsed ? "" : "1";
    el("corr-close").classList.toggle("active", !nowCollapsed);
    el("corr-close").setAttribute("aria-expanded", String(!nowCollapsed));
    localStorage.setItem("corrOpen", nowCollapsed ? "0" : "1");
    if (!nowCollapsed && state.episode) buildCorrelationHeatmap(state.episode);
  });

  el("timedim-toggle").addEventListener("click", () => {
    const card = el("timedim-card");
    const body = el("timedim-body");
    const nowCollapsed = body.classList.toggle("timedim-collapsed");
    card.dataset.open = nowCollapsed ? "" : "1";
    el("timedim-toggle").classList.toggle("active", !nowCollapsed);
    el("timedim-toggle").setAttribute("aria-expanded", String(!nowCollapsed));
    localStorage.setItem("timedimOpen", nowCollapsed ? "0" : "1");
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
      const modal = el("shortcuts-modal");
      const nowHidden = modal.classList.toggle("hidden");
      el("btn-shortcuts").setAttribute("aria-expanded", String(!nowHidden));
      return;
    }

    if (inInput) return;

    if (e.key === "b" || e.key === "B") {
      e.preventDefault(); toggleSidebar(); return;
    }

    // Alt+Up/Down: navigate between task group headers
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const headers = Array.from(document.querySelectorAll(
        ".task-group:not(.search-hidden) .task-header, .ds-header"
      ));
      const focused = document.activeElement;
      const idx = headers.indexOf(focused);
      let next;
      if (idx === -1) {
        next = e.key === "ArrowDown" ? headers[0] : headers[headers.length - 1];
      } else {
        next = e.key === "ArrowDown" ? headers[idx + 1] : headers[idx - 1];
      }
      if (next) { next.focus(); next.scrollIntoView({ block: "nearest" }); }
      return;
    }

    const modKey = e.ctrlKey || e.metaKey;
    if (e.key === "/" || e.key === "g" || e.key === "G" || (modKey && e.key === "k")) {
      e.preventDefault();
      el("search-input").focus();
      el("search-input").select();
      return;
    }
    if (modKey && e.key === "d") {
      e.preventDefault();
      toggleDarkMode();
      return;
    }

    if (modKey && e.key === "r") {
      e.preventDefault();
      if (state.activeDataset && state.activeEpIndex != null) {
        // Clear cache and reload current episode
        state.frameCache.clear();
        state.prefetchPending.clear();
        const entry = state.episodeList.find(
          e => e.dsPath === state.activeDataset && e.epIndex === state.activeEpIndex
        );
        selectEpisode(state.activeDataset, state.activeEpIndex,
          entry?.taskText ?? null, document.querySelector(".ep-item.active"));
        showCopyToast("Reloading episode…");
      }
      return;
    }
    if (modKey && e.key === "s") {
      e.preventDefault();
      exportFrame();
      return;
    }
    if (modKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
      e.preventDefault();
      copyCurrentFrameJSON();
      return;
    }

    if (!state.episode && !["[", "]", "Backspace"].includes(e.key)) return;

    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      if (!el("cam-lightbox").classList.contains("hidden")) {
        _lbSetZoom(_lbZoom * 1.2);
      } else {
        const cur = SPEEDS.indexOf(state.speed);
        if (cur < SPEEDS.length - 1) {
          state.speed = SPEEDS[cur + 1];
          el("speed-select").value = state.speed;
          localStorage.setItem("speed", state.speed);
          if (state.playing) { stopPlayback(); startPlayback(); }
          const efps = state.episode ? ` (${Math.round((state.episode.fps || 10) * state.speed)} fps)` : "";
          showCopyToast(`Speed: ${state.speed}×${efps}`);
        }
      }
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      if (!el("cam-lightbox").classList.contains("hidden")) {
        _lbSetZoom(_lbZoom / 1.2);
      } else {
        const cur = SPEEDS.indexOf(state.speed);
        if (cur > 0) {
          state.speed = SPEEDS[cur - 1];
          el("speed-select").value = state.speed;
          localStorage.setItem("speed", state.speed);
          if (state.playing) { stopPlayback(); startPlayback(); }
          const efps = state.episode ? ` (${Math.round((state.episode.fps || 10) * state.speed)} fps)` : "";
          showCopyToast(`Speed: ${state.speed}×${efps}`);
        }
      }
      return;
    }
    if (e.key === "l" || e.key === "L") {
      e.preventDefault();
      state.looping = !state.looping;
      el("btn-loop").classList.toggle("active", state.looping);
      el("btn-loop").setAttribute("aria-pressed", state.looping);
      localStorage.setItem("loop", state.looping ? "1" : "0");
      return;
    }
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleHistogram(e.shiftKey ? "action" : "state");
      return;
    }
    if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      toggleExpand(e.shiftKey ? "action" : "state");
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
    // Home/End: jump to first / last frame
    if (e.key === "Home" && state.episode) {
      e.preventDefault();
      stopPlayback();
      setFrame(0);
      return;
    }
    if (e.key === "End" && state.episode) {
      e.preventDefault();
      stopPlayback();
      setFrame(state.episode.length - 1);
      return;
    }
    // PageUp/PageDown: jump ±10% (or ±25% with Shift) of episode length
    if ((e.key === "PageUp" || e.key === "PageDown") && state.episode) {
      e.preventDefault();
      const pct = e.shiftKey ? 0.25 : 0.1;
      const step = Math.max(1, Math.round(state.episode.length * pct));
      stopPlayback();
      setFrame(state.frame + (e.key === "PageDown" ? step : -step));
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
    if (e.key === "x" || e.key === "X") {
      e.preventDefault();
      exportCSV();
      return;
    }
    if (e.key === "w" || e.key === "W") {
      e.preventDefault();
      exportTimestamps();
      return;
    }
    if (e.key === "q" || e.key === "Q") {
      e.preventDefault();
      const ts = state.episode?.timestamps?.[state.frame];
      if (ts != null) {
        const val = ts.toFixed(6);
        navigator.clipboard.writeText(val).catch(() => {});
        showCopyToast(`✓ t=${val}s (f${state.frame}) copied`, "success");
      }
      return;
    }
    if (e.key === "j" || e.key === "J") {
      e.preventDefault();
      exportJSON();
      return;
    }
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      // D in lightbox: download current camera frame; outside lightbox: download current frame as PNG
      if (!el("cam-lightbox").classList.contains("hidden")) {
        downloadLightboxFrame();
      } else {
        exportFrame();
      }
      return;
    }
    if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      el("ep-info-strip").classList.toggle("hidden");
      return;
    }
    if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      // Scroll sidebar to active episode
      const activeItem = document.querySelector(".ep-item.active");
      if (activeItem) {
        const wasCollapsed = el("main").classList.contains("sidebar-collapsed");
        if (wasCollapsed) toggleSidebar();
        // Wait for sidebar animation (200ms) before scrolling
        setTimeout(() => activeItem.scrollIntoView({ block: "center", behavior: "smooth" }), wasCollapsed ? 220 : 0);
        showCopyToast("Scrolled to current episode", "success");
      }
      return;
    }
    if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      // Isolate: collapse all task groups except the one containing the active episode
      const activeItem = document.querySelector(".ep-item.active");
      const activeGroup = activeItem?.closest(".task-group");
      const allGroups = document.querySelectorAll(".task-group");
      let collapsed = 0;
      allGroups.forEach(g => {
        if (g !== activeGroup && g.classList.contains("open")) {
          g.classList.remove("open");
          collapsed++;
        }
      });
      if (activeGroup && !activeGroup.classList.contains("open")) {
        activeGroup.classList.add("open");
      }
      showCopyToast(collapsed > 0 ? `Collapsed ${collapsed} other task group${collapsed > 1 ? "s" : ""}` : "Isolated current task");
      return;
    }
    if (modKey && e.key === "j") {
      e.preventDefault();
      if (state.episode && !state.playing) el("frame-counter").click();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      if (!el("cam-lightbox").classList.contains("hidden")) {
        e.preventDefault();
        // Fullscreen the lightbox image box
        const box = el("cam-lightbox").querySelector(".lightbox-box");
        if (document.fullscreenElement) document.exitFullscreen();
        else box?.requestFullscreen?.();
      } else {
        const slot = el("cam-0");
        if (slot && document.fullscreenEnabled) {
          e.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen();
          else slot.requestFullscreen?.();
        }
      }
      return;
    }
    if ((modKey) && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      if (state.episode) {
        stopPlayback();
        setFrame(Math.round((state.episode.length - 1) / 2));
        showCopyToast(`Midpoint → frame ${state.frame}`);
      }
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      _mirrorMode = !_mirrorMode;
      try { localStorage.setItem("mirrorMode", _mirrorMode ? "1" : "0"); } catch (_) {}
      _applyMirrorMode(_mirrorMode);
      showCopyToast(_mirrorMode ? "Mirror mode on — labels hidden" : "Mirror mode off");
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (state.playing) stopPlayback(); else startPlayback();
        break;
      case "Enter":
        if (modKey) { e.preventDefault(); if (state.playing) stopPlayback(); else startPlayback(); }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!el("cam-lightbox").classList.contains("hidden")) {
          lightboxNavigate(-1);
        } else if (e.altKey) {
          navigateFrameHistory(-1);
        } else {
          stopPlayback();
          setFrame(state.frame - (e.shiftKey ? 10 : 1));
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!el("cam-lightbox").classList.contains("hidden")) {
          lightboxNavigate(1);
        } else if (e.altKey) {
          navigateFrameHistory(1);
        } else {
          stopPlayback();
          setFrame(state.frame + (e.shiftKey ? 10 : 1));
        }
        break;
      case "r": case "R":
        e.preventDefault();
        if (e.shiftKey) {
          randomEpisode();
        } else {
          stopPlayback(); setFrame(0);
        }
        break;
      case "z": case "Z":
        e.preventDefault();
        stopPlayback(); setFrame(0); startPlayback();
        break;
      case "Backspace":
        // Backspace navigates to previous episode (intuitive browser-back analogue)
        if (!e.shiftKey && !modKey) {
          e.preventDefault();
          prevEpisode();
        }
        break;
      case "[":
        e.preventDefault();
        if (e.shiftKey) {
          // Jump to first episode in the list
          const first = state.episodeList[0];
          if (first) { first.el?.closest(".task-group")?.classList.add("open"); selectEpisode(first.dsPath, first.epIndex, first.taskText, first.el); }
        } else {
          prevEpisode();
        }
        break;
      case "]":
        e.preventDefault();
        if (e.shiftKey) {
          // Jump to last episode in the list
          const last = state.episodeList[state.episodeList.length - 1];
          if (last) { last.el?.closest(".task-group")?.classList.add("open"); selectEpisode(last.dsPath, last.epIndex, last.taskText, last.el); }
        } else {
          nextEpisode();
        }
        break;
      case "Escape":
        if (state.compareEpisode) { e.preventDefault(); clearCompare(); }
        el("shortcuts-modal").classList.add("hidden");
        el("btn-shortcuts").setAttribute("aria-expanded", "false");
        if (!el("cam-lightbox").classList.contains("hidden")) {
          if (_lbZoom > 1) {
            _lbResetZoom(); // First Esc: clear zoom; second Esc: close
          } else {
            el("cam-lightbox").classList.add("hidden");
            _lbPrevFocus?.focus();
          }
        }
        break;
    }
  });

  el("btn-shortcuts").addEventListener("click", () => {
    const modal = el("shortcuts-modal");
    const nowHidden = modal.classList.toggle("hidden"); // true = modal is now hidden
    el("btn-shortcuts").setAttribute("aria-expanded", String(!nowHidden));
    if (!nowHidden) {
      // Modal just opened — focus the box for keyboard nav
      const box = modal.querySelector(".modal-box");
      if (box && !box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
      requestAnimationFrame(() => box?.focus());
    }
  });
  // Focus trap inside shortcuts modal
  el("shortcuts-modal").addEventListener("keydown", e => {
    if (el("shortcuts-modal").classList.contains("hidden")) return;
    if (e.key === "Tab") {
      const focusable = Array.from(el("shortcuts-modal").querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  });
  el("shortcuts-modal").addEventListener("click", e => {
    if (e.target === el("shortcuts-modal")) {
      el("shortcuts-modal").classList.add("hidden");
      el("btn-shortcuts").setAttribute("aria-expanded", "false");
    }
  });
  // Focus trap inside lightbox
  el("cam-lightbox").addEventListener("keydown", e => {
    if (el("cam-lightbox").classList.contains("hidden")) return;
    if (e.key !== "Tab") return;
    const focusable = Array.from(el("cam-lightbox").querySelectorAll(
      'button:not([style*="display: none"]):not([style*="display:none"])'
    ));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  el("cam-lightbox").addEventListener("click", e => {
    if (e.target === el("cam-lightbox")) {
      el("cam-lightbox").classList.add("hidden");
      _lbPrevFocus?.focus();
    }
  });
  el("lightbox-close-btn")?.addEventListener("click", () => {
    el("cam-lightbox").classList.add("hidden");
    _lbPrevFocus?.focus();
  });

  // Swipe to navigate cameras in lightbox; pinch to zoom; swipe-down to close
  {
    let _touchStartX = 0;
    let _touchStartY = 0;
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1;
    let _isPinching = false;
    const lb = el("cam-lightbox");
    lb.addEventListener("touchstart", e => {
      if (e.touches.length === 2) {
        _isPinching = true;
        _pinchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        _pinchStartZoom = _lbZoom;
        e.preventDefault();
      } else {
        _isPinching = false;
        _touchStartX = e.touches[0].clientX;
        _touchStartY = e.touches[0].clientY;
      }
    }, { passive: false });
    lb.addEventListener("touchmove", e => {
      if (e.touches.length === 2 && _isPinching && _pinchStartDist > 0) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        _lbSetZoom(_pinchStartZoom * (dist / _pinchStartDist));
        e.preventDefault();
      }
    }, { passive: false });
    lb.addEventListener("touchend", e => {
      if (_isPinching) { _isPinching = false; return; }
      const dx = e.changedTouches[0].clientX - _touchStartX;
      const dy = e.changedTouches[0].clientY - _touchStartY;
      // Swipe-down to close (dominant vertical movement, not zoomed)
      if (dy > 80 && Math.abs(dy) > Math.abs(dx) && _lbZoom <= 1) {
        el("cam-lightbox").classList.add("hidden");
        _lbPrevFocus?.focus();
        return;
      }
      if (Math.abs(dx) > 40 && _lbZoom <= 1) lightboxNavigate(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ResizeObserver: resize Chart.js instances when viewer layout changes
  if (typeof ResizeObserver !== "undefined") {
    const _chartsResizeObs = new ResizeObserver(() => {
      state.stateCharts.forEach(c => c?.resize?.());
      state.actionCharts.forEach(c => c?.resize?.());
    });
    const chartsArea = el("charts-area");
    if (chartsArea) _chartsResizeObs.observe(chartsArea);
  }

  // Auto-collapse sidebar on resize below breakpoint
  const _mq = window.matchMedia(`(max-width: ${SIDEBAR_BREAKPOINT}px)`);
  _mq.addEventListener("change", e => {
    if (e.matches && !el("main").classList.contains("sidebar-collapsed")) {
      el("main").classList.add("sidebar-collapsed");
      el("sidebar-toggle").setAttribute("aria-pressed", "true");
    }
  });

  // Auto-collapse sidebar on orientation change (mobile)
  window.addEventListener("resize", () => {
    if (window.innerWidth < SIDEBAR_BREAKPOINT && !el("main").classList.contains("sidebar-collapsed")) {
      el("main").classList.add("sidebar-collapsed");
      el("sidebar-toggle").setAttribute("aria-pressed", "true");
    }
  }, { passive: true });

  // Search input: Escape clears; Enter/ArrowDown jumps to first visible episode
  el("search-input").addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.stopPropagation();
      el("search-input").value = "";
      applySearch("");
      el("search-input").blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = document.querySelector(
        ".ep-item:not(.ep-search-hidden):not(.search-hidden .ep-item)"
      );
      if (first) {
        first.focus();
        first.click();
        el("search-input").blur();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(document.querySelectorAll(
        ".ep-item:not(.ep-search-hidden):not(.search-hidden .ep-item)"
      ));
      const target = e.key === "ArrowDown" ? items[0] : items[items.length - 1];
      if (target) { target.focus(); target.scrollIntoView({ block: "nearest" }); }
    }
  });

  // ── Lightbox wheel zoom ──────────────────────────────────
  el("cam-lightbox").addEventListener("wheel", e => {
    if (el("cam-lightbox").classList.contains("hidden")) return;
    e.preventDefault();
    const box = el("cam-lightbox").querySelector(".lightbox-box");
    const rect = box?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };
    const ox = ((e.clientX - rect.left) / rect.width) * 100;
    const oy = ((e.clientY - rect.top) / rect.height) * 100;
    _lbSetZoom(_lbZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), ox, oy);
  }, { passive: false });

  el("lightbox-img").addEventListener("click", e => {
    e.stopPropagation(); // don't close lightbox on image click
    const box = el("cam-lightbox").querySelector(".lightbox-box");
    const rect = box?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };
    const ox = ((e.clientX - rect.left) / rect.width) * 100;
    const oy = ((e.clientY - rect.top) / rect.height) * 100;
    if (_lbZoom <= 1) {
      _lbSetZoom(2.5, ox, oy);
    }
  });
  el("lightbox-img").addEventListener("dblclick", e => {
    e.stopPropagation();
    if (_lbZoom > 1) { _lbResetZoom(); }
  });

  // ── Respond to browser back/forward (hash navigation) ──
  window.addEventListener("hashchange", () => {
    if (!location.hash || location.hash.length <= 1) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const ds = params.get("ds");
    const ep = params.get("ep");
    if (!ds || ep == null) return;
    const epIndex = parseInt(ep, 10);
    if (ds !== state.activeDataset || epIndex !== state.activeEpIndex) {
      loadHashState();
    } else {
      // Same episode — restore frame, speed, and normalize from hash
      const f = params.get("f");
      if (f != null) setFrame(parseInt(f, 10));
      const speedParam = parseFloat(params.get("speed") ?? "");
      if (!isNaN(speedParam) && SPEEDS.includes(speedParam) && speedParam !== state.speed) {
        state.speed = speedParam;
        el("speed-select").value = speedParam;
        localStorage.setItem("speed", speedParam);
      }
      const nParam = params.get("n");
      const wantNorm = nParam === null || nParam === "1";
      if (wantNorm !== state.normalizeEnabled) {
        state.normalizeEnabled = wantNorm;
        el("btn-normalize")?.classList.toggle("active", state.normalizeEnabled);
        el("btn-normalize")?.setAttribute("aria-pressed", state.normalizeEnabled);
        if (state.episode) { buildCharts(state.episode); updateFrameValues(); }
      }
    }
  });
});
