/* ══════════════════════════════════════════════════════════
   LeRobot Visualizer — app.js  v104
   ══════════════════════════════════════════════════════════ */

/* ── Constants ───────────────────────────────────────────── */
const PREFETCH_AHEAD = 8;
const SEARCH_DEBOUNCE_MS = 160;
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const SIDEBAR_BREAKPOINT = 720;
const MAX_RECENT = 8;
const MAX_CAMS = 6;
const FRAME_HISTORY_MAX = 40;
const MAX_LEGEND_DIMS = 20;
const CHART_MINI_DIMS_THRESHOLD = 22;
const FRAME_EXPORT_WIDTH = 480;
const FRAME_EXPORT_HEIGHT_RATIO = 3 / 4;
const FRAME_LABEL_HEIGHT = 28;
const FRAME_LABEL_SIZE_PX = 11;
const FULLSCREEN_LABEL_HEIGHT = 20;
const HISTOGRAM_BIN_COUNT = 22;
const TIMEDIM_MAX_CANVAS_W = 900;
const TIMEDIM_LABEL_W = 60;         // timedim left label column width (px)
const TIMEDIM_MAX_DIMS = 128;       // hard canvas OOM limit
const API_TIMEOUT_MS = 30000;
const FRAME_RETRY_DELAY_MS = 700;
const FRAME_RETRY_DEBOUNCE_MS = 120;
const CHART_FONT_SIZE = 9;          // Chart.js tick/label font size (px)
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
  deltaCharts: [],
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
  annotationSchema: [],   // [{name, type, options?}]
  annotations: {},        // {frame_index_str: {field_name: value}}
  annotationDirty: false, // true when unsaved changes in current session
  viewerTab: "video",     // "video" | "annotate"
  annFillConfig: {},      // {fieldName: {strategy: "none"|"fixed"|"linear"|"prev", fixedValue: ""}}
  datasetConfig: {},      // per-dataset config: {camera_labels: {...}, ...}
  sshSessions: [],        // active SSH sessions [{session_id, label, ssh_command, remote_path, datasets:[]}]
};

/* ── Frame navigation history ────────────────────────────── */
const _frameHistory = [];        // positions visited via explicit navigation
let _frameHistoryPos = -1;       // current index in _frameHistory (-1 = empty)
let _navigatingHistory = false;  // true while traversing history (prevents re-push)

/* ── Mirror mode ─────────────────────────────────────────── */
let _mirrorMode = false;

/* ── Frame values throttle ───────────────────────────────── */
let _lastFvUpdateMs = 0;

/* ── Frame JSON viewer ───────────────────────────────────── */
let _fjvDebounce  = null;   // debounce timer for fetch
let _fjvLastKey   = null;   // "ds/ep/frame" to avoid redundant fetches
let _fjvExpanded  = {};     // {colName: bool} — expanded arrays
let _fjvFilterText = "";    // current search filter string
let _fjvLastData  = null;   // last fetched data (for filter re-render without refetch)
let _fjvPrevData  = null;   // previous frame's data (for delta display)
let _fjvPrevKey   = null;   // key of _fjvPrevData ("ds/ep/frame")

/* ── Chart visibility (IntersectionObserver) ────────────── */
const _visibleCharts = new Set();
let _chartIntersectObs = null;
let _allChartsCache = [];  // updated in _refreshChartObserver to avoid repeated spread
let _visibleChartsArr = [];  // array version of visible charts, updated in observer callback

function _refreshChartObserver() {
  _visibleCharts.clear();
  _visibleChartsArr = [];
  _chartIntersectObs?.disconnect();
  _chartIntersectObs = null;
  _allChartsCache = [...state.stateCharts, ...state.actionCharts, ...(state.deltaCharts ?? [])].filter(c => c?.canvas);
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
    // Update _visibleChartsArr to avoid .filter() in hot updateChartCursor path
    _visibleChartsArr = _allChartsCache.filter(c => _visibleCharts.has(c));
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
const _node = x => typeof x === "string" ? el(x) : x;
const isHidden = x => _node(x)?.classList.contains("hidden") ?? true;
const hide = x => _node(x)?.classList.add("hidden");
const show = x => _node(x)?.classList.remove("hidden");
const toggle = (x, cls, force) => _node(x)?.classList.toggle(cls, force);
const attr = (x, k, v) => _node(x)?.setAttribute(k, v);
const toggleSub = (x, sel, cls, force) => _node(x)?.querySelector(sel)?.classList.toggle(cls, force);
const all = sel => Array.from(document.querySelectorAll(sel));
const truncate = (str, maxLen) => str?.length > maxLen ? str.slice(0, maxLen - 1) + "…" : (str ?? "");
const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const epStr = idx => `ep_${String(idx).padStart(6, "0")}`;
const lsBool = k => localStorage.getItem(k) === "1";
const lsFlag = (k, v) => localStorage.setItem(k, v ? "1" : "0");
const isoNow = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const setDisabled = (ids, disabled) => ids.forEach(id => { const e = el(id); if (e) e.disabled = disabled; });
const unslug = s => s.replace(/_/g, " ");
const camLabel = key => state.datasetConfig?.camera_labels?.[key] ?? unslug(key);
const dsSlug = () => (state.activeDataset ?? "").replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
const isSSHDataset = ds => typeof ds === "string" && ds.startsWith("__ssh_") && ds.endsWith("__");
const epPad = (idx = state.activeEpIndex) => String(idx).padStart(6, "0");
const apiDs = ds => `/api/datasets/${encodeURIComponent(ds)}`;
const hasActiveEp = () => !!(state.activeDataset && state.activeEpIndex != null);
const isKey = (e, ...keys) => keys.some(k => e.key === k || e.key === k.toUpperCase());
const isActivate = e => e.key === "Enter" || e.key === " ";
const boolStr = v => v ? "true" : "false";

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

async function apiPost(path, body, method = "POST") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const hasBody = method !== "DELETE" && method !== "GET";
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out");
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
  const h  = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(Math.floor(secs % 60)).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function escapeHTML(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
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
  const section = el("sidebar-recent");
  if (!section || !state.recentEpisodes.length) {
    hide(section);
    return;
  }
  show(section);
  const list = section.querySelector(".recent-list");
  if (!list) return;
  list.innerHTML = "";
  // Add clear button to header
  const header = section.querySelector(".recent-header");
  if (header && !header.querySelector(".recent-clear")) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
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
    attr(item, "role", "option");
    attr(item, "aria-label", `Recent: ${r.dsPath} episode ${r.epIndex}${r.taskText ? ` - ${r.taskText}` : ""}`);
    const epLabel = epStr(r.epIndex);
    const shortTask = truncate(r.taskText, 48);
    item.innerHTML =
      `<span class="recent-ep">${epLabel}</span>` +
      `<span class="recent-task">${escapeHTML(shortTask)}</span>`;
    item.title = `${r.dsPath} › ${epLabel}` + (r.taskText ? `\n${r.taskText}` : "");
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
      if (isActivate(e)) { e.preventDefault(); handleSelect(); }
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
  const dmBtn = el("dark-mode-btn");
  toggleSub("dark-mode-btn", ".icon-moon", "hidden", isDark);
  toggleSub("dark-mode-btn", ".icon-sun", "hidden", !isDark);
  attr(dmBtn, "aria-pressed", boolStr(isDark));
  if (save) {
    lsFlag("darkMode", isDark);
    if (state.episode) {
      buildCharts(state.episode);
      if (!isHidden("timedim-card")) buildTimeDimHeatmap(state.episode);
      if (!isHidden("corr-section")) buildCorrelationHeatmap(state.episode);
    }
  }
}

function toggleDarkMode() {
  applyDark(!document.documentElement.classList.contains("dark"));
}

/* ── Sidebar ─────────────────────────────────────────────── */
function toggleSidebar() {
  const collapsed = toggle("main", "sidebar-collapsed");
  attr("sidebar-toggle", "aria-pressed", boolStr(collapsed));
  lsFlag("sidebarCollapsed", collapsed);
}

function initSidebarState() {
  const stored = localStorage.getItem("sidebarCollapsed");
  const narrow = window.innerWidth < SIDEBAR_BREAKPOINT;
  // Auto-collapse on narrow viewports when no stored preference
  const shouldCollapse = stored === "1" || (stored === null && narrow);
  if (shouldCollapse) {
    el("main").classList.add("sidebar-collapsed");
    attr("sidebar-toggle", "aria-pressed", "true");
  }
}

/* ── URL hash state (bookmarkable links) ─────────────────── */
const _saveHashDebounced = debounce(_doSaveHash, 600);

function _doSaveHash() {
  if (!hasActiveEp()) return;
  const params = new URLSearchParams({
    ds: state.activeDataset,
    ep: state.activeEpIndex,
    f:  state.frame,
  });
  if (!state.normalizeEnabled) params.set("n", "0");  // only serialize when non-default
  if (state.speed !== 1.0) params.set("speed", state.speed);
  history.replaceState(null, "", "#" + params.toString());
}

const saveHashState = _saveHashDebounced;

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
    const tasks = await apiFetch(`${apiDs(ds)}/tasks`);

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
    if (!Number.isNaN(speedParam) && SPEEDS.includes(speedParam)) {
      state.speed = speedParam;
      el("speed-select").value = speedParam;
      localStorage.setItem("speed", speedParam);
    }
    // Restore normalize before loading so charts build with correct state
    const nParam = params.get("n");
    if (nParam !== null && (nParam === "1") !== state.normalizeEnabled) {
      state.normalizeEnabled = nParam === "1";
      _updateNormalizeButtonUI();
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

function _axisConf(cc, maxTicks, tickExtra = {}, gridExtra = {}, outer = {}) {
  return { ...outer, ticks: { maxTicksLimit: maxTicks, font: { size: CHART_FONT_SIZE }, color: cc.tick, ...tickExtra }, grid: { color: cc.grid, ...gridExtra }, border: { color: cc.border } };
}

function _ttConf(cc, extra = {}) {
  return { bodyFont: { size: 11 }, padding: 6, backgroundColor: cc.ttBg, borderColor: cc.ttBorder, borderWidth: 1, titleColor: cc.ttTitle, bodyColor: cc.ttBody, cornerRadius: 5, ...extra };
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
  updateAnnotationPanel();
  updateFrameJsonViewer();
  updateImages();
  // Drive 3D robot
  if (state.episode?.state?.[newF]) {
    RobotPanel.update(state.episode.state[newF].slice(0, 8));
  }
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
  toggle("task-label", "hidden", on);
  if (state.episode) toggle("ep-info-strip", "hidden", on);
  // Restore compare banner when turning off only if comparison is active
  if (on) hide("compare-banner");
  else if (state.compareEpisode) show("compare-banner");
  document.querySelectorAll(".cam-label").forEach(lbl => toggle(lbl, "hidden", on));
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
      tree.innerHTML = `<div class="empty-tree-msg">
        No datasets found in <code>./data/</code><br>
        <small>Create dataset folders with <code>meta/</code> and <code>data/</code> subdirectories</small>
      </div>`;
      updateSidebarFooter(0, 0);
      return;
    }
    tree.innerHTML = "";
    for (const ds of datasets) {
      const node = buildDatasetNode(ds);
      // Restore expansion state from localStorage
      const dsExpandKey = `ds-expand-${ds.path}`;
      if (lsBool(dsExpandKey)) {
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
    attr(errDiv, "role", "alert");
    errDiv.innerHTML =
      `Failed to load datasets<br>` +
      `<span class="error-msg-detail">${escapeHTML(msg)}</span>`;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.textContent = "Retry";
    retryBtn.className = "retry-btn-blue";
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
  let footer = el("sidebar-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "sidebar-footer";
    footer.className = "sidebar-footer";
    attr(footer, "role", "status");
    attr(footer, "aria-live", "polite");
    el("sidebar")?.appendChild(footer);
  }
  if (numDatasets > 0) {
    let knownFrames = 0, taskCount = 0;
    for (const d of datasets) {
      if (d.total_frames != null) knownFrames += d.total_frames;
      taskCount += d.total_tasks;
    }
    const framesHint = knownFrames > 0 ? ` · ${(knownFrames / 1e6).toFixed(1)}M f` : "";
    const taskHint = taskCount > 0 && taskCount > 1 ? ` · ${taskCount} tasks` : "";
    footer.textContent = `${numDatasets} dataset${numDatasets > 1 ? "s" : ""} · ${totalEps} ep${totalEps !== 1 ? "s" : ""}${taskHint}${framesHint}`;
    footer.title = datasets.map(d => `${d.name}: ${d.total_episodes} eps${d.total_frames != null ? ` · ${(d.total_frames / 1e6).toFixed(1)}M f` : ""}`).join("\n");
  } else {
    footer.textContent = "";
  }
  toggle(footer, "hidden", numDatasets === 0);
}

function buildDatasetNode(ds) {
  const node = document.createElement("div");
  node.className = "ds-node";
  attr(node, "role", "treeitem");
  attr(node, "aria-label", ds.name);
  const robotStr = ds.robot_type && ds.robot_type !== "unknown" ? ` • ${escapeHTML(ds.robot_type)}` : "";
  const metaTitle = `${escapeHTML(ds.name)}${robotStr} • ${ds.total_episodes} episodes • ${ds.fps} fps`;
  const subtitleParts = [`${ds.fps} fps`];
  if (ds.robot_type && ds.robot_type !== "unknown") subtitleParts.push(escapeHTML(ds.robot_type));
  if (ds.total_tasks > 1) subtitleParts.push(`${ds.total_tasks} tasks`);
  node.innerHTML = `
    <div class="ds-header" title="${metaTitle}">
      <svg class="ds-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <svg class="ds-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="ds-name">${escapeHTML(ds.name)}</span>
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
  attr(header, "role", "button");
  attr(header, "aria-expanded", "false");
  header.addEventListener("keydown", e => {
    if (isActivate(e)) { e.preventDefault(); header.click(); }
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
    attr(header, "aria-expanded", boolStr(!node.classList.contains("open")));
    const isOpening = !node.classList.contains("open");
    toggle(node, "open");
    // Persist dataset expansion state
    const dsExpandKey = `ds-expand-${ds.path}`;
    lsFlag(dsExpandKey, isOpening);
    if (!loaded) {
      loaded = true;
      try {
        const tasks = await apiFetch(`${apiDs(ds.path)}/tasks`);
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
        loaded = false;  // allow retry on next click
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
  if (lsBool(_tgKey)) group.classList.add("open");
  const shortTask = truncate(task.task, 72);
  group.dataset.task = task.task.toLowerCase();
  let minLen = Infinity, maxLen = -Infinity, totalFrames = 0;
  for (const ep of task.episodes) {
    const l = ep.length;
    if (l < minLen) minLen = l;
    if (l > maxLen) maxLen = l;
    totalFrames += l;
  }
  const n = task.episodes.length;
  if (!n) { minLen = 0; maxLen = 0; }
  const avgLen = n ? Math.round(totalFrames / n) : 0;
  const avgDur = formatDuration(avgLen / fps);
  const totalDur = formatDuration(totalFrames / fps);
  const statsTitle = `${task.task}\n\n${task.episodes.length} episodes · avg ${avgLen}f (${avgDur}) · min ${minLen}f · max ${maxLen}f\nTotal: ${totalFrames}f (${totalDur})`;

  group.innerHTML = `
    <div class="task-header" title="${escapeHTML(statsTitle).replace(/\n/g, '&#10;')}">
      <svg class="task-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="task-name">${escapeHTML(shortTask)}</span>
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
      <span>${epStr(ep.episode_index)}</span>
      <span class="ep-len ${cls}">${ep.length}f</span>`;

    const epPosInTask = epIdx + 1;
    const epTotalInTask = task.episodes.length;
    item.tabIndex = 0;
    attr(item, "role", "option");
    attr(item, "aria-selected", "false");
    attr(item, "aria-label", `Episode ${ep.episode_index}, ${ep.length} frames, ${epPosInTask} of ${epTotalInTask} in task`);
    item.dataset.length = ep.length;
    const epDurStr = formatDuration(ep.length / fps);
    item.title = `${epStr(ep.episode_index)} · ${ep.length}f · ${epDurStr} · ep ${epPosInTask}/${epTotalInTask} in task · double-click to play`;

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
      if (isActivate(e)) {
        e.preventDefault();
        handleActivate(e.ctrlKey || e.metaKey, false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const allItems = all(".ep-item:not(.ep-search-hidden):not(.search-hidden .ep-item)");
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
  attr(header, "role", "button");
  attr(header, "aria-expanded", boolStr(group.classList.contains("open")));
  header.addEventListener("click", () => {
    const open = toggle(group, "open");
    attr(header, "aria-expanded", boolStr(open));
    try { lsFlag(_tgKey, open); } catch (_) {}
  });
  header.addEventListener("keydown", e => {
    if (isActivate(e)) {
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
      if (!group.classList.contains("open")) header.click();
      group.querySelector(".ep-item:not(.ep-search-hidden)")?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (group.classList.contains("open")) header.click();
    }
  });
  return group;
}

/* ── Search / filter ─────────────────────────────────────── */
const applySearchDebounced = debounce(applySearch, SEARCH_DEBOUNCE_MS);

function highlightText(rawText, query) {
  const safe = escapeHTML(rawText);
  if (!query) return safe;
  return _applyHighlight(safe, query.toLowerCase());
}
function _applyHighlight(safe, queryLo) {
  const idx = safe.toLowerCase().indexOf(queryLo);
  if (idx === -1) return safe;
  return safe.slice(0, idx) +
    `<mark class="search-hl">${safe.slice(idx, idx + queryLo.length)}</mark>` +
    _applyHighlight(safe.slice(idx + queryLo.length), queryLo);
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
  toggle("search-clear", "hidden", !q);

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
      toggle(item, "ep-search-hidden", isHidden);
      if (!isHidden) anyEpMatch = true;
    }

    const groupVisible = taskMatches || anyEpMatch;
    const wasHidden = group.classList.contains("search-hidden");
    toggle(group, "search-hidden", !groupVisible);
    if (groupVisible && q && !group.classList.contains("open")) {
      group.classList.add("open");
    }

    const nameEl = group.querySelector(".task-name");
    if (nameEl) {
      const orig = group.dataset.taskOrig ?? (group.dataset.taskOrig = nameEl.textContent);
      nameEl.innerHTML = (textQ && taskMatches) ? highlightText(orig, textQ) : escapeHTML(orig);
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
  let countEl = el("search-count");
  if (!countEl) {
    countEl = document.createElement("div");
    countEl.id = "search-count";
    countEl.className = "search-count";
    attr(countEl, "aria-live", "polite");
    attr(countEl, "aria-atomic", "true");
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
  toggle(countEl, "hidden", !q);
}

/* ── Episode loading ─────────────────────────────────────── */
let _loadingEpKey = null;

async function selectEpisode(dsPath, epIndex, taskText, clickedEl) {
  const key = `${dsPath}::${epIndex}`;
  if (_loadingEpKey === key) return;
  _loadingEpKey = key;

  document.querySelectorAll(".ep-item.active").forEach(e => {
    e.classList.remove("active");
    attr(e, "aria-selected", "false");
  });
  if (clickedEl) {
    clickedEl.classList.add("active");
    attr(clickedEl, "aria-selected", "true");
    clickedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  stopPlayback();

  state.currentEpListIdx = state.episodeList.findIndex(
    e => e.dsPath === dsPath && e.epIndex === epIndex
  );

  if (dsPath !== state.activeDataset) {
    state.normStats = null;
    state.datasetConfig = {};
    try {
      state.normStats = await apiFetch(`${apiDs(dsPath)}/norm_stats`);
    } catch (_) {}
    try {
      state.datasetConfig = await apiFetch(`${apiDs(dsPath)}/config`);
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
  _tdimLayout = null;

  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) clearCompare();

  hide("welcome");
  const viewerEl = el("viewer");
  const taskLblEl = el("task-label");
  show(viewerEl);
  attr(viewerEl, "aria-busy", "true");
  show("viewer-loader");
  const displayTask = truncate(taskText, 80);
  taskLblEl.textContent = displayTask;
  taskLblEl.title = taskText?.length > 80 ? taskText : "";
  el("ep-info-strip").innerHTML = `<span class="spinner"></span><span class="text-muted"> Loading…</span>`;
  show("ep-info-strip");
  el("charts-area").classList.add("charts-loading");

  updatePrevNextButtons();

  let _sshDlPoller = null;
  if (isSSHDataset(dsPath)) {
    _sshDlPoller = setInterval(async () => {
      try {
        const st = await apiFetch(`/api/ssh/dl_status/${encodeURIComponent(dsPath)}/${epIndex}`, 5000);
        if (st.cached) { clearInterval(_sshDlPoller); _sshDlPoller = null; return; }
        if (st.status === "downloading" && st.total > 0) {
          const mb = v => (v / 1048576).toFixed(1);
          el("ep-info-strip").innerHTML =
            `<span class="spinner"></span>` +
            `<span class="text-muted"> Downloading from remote… ${mb(st.downloaded)} / ${mb(st.total)} MB</span>`;
        }
      } catch(_) {}
    }, 350);
  }

  try {
    const ep = await apiFetch(`${apiDs(dsPath)}/episodes/${epIndex}`);
    state.episode = ep;
    state.frame = 0;
    // Restore task text (replacing any prior error message markup)
    taskLblEl.textContent = displayTask;
    taskLblEl.title = taskText?.length > 80 ? taskText : "";
    toggle(taskLblEl, "hidden", _mirrorMode);
    updateEpInfoStrip(ep);
    if (_mirrorMode) hide("ep-info-strip");
    // Update normalize btn tooltip based on stats availability
    const hasNormStats = !!state.normStats;
    attr("btn-normalize", "title", hasNormStats
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
    // Initialise 3D robot at frame 0
    if (ep?.state?.[0]) RobotPanel.update(ep.state[0].slice(0, 8));
    updateTopbarBreadcrumb();
    saveHashState();
    addToRecent(dsPath, epIndex, taskText);
    const taskShort = truncate(taskText, 48);
    document.title = taskShort
      ? `${epStr(epIndex)} — ${taskShort} • LeRobot Visualizer`
      : `${epStr(epIndex)} • ${dsPath} • LeRobot Visualizer`;
    el("charts-area").classList.remove("charts-loading");
    hide("viewer-loader");
    attr(viewerEl, "aria-busy", "false");
    // Enable export buttons now that episode is loaded
    setDisabled(["btn-export", "btn-csv", "btn-frame-values", "btn-frame-json"], false);
    show("viewer-tabs");
    // Auto-open JSON viewer — respect user preference (null = first visit → open by default)
    const fjvPanel = el("frame-json-viewer");
    const fjvBtn   = el("btn-frame-json");
    const fjvPref = localStorage.getItem("fjvOpen");
    const fjvShouldOpen = fjvPref === null || fjvPref === "1"; // default open on first visit
    if (fjvPanel) fjvPanel.classList.toggle("hidden", !fjvShouldOpen);
    if (fjvBtn)   { fjvBtn.classList.toggle("active", fjvShouldOpen); fjvBtn.setAttribute("aria-pressed", boolStr(fjvShouldOpen)); }
    // Load annotation schema, per-episode annotation data, and fill config
    state.annotations = {};
    state.annotationDirty = false;
    _updateAnnotationDirtyIndicator();
    _loadFillConfig();
    clearTimeout(_fjvDebounce);   // cancel any in-flight fetch for old episode
    _fjvLastKey = null;           // invalidate so viewer refreshes for new episode
    _fjvExpanded = {};            // don't carry expanded state across episodes
    await Promise.all([
      loadAnnotationSchema(dsPath),
      loadAnnotationData(dsPath, epIndex),
    ]);
    // Re-apply current tab layout (rebuild annotation panel if in annotate tab)
    switchViewerTab(state.viewerTab);
  } catch (e) {
    hide("viewer-loader");
    attr(viewerEl, "aria-busy", "false");
    taskLblEl.innerHTML =
      `<span class="load-fail-label">Load failed:</span>` +
      `<span class="load-fail-msg">${escapeHTML(e.message)}</span>`;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.textContent = "Retry";
    retryBtn.className = "retry-btn-inline";
    retryBtn.addEventListener("click", () =>
      selectEpisode(dsPath, epIndex, taskText, document.querySelector(".ep-item.active"))
    );
    taskLblEl.appendChild(retryBtn);
    hide("ep-info-strip");
    el("charts-area").classList.remove("charts-loading");
    state.episode = null;
    RobotPanel.reset();
  } finally {
    if (_sshDlPoller !== null) { clearInterval(_sshDlPoller); _sshDlPoller = null; }
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

function _activateEpisodeEntry(entry) {
  entry.el?.closest(".task-group")?.classList.add("open");
  entry.el?.closest(".ds-node")?.classList.add("open");
  selectEpisode(entry.dsPath, entry.epIndex, entry.taskText, entry.el);
  requestAnimationFrame(() => entry.el?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
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
  _activateEpisodeEntry(list[idx]);
}

function prevEpisode() {
  const idx = state.currentEpListIdx;
  if (idx <= 0) return;
  _activateEpisodeEntry(state.episodeList[idx - 1]);
}

function nextEpisode() {
  const idx = state.currentEpListIdx;
  if (idx < 0 || idx >= state.episodeList.length - 1) return;
  _activateEpisodeEntry(state.episodeList[idx + 1]);
}

function updatePrevNextButtons() {
  const idx = state.currentEpListIdx;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < state.episodeList.length - 1;
  const prevBtn = el("btn-prev-ep");
  const nextBtn = el("btn-next-ep");
  prevBtn.disabled = !hasPrev;
  attr(prevBtn, "aria-disabled", !hasPrev);
  nextBtn.disabled = !hasNext;
  attr(nextBtn, "aria-disabled", !hasNext);
  const prev = hasPrev ? state.episodeList[idx - 1] : null;
  const next = hasNext ? state.episodeList[idx + 1] : null;
  prevBtn.title = prev ? `Previous episode: ${epStr(prev.epIndex)}  [` : "Previous episode  [";
  nextBtn.title = next ? `Next episode: ${epStr(next.epIndex)}  ]` : "Next episode  ]";
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
      `${apiDs(dsPath)}/episodes/${epIndex}`
    );
    buildCharts(state.episode);
    show("compare-banner");
    const cmpEp = state.compareEpisode;
    const cmpLastTs = cmpEp.timestamps?.[cmpEp.timestamps.length - 1] ?? null;
    const cmpDurStr = cmpLastTs !== null ? ` / ${formatDuration(cmpLastTs)}` : "";
    const cmpDs = dsPath !== state.activeDataset ? ` (${dsPath})` : "";
    const cmpTaskEp = state.episodeList.find(e => e.dsPath === dsPath && e.epIndex === epIndex);
    const cmpTaskStr = truncate(cmpTaskEp?.taskText, 36);
    const taskHint = cmpTaskStr ? ` · ${cmpTaskStr}` : "";
    const mainLen = state.episode?.length ?? cmpEp.length;
    const lenDiff = cmpEp.length - mainLen;
    const lenDiffStr = lenDiff !== 0 ? ` (${lenDiff > 0 ? "+" : ""}${lenDiff}f, ${lenDiff > 0 ? "+" : ""}${Math.round(lenDiff / mainLen * 100)}%)` : "";
    el("compare-label").textContent =
      `Comparing ${epStr(epIndex)}${cmpDs} — ${cmpEp.length}f${cmpDurStr}${lenDiffStr}${taskHint} — dashed overlay`;
    showCopyToast(`✓ Comparing ${epStr(epIndex)}`, "success");
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
  hide("compare-banner");
  if (state.episode) {
    buildCharts(state.episode);
    showCopyToast("✓ Comparison cleared", "success");
  }
}

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
        <small>Install opencv-python for video support</small>
      </div>`;
    } else if ((ep.image_keys?.length ?? 0) === 0) {
      cameras.innerHTML = `<div class="no-cam-notice">No camera data in this episode</div>`;
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

const CAM_PLACEHOLDER_HTML = `<div class="cam-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></div>`;

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
    apiFetch(`${apiDs(ds)}/episodes/${epIdx}/frame/${frameNo}`)
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
  show("cam-lightbox");
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
    hide(badge);
  } else {
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "lightbox-zoom-badge";
      badge.className = "lightbox-zoom-badge";
      el("cam-lightbox")?.appendChild(badge);
    }
    badge.textContent = `${_lbZoom.toFixed(1)}×`;
    show(badge);
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
  if (img) openLightbox(img.src, camLabel(keys[next]), next);
}

function renderFrameData(keys, frames) {
  keys.forEach((key, i) => {
    const slot = el(`cam-${i}`);
    if (!slot) return;
    slot.classList.remove("loading");
    const src = frames[key];
    if (!src) { resetCam(i); return; }

    const keyDisplay = camLabel(key);

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
    } else {
      const lbl = slot.querySelector(".cam-label");
      if (lbl) lbl.textContent = keyDisplay;
    }
    img.src = src;
    slot.tabIndex = 0;
    attr(slot, "role", "button");
    attr(slot, "aria-label", `Camera view: ${keyDisplay} — press Enter to expand`);
    slot.title = keyDisplay + " — click to expand · Ctrl+click to download · double-click for fullscreen · Enter to expand";

    if (!slot.dataset.camEventsSet) {
      slot.addEventListener("click", e => {
        const img = slot.querySelector("img");
        if (!img?.src) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const curKey = img.alt;
          _downloadDataURI(img.src, `${curKey}_ep${state.activeEpIndex}_f${state.frame}.jpg`);
          showCopyToast(`✓ Saved ${curKey} frame ${state.frame}`, "success");
        } else {
          openLightbox(img.src, camLabel(img.alt), i);
        }
      });

      slot.addEventListener("keydown", e => {
        if (isActivate(e)) {
          e.preventDefault();
          const img = slot.querySelector("img");
          if (img?.src) openLightbox(img.src, camLabel(img.alt), i);
        }
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
  if (!isHidden("cam-lightbox")) {
    const lbl = el("lightbox-label");
    if (lbl && state.episode) {
      const camIdx = parseInt(el("cam-lightbox").dataset.camIdx ?? "-1", 10);
      const key = camIdx >= 0 ? keys[camIdx] : null;
      const ts = state.episode.timestamps?.[state.frame];
      const tsStr = ts != null
        ? ` · ${ts >= 60 ? formatDuration(ts) : ts.toFixed(3) + "s"}  (f${state.frame})`
        : ` (f${state.frame})`;
      if (key) lbl.textContent = camLabel(key) + tsStr;
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
        `${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${f}`,
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
          `ep_${epPad()}  frame ${state.frame}`,
          canvas.width - 8, H + FULLSCREEN_LABEL_HEIGHT - 10
        );
        canvas.toBlob(blob => {
          if (!blob) { showCopyToast("Export failed: could not create image", "error"); return; }
          const objectURL = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = objectURL;
          const dlName = `${dsSlug()}__ep${epPad()}_f${String(state.frame).padStart(4,"0")}.png`;
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
  const fname = `${dsSlug()}__ep${epPad()}.json`;
  _downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), fname);
  showCopyToast("✓ JSON exported", "success");
}

/* ── Export episode timestamps ───────────────────────────– */
function exportTimestamps() {
  const ep = state.episode;
  if (!ep?.timestamps?.length) return;
  const lines = ep.timestamps.map((t, i) => `${i}\t${t.toFixed(6)}`);
  _downloadBlob(
    new Blob([lines.join("\n")], { type: "text/plain" }),
    `${state.activeDataset}__ep${epPad()}_timestamps.txt`
  );
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

  const fname = `${dsSlug()}__ep${epPad()}.csv`;
  _downloadBlob(new Blob([lines.join("\n")], { type: "text/csv" }), fname);
  showCopyToast(`✓ Exported ${fname}`, "success");
}

/* ── Copy episode URL to clipboard ───────────────────────── */
async function copyEpisodeURL() {
  if (!hasActiveEp()) return;
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
    inp.className = "offscreen-input";
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
    inp.className = "offscreen-input";
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
    ? `_${state.activeDataset || "dataset"}_ep${epPad(state.activeEpIndex ?? 0)}`
    : "";
  const ts = isoNow();

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
  const ts = isoNow();
  const fname = `lerobot_corr_${state.activeDataset || "dataset"}_ep${state.activeEpIndex ?? 0}_${ts}.png`;
  _exportCanvasPNG(canvas, fname);
  showCopyToast(`✓ Downloaded ${fname.split("/").pop()}`, "success");
}

function downloadTimedim() {
  const canvas = el("timedim-canvas");
  if (!canvas) { showCopyToast("Show the action heatmap first", "error"); return; }
  const ts = isoNow();
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

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  _downloadDataURI(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showCopyToast(msg = "Copied to clipboard", type = "info") {
  let toast = el("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.className = "copy-toast";
    attr(toast, "role", "status");
    attr(toast, "aria-live", "polite");
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

/* ── Δ State Norm chart ──────────────────────────────────── */

// Returns Float32Array of length T: norm[t] = ‖state[t+1] − state[t]‖₂
// Last frame is always 0 (no t+1 available).
function computeDeltaNorm(stateData) {
  const T = stateData.length;
  const out = new Float32Array(T);
  for (let t = 0; t < T - 1; t++) {
    const a = stateData[t], b = stateData[t + 1];
    let sq = 0;
    for (let d = 0; d < a.length; d++) { const diff = b[d] - a[d]; sq += diff * diff; }
    out[t] = Math.sqrt(sq);
  }
  return out;
}

function buildDeltaNormChart(ep) {
  const body = el("chart-body-delta");
  if (!body) return [];
  (state.deltaCharts ?? []).forEach(c => c?.destroy());

  if (!ep.state?.length) {
    body.innerHTML = `<div class="chart-no-data">No state data</div>`;
    return [];
  }

  const norms  = computeDeltaNorm(ep.state);  // Float32Array [T]
  const T      = norms.length;
  const labels = Array.from({ length: T }, (_, i) => i);
  // Wrap as 2D [T][1] so makeChart can handle it uniformly
  const data2d = Array.from(norms, v => [v]);

  body.innerHTML = `<div class="chart-wrap"><canvas id="delta-chart"></canvas></div>`;
  const chart = makeChart("delta-chart", labels, data2d, ["‖Δstate‖₂"], false, 1, 0, null, null);
  if (chart) {
    // Override dataset color to amber so it's visually distinct from state/action
    chart.data.datasets[0].borderColor = "rgb(245,158,11)";
    chart.update("none");
  }

  // Download button
  const dlBtn = el("dl-delta");
  if (dlBtn) {
    dlBtn.onclick = () => {
      if (!chart) return;
      const a = document.createElement("a");
      a.download = `delta_norm_ep${String(state.activeEpIndex ?? 0).padStart(6,"0")}.png`;
      a.href = chart.toBase64Image();
      a.click();
    };
  }

  return chart ? [chart] : [];
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
  state.deltaCharts  = buildDeltaNormChart(ep);
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

function _updateNormalizeButtonUI() {
  const btn = el("btn-normalize");
  if (!btn) return;
  toggle(btn, "active", state.normalizeEnabled);
  attr(btn, "aria-pressed", boolStr(state.normalizeEnabled));
}

function toggleNormalize() {
  state.normalizeEnabled = !state.normalizeEnabled;
  lsFlag("normalize", state.normalizeEnabled);
  _updateNormalizeButtonUI();
  if (state.episode) {
    buildCharts(state.episode);
    updateFrameValues();
    saveHashState();
  }
}

function toggleExpand(type) {
  state[`${type}Expanded`] = !state[`${type}Expanded`];
  lsFlag(`expand_${type}`, state[`${type}Expanded`]);
  rebuildChartsFor(type);
}

function toggleHistogram(type) {
  const key = `hist${capitalize(type)}`;
  state[key] = !state[key];
  lsFlag(`hist_${type}`, state[key]);
  rebuildChartsFor(type);
}

function toggleLooping() {
  state.looping = !state.looping;
  toggle("btn-loop", "active", state.looping);
  attr("btn-loop", "aria-pressed", boolStr(state.looping));
  lsFlag("loop", state.looping);
}

function buildChartCard(type, data2d, names, normalized, ep, cmpData2d = null, normBand = null) {
  const expanded = state[`${type}Expanded`];
  const isHist   = state[`hist${capitalize(type)}`];
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
      capitalize(type) +
      `<span class="chart-title-sub">(${dims}D)</span>` +
      (badge ? " " + badge : "");
  }

  toggle(btn, "active", expanded);
  toggleSub(btn, ".icon-expand", "hidden", expanded);
  toggleSub(btn, ".icon-collapse", "hidden", !expanded);
  toggle(histBtn, "active", isHist);

  if (dims === 0) {
    body.innerHTML = `<div class="chart-no-data">No ${type} data</div>`;
    return [];
  }

  if (expanded && dims > 64) {
    body.innerHTML = `<div class="chart-no-data">${dims}D — too many to split (max 64). Use the combined view.</div>`;
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
      const legendItems = [];
      const setAllVisible = () => {
        for (let i = 0; i < dims; i++) {
          const m = mainChart?.getDatasetMeta(i);
          if (m) m.hidden = false;
        }
        legendItems.forEach(li => li.classList.remove("legend-hidden"));
        mainChart?.update("none");
      };
      for (let d = 0; d < dims; d++) {
        const item = document.createElement("span");
        item.className = "legend-item";
        item.title = `Click to show/hide · ${MOD_KEY}+click to isolate · dbl-click to show all`;
        item.dataset.dim = d;
        item.innerHTML = `<span class="legend-dot" style="background:${PALETTE[d % PALETTE.length]}"></span>${escapeHTML(names[d] ?? `dim_${d}`)}`;
        item.addEventListener("click", e => {
          if (!mainChart) return;
          if (e.ctrlKey || e.metaKey) {
            // Isolate: hide all except this one
            for (let i = 0; i < dims; i++) {
              const m = mainChart.getDatasetMeta(i);
              if (m) m.hidden = i !== d;
            }
            legendItems.forEach((li, i) => toggle(li, "legend-hidden", i !== d));
          } else {
            const meta = mainChart.getDatasetMeta(d);
            meta.hidden = !meta.hidden;
            toggle(item, "legend-hidden", !!meta.hidden);
          }
          mainChart.update("none");
        });
        item.addEventListener("dblclick", setAllVisible);
        legendItems.push(item);
        legendDiv.appendChild(item);
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
    ? _axisConf(cc, isMini ? 3 : 5, { callback: v => v.toFixed(1) }, {}, { min: -1.05, max: 1.05 })
    : _axisConf(cc, isMini ? 3 : 5, { callback: fmtAxisTick });

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
          ..._ttConf(cc, { titleFont: { size: 11, weight: "600" } }),
        },
        cursor: {}, stdBand: {},
      },
      scales: {
        x: _axisConf(cc, isMini ? 4 : 8),
        y: yConfig,
      },
    },
  });

  attr(canvas, "role", "img");
  attr(canvas, "aria-label", isMini
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
          labels: { font: { size: CHART_FONT_SIZE }, boxWidth: 10, padding: 6, color: cc.tick } },
        tooltip: {
          callbacks: {
            title: items => `≈${fmtAxisTick(parseFloat(items[0].label))}`,
            label: item => ` ${item.dataset.label}: ${item.raw}`,
          },
          ..._ttConf(cc),
        },
      },
      scales: {
        x: _axisConf(cc, 6, { callback: v => fmtAxisTick(parseFloat(datasets[0]._edges[v] ?? v)) }, { display: false }),
        y: _axisConf(cc, 4),
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
  // Use pre-filtered visible charts array (updated in IntersectionObserver callback)
  const toUpdate = _chartIntersectObs !== null ? _visibleChartsArr : _allChartsCache;
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
  if (!ep?.actions?.length) { hide(section); return; }

  const dims = ep.actions[0].length;
  if (dims < 2) { hide(section); return; }

  // Defer render until expanded (avoids computing Pearson on every episode switch)
  if (body.classList.contains("corr-collapsed")) {
    show(section);
    body.innerHTML = "";
    return;
  }

  const cols = Array.from({ length: dims }, (_, d) => ep.actions.map(r => r[d]));
  const rawNames = ep.action_names ?? [];
  const rawLabels = Array.from({ length: dims }, (_, d) => rawNames[d] ?? `a${d}`);
  const labels = rawLabels.map(n => truncate(n, 7));

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
  canvas.style.width = W + "px";
  canvas.style.height = H_TOTAL + "px";
  attr(canvas, "role", "img");
  attr(canvas, "aria-label", `Action correlation matrix (${dims}×${dims})`);
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
        `r = ${r.toFixed(4)} <span class="text-muted">(${strength} ${dir})</span>`);
    } else {
      hideTimeDimTooltip();
    }
  });
  canvas.addEventListener("mouseleave", hideTimeDimTooltip);

  show(section);
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

// Cell height adapts: 18px for ≤20 dims, 12px for ≤40, 8px for more
function timedimCellH(dims) {
  if (dims <= 20) return 18;
  if (dims <= 40) return 12;
  return 8;
}

function buildTimeDimHeatmap(ep) {
  const card = el("timedim-card");
  const body = el("timedim-body");
  if (!card || !body) return;

  if (!ep?.actions?.length || ep.actions[0].length < 1) {
    hide(card);
    _tdimLayout = null;
    return;
  }

  // Defer render until expanded (avoids heavy canvas work on every episode switch)
  if (body.classList.contains("timedim-collapsed")) {
    show(card);
    body.innerHTML = "";
    _tdimLayout = null;
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
    return truncate(n, 9);
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

  const CANVAS_W  = Math.min(frames, TIMEDIM_MAX_CANVAS_W);
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
  canvas.style.width = TOTAL_W + "px";
  canvas.style.height = TOTAL_H + "px";
  canvas.id = "timedim-canvas";
  attr(canvas, "role", "img");
  attr(canvas, "aria-label", `Action heatmap: time × ${dims} dimensions`);
  attr(canvas, "tabindex", "0");
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
    return { f: clamp(Math.floor(px / cellW), 0, frames - 1), px };
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
        `<b>${labels[d]}</b>  ${val}<br><span class="text-muted">frame ${f}${tsStr}</span>`);
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
    legend.className = "timedim-legend";
    // Draw gradient swatch using a small canvas
    const swatch = document.createElement("canvas");
    swatch.width = 80; swatch.height = 8;
    swatch.className = "timedim-swatch";
    const sc = swatch.getContext("2d");
    for (let x = 0; x < 80; x++) {
      sc.fillStyle = _heatmapColor(x / 79);
      sc.fillRect(x, 0, 1, 8);
    }
    const spanLow = document.createElement("span");
    spanLow.textContent = "low";
    legend.appendChild(spanLow);
    legend.appendChild(swatch);
    const spanHigh = document.createElement("span");
    spanHigh.textContent = "high (per dim)";
    legend.appendChild(spanHigh);
    body.appendChild(legend);
  }

  if (truncated) {
    const note = document.createElement("div");
    note.className = "timedim-note";
    note.textContent = `Showing first ${TIMEDIM_MAX_DIMS} of ${dimsRaw} dimensions`;
    body.appendChild(note);
  }

  // Cache layout for _doUpdateTimeDimCursor to avoid recomputation
  _tdimLayout = { CELL_H, frames, cellW, CANVAS_W, TOTAL_W, CANVAS_H, TIME_AX_H: TIME_AX_H };

  show(card);
  if (!card.dataset.open) body.classList.add("timedim-collapsed");
}

let _timeDimRafPending = false;
let _lastTimeDimFrame = -1;
let _tdimLayout = null;  // cache layout values from buildTimeDimHeatmap

function updateTimeDimCursor() {
  if (_timeDimRafPending || _lastTimeDimFrame === state.frame) return;
  _timeDimRafPending = true;
  requestAnimationFrame(_doUpdateTimeDimCursor);
}

function _doUpdateTimeDimCursor() {
  _timeDimRafPending = false;
  const canvas = el("timedim-canvas");
  if (!canvas || !state.episode || !_tdimLayout) return;
  _lastTimeDimFrame = state.frame;

  const { CELL_H, frames, cellW, CANVAS_W, TOTAL_W, CANVAS_H, TIME_AX_H } = _tdimLayout;
  const TOTAL_H = CANVAS_H + TIME_AX_H;
  const cursorX = TIMEDIM_LABEL_W + state.frame * cellW;

  // Overlay canvas: only covers the heatmap rows (not the time axis)
  let overlay = el("timedim-overlay");
  if (!overlay) {
    const dpr2 = window.devicePixelRatio || 1;
    overlay = document.createElement("canvas");
    overlay.id = "timedim-overlay";
    overlay.width  = TOTAL_W * dpr2;
    overlay.height = CANVAS_H * dpr2;
    overlay.style.width = TOTAL_W + "px";
    overlay.style.height = CANVAS_H + "px";
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
  if (!hasActiveEp()) {
    crumb.textContent = "";
    hide(crumb);
    return;
  }
  const epLabel = epStr(state.activeEpIndex);
  const dsShort = state.activeDataset.length > 24
    ? state.activeDataset.slice(0, 21) + "…"
    : state.activeDataset;
  const ep = state.episode;
  const frameStr = ep ? `<span class="crumb-sep">·</span><span class="crumb-frame">${state.frame} / ${ep.length - 1}</span>` : "";
  crumb.innerHTML =
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ds" title="${escapeHTML(state.activeDataset)}">${escapeHTML(dsShort)}</span>` +
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb-ep" title="Click to copy URL  (C)">${epLabel}</span>` +
    frameStr;
  show(crumb);
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
  counter.addEventListener("keydown", e => {
    if (isActivate(e)) { e.preventDefault(); counter.click(); }
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
      _jumpCancelled = true;  // prevent double-fire from blur triggered by replaceWith
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
        if (Number.isNaN(parsed)) { input.replaceWith(counter); return; }
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
  lsFlag("fvSort", _fvSortActive);
  const btn = el("fv-sort-btn");
  if (btn) {
    toggle(btn, "active", _fvSortActive);
    btn.title = _fvSortActive ? "Sort by |value| (click to restore order)" : "Sort by absolute value";
  }
  updateFrameValues();
}

/* ── Frame values panel toggle ───────────────────────────── */
function toggleFrameValuesPanel() {
  const panel = el("frame-values-panel");
  if (!panel) return;
  const hidden = toggle(panel, "fv-collapsed");
  toggle("btn-frame-values", "active", !hidden);
  attr("btn-frame-values", "aria-pressed", boolStr(!hidden));
}

/* ── Viewer tab switching ─────────────────────────────────── */

function switchViewerTab(tab) {
  if (!state.episode) return;
  state.viewerTab = tab;

  // Update tab button states
  document.querySelectorAll(".viewer-tab").forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    attr(btn, "aria-selected", boolStr(isActive));
  });

  const inAnnotate = tab === "annotate";
  // Hide video-only sections in annotate tab; restore their previous visibility when returning
  ["charts-area", "corr-section", "timedim-card", "frame-values-panel"].forEach(id => {
    const node = el(id);
    if (!node) return;
    if (inAnnotate) {
      node.dataset.tabHidden = node.classList.contains("hidden") ? "1" : "0";
      node.classList.add("hidden");
    } else if ("tabHidden" in node.dataset) {
      // Only restore when we've previously stashed the state (came from annotate tab)
      node.classList.toggle("hidden", node.dataset.tabHidden === "1");
    }
  });

  // Annotation panel only visible in annotate tab
  const panel = el("annotation-panel");
  if (panel) {
    panel.classList.toggle("hidden", !inAnnotate);
    if (inAnnotate) buildAnnotationPanel();
  }
}

/* ── Annotation panel ────────────────────────────────────── */

const _annSaveTimers = {};   // per-frame debounce: {frameIndex: timerId}
let _annActiveTab = "annotate"; // "schema" | "annotate"
let _annChipInputs = null;      // {fieldName: {input, chip, ftype}} — built once, reused across frames
let _annTimelineMove = null;    // document mousemove handler for seek (cleaned up on rebuild)
let _annTimelineUp = null;      // document mouseup handler for seek
let _annSettingsOpen = false;   // whether the fill-settings popover is visible
let _annTimelineRO = null;      // ResizeObserver watching the timeline canvas

function toggleAnnotationPanel() {
  switchViewerTab(state.viewerTab === "annotate" ? "video" : "annotate");
}

async function loadAnnotationSchema(dataset) {
  try {
    const data = await apiFetch(`${apiDs(dataset)}/annotation_schema`);
    state.annotationSchema = Array.isArray(data) ? data : [];
  } catch (_) {
    state.annotationSchema = [];
  }
}

async function loadAnnotationData(dataset, epIndex) {
  try {
    const data = await apiFetch(`${apiDs(dataset)}/episodes/${epIndex}/annotations`);
    state.annotations = data?.frames ?? {};
    state.annotationDirty = false;
    _updateAnnotationDirtyIndicator();
  } catch (_) {
    state.annotations = {};
    state.annotationDirty = false;
    _updateAnnotationDirtyIndicator();
  }
}

// ── Fill config (persisted in localStorage) ───────────────────────────────────

function _fillCfgKey() {
  return `lrv_fill_cfg_${state.activeDataset ?? ""}`;
}

function _updateAnnotationDirtyIndicator() {
  const tab = el("vtab-annotate");
  if (tab) tab.classList.toggle("ann-dirty", !!state.annotationDirty);
}

function _loadFillConfig() {
  try {
    const raw = localStorage.getItem(_fillCfgKey());
    state.annFillConfig = raw ? JSON.parse(raw) : {};
  } catch (_) {
    state.annFillConfig = {};
  }
}

function _saveFillConfig() {
  try { localStorage.setItem(_fillCfgKey(), JSON.stringify(state.annFillConfig)); } catch (_) {}
}

// Compute filled annotation frames — applies fill strategy per field to all frames
function _computeFilledAnnotations() {
  const total = state.episode?.length ?? 0;
  if (total === 0) return {};

  // Deep-copy existing annotations
  const result = {};
  for (const [k, v] of Object.entries(state.annotations)) {
    result[k] = { ...v };
  }

  state.annotationSchema.forEach(field => {
    const cfg = state.annFillConfig[field.name] ?? { strategy: "none" };
    if (cfg.strategy === "none") return;

    if (cfg.strategy === "fixed") {
      let fixedVal;
      const rawFixed = cfg.fixedValue ?? "";
      if (field.type === "number") {
        fixedVal = rawFixed === "" ? null : parseFloat(rawFixed);
      } else if (field.type === "boolean") {
        fixedVal = rawFixed === "true" || rawFixed === true;
      } else {
        fixedVal = rawFixed === "" ? null : rawFixed;
      }
      if (fixedVal === null || fixedVal === undefined) return;
      for (let f = 0; f < total; f++) {
        const key = String(f);
        if (result[key]?.[field.name] !== undefined) continue;
        if (!result[key]) result[key] = {};
        result[key][field.name] = fixedVal;
      }
      return;
    }

    if (cfg.strategy === "prev") {
      let lastVal;
      for (let f = 0; f < total; f++) {
        const key = String(f);
        const cur = result[key]?.[field.name];
        if (cur !== undefined && cur !== null && cur !== "") {
          lastVal = cur;
        } else if (lastVal !== undefined) {
          if (!result[key]) result[key] = {};
          result[key][field.name] = lastVal;
        }
      }
      return;
    }

    if (cfg.strategy === "linear" && field.type === "number") {
      // Collect sorted annotated keyframes for this field
      const kf = [];
      for (let f = 0; f < total; f++) {
        const v = result[String(f)]?.[field.name];
        if (v !== undefined && v !== null && v !== "") kf.push({ f, v: parseFloat(v) });
      }
      if (kf.length === 0) return;
      // O(n) two-pointer: ni tracks the first keyframe index with .f > current frame
      let ni = 0;
      for (let f = 0; f < total; f++) {
        while (ni < kf.length && kf[ni].f <= f) ni++;
        const key = String(f);
        if (result[key]?.[field.name] !== undefined) continue;
        const prevKf = ni > 0 ? kf[ni - 1] : null;
        const nextKf = ni < kf.length ? kf[ni] : null;
        let interp = null;
        if (prevKf && nextKf) {
          interp = prevKf.v + (nextKf.v - prevKf.v) * (f - prevKf.f) / (nextKf.f - prevKf.f);
        } else if (prevKf) {
          interp = prevKf.v;
        } else if (nextKf) {
          interp = nextKf.v;
        }
        if (interp !== null) {
          if (!result[key]) result[key] = {};
          result[key][field.name] = interp;
        }
      }
    }
  });

  return result;
}

// Returns {incomplete, complete} — fields split by whether all episode frames have a value
function _splitFieldsByCompletion() {
  const total = state.episode?.length ?? 0;
  const incomplete = [], complete = [];
  if (total === 0 || state.annotationSchema.length === 0) {
    return { incomplete: [...state.annotationSchema], complete: [] };
  }
  state.annotationSchema.forEach(field => {
    let filled = 0;
    for (let f = 0; f < total; f++) {
      const fd = state.annotations[String(f)];
      const v = fd?.[field.name];
      if (v !== undefined && v !== null && v !== "") filled++;
    }
    (filled === total ? complete : incomplete).push(field);
  });
  return { incomplete, complete };
}

// ── Build annotation panel ─────────────────────────────────────────────────────

function buildAnnotationPanel() {
  const panel = el("annotation-panel");
  if (!panel) return;
  _annChipInputs = null;  // force DOM rebuild
  if (_annTimelineRO) { _annTimelineRO.disconnect(); _annTimelineRO = null; }
  if (_annTimelineMove) { document.removeEventListener("mousemove", _annTimelineMove); _annTimelineMove = null; }
  if (_annTimelineUp)   { document.removeEventListener("mouseup",   _annTimelineUp);   _annTimelineUp   = null; }
  const ttOld = document.getElementById("ann-timeline-tt");
  if (ttOld) ttOld.style.display = "none";
  panel.innerHTML = "";

  // Header
  const hdr = document.createElement("div");
  hdr.className = "ann-panel-header";
  const { incomplete: _incTab, complete: _comTab } = _splitFieldsByCompletion();
  const _incBadge = _incTab.length  ? ` <span class="ann-tab-badge">${_incTab.length}</span>`  : "";
  const _comBadge = _comTab.length  ? ` <span class="ann-tab-badge ann-tab-badge-green">${_comTab.length}</span>` : "";
  hdr.innerHTML =
    `<span class="ann-panel-title">Annotation</span>` +
    `<div class="ann-tab-bar">` +
      `<button class="ann-tab${_annActiveTab === "annotate"  ? " active" : ""}" data-tab="annotate"  type="button">Annotate${_incBadge}</button>` +
      `<button class="ann-tab${_annActiveTab === "annotated" ? " active" : ""}" data-tab="annotated" type="button">Annotated${_comBadge}</button>` +
      `<button class="ann-tab${_annActiveTab === "schema"    ? " active" : ""}" data-tab="schema"    type="button">Schema</button>` +
      `<button class="ann-tab${_annActiveTab === "saved"     ? " active" : ""}" data-tab="saved"     type="button">Saved</button>` +
    `</div>` +
    `<button class="ann-settings-btn${_annSettingsOpen ? " active" : ""}" type="button" id="ann-settings-btn" title="Fill defaults for unannotated frames" aria-label="Annotation fill settings" aria-pressed="${_annSettingsOpen}">` +
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<circle cx="12" cy="12" r="3"/>` +
        `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>` +
      `</svg>` +
    `</button>`;
  panel.appendChild(hdr);
  hdr.querySelectorAll(".ann-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      _annActiveTab = btn.dataset.tab;
      try { localStorage.setItem("annActiveTab", btn.dataset.tab); } catch (_) {}
      buildAnnotationPanel();
    });
  });

  // Settings panel (collapsible, between header and body)
  const settingsDiv = document.createElement("div");
  settingsDiv.id = "ann-settings-panel";
  settingsDiv.className = "ann-settings-panel" + (_annSettingsOpen ? " open" : "");
  _buildSettingsPanel(settingsDiv);
  panel.appendChild(settingsDiv);

  hdr.querySelector("#ann-settings-btn").addEventListener("click", () => {
    _annSettingsOpen = !_annSettingsOpen;
    settingsDiv.classList.toggle("open", _annSettingsOpen);
    const btn = hdr.querySelector("#ann-settings-btn");
    btn.classList.toggle("active", _annSettingsOpen);
    btn.setAttribute("aria-pressed", String(_annSettingsOpen));
  });

  // Body
  const body = document.createElement("div");
  body.className = "ann-body";
  panel.appendChild(body);

  if (_annActiveTab === "schema") {
    _buildSchemaSection(body);
  } else if (_annActiveTab === "saved") {
    _buildSavedSection(body);
  } else if (_annActiveTab === "annotated") {
    _buildAnnotatedSection(body);
  } else {
    _buildAnnotateSection(body);
  }
}

function _buildSettingsPanel(container) {
  container.innerHTML = "";

  if (state.annotationSchema.length === 0) {
    container.innerHTML = `<div class="ann-settings-empty">Define annotation fields in the Schema tab first.</div>`;
    return;
  }

  const rows = document.createElement("div");
  rows.className = "ann-settings-rows";

  state.annotationSchema.forEach(field => {
    const cfg = state.annFillConfig[field.name] ?? { strategy: "none", fixedValue: "" };
    const canInterp = field.type === "number";

    const strategies = [
      { v: "none",   label: "None (leave null)" },
      { v: "fixed",  label: "Fixed value" },
      { v: "prev",   label: "Forward fill" },
      ...(canInterp ? [{ v: "linear", label: "Linear interp" }] : []),
    ];

    const row = document.createElement("div");
    row.className = "ann-settings-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "ann-settings-field-name";
    nameSpan.textContent = field.name;

    const typeTag = document.createElement("span");
    typeTag.className = "ann-settings-field-type";
    typeTag.textContent = field.type;

    const stratSel = document.createElement("select");
    stratSel.className = "ann-settings-strategy";
    strategies.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.v;
      opt.textContent = s.label;
      if (cfg.strategy === s.v) opt.selected = true;
      stratSel.appendChild(opt);
    });

    // Fixed-value input — shown only when strategy = "fixed"
    const fixedWrap = document.createElement("span");
    fixedWrap.className = "ann-settings-fixed-wrap";
    fixedWrap.style.display = cfg.strategy === "fixed" ? "" : "none";
    fixedWrap.appendChild(_buildFixedInput(field, cfg.fixedValue ?? ""));

    stratSel.addEventListener("change", () => {
      const s = stratSel.value;
      fixedWrap.style.display = s === "fixed" ? "" : "none";
      state.annFillConfig[field.name] = { ...(state.annFillConfig[field.name] ?? {}), strategy: s };
      _saveFillConfig();
    });

    const fixedInput = fixedWrap.querySelector("[data-fixed-input]");
    if (fixedInput) {
      const persist = () => {
        state.annFillConfig[field.name] = {
          ...(state.annFillConfig[field.name] ?? {}),
          fixedValue: fixedInput.type === "checkbox" ? String(fixedInput.checked) : fixedInput.value,
        };
        _saveFillConfig();
      };
      fixedInput.addEventListener("input", persist);
      fixedInput.addEventListener("change", persist);
    }

    row.appendChild(nameSpan);
    row.appendChild(typeTag);
    row.appendChild(stratSel);
    row.appendChild(fixedWrap);
    rows.appendChild(row);
  });

  container.appendChild(rows);

  const note = document.createElement("p");
  note.className = "ann-settings-note";
  note.textContent = "Applied to unannotated frames when committing. Linear interp only available for number fields.";
  container.appendChild(note);
}

function _buildFixedInput(field, currentValue) {
  if (field.type === "boolean") {
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = currentValue === "true" || currentValue === true;
    chk.dataset.fixedInput = "1";
    chk.title = "Fixed boolean value";
    return chk;
  }
  if (field.type === "category") {
    const sel = document.createElement("select");
    sel.dataset.fixedInput = "1";
    sel.className = "ann-settings-fixed-sel";
    (field.options ?? []).forEach(o => {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      if (currentValue === o) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }
  // number or string
  const inp = document.createElement("input");
  inp.type = field.type === "number" ? "number" : "text";
  inp.step = "any";
  inp.value = currentValue ?? "";
  inp.className = "ann-settings-fixed-inp";
  inp.dataset.fixedInput = "1";
  inp.placeholder = field.type === "number" ? "0" : "value";
  return inp;
}

function _buildSavedSection(body) {
  const sec = document.createElement("div");
  sec.className = "ann-saved-section";
  body.appendChild(sec);

  const refresh = () => {
    sec.innerHTML = `<div class="ann-saved-loading">Loading saved annotations…</div>`;
    apiFetch(`${apiDs(state.activeDataset)}/annotations`)
      .then(list => _renderSavedList(sec, list, refresh))
      .catch(() => {
        sec.innerHTML = `<div class="ann-saved-empty">Failed to load saved annotations.</div>`;
      });
  };
  refresh();
}

function _renderSavedList(container, list, refresh) {
  container.innerHTML = "";

  // Header row with refresh button
  const topBar = document.createElement("div");
  topBar.className = "ann-saved-topbar";
  const countLabel = document.createElement("span");
  countLabel.className = "ann-saved-count";
  countLabel.textContent = list?.length
    ? `${list.length} saved draft${list.length !== 1 ? "s" : ""}`
    : "No saved drafts";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ann-saved-refresh-btn";
  refreshBtn.title = "Refresh list";
  refreshBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
  refreshBtn.addEventListener("click", () => refresh?.());
  topBar.appendChild(countLabel);
  topBar.appendChild(refreshBtn);
  container.appendChild(topBar);

  if (!list || list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ann-saved-empty";
    empty.textContent = "No saved annotation drafts for this dataset.";
    container.appendChild(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "ann-saved-header";
  header.innerHTML =
    `<span class="ann-saved-col-ep">Episode</span>` +
    `<span class="ann-saved-col-frames">Frames</span>` +
    `<span class="ann-saved-col-fields">Fields</span>` +
    `<span class="ann-saved-col-actions"></span>`;
  container.appendChild(header);

  const rows = document.createElement("div");
  rows.className = "ann-saved-rows";

  list.forEach(item => {
    const isCurrent = item.episode_index === state.activeEpIndex;
    const row = document.createElement("div");
    row.className = "ann-saved-row" + (isCurrent ? " current" : "");
    row.dataset.epIndex = item.episode_index;
    row.title = `Click to view episode ${item.episode_index}`;

    // Click anywhere on the row (except action buttons) to navigate
    row.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      selectEpisode(state.activeDataset, item.episode_index, null, null);
    });

    const epSpan = document.createElement("span");
    epSpan.className = "ann-saved-col-ep";
    epSpan.textContent = `ep ${item.episode_index}`;
    if (isCurrent) {
      const badge = document.createElement("span");
      badge.className = "ann-saved-current-badge";
      badge.textContent = "current";
      epSpan.appendChild(badge);
    }

    const framesSpan = document.createElement("span");
    framesSpan.className = "ann-saved-col-frames";
    framesSpan.textContent = item.frame_count;

    const fieldsSpan = document.createElement("span");
    fieldsSpan.className = "ann-saved-col-fields";
    fieldsSpan.textContent = (item.field_names ?? []).join(", ") || "—";
    fieldsSpan.title = (item.field_names ?? []).join(", ");

    const actionsSpan = document.createElement("span");
    actionsSpan.className = "ann-saved-col-actions";

    // Commit button — commits this episode's draft to Parquet without navigating
    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.className = "ann-saved-commit-btn";
    commitBtn.title = `Commit annotations for episode ${item.episode_index} to Parquet`;
    commitBtn.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
        `<polyline points="20 6 9 17 4 12"/>` +
      `</svg>`;

    commitBtn.addEventListener("click", async () => {
      commitBtn.disabled = true;
      try {
        // For the current episode, send filled frames (with fill strategies applied)
        // For other episodes, send empty body and let the server use the sidecar
        const body = isCurrent ? { filled_frames: _computeFilledAnnotations() } : {};
        const result = await apiPost(
          `${apiDs(state.activeDataset)}/episodes/${item.episode_index}/annotations/commit`,
          body
        );
        showCopyToast(
          `✓ ep ${item.episode_index}: committed ${Object.keys(result.columns_written ?? {}).length || (result.columns_written?.length ?? 0)} column${(result.columns_written?.length ?? 0) !== 1 ? "s" : ""}`,
          "success"
        );
        // Refresh count (committed but draft still exists on disk)
        refresh?.();
      } catch (e) {
        commitBtn.disabled = false;
        showCopyToast(`Commit ep ${item.episode_index} failed: ${e.message}`, "error");
      }
    });

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ann-saved-del-btn";
    delBtn.title = `Delete saved annotation draft for episode ${item.episode_index}`;
    delBtn.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
        `<polyline points="3 6 5 6 21 6"/>` +
        `<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>` +
        `<path d="M10 11v6"/><path d="M14 11v6"/>` +
        `<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>` +
      `</svg>`;

    delBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Delete saved annotation draft for episode ${item.episode_index}?\n\n` +
        `${item.frame_count} annotated frame${item.frame_count !== 1 ? "s" : ""} will be permanently removed.`
      );
      if (!confirmed) return;
      delBtn.disabled = true;
      try {
        await apiPost(
          `${apiDs(state.activeDataset)}/episodes/${item.episode_index}/annotations`,
          {},
          "DELETE"
        );
        if (item.episode_index === state.activeEpIndex) _clearCurrentEpisodeAnnotationsInMemory();
        row.classList.add("ann-saved-row-deleting");
        setTimeout(() => refresh?.(), 250);
      } catch (e) {
        delBtn.disabled = false;
        showCopyToast(`Delete failed: ${e.message}`, "error");
      }
    });

    actionsSpan.appendChild(commitBtn);
    actionsSpan.appendChild(delBtn);
    row.appendChild(epSpan);
    row.appendChild(framesSpan);
    row.appendChild(fieldsSpan);
    row.appendChild(actionsSpan);
    rows.appendChild(row);
  });

  container.appendChild(rows);

  const note = document.createElement("p");
  note.className = "ann-saved-note";
  note.textContent = `${list.length} episode${list.length !== 1 ? "s" : ""} with saved drafts · click row to navigate · ✓ to commit to Parquet · 🗑 to delete draft`;
  container.appendChild(note);
}

function _buildSchemaSection(body) {
  const sec = document.createElement("div");
  sec.className = "ann-schema-section visible";

  // Field list
  const list = document.createElement("div");
  list.className = "ann-field-list";
  if (state.annotationSchema.length === 0) {
    list.innerHTML = `<div class="ann-empty-schema">No fields defined yet.</div>`;
  } else {
    state.annotationSchema.forEach((field, idx) => {
      const row = document.createElement("div");
      row.className = "ann-field-row";
      row.innerHTML =
        `<span class="ann-field-name">${escapeHTML(field.name)}</span>` +
        `<span class="ann-field-type">${escapeHTML(field.type)}</span>` +
        (field.options?.length ? `<span style="font-size:10px;color:var(--text-2)">${escapeHTML(field.options.join(", "))}</span>` : "") +
        `<button class="ann-field-del" type="button" title="Remove field" aria-label="Remove ${escapeHTML(field.name)}">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
        `</button>`;
      row.querySelector(".ann-field-del").addEventListener("click", async () => {
        const updated = state.annotationSchema.filter((_, i) => i !== idx);
        await _saveSchema(updated);
      });
      list.appendChild(row);
    });
  }
  sec.appendChild(list);

  // Add field form
  const form = document.createElement("div");
  form.className = "ann-add-form";
  form.innerHTML =
    `<input type="text" placeholder="field_name" maxlength="64" autocomplete="off" spellcheck="false" />` +
    `<select>` +
      `<option value="number">Number</option>` +
      `<option value="string">String</option>` +
      `<option value="boolean">Boolean</option>` +
      `<option value="category">Category</option>` +
    `</select>` +
    `<button class="ann-add-btn" type="button">Add</button>`;
  const nameInput = form.querySelector("input");
  const typeSelect = form.querySelector("select");

  // Category options field (shown when type=category)
  const catWrap = document.createElement("div");
  catWrap.className = "ann-category-opts";
  catWrap.innerHTML = `<input type="text" placeholder="Option A, Option B, Option C" style="display:none" />`;
  const catInput = catWrap.querySelector("input");
  form.appendChild(catWrap);

  typeSelect.addEventListener("change", () => {
    catInput.style.display = typeSelect.value === "category" ? "" : "none";
  });

  form.querySelector(".ann-add-btn").addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) {
      showCopyToast("Field name must start with a letter/underscore and contain only alphanumerics/underscores", "error");
      return;
    }
    if (state.annotationSchema.some(f => f.name === name)) {
      showCopyToast(`Field '${name}' already exists`, "error");
      return;
    }
    const field = { name, type: typeSelect.value };
    if (typeSelect.value === "category") {
      const opts = catInput.value.split(",").map(s => s.trim()).filter(Boolean);
      if (opts.length) field.options = opts;
    }
    await _saveSchema([...state.annotationSchema, field]);
  });

  nameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); form.querySelector(".ann-add-btn").click(); }
  });

  sec.appendChild(form);
  body.appendChild(sec);
}

function _buildAnnotateSection(body) {
  const sec = document.createElement("div");
  sec.className = "ann-annotate-section visible";

  if (state.annotationSchema.length === 0) {
    sec.innerHTML = `<div class="ann-no-schema-msg">No annotation fields defined.<br>Switch to the <strong>Schema</strong> tab to add fields.</div>`;
    body.appendChild(sec);
    return;
  }

  const { incomplete: fieldsToAnnotate, complete: fieldsComplete } = _splitFieldsByCompletion();

  if (fieldsToAnnotate.length === 0) {
    const annotatedCount = Object.keys(state.annotations).length;
    const doneDiv = document.createElement("div");
    doneDiv.className = "ann-all-done-msg";
    doneDiv.innerHTML =
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` +
      `<span>All ${fieldsComplete.length} field${fieldsComplete.length !== 1 ? "s" : ""} fully annotated.<br>` +
      `View them in the <strong>Annotated</strong> tab.</span>`;
    sec.appendChild(doneDiv);
    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.className = "ann-commit-btn";
    commitBtn.id = "ann-commit-btn";
    commitBtn.textContent = `Commit annotations to Dataset`;
    commitBtn.disabled = annotatedCount === 0;
    commitBtn.addEventListener("click", commitAnnotations);
    sec.appendChild(commitBtn);
    body.appendChild(sec);
    return;
  }

  // Interactive annotation timeline
  const annotatedCount = Object.keys(state.annotations).length;
  const totalFrames = state.episode?.length ?? 0;
  const progressRow = document.createElement("div");
  progressRow.className = "ann-progress-row";
  progressRow.id = "ann-progress-row";
  progressRow.innerHTML =
    `<canvas id="ann-timeline" class="ann-timeline-canvas" title="Click or drag to seek"></canvas>` +
    `<span class="ann-progress-label" id="ann-progress-label">${annotatedCount} / ${totalFrames} frames</span>`;
  sec.appendChild(progressRow);

  // Attach seek interaction — remove old document listeners to prevent accumulation
  const _attachTimelineSeek = (canvas) => {
    if (!canvas) return;
    // Clean up previous global listeners and ResizeObserver
    if (_annTimelineMove) document.removeEventListener("mousemove", _annTimelineMove);
    if (_annTimelineUp)   document.removeEventListener("mouseup",   _annTimelineUp);
    if (_annTimelineRO)   { _annTimelineRO.disconnect(); _annTimelineRO = null; }

    let isSeeking = false;

    const frameAt = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return -1;
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width - 1));
      const n = state.episode?.length ?? 1;
      return Math.max(0, Math.min(Math.floor((x / rect.width) * n), n - 1));
    };

    const seekToFrame = (f) => { if (f >= 0) setFrame(f); };

    // Mouse seek
    canvas.addEventListener("mousedown", e => {
      seekToFrame(frameAt(e.clientX)); isSeeking = true; e.preventDefault();
    });
    _annTimelineMove = e => { if (isSeeking) seekToFrame(frameAt(e.clientX)); };
    _annTimelineUp   = () => { isSeeking = false; };
    document.addEventListener("mousemove", _annTimelineMove);
    document.addEventListener("mouseup",   _annTimelineUp);

    // Touch seek (mobile / trackpad)
    const seekTouch = (e) => {
      if (!e.touches[0]) return;
      seekToFrame(frameAt(e.touches[0].clientX));
    };
    canvas.addEventListener("touchstart",  e => { seekTouch(e); isSeeking = true;  e.preventDefault(); }, { passive: false });
    canvas.addEventListener("touchmove",   e => { if (isSeeking) seekTouch(e);     e.preventDefault(); }, { passive: false });
    canvas.addEventListener("touchend",    () => { isSeeking = false; });

    // Hover tooltip
    const tooltip = (() => {
      let tt = document.getElementById("ann-timeline-tt");
      if (!tt) {
        tt = document.createElement("div");
        tt.id = "ann-timeline-tt";
        tt.className = "ann-timeline-tt";
        document.body.appendChild(tt);
      }
      return tt;
    })();
    canvas.addEventListener("mousemove", e => {
      const f = frameAt(e.clientX);
      if (f < 0) return;
      const fd = state.annotations[String(f)];
      const annotCount = fd ? Object.keys(fd).length : 0;
      const schemaCount = state.annotationSchema.length;
      tooltip.textContent = schemaCount > 0
        ? `Frame ${f}  ·  ${annotCount}/${schemaCount} fields`
        : `Frame ${f}`;
      tooltip.style.left = (e.clientX + 14) + "px";
      tooltip.style.top  = (e.clientY - 32) + "px";
      tooltip.style.display = "block";
    });
    canvas.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });

    // Redraw when panel width changes (e.g. sidebar resize)
    _annTimelineRO = new ResizeObserver(() => _drawAnnTimeline());
    _annTimelineRO.observe(canvas);
  };
  // Defer until layout is computed so canvas has a width
  requestAnimationFrame(() => {
    const c = el("ann-timeline");
    if (c) { _attachTimelineSeek(c); _drawAnnTimeline(); }
  });

  // Input chips — built ONCE, reused across frame changes
  const grid = document.createElement("div");
  grid.className = "ann-chips-grid";
  grid.id = "ann-chips-grid";
  sec.appendChild(grid);

  _annChipInputs = {};
  const frameKey = String(state.frame);
  const frameData = state.annotations[frameKey] ?? {};

  fieldsToAnnotate.forEach(field => {
    const chip = document.createElement("div");
    chip.className = "ann-chip" + (field.name in frameData ? " annotated" : "");
    chip.dataset.field = field.name;

    const label = document.createElement("span");
    label.className = "ann-chip-label";
    label.textContent = field.name;

    let input;
    const ftype = field.type;
    if (ftype === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = frameData[field.name] ?? "";
    } else if (ftype === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!(frameData[field.name]);
    } else if (ftype === "category") {
      input = document.createElement("select");
      input.innerHTML = `<option value="">—</option>` +
        (field.options ?? []).map(o => `<option>${escapeHTML(o)}</option>`).join("");
      input.value = frameData[field.name] ?? "";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = frameData[field.name] ?? "";
    }
    input.dataset.fieldName = field.name;
    input.dataset.fieldType = ftype;

    // On every change: update state.annotations immediately (in-memory), debounce server save
    const onInput = () => {
      const capturedFrame = state.frame;  // lock frame at input time
      const capturedKey = String(capturedFrame);
      const val = _readInputValue(input, ftype);
      // Update in-memory state immediately so navigation never loses the value
      if (val !== null) {
        state.annotations[capturedKey] = { ...(state.annotations[capturedKey] ?? {}), [field.name]: val };
      } else {
        const existing = state.annotations[capturedKey];
        if (existing) {
          delete existing[field.name];
          if (Object.keys(existing).length === 0) delete state.annotations[capturedKey];
        }
      }
      chip.classList.toggle("annotated", val !== null);
      state.annotationDirty = true;
      _updateAnnotationProgress();
      // Debounce the actual server persist for this specific frame
      // Per-frame timer — never cancels other frames' pending saves
      clearTimeout(_annSaveTimers[capturedFrame]);
      _annSaveTimers[capturedFrame] = setTimeout(() => {
        _persistAnnotationFrame(capturedFrame);
        delete _annSaveTimers[capturedFrame];
      }, 800);
    };
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);

    // Keyboard navigation within chips (Tab or arrow keys to move between fields)
    input.addEventListener("keydown", e => {
      const fieldNames = Object.keys(_annChipInputs);
      const curIdx = fieldNames.indexOf(field.name);
      if (curIdx === -1) return;

      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
        const nextIdx = (curIdx + 1) % fieldNames.length;
        _annChipInputs[fieldNames[nextIdx]]?.input?.focus();
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
        const prevIdx = (curIdx - 1 + fieldNames.length) % fieldNames.length;
        _annChipInputs[fieldNames[prevIdx]]?.input?.focus();
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        setFrame(Math.min(state.frame + 1, (state.episode?.length ?? 1) - 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setFrame(Math.max(state.frame - 1, 0));
        e.preventDefault();
      }
    });

    chip.appendChild(label);
    chip.appendChild(input);
    grid.appendChild(chip);
    _annChipInputs[field.name] = { input, chip, ftype };
  });

  // Nav buttons + clear button
  const navRow = document.createElement("div");
  navRow.className = "ann-nav-row";
  navRow.innerHTML =
    `<button class="ann-nav-btn" type="button" id="ann-prev-unannotated">← Prev unannotated</button>` +
    `<button class="ann-nav-btn" type="button" id="ann-next-unannotated">Next unannotated →</button>` +
    `<button class="ann-nav-btn ann-clear-btn" type="button" id="ann-clear-episode" title="Clear all annotations for this episode  Del">` +
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>` +
      ` Clear all` +
    `</button>`;
  navRow.querySelector("#ann-prev-unannotated").addEventListener("click", () => _jumpToUnannotated(-1));
  navRow.querySelector("#ann-next-unannotated").addEventListener("click", () => _jumpToUnannotated(+1));
  navRow.querySelector("#ann-clear-episode").addEventListener("click", clearEpisodeAnnotations);
  sec.appendChild(navRow);

  // Fill & Save button — applies fill strategies and persists to JSON sidecar
  const fillSaveBtn = document.createElement("button");
  fillSaveBtn.type = "button";
  fillSaveBtn.className = "ann-fill-save-btn";
  fillSaveBtn.id = "ann-fill-save-btn";
  fillSaveBtn.title = "Apply fill strategies to all unannotated frames and save draft  Ctrl+S";
  fillSaveBtn.innerHTML =
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>` +
      `<polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>` +
    `</svg>` +
    ` Fill &amp; Save <kbd>Ctrl+S</kbd>`;
  fillSaveBtn.disabled = annotatedCount === 0;
  fillSaveBtn.addEventListener("click", fillAndSaveAllAnnotations);
  sec.appendChild(fillSaveBtn);

  // Export as CSV button
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "ann-export-csv-btn";
  exportBtn.id = "ann-export-csv-btn";
  exportBtn.title = "Export current episode annotations as CSV";
  exportBtn.innerHTML =
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>` +
      `<polyline points="14 2 14 8 20 8"/>` +
      `<line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>` +
    `</svg>` +
    ` Export as CSV`;
  exportBtn.disabled = annotatedCount === 0;
  exportBtn.addEventListener("click", exportAnnotationsAsCSV);
  sec.appendChild(exportBtn);

  // Commit button
  const commitBtn = document.createElement("button");
  commitBtn.type = "button";
  commitBtn.className = "ann-commit-btn";
  commitBtn.id = "ann-commit-btn";
  commitBtn.textContent = `Commit ${annotatedCount} annotation${annotatedCount !== 1 ? "s" : ""} to Dataset`;
  commitBtn.disabled = annotatedCount === 0;
  commitBtn.addEventListener("click", commitAnnotations);
  sec.appendChild(commitBtn);

  body.appendChild(sec);
}

function _buildAnnotatedSection(body) {
  const sec = document.createElement("div");
  sec.className = "ann-annotate-section visible";

  const { incomplete, complete } = _splitFieldsByCompletion();
  const totalFrames = state.episode?.length ?? 0;

  if (complete.length === 0) {
    sec.innerHTML =
      `<div class="ann-no-schema-msg">No fully-annotated fields yet.<br>` +
      `A field appears here once <em>all ${totalFrames} frames</em> have a value.</div>`;
    body.appendChild(sec);
    return;
  }

  // Stats summary per field
  const statsGrid = document.createElement("div");
  statsGrid.className = "ann-annotated-grid";

  complete.forEach(field => {
    const card = document.createElement("div");
    card.className = "ann-annotated-card";

    const titleRow = document.createElement("div");
    titleRow.className = "ann-annotated-card-title";
    titleRow.innerHTML =
      `<span class="ann-annotated-field-name">${escapeHTML(field.name)}</span>` +
      `<span class="ann-annotated-field-type">${escapeHTML(field.type)}</span>` +
      `<span class="ann-annotated-badge">✓ ${totalFrames}</span>`;
    card.appendChild(titleRow);

    // Collect values across all frames
    const values = [];
    for (let f = 0; f < totalFrames; f++) {
      const v = state.annotations[String(f)]?.[field.name];
      if (v !== undefined && v !== null && v !== "") values.push(v);
    }

    if (field.type === "number" && values.length > 0) {
      const nums = values.map(Number).filter(n => !isNaN(n));
      if (nums.length > 0) {
        const min = Math.min(...nums), max = Math.max(...nums);
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
        const statsRow = document.createElement("div");
        statsRow.className = "ann-annotated-stats";
        statsRow.innerHTML =
          `<span title="min"><span class="ann-stat-lbl">min</span> ${escapeHTML(fmt(min))}</span>` +
          `<span title="mean"><span class="ann-stat-lbl">avg</span> ${escapeHTML(fmt(mean))}</span>` +
          `<span title="max"><span class="ann-stat-lbl">max</span> ${escapeHTML(fmt(max))}</span>`;
        card.appendChild(statsRow);

        // Sparkline chart
        const sparkCanvas = document.createElement("canvas");
        sparkCanvas.className = "ann-sparkline";
        sparkCanvas.dataset.field = field.name;
        sparkCanvas.title = `${field.name} over time — click to seek`;
        card.appendChild(sparkCanvas);
        // Seek on click
        sparkCanvas.addEventListener("click", e => {
          const rect = sparkCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const f = Math.max(0, Math.min(
            Math.floor(((e.clientX - rect.left) / rect.width) * totalFrames),
            totalFrames - 1,
          ));
          setFrame(f);
        });
        requestAnimationFrame(() => _drawAnnotatedSparkline(sparkCanvas, field.name, totalFrames));
      }
    } else if (field.type === "category" || field.type === "string") {
      // Count unique values
      const counts = {};
      values.forEach(v => { counts[String(v)] = (counts[String(v)] ?? 0) + 1; });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        const distRow = document.createElement("div");
        distRow.className = "ann-annotated-dist";
        sorted.slice(0, 5).forEach(([v, n]) => {
          const pct = Math.round((n / totalFrames) * 100);
          const chip = document.createElement("span");
          chip.className = "ann-dist-chip";
          chip.title = `${n} frames`;
          chip.innerHTML = `<span class="ann-dist-val">${escapeHTML(v)}</span><span class="ann-dist-pct">${pct}%</span>`;
          distRow.appendChild(chip);
        });
        if (sorted.length > 5) {
          const more = document.createElement("span");
          more.className = "ann-dist-more";
          more.textContent = `+${sorted.length - 5} more`;
          distRow.appendChild(more);
        }
        card.appendChild(distRow);
      }
    } else if (field.type === "boolean") {
      const trueCount = values.filter(v => v === true || v === "true").length;
      const pctTrue = Math.round((trueCount / totalFrames) * 100);
      const distRow = document.createElement("div");
      distRow.className = "ann-annotated-stats";
      distRow.innerHTML =
        `<span><span class="ann-stat-lbl">true</span> ${trueCount} (${pctTrue}%)</span>` +
        `<span><span class="ann-stat-lbl">false</span> ${totalFrames - trueCount} (${100 - pctTrue}%)</span>`;
      card.appendChild(distRow);
    }

    // Current-frame value preview (updated on frame navigation without full rebuild)
    const curVal = state.annotations[String(state.frame)]?.[field.name];
    const curRow = document.createElement("div");
    curRow.className = "ann-annotated-cur";
    curRow.dataset.field = field.name;
    if (curVal !== undefined && curVal !== null) {
      curRow.innerHTML = `<span class="ann-stat-lbl">frame ${state.frame}</span> ${escapeHTML(String(curVal))}`;
    } else {
      curRow.style.display = "none";
    }
    card.appendChild(curRow);

    statsGrid.appendChild(card);
  });

  sec.appendChild(statsGrid);

  if (incomplete.length > 0) {
    const note = document.createElement("div");
    note.className = "ann-annotated-note";
    note.textContent = `${incomplete.length} field${incomplete.length !== 1 ? "s" : ""} still incomplete — annotate remaining frames in the Annotate tab.`;
    sec.appendChild(note);
  }

  body.appendChild(sec);
}

function _readInputValue(input, ftype) {
  if (ftype === "boolean") return input.checked;  // false is a valid annotation value
  if (ftype === "number") return input.value === "" ? null : parseFloat(input.value);
  return input.value === "" ? null : input.value;
}

function updateAnnotationPanel() {
  const panel = el("annotation-panel");
  if (!panel || panel.classList.contains("hidden")) return;

  if (_annActiveTab === "annotated") {
    // Lightweight update: refresh current-frame preview rows and sparkline cursors
    const frameData = state.annotations[String(state.frame)] ?? {};
    const totalFrames = state.episode?.length ?? 0;
    panel.querySelectorAll(".ann-annotated-cur[data-field]").forEach(row => {
      const name = row.dataset.field;
      const v = frameData[name];
      if (v !== undefined && v !== null) {
        row.innerHTML = `<span class="ann-stat-lbl">frame ${state.frame}</span> ${escapeHTML(String(v))}`;
        row.style.display = "";
      } else {
        row.style.display = "none";
      }
    });
    panel.querySelectorAll(".ann-sparkline[data-field]").forEach(canvas => {
      _drawAnnotatedSparkline(canvas, canvas.dataset.field, totalFrames);
    });
    return;
  }

  if (_annActiveTab !== "annotate") return;
  if (!_annChipInputs || state.annotationSchema.length === 0) return;

  // Only update input values — DOM is reused, never rebuilt
  const frameData = state.annotations[String(state.frame)] ?? {};
  Object.entries(_annChipInputs).forEach(([name, { input, chip, ftype }]) => {
    const val = frameData[name];
    if (ftype === "boolean") {
      input.checked = !!(val);
    } else {
      input.value = val ?? "";
    }
    chip.classList.toggle("annotated", val !== undefined && val !== null && val !== "");
  });
  _updateAnnotationProgress();
}

function _updateAnnotationProgress() {
  const totalFrames = state.episode?.length ?? 0;
  const schemaCount = state.annotationSchema.length;
  let annotatedCount = 0, fullCount = 0, partialCount = 0;
  for (const fd of Object.values(state.annotations)) {
    const n = Object.keys(fd).length;
    if (n > 0) annotatedCount++;
    if (n >= schemaCount) fullCount++;
    else if (n > 0) partialCount++;
  }
  const label = el("ann-progress-label");
  const btn = el("ann-commit-btn");
  const fillBtn = el("ann-fill-save-btn");
  if (label) {
    label.textContent = schemaCount > 1
      ? `${fullCount} full · ${partialCount} partial / ${totalFrames}`
      : `${annotatedCount} / ${totalFrames} frames`;
  }
  if (btn) {
    btn.disabled = annotatedCount === 0;
    btn.textContent = `Commit ${annotatedCount} annotation${annotatedCount !== 1 ? "s" : ""} to Dataset`;
  }
  if (fillBtn) {
    fillBtn.disabled = annotatedCount === 0;
  }
  _updateAnnotationDirtyIndicator();
  _drawAnnTimeline();
}

function _drawAnnTimeline() {
  const canvas = el("ann-timeline");
  if (!canvas) return;
  const totalFrames = state.episode?.length ?? 0;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w === 0 || h === 0 || totalFrames === 0) return;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Read CSS tokens for theme-aware colors
  const cs = getComputedStyle(document.documentElement);
  const bgColor      = cs.getPropertyValue("--bg-3").trim()    || "#e5e7eb";
  const fullColor    = cs.getPropertyValue("--green").trim()   || "#10B981";
  const partialColor = cs.getPropertyValue("--amber").trim()   || "#F59E0B";

  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // Per-frame annotation segments: green = fully annotated, amber = partial
  const schemaCount = state.annotationSchema.length;
  const annotatedFrames = Object.keys(state.annotations);
  if (annotatedFrames.length > 0) {
    const frameW = Math.max(1, Math.ceil(w / totalFrames));
    ctx.globalAlpha = 0.82;
    annotatedFrames.forEach(key => {
      const fi = parseInt(key, 10);
      if (isNaN(fi)) return;
      const fieldCount = Object.keys(state.annotations[key]).length;
      ctx.fillStyle = (schemaCount > 0 && fieldCount >= schemaCount) ? fullColor : partialColor;
      const x = Math.floor((fi / totalFrames) * w);
      ctx.fillRect(x, 0, frameW, h);
    });
    ctx.globalAlpha = 1;
  }

  // Current-frame cursor
  const curX = Math.round((state.frame / Math.max(totalFrames - 1, 1)) * w);
  ctx.strokeStyle = "#3B82F6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(curX, 0);
  ctx.lineTo(curX, h);
  ctx.stroke();

  // Cursor head triangle
  ctx.fillStyle = "#3B82F6";
  ctx.beginPath();
  ctx.moveTo(curX - 4, 0);
  ctx.lineTo(curX + 4, 0);
  ctx.lineTo(curX, 5);
  ctx.closePath();
  ctx.fill();
}

function _drawAnnotatedSparkline(canvas, fieldName, totalFrames) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w === 0 || h === 0 || totalFrames === 0) return;

  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const cs = getComputedStyle(document.documentElement);
  const bgColor     = cs.getPropertyValue("--bg-3").trim()    || "#f3f4f6";
  const lineColor   = cs.getPropertyValue("--green").trim()   || "#10B981";
  const dotColor    = cs.getPropertyValue("--green").trim()   || "#10B981";
  const cursorColor = "#3B82F6";
  const labelColor  = cs.getPropertyValue("--text-3").trim()  || "#9ca3af";

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // Collect (frame, value) pairs
  const pts = [];
  for (let f = 0; f < totalFrames; f++) {
    const v = state.annotations[String(f)]?.[fieldName];
    if (v !== undefined && v !== null && v !== "") {
      const n = parseFloat(v);
      if (!isNaN(n)) pts.push({ f, v: n });
    }
  }
  if (pts.length === 0) return;

  const pad = { top: 8, bottom: 14, left: 4, right: 4 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  let minV = pts[0].v, maxV = pts[0].v;
  pts.forEach(p => { if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; });
  const rangeV = maxV === minV ? 1 : maxV - minV;

  const toX = f => pad.left + (f / Math.max(totalFrames - 1, 1)) * chartW;
  const toY = v => pad.top + chartH - ((v - minV) / rangeV) * chartH;

  // Line through annotated points
  if (pts.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.moveTo(toX(pts[0].f), toY(pts[0].v));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(toX(pts[i].f), toY(pts[i].v));
    }
    ctx.stroke();

    // Shaded area under line
    ctx.beginPath();
    ctx.moveTo(toX(pts[0].f), h - pad.bottom);
    pts.forEach(p => ctx.lineTo(toX(p.f), toY(p.v)));
    ctx.lineTo(toX(pts[pts.length - 1].f), h - pad.bottom);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Dots at annotated frames
  ctx.fillStyle = dotColor;
  pts.forEach(p => {
    ctx.beginPath();
    ctx.arc(toX(p.f), toY(p.v), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Y-axis labels (min/max)
  const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  ctx.fillStyle = labelColor;
  ctx.font = `${8 * dpr / dpr}px system-ui,sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText(fmt(maxV), w - 2, pad.top + 6);
  ctx.fillText(fmt(minV), w - 2, h - pad.bottom - 2);

  // Current-frame cursor
  const curX = toX(state.frame);
  ctx.strokeStyle = cursorColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(curX, 0);
  ctx.lineTo(curX, h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Current frame value dot
  const curV = state.annotations[String(state.frame)]?.[fieldName];
  if (curV !== undefined && curV !== null) {
    const cv = parseFloat(curV);
    if (!isNaN(cv)) {
      ctx.fillStyle = cursorColor;
      ctx.beginPath();
      ctx.arc(curX, toY(cv), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function _persistAnnotationFrame(frameIndex) {
  if (!state.activeDataset || state.activeEpIndex == null) return;
  const values = state.annotations[String(frameIndex)] ?? {};
  // Send even when empty — server interprets empty values as a delete for this frame
  apiPost(
    `${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/annotations`,
    { frame_index: frameIndex, values }
  ).catch(() => {});
}

// Reset in-memory annotation state for the current episode (inputs, timers, state)
function _clearCurrentEpisodeAnnotationsInMemory() {
  Object.keys(_annSaveTimers).forEach(k => { clearTimeout(_annSaveTimers[k]); delete _annSaveTimers[k]; });
  state.annotations = {};
  state.annotationDirty = false;
  _updateAnnotationDirtyIndicator();
  if (_annChipInputs) {
    Object.values(_annChipInputs).forEach(({ input, chip, ftype }) => {
      if (ftype === "boolean") input.checked = false;
      else input.value = "";
      chip.classList.remove("annotated");
    });
  }
  _updateAnnotationProgress();
}

async function clearEpisodeAnnotations() {
  if (!state.episode || !state.activeDataset) return;
  const count = Object.keys(state.annotations).length;
  if (count === 0) {
    showCopyToast("No annotations to clear for this episode", "info");
    return;
  }
  const confirmed = window.confirm(
    `Clear ALL ${count} frame annotation${count !== 1 ? "s" : ""} for episode ${state.activeEpIndex}?\n\nThis permanently removes all annotation data for this episode (both draft and saved).`
  );
  if (!confirmed) return;

  _clearCurrentEpisodeAnnotationsInMemory();

  try {
    await apiPost(`${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/annotations`, {}, "DELETE");
    showCopyToast(`Cleared all annotations for episode ${state.activeEpIndex}`, "success");
  } catch (e) {
    showCopyToast(`Server delete failed: ${e.message}`, "error");
  }
}

function _jumpToUnannotated(dir) {
  if (!state.episode || !_annChipInputs) return;
  const len = state.episode.length;
  const fieldNames = Object.keys(_annChipInputs);
  if (fieldNames.length === 0) return;

  let f = state.frame + dir;
  for (let i = 0; i < len; i++, f += dir) {
    if (f < 0) f = len - 1;
    if (f >= len) f = 0;

    // Check if this frame is unannotated for ANY of the current fields in the Annotate tab
    const frameData = state.annotations[String(f)] ?? {};
    const hasUnannotated = fieldNames.some(name =>
      frameData[name] === undefined || frameData[name] === null || frameData[name] === ""
    );

    if (hasUnannotated) {
      stopPlayback();
      setFrame(f);
      return;
    }
  }
  showCopyToast("All frames annotated!", "success");
}

async function _saveSchema(fields) {
  try {
    await apiPost(`${apiDs(state.activeDataset)}/annotation_schema`, { fields });
    state.annotationSchema = fields;
    buildAnnotationPanel();
    showCopyToast("Schema saved", "success");
  } catch (e) {
    showCopyToast(`Schema error: ${e.message}`, "error");
  }
}

// Apply fill strategies to all unannotated frames, persist to JSON sidecar, refresh UI.
// Triggered by Ctrl+S when annotation panel is visible.
async function fillAndSaveAllAnnotations() {
  if (!state.activeDataset || state.activeEpIndex === null) return;
  if (state.annotationSchema.length === 0) {
    showCopyToast("Define annotation fields in the Schema tab first", "warn");
    return;
  }
  const filled = _computeFilledAnnotations();
  const count = Object.keys(filled).length;
  if (count === 0) {
    showCopyToast("No annotations to save (annotate at least one frame first)", "warn");
    return;
  }
  // Update in-memory state immediately so UI reflects the fill
  state.annotations = filled;
  state.annotationDirty = false;
  _updateAnnotationDirtyIndicator();
  try {
    await apiPost(
      `${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/annotations`,
      { frames: filled },
      "PUT",
    );
    showCopyToast(`Saved ${count} frame${count !== 1 ? "s" : ""} (with fill applied)`, "success");
    // If all fields are now complete, switch to Annotated tab so user can review
    const { incomplete } = _splitFieldsByCompletion();
    if (incomplete.length === 0 && _annActiveTab === "annotate") _annActiveTab = "annotated";
    buildAnnotationPanel();
  } catch (err) {
    showCopyToast(`Save failed: ${err.message}`, "error");
    state.annotationDirty = true;
  }
}

function exportAnnotationsAsCSV() {
  if (!state.activeDataset || state.activeEpIndex === null) return;
  const count = Object.keys(state.annotations).length;
  if (count === 0) {
    showCopyToast("No annotations to export", "warn");
    return;
  }

  // Collect all field names from schema
  const headers = ["frame_index", ...state.annotationSchema.map(f => f.name)];
  const total = state.episode?.length ?? 0;
  const rows = [];

  for (let f = 0; f < total; f++) {
    const frameData = state.annotations[String(f)] ?? {};
    const row = [String(f)];
    state.annotationSchema.forEach(field => {
      const val = frameData[field.name];
      if (val === undefined || val === null) {
        row.push("");
      } else if (typeof val === "boolean") {
        row.push(val ? "true" : "false");
      } else {
        row.push(String(val));
      }
    });
    rows.push(row);
  }

  // Escape CSV values and join
  const escapeCsv = v => {
    if (v === "") return '""';
    if (v.includes(",") || v.includes('"') || v.includes("\n")) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  };

  const csv = [headers.map(escapeCsv).join(","), ...rows.map(r => r.map(escapeCsv).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.activeDataset}_ep${epPad()}_annotations.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showCopyToast("Annotations exported as CSV", "success");
}

async function commitAnnotations() {
  const count = Object.keys(state.annotations).length;
  if (count === 0) return;

  // Apply fill strategies to get the full frame set to commit
  const filledFrames = _computeFilledAnnotations();
  const filledCount = Object.keys(filledFrames).length;
  const total = state.episode?.length ?? 0;
  const fillNote = filledCount > count
    ? `\n\nFill strategies will expand coverage from ${count} → ${filledCount} / ${total} frames.`
    : "";

  const confirmed = window.confirm(
    `Commit ${count} annotated frame${count !== 1 ? "s" : ""} to the dataset Parquet file?${fillNote}\n\nThis will permanently add/overwrite annotation columns in:\n${state.activeDataset} / episode ${state.activeEpIndex}`
  );
  if (!confirmed) return;
  try {
    const result = await apiPost(
      `${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/annotations/commit`,
      { filled_frames: filledFrames }
    );
    showCopyToast(`✓ Committed ${filledCount} frame annotations to dataset (${result.columns_written?.join(", ")})`, "success");
    state.annotationDirty = false;
    _updateAnnotationDirtyIndicator();
    _fjvLastKey = null;  // force refresh — Parquet now has new columns
    updateFrameJsonViewer(true);
  } catch (e) {
    showCopyToast(`Commit failed: ${e.message}`, "error");
  }
}

/* ── TimeDim tooltip ─────────────────────────────────────── */
function showTimeDimTooltip(x, y, html) {
  let tt = el("timedim-tooltip");
  if (!tt) {
    tt = document.createElement("div");
    tt.id = "timedim-tooltip";
    tt.className = "timedim-tooltip";
    document.body.appendChild(tt);
  }
  tt.innerHTML = html;
  show(tt);
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
  hide("timedim-tooltip");
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

  if (!sDims && !aDims) { hide(panel); return; }

  _fvCache = { s: [], a: [] };  // invalidate stale element references
  panel.innerHTML = "";

  // Panel header with sort + copy buttons
  {
    const hdr = document.createElement("div");
    hdr.className = "fv-panel-header";
    hdr.innerHTML =
      `<span class="fv-panel-title">Frame Values</span>` +
      `<div class="fv-btn-group">` +
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
      const span = document.createElement("span");
      span.className = "fv-val";
      span.textContent = "—";
      const barFill = document.createElement("div");
      barFill.className = "fv-bar-fill";
      barFill.style.background = PALETTE[d % PALETTE.length];
      chip.innerHTML = `<div class="fv-top"><span class="fv-dim" style="color:${PALETTE[d % PALETTE.length]}">${escapeHTML(names[d] ?? `${prefix}${d}`)}</span></div><div class="fv-bar"></div>`;
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

/* ── Frame JSON viewer ──────────────────────────────────── */
function toggleFrameJsonViewer() {
  const panel = el("frame-json-viewer");
  const btn   = el("btn-frame-json");
  if (!panel) return;
  const hidden = toggle(panel, "hidden");
  btn?.classList.toggle("active", !hidden);
  btn?.setAttribute("aria-pressed", boolStr(!hidden));
  lsFlag("fjvOpen", !hidden);   // persist user preference
  if (!hidden) updateFrameJsonViewer(true);
}

function updateFrameJsonViewer(force = false) {
  const panel = el("frame-json-viewer");
  if (!panel || panel.classList.contains("hidden")) return;
  if (!state.activeDataset || state.activeEpIndex == null) return;
  // Skip update during high-speed playback to avoid flooding the server
  if (state.playing && state.speed >= 4) return;

  const key = `${state.activeDataset}/${state.activeEpIndex}/${state.frame}`;
  if (!force && key === _fjvLastKey) return;

  // Save previous frame data before updating (same episode only, consecutive frames)
  const [prevDs, prevEp, prevF] = (_fjvPrevKey ?? "//").split("/");
  const sameEp = prevDs === state.activeDataset && prevEp === String(state.activeEpIndex);
  if (sameEp && _fjvLastData) {
    _fjvPrevData = _fjvLastData;
    _fjvPrevKey  = _fjvLastKey;
  } else if (!sameEp) {
    _fjvPrevData = null;
    _fjvPrevKey  = null;
  }

  _fjvLastKey = key;

  clearTimeout(_fjvDebounce);
  const delay = state.playing ? 200 : 0;
  _fjvDebounce = setTimeout(async () => {
    // Show loading only if the table is not already populated (reduces flicker)
    if (!panel.querySelector(".fjv-table")) {
      panel.innerHTML = `<div class="fjv-loading">Loading…</div>`;
    }
    try {
      const data = await apiFetch(
        `${apiDs(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${state.frame}/values`
      );
      _fjvLastData = data;
      _renderFrameJsonViewer(panel, data);
    } catch (err) {
      panel.innerHTML = `<div class="fjv-error">Failed to load: ${escapeHTML(err.message)}</div>`;
    }
  }, delay);
}

// Re-render JSON viewer using cached data (no fetch) — used when filter changes
function _reRenderFrameJsonViewerFromCache() {
  const panel = el("frame-json-viewer");
  if (!panel || !_fjvLastData) return;
  _renderFrameJsonViewer(panel, _fjvLastData);
}

// Format a number for display in the JSON viewer
const _fjvFmt = n => {
  if (!isFinite(n)) return String(n);
  if (Object.is(n, -0)) return "0";         // normalize negative zero
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(7).replace(/\.?0+$/, ""); // trim trailing zeros
};

function _fjvAppendRow(table, key, val, isAnn) {
  const isArr = Array.isArray(val);
  const row = document.createElement("div");
  row.className = "fjv-row" + (isAnn ? " fjv-row-ann" : "");

  const keyEl = document.createElement("span");
  keyEl.className = "fjv-key";
  keyEl.textContent = key;
  if (isAnn) {
    const tag = document.createElement("span");
    tag.className = "fjv-ann-tag";
    tag.textContent = "ann";
    keyEl.appendChild(tag);
  }

  const valEl = document.createElement("span");
  valEl.className = "fjv-val";

  if (isArr) {
    const expanded = !!_fjvExpanded[key];
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "fjv-arr-toggle";
    summary.innerHTML =
      `<svg class="fjv-arr-chevron${expanded ? " open" : ""}" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>` +
      ` [${val.length} dims]`;
    valEl.appendChild(summary);

    const detail = document.createElement("div");
    detail.className = "fjv-arr-detail" + (expanded ? " open" : "");
    detail.innerHTML = val.map((v, i) =>
      `<span class="fjv-arr-item"><span class="fjv-arr-idx">${i}</span><span class="fjv-num">${
        typeof v === "number" ? _fjvFmt(v) : escapeHTML(String(v))
      }</span></span>`
    ).join("");
    valEl.appendChild(detail);

    summary.addEventListener("click", () => {
      _fjvExpanded[key] = !_fjvExpanded[key];
      summary.querySelector(".fjv-arr-chevron").classList.toggle("open", !!_fjvExpanded[key]);
      detail.classList.toggle("open", !!_fjvExpanded[key]);
    });
  } else if (typeof val === "number") {
    const numSpan = document.createElement("span");
    numSpan.className = "fjv-num";
    numSpan.textContent = _fjvFmt(val);
    valEl.appendChild(numSpan);

    // Show delta from previous frame (same episode only)
    if (_fjvPrevData && key in _fjvPrevData) {
      const prev = _fjvPrevData[key];
      if (typeof prev === "number" && !Object.is(prev, val)) {
        const delta = val - prev;
        const badge = document.createElement("span");
        badge.className = "fjv-delta" + (delta > 0 ? " fjv-delta-pos" : " fjv-delta-neg");
        badge.textContent = (delta > 0 ? "+" : "") + _fjvFmt(delta);
        valEl.appendChild(badge);
        row.classList.add("fjv-changed");
      }
    }
  } else if (typeof val === "boolean") {
    valEl.innerHTML = `<span class="fjv-bool">${val}</span>`;
    if (_fjvPrevData && key in _fjvPrevData && _fjvPrevData[key] !== val) {
      row.classList.add("fjv-changed");
    }
  } else {
    valEl.innerHTML = `<span class="fjv-str">${escapeHTML(String(val))}</span>`;
    if (_fjvPrevData && key in _fjvPrevData && _fjvPrevData[key] !== val) {
      row.classList.add("fjv-changed");
    }
  }

  row.appendChild(keyEl);
  row.appendChild(valEl);
  table.appendChild(row);
}

function _renderFrameJsonViewer(panel, data) {
  const annFields = new Set(state.annotationSchema.map(f => f.name));

  // Partition into groups: annotations → scalars → arrays
  const annEntries = [], scalarEntries = [], arrEntries = [];
  for (const [k, v] of Object.entries(data)) {
    if (annFields.has(k))      annEntries.push([k, v]);
    else if (Array.isArray(v)) arrEntries.push([k, v]);
    else                       scalarEntries.push([k, v]);
  }
  // Sort arrays by length (shortest first so small dims come before large)
  arrEntries.sort(([, a], [, b]) => a.length - b.length);
  const entries = [...annEntries, ...scalarEntries, ...arrEntries];

  panel.innerHTML = "";

  // Header bar with copy button
  const hdr = document.createElement("div");
  hdr.className = "fjv-header";

  const titleSpan = document.createElement("span");
  titleSpan.className = "fjv-title";
  titleSpan.innerHTML =
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>` +
    ` Frame <strong>${state.frame}</strong> · raw data`;

  const rightGroup = document.createElement("span");
  rightGroup.className = "fjv-header-right";

  // Filter/search input
  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "fjv-filter";
  filterInput.placeholder = "Filter…";
  filterInput.value = _fjvFilterText;
  filterInput.title = "Filter keys (type to search)";
  filterInput.setAttribute("aria-label", "Filter frame data keys");
  filterInput.addEventListener("input", () => {
    _fjvFilterText = filterInput.value.trim().toLowerCase();
    _reRenderFrameJsonViewerFromCache();
  });

  const filteredEntries = _fjvFilterText
    ? entries.filter(([k]) => k.toLowerCase().includes(_fjvFilterText))
    : entries;

  const colCount = document.createElement("span");
  colCount.className = "fjv-subtitle";
  colCount.textContent = _fjvFilterText
    ? `${filteredEntries.length} / ${entries.length} cols`
    : `${entries.length} cols`;

  const arrKeys = arrEntries.map(([k]) => k);
  const allExpanded = arrKeys.length > 0 && arrKeys.every(k => _fjvExpanded[k]);
  const expandAllBtn = document.createElement("button");
  expandAllBtn.type = "button";
  expandAllBtn.className = "fjv-copy-btn";
  expandAllBtn.title = allExpanded ? "Collapse all arrays" : "Expand all arrays";
  expandAllBtn.innerHTML = allExpanded
    ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`
    : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  expandAllBtn.style.display = arrKeys.length ? "" : "none";
  expandAllBtn.addEventListener("click", () => {
    const next = !allExpanded;
    arrKeys.forEach(k => { _fjvExpanded[k] = next; });
    updateFrameJsonViewer(true);
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "fjv-copy-btn";
  copyBtn.title = "Copy as JSON";
  copyBtn.innerHTML =
    `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener("click", () => {
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json).then(
      () => showCopyToast("Frame data copied as JSON", "success"),
      () => showCopyToast("Copy failed", "error"),
    );
  });

  rightGroup.appendChild(colCount);
  rightGroup.appendChild(expandAllBtn);
  rightGroup.appendChild(copyBtn);
  hdr.appendChild(titleSpan);
  hdr.appendChild(filterInput);
  hdr.appendChild(rightGroup);
  panel.appendChild(hdr);

  // Key-value table (use filtered entries if filter is active)
  const table = document.createElement("div");
  table.className = "fjv-table";

  // Divider between groups
  const addDivider = (label) => {
    const div = document.createElement("div");
    div.className = "fjv-group-divider";
    div.setAttribute("data-label", label);
    table.appendChild(div);
  };

  // Partition filtered entries by type
  const annFiltered = filteredEntries.filter(([k]) => annFields.has(k));
  const arrFiltered = filteredEntries.filter(([k]) => arrEntries.some(([ak]) => ak === k));
  const scalarFiltered = filteredEntries.filter(([k]) => scalarEntries.some(([sk]) => sk === k));

  if (annFiltered.length > 0) {
    addDivider("annotations");
    annFiltered.forEach(([k, v]) => _fjvAppendRow(table, k, v, true));
  }
  if (scalarFiltered.length > 0) {
    if (annFiltered.length > 0) addDivider("metadata");
    scalarFiltered.forEach(([k, v]) => _fjvAppendRow(table, k, v, false));
  }
  if (arrFiltered.length > 0) {
    addDivider("arrays");
    arrFiltered.forEach(([k, v]) => _fjvAppendRow(table, k, v, false));
  }

  if (filteredEntries.length === 0 && _fjvFilterText) {
    const noMatch = document.createElement("div");
    noMatch.className = "fjv-no-match";
    noMatch.textContent = `No columns match "${_fjvFilterText}"`;
    panel.appendChild(noMatch);
  } else {
    panel.appendChild(table);
  }
}

/* ── Playback ────────────────────────────────────────────── */
function setupControls(ep) {
  const scrubber = el("scrubber");
  scrubber.max = ep.length - 1;
  scrubber.value = 0;
  attr(scrubber, "aria-valuemin", "0");
  attr(scrubber, "aria-valuemax", ep.length - 1);
  attr(scrubber, "aria-valuenow", "0");
  attr(scrubber, "aria-valuetext", "frame 0");
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
  attr(scrubber, "aria-valuenow", state.frame);
  attr(scrubber, "aria-valuetext", titleStr);
  // Fill the scrubber track to show playback progress (CSS --scrub-pct custom property)
  const pct = ep.length > 1 ? (state.frame / (ep.length - 1)) * 100 : 0;
  scrubber.style.setProperty("--scrub-pct", pct.toFixed(1) + "%");
}

function stopPlayback() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.playing = false;
  state.rafId = null;
  state.lastTick = null;
  show("play-icon");
  hide("pause-icon");
  const fpsBadge = el("fps-badge");
  if (fpsBadge) { hide(fpsBadge); fpsBadge.dataset.fast = ""; }
  document.body.classList.remove("is-playing");
  // Strip frame prefix from title when stopped
  document.title = document.title.replace(/^\[\d+\] /, "");
  saveHashState();
}

function changeSpeed(delta) {
  const cur = SPEEDS.indexOf(state.speed);
  const next = cur + delta;
  if (next < 0 || next >= SPEEDS.length) return;
  state.speed = SPEEDS[next];
  el("speed-select").value = state.speed;
  localStorage.setItem("speed", state.speed);
  if (state.playing) { stopPlayback(); startPlayback(); }
  const efps = state.episode ? ` (${Math.round((state.episode.fps || 10) * state.speed)} fps)` : "";
  showCopyToast(`Speed: ${state.speed}×${efps}`);
}

function startPlayback() {
  if (!state.episode) return;
  state.playing = true;
  state.loopCount = 0;
  hide("play-icon");
  show("pause-icon");
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
          show(badge);
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
  state.looping = lsBool("loop");
  toggle("btn-loop", "active", state.looping);
  attr("btn-loop", "aria-pressed", boolStr(state.looping));

  // Restore normalize preference (hash URL takes priority, but localStorage covers no-hash case)
  const savedNorm = localStorage.getItem("normalize");
  if (savedNorm !== null) {
    state.normalizeEnabled = savedNorm === "1";
    _updateNormalizeButtonUI();
  }
}

/* ── Platform detection ──────────────────────────────────── */
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/* ── Event wiring ────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════
   SSH Remote Server Support
   ═══════════════════════════════════════════════════════════ */

function openSSHModal() {
  show("ssh-modal");
  el("ssh-cmd-input")?.focus();
  loadSSHSessionsIntoModal();
}

function closeSSHModal() {
  hide("ssh-modal");
  hide("ssh-connect-error");
}

async function loadSSHSessionsIntoModal() {
  try {
    const data = await apiFetch("/api/ssh/sessions");
    state.sshSessions = data.active || [];
    _renderSSHActiveSessions(data.active || []);
    _renderSSHHistory(data.history || []);
  } catch (_) {}
}

function _renderSSHActiveSessions(sessions) {
  const section = el("ssh-active-sessions");
  const body = el("ssh-sessions-body");
  if (!section || !body) return;
  if (!sessions.length) { hide(section); return; }
  show(section);
  body.innerHTML = "";
  for (const sess of sessions) {
    const row = document.createElement("div");
    row.className = "ssh-session-row";
    const dsCount = sess.datasets?.length ?? 0;
    row.innerHTML =
      `<div class="ssh-session-info">` +
      `<span class="ssh-session-label">${escapeHTML(sess.label)}</span>` +
      `<span class="ssh-session-meta">${escapeHTML(sess.remote_path)} · ${dsCount} dataset${dsCount !== 1 ? "s" : ""}</span>` +
      `</div>` +
      `<button type="button" class="ssh-disconnect-btn" data-sid="${escapeHTML(sess.session_id)}" title="Disconnect">` +
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
      `</button>`;
    row.querySelector(".ssh-disconnect-btn").addEventListener("click", async (e) => {
      const sid = e.currentTarget.dataset.sid;
      await sshDisconnect(sid);
      loadSSHSessionsIntoModal();
    });
    body.appendChild(row);
  }
}

function _renderSSHHistory(history) {
  const section = el("ssh-history-section");
  const body = el("ssh-history-body");
  if (!section || !body) return;
  if (!history.length) { hide(section); return; }
  show(section);
  body.innerHTML = "";
  for (const h of history.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "ssh-history-row";
    const date = h.last_used ? new Date(h.last_used).toLocaleDateString() : "";
    row.innerHTML =
      `<div class="ssh-history-info">` +
      `<span class="ssh-session-label">${escapeHTML(h.label || h.ssh_command)}</span>` +
      `<span class="ssh-session-meta">${escapeHTML(h.remote_path)}${date ? ` · ${date}` : ""}</span>` +
      `</div>` +
      `<button type="button" class="ssh-history-use-btn" title="Use this connection">` +
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>` +
      `</button>`;
    row.querySelector(".ssh-history-use-btn").addEventListener("click", () => {
      el("ssh-cmd-input").value = h.ssh_command;
      el("ssh-path-input").value = h.remote_path;
    });
    body.appendChild(row);
  }
}

async function sshConnect() {
  const cmd = el("ssh-cmd-input")?.value?.trim();
  const path = el("ssh-path-input")?.value?.trim();
  if (!cmd || !path) { _sshShowError("Please fill in both fields."); return; }
  const btn = el("ssh-connect-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  hide("ssh-connect-error");
  try {
    const data = await apiPost("/api/ssh/connect", { ssh_command: cmd, remote_path: path });
    const sessionId = data.session_id;
    btn.textContent = "Discovering…";
    const datasets = await apiFetch(`/api/ssh/sessions/${sessionId}/discover`);
    showCopyToast(`Connected to ${data.label}: ${datasets.length} dataset${datasets.length !== 1 ? "s" : ""} found`);
    closeSSHModal();
    await refreshSSHSections();
  } catch (e) {
    _sshShowError(e.message || "Connection failed");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg> Connect`;
  }
}

async function sshDisconnect(sessionId) {
  try {
    await apiPost(`/api/ssh/sessions/${sessionId}`, null, "DELETE");
    showCopyToast("SSH session disconnected");
  } catch (e) {
    showCopyToast(`Disconnect failed: ${e.message}`, "error");
  } finally {
    await refreshSSHSections();
  }
}

function _sshShowError(msg) {
  const errEl = el("ssh-connect-error");
  if (errEl) { errEl.textContent = msg; show(errEl); }
}

async function refreshSSHSections() {
  try {
    const data = await apiFetch("/api/ssh/sessions");
    state.sshSessions = data.active || [];
  } catch (_) {
    state.sshSessions = [];
  }
  renderSSHSections();
}

function renderSSHSections() {
  const container = el("ssh-remote-tree");
  if (!container) return;
  container.innerHTML = "";
  if (!state.sshSessions.length) return;
  for (const sess of state.sshSessions) {
    const datasets = sess.datasets || [];
    if (!datasets.length) continue;
    // Section header
    const sectionEl = document.createElement("div");
    sectionEl.className = "ssh-section";
    const headerEl = document.createElement("div");
    headerEl.className = "ssh-section-header";
    headerEl.innerHTML =
      `<svg class="ssh-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>` +
      `<span class="ssh-section-label-text">${escapeHTML(sess.label)}</span>` +
      `<span class="ssh-section-path" title="${escapeHTML(sess.remote_path)}">${escapeHTML(sess.remote_path)}</span>` +
      `<button type="button" class="ssh-section-disconnect" data-sid="${escapeHTML(sess.session_id)}" title="Disconnect">` +
      `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
      `</button>`;
    headerEl.querySelector(".ssh-section-disconnect").addEventListener("click", async (e) => {
      e.stopPropagation();
      await sshDisconnect(e.currentTarget.dataset.sid);
    });
    sectionEl.appendChild(headerEl);
    // Dataset nodes
    for (const ds of datasets) {
      const node = buildDatasetNode({
        name: ds.name,
        path: ds.virtual_name,
        total_episodes: ds.total_episodes,
        total_tasks: ds.total_tasks,
        robot_type: ds.robot_type,
        fps: ds.fps,
        isRemote: true,
      });
      node.classList.add("ds-node-remote");
      const nameEl = node.querySelector(".ds-name");
      if (nameEl) {
        const badge = document.createElement("span");
        badge.className = "ssh-remote-badge";
        badge.title = ds.remote_path;
        badge.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M10.19 15.19l1.81 1.81 1.81-1.81"/><circle cx="12" cy="20" r="1"/></svg>`;
        nameEl.parentNode.insertBefore(badge, nameEl);
      }
      sectionEl.appendChild(node);
    }
    container.appendChild(sectionEl);
  }
}

// ── Robot 3D Panel ───────────────────────────────────────────────────────────
// Franka Panda FK + Three.js scene.
// Joint params extracted from panda_arm.urdf (frankaemika/polymetis).
// Each revolute joint: T = T_origin(xyz,rpy) × Rz(θ).  All axes = [0 0 1].
// URDF uses z-up; Three.js uses y-up → robotGroup.rotation.x = -π/2.

// ── Robot 3D Panel — URDF + STL mesh renderer ────────────────────────────────
// Loads /robot/panda_arm.urdf, parses the kinematic chain, then loads the
// collision STL meshes (/robot/meshes/collision/*.stl).  Joint angles from
// episode.state[:,0:7] drive the scene-graph rotations in real time.

const RobotPanel = (() => {
  const URDF_URL  = "/robot/panda_arm.urdf";
  const MESH_BASE = "/robot/";           // base URL; mesh filename from URDF appended

  // ── URDF helpers ─────────────────────────────────────────────────────────
  function _v3(s) { return (s || "0 0 0").trim().split(/\s+/).map(Number); }

  // URDF rpy convention: R = Rz(yaw)·Ry(pitch)·Rx(roll) = intrinsic XYZ
  function _originGroup(xyz, rpy) {
    const g = new THREE.Group();
    g.position.set(...xyz);
    g.rotation.set(...rpy);   // default order 'XYZ' matches URDF intrinsic XYZ
    return g;
  }

  function _parseURDF(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const links = {}, joints = {};
    for (const el of doc.querySelectorAll("link")) {
      const name    = el.getAttribute("name");
      const meshEl  = el.querySelector("visual mesh");
      const origEl  = el.querySelector("visual origin");
      links[name] = {
        meshFile: meshEl?.getAttribute("filename") ?? null,
        vOrigin:  { xyz: _v3(origEl?.getAttribute("xyz")), rpy: _v3(origEl?.getAttribute("rpy")) },
      };
    }
    for (const el of doc.querySelectorAll("joint")) {
      const name   = el.getAttribute("name");
      const origEl = el.querySelector("origin");
      joints[name] = {
        parent: el.querySelector("parent")?.getAttribute("link"),
        child:  el.querySelector("child")?.getAttribute("link"),
        type:   el.getAttribute("type"),
        origin: { xyz: _v3(origEl?.getAttribute("xyz")), rpy: _v3(origEl?.getAttribute("rpy")) },
      };
    }
    return { links, joints };
  }

  // ── STL mesh loader ───────────────────────────────────────────────────────
  const LINK_COLOR = {
    panda_link0: 0x555555, panda_link7: 0x666666,
  };
  const DEF_COLOR_WHITE = 0xd8d8d8;
  const DEF_COLOR_DARK  = 0x666666;

  function _loadMeshes(links) {
    const loader  = new THREE.STLLoader();
    const meshMap = {};
    const proms   = Object.entries(links).map(([name, def]) => {
      if (!def.meshFile) return Promise.resolve();
      // Map visual DAE path → collision STL path
      const stlFile = def.meshFile.replace("visual/", "collision/").replace(".dae", ".stl");
      const url     = MESH_BASE + stlFile;
      const color   = LINK_COLOR[name] ?? DEF_COLOR_WHITE;
      return new Promise(res => {
        loader.load(url, geo => {
          geo.computeVertexNormals();
          const mat  = new THREE.MeshPhongMaterial({ color, specular: 0x333333, shininess: 80 });
          const mesh = new THREE.Mesh(geo, mat);
          // Apply per-link visual origin offset (usually zero for Panda)
          if (def.vOrigin) {
            mesh.position.set(...def.vOrigin.xyz);
            mesh.rotation.set(...def.vOrigin.rpy);
          }
          meshMap[name] = mesh;
          res();
        }, undefined, () => res());   // ignore load errors — link just stays invisible
      });
    });
    return Promise.all(proms).then(() => meshMap);
  }

  // ── Kinematic scene graph ─────────────────────────────────────────────────
  // _jNodes[jname]   = rotGroup that gets rotation.z = θ (revolute joints)
  // _flangeGroup     = panda_link8 Group; Robotiq gripper is attached here
  const _jNodes = {};
  let _flangeGroup = null;

  function _buildGraph(links, joints, meshMap) {
    const isChild = new Set(Object.values(joints).map(j => j.child));
    const rootName = Object.keys(links).find(n => !isChild.has(n)) ?? "panda_link0";

    const childOf = {};
    for (const [jn, jd] of Object.entries(joints)) {
      (childOf[jd.parent] ??= []).push(jn);
    }

    function buildLink(linkName) {
      const linkGroup = new THREE.Group();
      linkGroup.name = linkName;
      if (meshMap[linkName]) linkGroup.add(meshMap[linkName]);
      // Track the flange so we can attach the gripper after the graph is built
      if (linkName === "panda_link8") _flangeGroup = linkGroup;

      for (const jname of (childOf[linkName] ?? [])) {
        const jd = joints[jname];
        const origG = _originGroup(jd.origin.xyz, jd.origin.rpy);
        origG.name  = `${jname}_origin`;
        linkGroup.add(origG);

        const rotG = new THREE.Group();
        rotG.name  = `${jname}_rot`;
        origG.add(rotG);

        if (jd.type === "revolute" || jd.type === "continuous") {
          _jNodes[jname] = rotG;
        }

        rotG.add(buildLink(jd.child));
      }
      return linkGroup;
    }

    return buildLink(rootName);
  }

  // ── Robotiq 2F-85 gripper geometry ───────────────────────────────────────
  // Hand-crafted from the official spec: 68 mm wide, ~115 mm total height,
  // 85 mm full stroke (42.5 mm per finger from center-line).
  // Coordinate frame: panda_link8 local, +Z = gripper approach direction.
  //
  //   z=0.000  flange face
  //   z=0.012  top of coupler plate
  //   z=0.066  top of main housing
  //   z=0.092  start of finger rail
  //   z=0.118  fingertip (roughly)
  //
  let _fingerR = null, _fingerL = null;

  function _buildGripper() {
    const group = new THREE.Group();
    group.name  = "robotiq_2f85";

    // Shared materials — Robotiq's dark charcoal / anthracite palette
    const mBody   = () => new THREE.MeshPhongMaterial({ color: 0x2b2b2b, specular: 0x3a3a3a, shininess: 90 });
    const mHouse  = () => new THREE.MeshPhongMaterial({ color: 0x1e1e1e, specular: 0x282828, shininess: 70 });
    const mFinger = () => new THREE.MeshPhongMaterial({ color: 0x3c3c3c, specular: 0x303030, shininess: 60 });
    const mPad    = () => new THREE.MeshPhongMaterial({ color: 0x111111, specular: 0x111111, shininess: 20 });

    function addBox(parent, w, d, h, x, y, z, matFn) {
      // Three.js BoxGeometry(width=X, height=Y, depth=Z) — our "up" axis in gripper frame is Z
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), matFn());
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    }
    function addCyl(parent, r, h, x, y, z, rx, matFn) {
      // CylinderGeometry aligned along Y by default; rx rotates it to desired axis
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), matFn());
      m.rotation.x = rx ?? 0;
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    }

    // ── Coupler plate (ISO 9283 flange adapter) ─────────────────────────────
    addBox(group, 0.062, 0.062, 0.012,  0,  0, 0.006,  mBody);   // plate
    addCyl(group, 0.012, 0.006, 0,  0,  0.009, Math.PI/2, mHouse); // center boss

    // ── Main housing ────────────────────────────────────────────────────────
    addBox(group, 0.068, 0.046, 0.052,  0,  0, 0.038,  mHouse);  // main block
    addBox(group, 0.060, 0.040, 0.008,  0,  0, 0.068,  mHouse);  // top cap
    // Side shoulders (where fingers are guided)
    addBox(group, 0.068, 0.010, 0.022,  0, +0.028, 0.055, mBody);
    addBox(group, 0.068, 0.010, 0.022,  0, -0.028, 0.055, mBody);
    // Motor housing (small cylinder on top center)
    addCyl(group, 0.011, 0.016, 0, 0, 0.080, Math.PI/2, mBody);

    // ── Static finger rails (guide tracks) ─────────────────────────────────
    addBox(group, 0.014, 0.014, 0.026,  0, +0.025, 0.085, mFinger);
    addBox(group, 0.014, 0.014, 0.026,  0, -0.025, 0.085, mFinger);

    // ── Moveable finger groups ─────────────────────────────────────────────
    // Each finger: proximal link + distal tip + rubber pad
    function makeFinger(ySign) {
      const fg = new THREE.Group();
      // Proximal link
      addBox(fg, 0.018, 0.012, 0.044,  0, 0, 0.022, mFinger);
      // Knuckle / joint sphere suggestion
      addBox(fg, 0.022, 0.018, 0.010,  0, 0, 0.047, mBody);
      // Distal link (angled toward center-line)
      addBox(fg, 0.016, 0.011, 0.028,  0, ySign * (-0.004), 0.069, mFinger);
      // Rubber contact pad (darkest)
      addBox(fg, 0.024, 0.012, 0.014,  0, ySign * (-0.008), 0.087, mPad);
      return fg;
    }

    _fingerR = makeFinger(+1);
    _fingerL = makeFinger(-1);
    _fingerR.name = "finger_right";
    _fingerL.name = "finger_left";
    group.add(_fingerR, _fingerL);
    // Initial position will be set by first _updateGripper() call
    _updateGripper(0);   // fully open

    return group;
  }

  // gripper_state: 0.0 = fully open (42.5 mm each side), 0.75 = closed
  function _updateGripper(gState) {
    if (!_fingerR || !_fingerL) return;
    const open   = Math.max(0, Math.min(1, 1 - gState / 0.75));
    const halfGap = 0.021 + open * 0.021;   // 21 mm closed → 42 mm open (per side)
    _fingerR.position.set(0, +halfGap, 0.092);
    _fingerL.position.set(0, -halfGap, 0.092);
  }

  // ── Orbit + pan camera ───────────────────────────────────────────────────
  // Left-drag          : orbit (rotate around target)
  // Right-drag or Shift+left-drag : pan (translate the target point)
  // Scroll             : zoom (change orbit radius)
  // Two-finger pinch   : zoom
  // Two-finger drag    : pan (touch)

  let renderer = null, scene, camera;
  const _orb    = { theta: 0.7, phi: 1.05, r: 1.9 };
  const _orbTgt = { x: 0, y: 0.4, z: 0 };   // look-at target; plain obj (no THREE at parse time)
  const _VIEW_KEY = "robotPanelView";
  let _drag = false, _panning = false, _lx = 0, _ly = 0, _td = 0;

  function _camUpdate() {
    const sp = Math.sin(_orb.phi), cp = Math.cos(_orb.phi);
    const st = Math.sin(_orb.theta), ct = Math.cos(_orb.theta);
    camera.position.set(_orbTgt.x + _orb.r * sp * st,
                        _orbTgt.y + _orb.r * cp,
                        _orbTgt.z + _orb.r * sp * ct);
    camera.lookAt(_orbTgt.x, _orbTgt.y, _orbTgt.z);
  }

  // Pan: translate the look-at target in the camera's view-plane.
  // right = (cos θ,             0,            -sin θ)
  // up    = (-sin θ · cos φ,  sin φ,  -cos θ · cos φ)
  // (derived analytically from the spherical-coordinate orbit, avoids THREE.Vector3)
  function _pan(dx, dy) {
    const st = Math.sin(_orb.theta), ct = Math.cos(_orb.theta);
    const sp = Math.sin(_orb.phi),   cp = Math.cos(_orb.phi);
    const scale = _orb.r * 0.0012;
    // target += dx * right - dy * up
    _orbTgt.x += ( dx * ct - dy * (-st * cp)) * scale;
    _orbTgt.y += (           -dy *   sp      ) * scale;
    _orbTgt.z += (-dx * st - dy * (-ct * cp) ) * scale;
    _camUpdate();
  }

  function _saveDefaultView() {
    localStorage.setItem(_VIEW_KEY, JSON.stringify({ orb: {..._orb}, tgt: {..._orbTgt} }));
    // Visual feedback: flash the button yellow
    const btn = document.getElementById("robot-save-view-btn");
    if (btn) {
      btn.classList.add("rp-saved");
      setTimeout(() => btn.classList.remove("rp-saved"), 1200);
    }
    // Toast notification
    const toast = document.createElement("div");
    toast.className = "rp-toast";
    toast.textContent = "View saved as default";
    (document.getElementById("robot-canvas-wrap") ?? document.body).appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  function _loadSavedView() {
    try {
      const d = JSON.parse(localStorage.getItem(_VIEW_KEY) ?? "null");
      if (d?.orb && d?.tgt) { Object.assign(_orb, d.orb); Object.assign(_orbTgt, d.tgt); }
    } catch (_) {}
  }

  function _bindOrbit(canvas) {
    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("mousedown", e => {
      if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
        _panning = true;
      } else if (e.button === 0) {
        _drag = true;
      }
      _lx = e.clientX; _ly = e.clientY;
    });
    canvas.addEventListener("mousemove", e => {
      const dx = e.clientX - _lx, dy = e.clientY - _ly;
      if (_panning) {
        _pan(dx, dy);
      } else if (_drag) {
        _orb.theta -= dx * 0.012;
        _orb.phi    = Math.max(0.05, Math.min(Math.PI - 0.05, _orb.phi + dy * 0.012));
        _camUpdate();
      }
      _lx = e.clientX; _ly = e.clientY;
    });
    canvas.addEventListener("mouseup",    () => { _drag = false; _panning = false; });
    canvas.addEventListener("mouseleave", () => { _drag = false; _panning = false; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      _orb.r = Math.max(0.4, Math.min(5.0, _orb.r + e.deltaY * 0.0025));
      _camUpdate();
    }, { passive: false });

    // Touch: single finger = orbit, two fingers = pinch-zoom + two-finger pan
    let _tlx = 0, _tly = 0;
    canvas.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        _drag = true;
        _lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        _drag = false;
        _td  = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                          e.touches[0].clientY - e.touches[1].clientY);
        _tlx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        _tly = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      }
    }, { passive: true });
    canvas.addEventListener("touchmove", e => {
      e.preventDefault();
      if (e.touches.length === 1 && _drag) {
        const dx = e.touches[0].clientX - _lx, dy = e.touches[0].clientY - _ly;
        _orb.theta -= dx * 0.012;
        _orb.phi = Math.max(0.05, Math.min(Math.PI - 0.05, _orb.phi + dy * 0.012));
        _lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
        _camUpdate();
      } else if (e.touches.length === 2) {
        const mx  = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my  = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const d   = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                               e.touches[0].clientY - e.touches[1].clientY);
        _orb.r = Math.max(0.4, Math.min(5.0, _orb.r + (_td - d) * 0.008));
        _pan(mx - _tlx, my - _tly);   // two-finger pan
        _td = d; _tlx = mx; _tly = my;
      }
    }, { passive: false });
    canvas.addEventListener("touchend", () => { _drag = false; _panning = false; });
  }

  // ── init ─────────────────────────────────────────────────────────────────
  function init() {
    if (typeof THREE === "undefined" || typeof THREE.STLLoader === "undefined") {
      console.warn("RobotPanel: THREE or STLLoader not available");
      return;
    }
    const canvas = document.getElementById("robot-canvas");
    const wrap   = document.getElementById("robot-canvas-wrap");
    if (!canvas || !wrap) return;

    // Restore previously saved default view (overwrites hardcoded defaults)
    _loadSavedView();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d1a);

    const w = wrap.clientWidth || 300, h = wrap.clientHeight || 400;
    camera = new THREE.PerspectiveCamera(44, w / h, 0.01, 10);
    _camUpdate();

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Lights: key + fill + ambient
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(1.5, 3, 2);   scene.add(key);
    const fill= new THREE.DirectionalLight(0x88aaff, 0.4); fill.position.set(-2, 1, -1.5);scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffeedd, 0.3); rim.position.set(0, -1, 2);    scene.add(rim);

    scene.add(new THREE.GridHelper(2, 10, 0x1a3050, 0x0f1f35));

    _bindOrbit(canvas);

    new ResizeObserver(() => {
      if (!renderer) return;
      const w2 = wrap.clientWidth, h2 = wrap.clientHeight;
      if (w2 < 1 || h2 < 1) return;
      renderer.setSize(w2, h2);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    }).observe(wrap);

    (function _loop() { requestAnimationFrame(_loop); if (renderer) renderer.render(scene, camera); })();

    // ── Async load URDF + STL meshes ───────────────────────────────────────
    const emptyEl = document.getElementById("robot-empty-msg");
    if (emptyEl) emptyEl.textContent = "Loading robot…";

    fetch(URDF_URL)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(xml => {
        const { links, joints } = _parseURDF(xml);
        return _loadMeshes(links).then(meshMap => ({ links, joints, meshMap }));
      })
      .then(({ links, joints, meshMap }) => {
        const root = _buildGraph(links, joints, meshMap);
        // URDF uses z-up; Three.js uses y-up
        root.rotation.x = -Math.PI / 2;
        scene.add(root);

        // Attach Robotiq 2F-85 gripper to Franka flange (panda_link8)
        if (_flangeGroup) {
          _flangeGroup.add(_buildGripper());
        }

        if (emptyEl) emptyEl.style.display = "none";
        // Apply pose if episode already playing (pass full 8-element state)
        if (state.episode?.state?.[state.frame]) {
          update(state.episode.state[state.frame].slice(0, 8));
        }
      })
      .catch(err => {
        console.error("RobotPanel load error:", err);
        if (emptyEl) emptyEl.textContent = "Failed to load robot";
      });
  }

  // ── update: joints[0..6] = arm angles, joints[7] = gripper state ─────────
  function update(joints) {
    if (!renderer) return;
    for (let i = 0; i < 7; i++) {
      const g = _jNodes[`panda_joint${i + 1}`];
      if (g) g.rotation.z = joints[i];
    }
    if (joints.length > 7) _updateGripper(joints[7]);
  }

  function reset() { /* keep model visible; episode unloaded is fine */ }

  return { init, update, reset, saveView: _saveDefaultView };
})();

// ── Robot panel toggle ───────────────────────────────────────────────────────
function initRobotPanelToggle() {
  const panel  = document.getElementById("robot-panel");
  const topBtn = document.getElementById("robot-panel-btn");
  const colBtn = document.getElementById("robot-panel-collapse");
  const chev   = document.getElementById("rp-chevron");
  if (!panel) return;

  // chevron: ‹ (15 6 9 12 15 18) = left = "open", › (9 18 15 12 9 6) = right = "collapse"
  function _syncChevron(isHidden) {
    if (!chev) return;
    chev.querySelector("polyline")?.setAttribute(
      "points", isHidden ? "15 18 9 12 15 6" : "9 18 15 12 9 6"
    );
    colBtn?.setAttribute("title", isHidden ? "Open robot panel" : "Collapse robot panel");
  }

  // Restore persisted state (default: visible)
  const hidden = localStorage.getItem("robotPanelHidden") === "1";
  if (hidden) {
    panel.classList.add("rp-hide");
    topBtn?.setAttribute("aria-pressed", "false");
    topBtn?.classList.remove("active");
  } else {
    topBtn?.setAttribute("aria-pressed", "true");
    topBtn?.classList.add("active");
  }
  _syncChevron(hidden);

  function toggle() {
    const nowHidden = panel.classList.toggle("rp-hide");
    topBtn?.setAttribute("aria-pressed", nowHidden ? "false" : "true");
    topBtn?.classList.toggle("active", !nowHidden);
    localStorage.setItem("robotPanelHidden", nowHidden ? "1" : "0");
    _syncChevron(nowHidden);
  }

  topBtn?.addEventListener("click", toggle);
  colBtn?.addEventListener("click", toggle);

  // Save-view button (star): delegate to RobotPanel.saveView()
  document.getElementById("robot-save-view-btn")
    ?.addEventListener("click", () => RobotPanel.saveView());
}

// ── Robot panel drag-resize ──────────────────────────────────────────────────
function initRobotPanelResize() {
  const handle = document.getElementById("robot-resize-handle");
  const panel  = document.getElementById("robot-panel");
  if (!handle || !panel) return;

  // Restore saved width
  const saved = parseInt(localStorage.getItem("robotPanelWidth") ?? "", 10);
  if (!isNaN(saved) && saved >= 200 && saved <= 640) {
    panel.style.width = saved + "px";
  }

  handle.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = panel.offsetWidth;
    handle.classList.add("rh-active");
    // Disable CSS transition while dragging for crisp feedback
    panel.style.transition = "none";
    document.body.style.cursor    = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(e) {
      // handle is on the left edge; dragging left → wider
      const delta    = startX - e.clientX;
      const newWidth = Math.max(200, Math.min(640, startWidth + delta));
      panel.style.width = newWidth + "px";
    }

    function onUp() {
      handle.classList.remove("rh-active");
      panel.style.transition = "";       // restore CSS transition
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      localStorage.setItem("robotPanelWidth", panel.offsetWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initDarkMode();
  initSidebarState();
  initFrameCounterJump();
  initPlaybackPreferences();
  loadRecentEpisodes();
  updateRecentSection();
  // Restore mirror mode
  _mirrorMode = lsBool("mirrorMode");
  if (_mirrorMode) _applyMirrorMode(true);

  // Restore persisted chart UI states
  state.stateExpanded  = lsBool("expand_state");
  state.actionExpanded = lsBool("expand_action");
  state.histState  = lsBool("hist_state");
  state.histAction = lsBool("hist_action");

  // Restore frame values sort preference
  _fvSortActive = lsBool("fvSort");

  // Restore annotation tab preference (single key replaces old multi-flag scheme)
  const _savedAnnTab = localStorage.getItem("annActiveTab");
  if (_savedAnnTab && ["annotate", "annotated", "schema", "saved"].includes(_savedAnnTab)) {
    _annActiveTab = _savedAnnTab;
  }

  // Restore corr/timedim open state (will take effect after episode loads)
  if (lsBool("corrOpen")) {
    el("corr-body")?.classList.remove("corr-collapsed");
    if (el("corr-section")) el("corr-section").dataset.open = "1";
    el("corr-close")?.classList.add("active");
    attr("corr-close", "aria-expanded", "true");
  }
  if (lsBool("timedimOpen")) {
    el("timedim-body")?.classList.remove("timedim-collapsed");
    if (el("timedim-card")) el("timedim-card").dataset.open = "1";
    el("timedim-toggle")?.classList.add("active");
    attr("timedim-toggle", "aria-expanded", "true");
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

  // Robot 3D panel
  RobotPanel.init();
  initRobotPanelToggle();
  initRobotPanelResize();

  // SSH modal
  el("ssh-btn")?.addEventListener("click", openSSHModal);
  el("ssh-cancel-btn")?.addEventListener("click", closeSSHModal);
  el("ssh-connect-btn")?.addEventListener("click", sshConnect);
  el("ssh-modal")?.addEventListener("click", e => { if (e.target === el("ssh-modal")) closeSSHModal(); });
  el("ssh-cmd-input")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el("ssh-path-input")?.focus(); } });
  el("ssh-path-input")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sshConnect(); } });
  // Load any previously active SSH sessions (backend state survives server restart? No, but
  // we call this anyway in case the page is reloaded while server is still running)
  refreshSSHSections();

  // Pause playback when tab becomes hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) stopPlayback();
  });

  // Viewer tabs
  document.querySelectorAll(".viewer-tab").forEach(btn => {
    btn.addEventListener("click", () => switchViewerTab(btn.dataset.tab));
  });

  el("sidebar-toggle").addEventListener("click", toggleSidebar);
  el("dark-mode-btn").addEventListener("click", toggleDarkMode);
  el("collapse-all-btn").addEventListener("click", collapseAllTasks);
  el("refresh-btn").addEventListener("click", loadDatasets);
  el("dl-state").addEventListener("click", () => downloadChart("state"));
  el("dl-action").addEventListener("click", () => downloadChart("action"));
  el("dl-corr").addEventListener("click", downloadCorr);
  el("dl-timedim").addEventListener("click", downloadTimedim);
  document.querySelector(".lightbox-prev")?.addEventListener("click", () => lightboxNavigate(-1));
  document.querySelector(".lightbox-next")?.addEventListener("click", () => lightboxNavigate(1));
  el("lightbox-dl")?.addEventListener("click", downloadLightboxFrame);

  el("btn-play").addEventListener("click", () => {
    if (state.playing) stopPlayback(); else startPlayback();
    attr("btn-play", "aria-label", state.playing ? "Pause playback" : "Start playback");
  });
  el("btn-rewind").addEventListener("click", () => { stopPlayback(); setFrame(0); });
  el("btn-loop").addEventListener("click", toggleLooping);
  el("btn-prev-ep").addEventListener("click", prevEpisode);
  el("btn-next-ep").addEventListener("click", nextEpisode);

  // FPS badge click toggles loop (convenient during playback)
  el("fps-badge")?.addEventListener("click", () => {
    toggleLooping();
    showCopyToast(state.looping ? "Loop on" : "Loop off");
  });
  el("btn-export").addEventListener("click", exportFrame);
  el("btn-frame-values").addEventListener("click", toggleFrameValuesPanel);
  el("btn-frame-json")?.addEventListener("click", toggleFrameJsonViewer);
  el("btn-normalize")?.addEventListener("click", toggleNormalize);
  el("btn-csv")?.addEventListener("click", exportCSV);
  el("btn-copy-url")?.addEventListener("click", copyEpisodeURL);

  // Disable export buttons initially
  setDisabled(["btn-export", "btn-csv", "btn-frame-values", "btn-frame-json"], true);

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
    show(_scrubTooltipEl);
  });
  el("scrubber").addEventListener("mouseleave", () => {
    hide(_scrubTooltipEl);
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
    if (isActivate(e)) { e.preventDefault(); _copyTaskLabel(); }
  });
  el("task-label").title = "Click to copy task description";

  el("corr-close").addEventListener("click", () => {
    const body = el("corr-body");
    const nowCollapsed = toggle(body, "corr-collapsed");
    el("corr-section").dataset.open = nowCollapsed ? "" : "1";
    toggle("corr-close", "active", !nowCollapsed);
    attr("corr-close", "aria-expanded", boolStr(!nowCollapsed));
    lsFlag("corrOpen", !nowCollapsed);
    if (!nowCollapsed && state.episode) buildCorrelationHeatmap(state.episode);
  });

  el("timedim-toggle").addEventListener("click", () => {
    const card = el("timedim-card");
    const body = el("timedim-body");
    const nowCollapsed = toggle(body, "timedim-collapsed");
    card.dataset.open = nowCollapsed ? "" : "1";
    toggle("timedim-toggle", "active", !nowCollapsed);
    attr("timedim-toggle", "aria-expanded", boolStr(!nowCollapsed));
    lsFlag("timedimOpen", !nowCollapsed);
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
  const _inputTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    const inInput = _inputTags.has(tag);

    if (e.key === "?" && !inInput) {
      e.preventDefault();
      const modal = el("shortcuts-modal");
      const nowHidden = toggle(modal, "hidden");
      attr("btn-shortcuts", "aria-expanded", boolStr(!nowHidden));
      return;
    }

    // Ctrl/Cmd shortcuts that should fire even when an input/select is focused
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "s") {
        e.preventDefault();
        if (state.viewerTab === "annotate" && !isHidden("annotation-panel")) {
          fillAndSaveAllAnnotations();
        } else {
          exportFrame();
        }
        return;
      }
    }

    if (inInput) return;

    if (isKey(e, "b")) {
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
    if (e.key === "/" || isKey(e, "g") || (modKey && e.key === "k")) {
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
      if (hasActiveEp()) {
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
      // handled above (before inInput guard) to fire even when a select is focused
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
      if (!isHidden("cam-lightbox")) {
        _lbSetZoom(_lbZoom * 1.2);
      } else {
        changeSpeed(+1);
      }
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      if (!isHidden("cam-lightbox")) {
        _lbSetZoom(_lbZoom / 1.2);
      } else {
        changeSpeed(-1);
      }
      return;
    }
    if (isKey(e, "l")) {
      e.preventDefault();
      toggleLooping();
      return;
    }
    if (isKey(e, "h")) {
      e.preventDefault();
      toggleHistogram(e.shiftKey ? "action" : "state");
      return;
    }
    if (isKey(e, "e")) {
      e.preventDefault();
      toggleExpand(e.shiftKey ? "action" : "state");
      return;
    }
    if (isKey(e, "t")) {
      e.preventDefault();
      el("timedim-toggle")?.click();
      return;
    }
    if (isKey(e, "k")) {
      e.preventDefault();
      el("corr-close")?.click();
      return;
    }
    if (isKey(e, "v", "p")) {
      e.preventDefault();
      toggleFrameValuesPanel();
      return;
    }
    if (isKey(e, "z")) {
      e.preventDefault();
      if (hasActiveEp()) toggleFrameJsonViewer();
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
    if (isKey(e, "n")) {
      e.preventDefault();
      toggleNormalize();
      return;
    }
    if (isKey(e, "c")) {
      e.preventDefault();
      copyEpisodeURL();
      return;
    }
    if (isKey(e, "x")) {
      e.preventDefault();
      exportCSV();
      return;
    }
    if (isKey(e, "w")) {
      e.preventDefault();
      exportTimestamps();
      return;
    }
    if (isKey(e, "q")) {
      e.preventDefault();
      const ts = state.episode?.timestamps?.[state.frame];
      if (ts != null) {
        const val = ts.toFixed(6);
        navigator.clipboard.writeText(val).catch(() => {});
        showCopyToast(`✓ t=${val}s (f${state.frame}) copied`, "success");
      }
      return;
    }
    if (isKey(e, "j")) {
      e.preventDefault();
      exportJSON();
      return;
    }
    if (isKey(e, "d")) {
      e.preventDefault();
      // D in lightbox: download current camera frame; outside lightbox: download current frame as PNG
      if (!isHidden("cam-lightbox")) {
        downloadLightboxFrame();
      } else {
        exportFrame();
      }
      return;
    }
    if (isKey(e, "i")) {
      e.preventDefault();
      toggle("ep-info-strip", "hidden");
      return;
    }
    if (isKey(e, "a")) {
      e.preventDefault();
      if (hasActiveEp()) switchViewerTab(state.viewerTab === "annotate" ? "video" : "annotate");
      return;
    }
    if (e.key === "Delete" && state.viewerTab === "annotate") {
      e.preventDefault();
      clearEpisodeAnnotations();
      return;
    }
    if (isKey(e, "o")) {
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
    if (isKey(e, "f")) {
      if (!isHidden("cam-lightbox")) {
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
    if (modKey && isKey(e, "m")) {
      e.preventDefault();
      if (state.episode) {
        stopPlayback();
        setFrame(Math.round((state.episode.length - 1) / 2));
        showCopyToast(`Midpoint → frame ${state.frame}`);
      }
      return;
    }
    if (isKey(e, "m")) {
      e.preventDefault();
      _mirrorMode = !_mirrorMode;
      try { lsFlag("mirrorMode", _mirrorMode); } catch (_) {}
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
        if (!isHidden("cam-lightbox")) {
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
        if (!isHidden("cam-lightbox")) {
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
        if (_annSettingsOpen) {
          _annSettingsOpen = false;
          const sp = el("ann-settings-panel");
          const sb = el("ann-settings-btn");
          if (sp) sp.classList.remove("open");
          if (sb) { sb.classList.remove("active"); sb.setAttribute("aria-pressed", "false"); }
          e.preventDefault();
          break;
        }
        if (state.compareEpisode) { e.preventDefault(); clearCompare(); }
        hide("shortcuts-modal");
        attr("btn-shortcuts", "aria-expanded", "false");
        if (!isHidden("cam-lightbox")) {
          if (_lbZoom > 1) {
            _lbResetZoom(); // First Esc: clear zoom; second Esc: close
          } else {
            hide("cam-lightbox");
            _lbPrevFocus?.focus();
          }
        }
        break;
    }
  });

  el("btn-shortcuts").addEventListener("click", () => {
    const modal = el("shortcuts-modal");
    const nowHidden = toggle(modal, "hidden"); // true = modal is now hidden
    attr("btn-shortcuts", "aria-expanded", boolStr(!nowHidden));
    if (!nowHidden) {
      // Modal just opened — focus the box for keyboard nav
      const box = modal.querySelector(".modal-box");
      if (box && !box.hasAttribute("tabindex")) attr(box, "tabindex", "-1");
      requestAnimationFrame(() => box?.focus());
    }
  });
  // Focus trap inside shortcuts modal
  el("shortcuts-modal").addEventListener("keydown", e => {
    if (isHidden("shortcuts-modal")) return;
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
      hide("shortcuts-modal");
      attr("btn-shortcuts", "aria-expanded", "false");
    }
  });
  // Focus trap inside lightbox
  el("cam-lightbox").addEventListener("keydown", e => {
    if (isHidden("cam-lightbox")) return;
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
      hide("cam-lightbox");
      _lbPrevFocus?.focus();
    }
  });
  el("lightbox-close-btn")?.addEventListener("click", () => {
    hide("cam-lightbox");
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
        hide("cam-lightbox");
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
      attr("sidebar-toggle", "aria-pressed", "true");
    }
  });

  // Auto-collapse sidebar on orientation change (mobile)
  window.addEventListener("resize", () => {
    if (window.innerWidth < SIDEBAR_BREAKPOINT && !el("main").classList.contains("sidebar-collapsed")) {
      el("main").classList.add("sidebar-collapsed");
      attr("sidebar-toggle", "aria-pressed", "true");
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
    if (isHidden("cam-lightbox")) return;
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
      if (!Number.isNaN(speedParam) && SPEEDS.includes(speedParam) && speedParam !== state.speed) {
        state.speed = speedParam;
        el("speed-select").value = speedParam;
        localStorage.setItem("speed", speedParam);
      }
      const nParam = params.get("n");
      const wantNorm = nParam === null || nParam === "1";
      if (wantNorm !== state.normalizeEnabled) {
        state.normalizeEnabled = wantNorm;
        _updateNormalizeButtonUI();
        if (state.episode) { buildCharts(state.episode); updateFrameValues(); }
      }
    }
  });
});
