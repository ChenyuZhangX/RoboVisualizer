/* ── State ───────────────────────────────────────────────── */
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
  frameCache: new Map(),
  prefetchPending: new Set(),
  compareEpisode: null,
  compareDataset: null,
  compareEpIndex: null,
};

const PREFETCH_AHEAD = 8;

/* ── Palettes ────────────────────────────────────────────── */
const PALETTE = [
  "#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6",
  "#06B6D4","#F97316","#EC4899","#14B8A6","#6366F1",
];
const PALETTE_CMP = [
  "#F59E0B","#F97316","#EF4444","#8B5CF6","#EC4899",
  "#14B8A6","#6366F1","#06B6D4","#10B981","#3B82F6",
];

/* ── Normalization ───────────────────────────────────────── */
function normalizeValue(v, q01, q99) {
  if (q99 === q01) return 0;
  const clipped = Math.max(q01, Math.min(q99, v));
  return 2 * (clipped - q01) / (q99 - q01) - 1;
}

function normalizeData(data2d, ns) {
  if (!ns) return { data: data2d, normalized: false };
  const q01 = ns.q01, q99 = ns.q99;
  const normed = data2d.map(row =>
    row.map((v, d) => normalizeValue(v, q01[d], q99[d]))
  );
  return { data: normed, normalized: true };
}

// Map raw mean/std → normalized space for std band overlay
function normalizeMeanStd(ns) {
  if (!ns || !ns.mean || !ns.std) return null;
  const { mean, std, q01, q99 } = ns;
  const normMean = mean.map((m, d) => normalizeValue(m, q01[d], q99[d]));
  const normStd  = std.map((s, d) => q99[d] === q01[d] ? 0 : 2 * s / (q99[d] - q01[d]));
  return { mean: normMean, std: normStd };
}

/* ── Custom Chart.js plugins ─────────────────────────────── */
const cursorPlugin = {
  id: "cursor",
  afterDraw(chart) {
    const ep = state.episode;
    if (!ep) return;
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

/* ── Helpers ─────────────────────────────────────────────── */
async function apiFetch(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function el(id) { return document.getElementById(id); }

function setFrame(f) {
  if (!state.episode) return;
  state.frame = Math.max(0, Math.min(f, state.episode.length - 1));
  updateScrubber();
  updateChartCursor();
  updateImages();
}

/* ── Episode length color coding ────────────────────────── */
function lengthClass(len, sorted) {
  const n = sorted.length;
  if (!n) return "";
  const pct = sorted.filter(x => x <= len).length / n;
  if (pct < 0.20) return "len-short";
  if (pct < 0.40) return "len-med-short";
  if (pct < 0.60) return "len-medium";
  if (pct < 0.80) return "len-med-long";
  return "len-long";
}

/* ── Sidebar ─────────────────────────────────────────────── */
async function loadDatasets() {
  const tree = el("dataset-tree");
  tree.innerHTML = `<div class="loading-msg"><span class="spinner"></span> Loading datasets…</div>`;
  try {
    const datasets = await apiFetch("/api/datasets");
    if (!datasets.length) {
      tree.innerHTML = `<div class="loading-msg" style="color:var(--text-3)">No datasets found in ./data/</div>`;
      return;
    }
    tree.innerHTML = "";
    for (const ds of datasets) {
      tree.appendChild(buildDatasetNode(ds));
    }
  } catch (e) {
    tree.innerHTML = `<div class="error-msg">Failed to load datasets: ${e.message}</div>`;
  }
}

function buildDatasetNode(ds) {
  const node = document.createElement("div");
  node.className = "ds-node";
  node.innerHTML = `
    <div class="ds-header">
      <svg class="ds-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <svg class="ds-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="ds-name">${ds.name}</span>
      <span class="ds-badge">${ds.total_episodes} ep</span>
    </div>
    <div class="ds-children" id="ds-children-${ds.path}">
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
        // collect all lengths for color coding
        const allLengths = tasks.flatMap(t => t.episodes.map(e => e.length)).sort((a, b) => a - b);
        for (const task of tasks) {
          children.appendChild(buildTaskNode(ds.path, task, allLengths));
        }
      } catch (e) {
        children.innerHTML = `<div class="error-msg">${e.message}</div>`;
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
    <div class="task-header">
      <svg class="task-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="task-name">${shortTask}</span>
    </div>
    <div class="task-eps"></div>`;

  const header = group.querySelector(".task-header");
  const eps = group.querySelector(".task-eps");

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
    item.addEventListener("click", e => {
      if (e.ctrlKey || e.metaKey) {
        selectCompareEpisode(dsPath, ep.episode_index, item);
      } else {
        selectEpisode(dsPath, ep.episode_index, task.task, item);
      }
    });
    eps.appendChild(item);
  }

  header.addEventListener("click", () => group.classList.toggle("open"));
  return group;
}

/* ── Search filter ───────────────────────────────────────── */
function applySearch(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll(".task-group").forEach(group => {
    const matches = !q || group.dataset.task?.includes(q);
    group.classList.toggle("search-hidden", !matches);
    if (matches && q) group.classList.add("open");
  });
  // Show/hide dataset nodes that have no visible tasks
  document.querySelectorAll(".ds-node").forEach(node => {
    const children = node.querySelector(".ds-children");
    if (!children) return;
    const visible = children.querySelectorAll(".task-group:not(.search-hidden)").length;
    // only hide if loaded (has task-groups); keep visible when still loading
    const total = children.querySelectorAll(".task-group").length;
    if (total > 0) node.style.display = visible ? "" : "none";
  });
}

/* ── Episode loading ─────────────────────────────────────── */
async function selectEpisode(dsPath, epIndex, taskText, clickedEl) {
  document.querySelectorAll(".ep-item.active").forEach(e => e.classList.remove("active"));
  clickedEl.classList.add("active");

  stopPlayback();

  if (dsPath !== state.activeDataset) {
    state.normStats = null;
    try {
      const ns = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/norm_stats`);
      state.normStats = ns;
    } catch (_) {}
  }

  state.activeDataset = dsPath;
  state.activeEpIndex = epIndex;
  state.frameCache.clear();
  state.prefetchPending.clear();

  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) {
    clearCompare();
  }

  el("welcome").classList.add("hidden");
  el("viewer").classList.remove("hidden");
  el("task-label").textContent = taskText;

  for (let i = 0; i < 3; i++) resetCam(i);

  try {
    const ep = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/episodes/${epIndex}`);
    state.episode = ep;
    state.frame = 0;

    buildCharts(ep);
    buildCorrelationHeatmap(ep);
    setupControls(ep);
    updateScrubber();
    updateImages();
  } catch (e) {
    el("task-label").textContent = `Error: ${e.message}`;
  }
}

async function selectCompareEpisode(dsPath, epIndex, clickedEl) {
  if (state.compareDataset === dsPath && state.compareEpIndex === epIndex) {
    clearCompare();
    return;
  }
  document.querySelectorAll(".ep-item.compare").forEach(e => e.classList.remove("compare"));
  clickedEl.classList.add("compare");
  state.compareDataset = dsPath;
  state.compareEpIndex = epIndex;

  try {
    const ep = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/episodes/${epIndex}`);
    state.compareEpisode = ep;
    buildCharts(state.episode);
    el("compare-banner").classList.remove("hidden");
    el("compare-label").textContent = `Comparing ep_${String(epIndex).padStart(6,"0")} (dashed)`;
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

/* ── Camera rendering ────────────────────────────────────── */
function resetCam(i) {
  const slot = el(`cam-${i}`);
  slot.innerHTML = `<div class="cam-placeholder"><span>No camera</span></div>`;
}

function prefetchFrames() {
  const ep = state.episode;
  if (!ep || !ep.has_images) return;
  const ds = state.activeDataset;
  const epIdx = state.activeEpIndex;
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

function openLightbox(src, label) {
  el("lightbox-img").src = src;
  el("lightbox-label").textContent = label;
  el("cam-lightbox").classList.remove("hidden");
}

function renderFrameData(keys, frames) {
  keys.forEach((key, i) => {
    const slot = el(`cam-${i}`);
    const src = frames[key];
    if (!src) { resetCam(i); return; }
    let img = slot.querySelector("img");
    if (!img) {
      slot.innerHTML = "";
      img = document.createElement("img");
      img.alt = key;
      slot.appendChild(img);
      const label = document.createElement("div");
      label.className = "cam-label";
      label.textContent = key.replace(/_/g, " ");
      slot.appendChild(label);
    }
    img.src = src;
    // lightbox on click
    slot.onclick = () => openLightbox(src, key.replace(/_/g, " "));
  });
}

async function updateImages() {
  const ep = state.episode;
  if (!ep || !ep.has_images) return;

  const keys = ep.image_keys.slice(0, 3);
  for (let i = keys.length; i < 3; i++) resetCam(i);

  const f = state.frame;
  if (state.frameCache.has(f)) {
    renderFrameData(keys, state.frameCache.get(f));
  } else {
    try {
      const frames = await apiFetch(
        `/api/datasets/${encodeURIComponent(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${f}`
      );
      if (state.frame === f) {
        state.frameCache.set(f, frames);
        renderFrameData(keys, frames);
      }
    } catch (_) {}
  }
  prefetchFrames();
}

/* ── Charts ─────────────────────────────────────────────── */
function buildCharts(ep) {
  if (!ep) return;
  const ns = state.normStats;
  const { data: stateData,  normalized: sNorm } = normalizeData(ep.state,   ns?.state);
  const { data: actionData, normalized: aNorm } = normalizeData(ep.actions, ns?.action);

  const cmp = state.compareEpisode;
  const cmpState  = cmp ? normalizeData(cmp.state,   ns?.state).data  : null;
  const cmpAction = cmp ? normalizeData(cmp.actions, ns?.action).data : null;

  // normalized stats for std band
  const nsState  = sNorm ? normalizeMeanStd(ns?.state)  : null;
  const nsAction = aNorm ? normalizeMeanStd(ns?.action) : null;

  state.stateCharts  = buildChartCard("state",  stateData,  ep.state_names,  sNorm, ep, cmpState,  nsState);
  state.actionCharts = buildChartCard("action", actionData, ep.action_names, aNorm, ep, cmpAction, nsAction);
}

function buildChartCard(type, data2d, names, normalized, ep, cmpData2d = null, normBand = null) {
  const expanded = state[`${type}Expanded`];
  const isHist   = state[`hist${type.charAt(0).toUpperCase() + type.slice(1)}`];
  const body    = el(`chart-body-${type}`);
  const titleEl = el(`chart-title-${type}`);
  const btn     = el(`expand-${type}`);
  const histBtn = el(`hist-${type}`);

  if (!body) return [];

  const labels = ep.state.map((_, i) => i);
  const dims = data2d[0]?.length ?? 0;

  const old = state[`${type}Charts`] ?? [];
  old.forEach(c => c.destroy());

  const badge = normalized ? `<span class="norm-badge">normalized [-1, 1]</span>` : "";
  if (titleEl) titleEl.innerHTML = (type === "state" ? "State" : "Action") + (badge ? " " + badge : "");

  btn.classList.toggle("active", expanded);
  btn.querySelector(".icon-expand").classList.toggle("hidden", expanded);
  btn.querySelector(".icon-collapse").classList.toggle("hidden", !expanded);
  histBtn?.classList.toggle("active", isHist);

  const charts = [];

  if (isHist) {
    // ── Histogram mode ─────────────────────────────────────
    if (!expanded) {
      body.innerHTML = `<div class="hist-wrap"><canvas id="${type}-chart"></canvas></div>`;
      charts.push(makeHistChart(`${type}-chart`, data2d, names, dims));
    } else {
      body.innerHTML = `<div class="hist-grid" id="${type}-grid"></div>`;
      const grid = el(`${type}-grid`);
      for (let d = 0; d < dims; d++) {
        const label = names[d] ?? `dim_${d}`;
        const color = PALETTE[d % PALETTE.length];
        const itemId = `${type}-chart-${d}`;
        const item = document.createElement("div");
        item.className = "mini-chart-item";
        item.innerHTML = `
          <div class="mini-chart-label" style="color:${color}">${label}</div>
          <div class="mini-chart-wrap"><canvas id="${itemId}"></canvas></div>`;
        grid.appendChild(item);
        charts.push(makeHistChart(itemId, data2d, names, 1, d));
      }
    }
  } else if (!expanded) {
    // ── Collapsed: all dims on one line chart ──────────────
    body.innerHTML = `<div class="chart-wrap"><canvas id="${type}-chart"></canvas></div>`;
    charts.push(makeChart(`${type}-chart`, labels, data2d, names, normalized, dims, null, cmpData2d, null));
  } else {
    // ── Expanded: per-dim line charts ──────────────────────
    body.innerHTML = `<div class="chart-grid" id="${type}-grid"></div>`;
    const grid = el(`${type}-grid`);
    for (let d = 0; d < dims; d++) {
      const label = names[d] ?? `dim_${d}`;
      const color = PALETTE[d % PALETTE.length];
      const itemId = `${type}-chart-${d}`;
      const item = document.createElement("div");
      item.className = "mini-chart-item";
      item.innerHTML = `
        <div class="mini-chart-label" style="color:${color}">${label}</div>
        <div class="mini-chart-wrap"><canvas id="${itemId}"></canvas></div>`;
      grid.appendChild(item);
      const band = normBand ? { mean: normBand.mean[d], std: normBand.std[d] } : null;
      charts.push(makeChart(itemId, labels, data2d, names, normalized, 1, d, cmpData2d, band));
    }
  }

  return charts;
}

function makeChart(canvasId, labels, data2d, names, normalized, dims, dimIndex = null, cmpData2d = null, stdBand = null) {
  const ctx = el(canvasId).getContext("2d");
  const isMini = dimIndex !== null;

  function primaryDS() {
    if (isMini) return [{
      label: names[dimIndex] ?? `dim_${dimIndex}`,
      data: data2d.map(row => row[dimIndex]),
      borderColor: PALETTE[dimIndex % PALETTE.length],
      borderWidth: 1.5, pointRadius: 0, tension: 0.2,
    }];
    return Array.from({ length: dims }, (_, d) => ({
      label: names[d] ?? `dim_${d}`,
      data: data2d.map(row => row[d]),
      borderColor: PALETTE[d % PALETTE.length],
      borderWidth: 1.5, pointRadius: 0, tension: 0.2,
    }));
  }

  function compareDS() {
    if (!cmpData2d) return [];
    if (isMini) return [{
      label: `B: ${names[dimIndex] ?? `dim_${dimIndex}`}`,
      data: cmpData2d.map(row => row[dimIndex]),
      borderColor: PALETTE_CMP[dimIndex % PALETTE_CMP.length],
      borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3],
    }];
    return Array.from({ length: dims }, (_, d) => ({
      label: `B: ${names[d] ?? `dim_${d}`}`,
      data: cmpData2d.map(row => row[d]),
      borderColor: PALETTE_CMP[d % PALETTE_CMP.length],
      borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3],
    }));
  }

  const yConfig = normalized
    ? { min: -1.05, max: 1.05,
        ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: "#94A3B8",
                 callback: v => v.toFixed(1) },
        grid: { color: "#F1F5F9" }, border: { color: "#E2E8F0" } }
    : { ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: "#94A3B8" },
        grid: { color: "#F1F5F9" }, border: { color: "#E2E8F0" } };

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [...primaryDS(), ...compareDS()] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      stdBand: stdBand || undefined,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: {
            title: items => `Frame ${items[0].label}`,
            label: item => ` ${item.dataset.label}: ${item.raw.toFixed(4)}`,
          },
          bodyFont: { size: 11 },
          padding: 6,
        },
        cursor: {},
        stdBand: {},
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: isMini ? 4 : 8, font: { size: 9 }, color: "#94A3B8" },
          grid: { color: "#F1F5F9" },
          border: { color: "#E2E8F0" },
        },
        y: yConfig,
      },
    },
  });

  el(canvasId).addEventListener("click", e => {
    const pts = chart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (pts.length) setFrame(pts[0].index);
  });

  return chart;
}

/* ── Histogram charts ────────────────────────────────────── */
function computeBins(values, nBins = 24) {
  if (!values.length) return { edges: [], counts: [] };
  const mn = Math.min(...values), mx = Math.max(...values);
  const range = mx - mn || 1;
  const w = range / nBins;
  const counts = Array(nBins).fill(0);
  for (const v of values) {
    const i = Math.min(Math.floor((v - mn) / w), nBins - 1);
    counts[i]++;
  }
  const edges = Array.from({ length: nBins }, (_, i) => (mn + i * w + w / 2).toFixed(3));
  return { edges, counts };
}

function makeHistChart(canvasId, data2d, names, dims, dimIndex = null) {
  const ctx = el(canvasId).getContext("2d");
  const isMini = dimIndex !== null;
  const N_BINS = 20;

  const datasets = isMini
    ? (() => {
        const vals = data2d.map(r => r[dimIndex]);
        const { edges, counts } = computeBins(vals, N_BINS);
        return [{ label: names[dimIndex] ?? `dim_${dimIndex}`,
          data: counts, backgroundColor: PALETTE[dimIndex % PALETTE.length] + "99",
          borderColor: PALETTE[dimIndex % PALETTE.length], borderWidth: 1,
          _edges: edges }];
      })()
    : Array.from({ length: dims }, (_, d) => {
        const vals = data2d.map(r => r[d]);
        const { edges, counts } = computeBins(vals, N_BINS);
        return { label: names[d] ?? `dim_${d}`,
          data: counts, backgroundColor: PALETTE[d % PALETTE.length] + "66",
          borderColor: PALETTE[d % PALETTE.length], borderWidth: 1,
          _edges: edges };
      });

  const labels = datasets[0]._edges || [];

  return new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: !isMini && dims <= 6,
          labels: { font: { size: 9 }, boxWidth: 10, padding: 6 } },
        tooltip: {
          callbacks: {
            title: items => `~${items[0].label}`,
            label: item => ` ${item.dataset.label}: ${item.raw}`,
          },
          bodyFont: { size: 11 }, padding: 6,
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 9 }, color: "#94A3B8" },
             grid: { display: false }, border: { color: "#E2E8F0" } },
        y: { ticks: { maxTicksLimit: 4, font: { size: 9 }, color: "#94A3B8" },
             grid: { color: "#F1F5F9" }, border: { color: "#E2E8F0" } },
      },
    },
  });
}

function toggleHistogram(type) {
  const key = `hist${type.charAt(0).toUpperCase() + type.slice(1)}`;
  state[key] = !state[key];
  if (!state.episode) return;
  const ep = state.episode;
  const ns = state.normStats;
  const nsKey = type === "state" ? "state" : "action";
  const data = type === "state" ? ep.state : ep.actions;
  const names = type === "state" ? ep.state_names : ep.action_names;
  const { data: normData, normalized } = normalizeData(data, ns?.[nsKey]);
  const cmp = state.compareEpisode;
  const cmpRaw = cmp ? (type === "state" ? cmp.state : cmp.actions) : null;
  const cmpData = cmpRaw ? normalizeData(cmpRaw, ns?.[nsKey]).data : null;
  const nsNorm = normalized ? normalizeMeanStd(ns?.[nsKey]) : null;
  state[`${type}Charts`] = buildChartCard(type, normData, names, normalized, ep, cmpData, nsNorm);
}

function updateChartCursor() {
  state.stateCharts.forEach(c => c.update("none"));
  state.actionCharts.forEach(c => c.update("none"));
}

function toggleExpand(type) {
  state[`${type}Expanded`] = !state[`${type}Expanded`];
  if (!state.episode) return;
  const ep = state.episode;
  const ns = state.normStats;
  const nsKey = type === "state" ? "state" : "action";
  const data = type === "state" ? ep.state : ep.actions;
  const names = type === "state" ? ep.state_names : ep.action_names;
  const { data: normData, normalized } = normalizeData(data, ns?.[nsKey]);
  const cmp = state.compareEpisode;
  const cmpRaw = cmp ? (type === "state" ? cmp.state : cmp.actions) : null;
  const cmpData = cmpRaw ? normalizeData(cmpRaw, ns?.[nsKey]).data : null;
  const nsNorm = normalized ? normalizeMeanStd(ns?.[nsKey]) : null;
  state[`${type}Charts`] = buildChartCard(type, normData, names, normalized, ep, cmpData, nsNorm);
}

/* ── Correlation heatmap ─────────────────────────────────── */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (!n) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]; sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i]; sumY2 += ys[i] * ys[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  return den === 0 ? 0 : num / den;
}

function corrColor(r) {
  // r in [-1, 1] → blue(-1) white(0) red(+1)
  if (r >= 0) {
    const t = r;
    const R = Math.round(255);
    const G = Math.round(255 * (1 - t));
    const B = Math.round(255 * (1 - t));
    return `rgb(${R},${G},${B})`;
  } else {
    const t = -r;
    const R = Math.round(255 * (1 - t));
    const G = Math.round(255 * (1 - t));
    const B = Math.round(255);
    return `rgb(${R},${G},${B})`;
  }
}

function buildCorrelationHeatmap(ep) {
  const section = el("corr-section");
  const body = el("corr-body");
  if (!ep || !ep.actions || !ep.actions.length) { section.classList.add("hidden"); return; }

  const dims = ep.actions[0].length;
  if (dims < 2) { section.classList.add("hidden"); return; }

  // extract per-dim arrays
  const cols = Array.from({ length: dims }, (_, d) => ep.actions.map(r => r[d]));
  const names = ep.action_names ?? Array.from({ length: dims }, (_, d) => `a${d}`);

  // short labels (up to 8 chars)
  const labels = names.map(n => n.length > 8 ? n.slice(0, 7) + "…" : n);

  const CELL = 36, LABEL_W = 64, PAD = 4;
  const W = LABEL_W + dims * CELL + PAD;
  const H = LABEL_W + dims * CELL + PAD;

  body.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.id = "corr-canvas";
  canvas.width = W; canvas.height = H;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.font = "9px -apple-system, sans-serif";
  ctx.textBaseline = "middle";

  // draw cells
  for (let i = 0; i < dims; i++) {
    for (let j = 0; j < dims; j++) {
      const r = pearson(cols[i], cols[j]);
      ctx.fillStyle = corrColor(r);
      ctx.fillRect(LABEL_W + j * CELL, PAD + i * CELL, CELL - 1, CELL - 1);
      ctx.fillStyle = Math.abs(r) > 0.5 ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.6)";
      ctx.textAlign = "center";
      ctx.fillText(r.toFixed(2), LABEL_W + j * CELL + CELL / 2, PAD + i * CELL + CELL / 2);
    }
  }

  // row labels (left)
  ctx.fillStyle = "#64748B";
  ctx.textAlign = "right";
  for (let i = 0; i < dims; i++) {
    ctx.fillText(labels[i], LABEL_W - 4, PAD + i * CELL + CELL / 2);
  }

  // col labels (top, rotated)
  ctx.save();
  ctx.textAlign = "left";
  for (let j = 0; j < dims; j++) {
    ctx.save();
    ctx.translate(LABEL_W + j * CELL + CELL / 2, LABEL_W - 4);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(labels[j], 0, 0);
    ctx.restore();
  }
  ctx.restore();

  section.classList.remove("hidden");
}

/* ── Playback ────────────────────────────────────────────── */
function setupControls(ep) {
  const scrubber = el("scrubber");
  scrubber.max = ep.length - 1;
  scrubber.value = 0;
  el("frame-counter").textContent = `0 / ${ep.length - 1}`;
}

function updateScrubber() {
  const ep = state.episode;
  if (!ep) return;
  el("scrubber").value = state.frame;
  el("frame-counter").textContent = `${state.frame} / ${ep.length - 1}`;
}

function stopPlayback() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.playing = false;
  state.rafId = null;
  state.lastTick = null;
  el("play-icon")?.classList.remove("hidden");
  el("pause-icon")?.classList.add("hidden");
}

function startPlayback() {
  if (!state.episode) return;
  state.playing = true;
  el("play-icon").classList.add("hidden");
  el("pause-icon").classList.remove("hidden");

  const fps = (state.episode.fps || 10) * state.speed;
  const interval = 1000 / fps;

  function tick(ts) {
    if (!state.playing) return;
    if (!state.lastTick) state.lastTick = ts;
    if (ts - state.lastTick >= interval) {
      state.lastTick = ts;
      const next = state.frame + 1;
      if (next >= state.episode.length) {
        if (state.looping) {
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

/* ── Control event wiring ────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  loadDatasets();

  el("btn-play").addEventListener("click", () => {
    if (state.playing) stopPlayback(); else startPlayback();
  });

  el("btn-rewind").addEventListener("click", () => {
    stopPlayback(); setFrame(0);
  });

  el("btn-loop").addEventListener("click", () => {
    state.looping = !state.looping;
    el("btn-loop").classList.toggle("active", state.looping);
  });

  el("speed-select").addEventListener("change", e => {
    state.speed = parseFloat(e.target.value);
    if (state.playing) { stopPlayback(); startPlayback(); }
  });

  el("scrubber").addEventListener("input", e => {
    stopPlayback();
    setFrame(parseInt(e.target.value, 10));
  });

  el("expand-state").addEventListener("click",  () => toggleExpand("state"));
  el("expand-action").addEventListener("click", () => toggleExpand("action"));

  el("hist-state").addEventListener("click",  () => toggleHistogram("state"));
  el("hist-action").addEventListener("click", () => toggleHistogram("action"));

  el("compare-clear").addEventListener("click", clearCompare);

  el("corr-close").addEventListener("click", () => el("corr-section").classList.add("hidden"));

  // ── Search filter ─────────────────────────────────────────
  el("search-input").addEventListener("input", e => applySearch(e.target.value));

  // ── Keyboard shortcuts ────────────────────────────────────
  document.addEventListener("keydown", e => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (!state.episode) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (state.playing) stopPlayback(); else startPlayback();
        break;
      case "ArrowLeft":
        e.preventDefault();
        stopPlayback();
        setFrame(state.frame - (e.shiftKey ? 10 : 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        stopPlayback();
        setFrame(state.frame + (e.shiftKey ? 10 : 1));
        break;
      case "r": case "R": case "Home":
        e.preventDefault();
        stopPlayback();
        setFrame(0);
        break;
      case "End":
        e.preventDefault();
        stopPlayback();
        setFrame(state.episode.length - 1);
        break;
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
