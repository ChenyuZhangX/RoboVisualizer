/* ── State ───────────────────────────────────────────────── */
const state = {
  episode: null,        // loaded episode data
  normStats: null,      // norm_stats.json for active dataset (or null)
  frame: 0,
  playing: false,
  rafId: null,
  lastTick: null,
  stateCharts: [],      // array: length 1 (collapsed) or N dims (expanded)
  actionCharts: [],
  stateExpanded: false,
  actionExpanded: false,
  activeDataset: null,
  activeEpIndex: null,
};

/* ── Palette ─────────────────────────────────────────────── */
const PALETTE = [
  "#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6",
  "#06B6D4","#F97316","#EC4899","#14B8A6","#6366F1",
];

/* ── Normalization ───────────────────────────────────────── */
// Clip to [q01, q99] then scale to [-1, 1]
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

/* ── Cursor plugin for Chart.js ──────────────────────────── */
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
Chart.register(cursorPlugin);

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
        for (const task of tasks) {
          children.appendChild(buildTaskNode(ds.path, task));
        }
      } catch (e) {
        children.innerHTML = `<div class="error-msg">${e.message}</div>`;
      }
    }
  });

  return node;
}

function buildTaskNode(dsPath, task) {
  const group = document.createElement("div");
  group.className = "task-group";
  const shortTask = task.task.length > 72
    ? task.task.slice(0, 72) + "…"
    : task.task;

  group.innerHTML = `
    <div class="task-header">
      <svg class="task-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="task-name">${shortTask}</span>
    </div>
    <div class="task-eps"></div>`;

  const header = group.querySelector(".task-header");
  const eps = group.querySelector(".task-eps");

  for (const ep of task.episodes) {
    const item = document.createElement("div");
    item.className = "ep-item";
    item.dataset.dataset = dsPath;
    item.dataset.episode = ep.episode_index;
    item.innerHTML = `
      <span class="ep-dot"></span>
      <span>ep_${String(ep.episode_index).padStart(6, "0")}</span>
      <span class="ep-len">${ep.length}f</span>`;
    item.addEventListener("click", () => selectEpisode(dsPath, ep.episode_index, task.task, item));
    eps.appendChild(item);
  }

  header.addEventListener("click", () => {
    group.classList.toggle("open");
  });

  return group;
}

/* ── Episode loading ─────────────────────────────────────── */
async function selectEpisode(dsPath, epIndex, taskText, clickedEl) {
  document.querySelectorAll(".ep-item.active").forEach(e => e.classList.remove("active"));
  clickedEl.classList.add("active");

  stopPlayback();

  // Fetch norm_stats if switching to a new dataset
  if (dsPath !== state.activeDataset) {
    state.normStats = null;
    try {
      const ns = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/norm_stats`);
      state.normStats = ns;  // null if server returns null (no norm_stats.json)
    } catch (_) {}
  }

  state.activeDataset = dsPath;
  state.activeEpIndex = epIndex;

  el("welcome").classList.add("hidden");
  el("viewer").classList.remove("hidden");
  el("task-label").textContent = taskText;

  for (let i = 0; i < 3; i++) resetCam(i);

  try {
    const ep = await apiFetch(`/api/datasets/${encodeURIComponent(dsPath)}/episodes/${epIndex}`);
    state.episode = ep;
    state.frame = 0;

    buildCharts(ep);
    setupControls(ep);
    updateScrubber();
    updateImages();
  } catch (e) {
    el("task-label").textContent = `Error: ${e.message}`;
  }
}

/* ── Camera rendering ────────────────────────────────────── */
function resetCam(i) {
  const slot = el(`cam-${i}`);
  slot.innerHTML = `<div class="cam-placeholder"><span>No camera</span></div>`;
}

async function updateImages() {
  const ep = state.episode;
  if (!ep || !ep.has_images) return;

  const keys = ep.image_keys.slice(0, 3);
  // Fill missing slots with placeholder
  for (let i = keys.length; i < 3; i++) resetCam(i);

  try {
    const frames = await apiFetch(
      `/api/datasets/${encodeURIComponent(state.activeDataset)}/episodes/${state.activeEpIndex}/frame/${state.frame}`
    );
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
    });
  } catch (_) {}
}

/* ── Charts ─────────────────────────────────────────────── */
function buildCharts(ep) {
  const ns = state.normStats;
  const { data: stateData,  normalized: sNorm } = normalizeData(ep.state,   ns?.state);
  const { data: actionData, normalized: aNorm } = normalizeData(ep.actions, ns?.action);

  state.stateCharts  = buildChartCard("state",  stateData,  ep.state_names,  sNorm, ep);
  state.actionCharts = buildChartCard("action", actionData, ep.action_names, aNorm, ep);
}

function buildChartCard(type, data2d, names, normalized, ep) {
  const expanded = state[`${type}Expanded`];
  const body    = el(`chart-body-${type}`);
  const titleEl = el(`chart-title-${type}`);
  const btn     = el(`expand-${type}`);

  if (!body) { console.error(`chart-body-${type} not found`); return []; }

  const labels = ep.state.map((_, i) => i);
  const dims = data2d[0]?.length ?? 0;

  // Destroy old charts
  const old = state[`${type}Charts`] ?? [];
  old.forEach(c => c.destroy());

  // Update title badge
  const badge = normalized ? `<span class="norm-badge">normalized [-1, 1]</span>` : "";
  if (titleEl) titleEl.innerHTML = (type === "state" ? "State" : "Action") + (badge ? " " + badge : "");

  // Toggle button appearance
  btn.classList.toggle("active", expanded);
  btn.querySelector(".icon-expand").classList.toggle("hidden", expanded);
  btn.querySelector(".icon-collapse").classList.toggle("hidden", !expanded);

  const charts = [];

  if (!expanded) {
    // ── Collapsed: all dims on one chart ────────────────────
    body.innerHTML = `<div class="chart-wrap"><canvas id="${type}-chart"></canvas></div>`;
    charts.push(makeChart(`${type}-chart`, labels, data2d, names, normalized, dims));
  } else {
    // ── Expanded: one mini chart per dim ────────────────────
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
      charts.push(makeChart(itemId, labels, data2d, names, normalized, 1, d));
    }
  }

  return charts;
}

// dims: how many dims to show; dimIndex: which single dim (for mini charts)
function makeChart(canvasId, labels, data2d, names, normalized, dims, dimIndex = null) {
  const ctx = el(canvasId).getContext("2d");
  const isMini = dimIndex !== null;

  const datasets = isMini
    ? [{
        label: names[dimIndex] ?? `dim_${dimIndex}`,
        data: data2d.map(row => row[dimIndex]),
        borderColor: PALETTE[dimIndex % PALETTE.length],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
      }]
    : Array.from({ length: dims }, (_, d) => ({
        label: names[d] ?? `dim_${d}`,
        data: data2d.map(row => row[d]),
        borderColor: PALETTE[d % PALETTE.length],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
      }));

  const yConfig = normalized
    ? { min: -1.05, max: 1.05,
        ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: "#94A3B8",
                 callback: v => v.toFixed(1) },
        grid: { color: "#F1F5F9" }, border: { color: "#E2E8F0" } }
    : { ticks: { maxTicksLimit: isMini ? 3 : 5, font: { size: 9 }, color: "#94A3B8" },
        grid: { color: "#F1F5F9" }, border: { color: "#E2E8F0" } };

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
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

function updateChartCursor() {
  state.stateCharts.forEach(c => c.update("none"));
  state.actionCharts.forEach(c => c.update("none"));
}

function toggleExpand(type) {
  state[`${type}Expanded`] = !state[`${type}Expanded`];
  if (!state.episode) return;
  const ep = state.episode;
  const ns = state.normStats;
  const data = type === "state" ? ep.state : ep.actions;
  const names = type === "state" ? ep.state_names : ep.action_names;
  const nsKey = type === "state" ? "state" : "action";
  const { data: normData, normalized } = normalizeData(data, ns?.[nsKey]);
  state[`${type}Charts`] = buildChartCard(type, normData, names, normalized, ep);
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

  const fps = state.episode.fps || 10;
  const interval = 1000 / fps;

  function tick(ts) {
    if (!state.playing) return;
    if (!state.lastTick) state.lastTick = ts;
    if (ts - state.lastTick >= interval) {
      state.lastTick = ts;
      const next = state.frame + 1;
      if (next >= state.episode.length) {
        stopPlayback();
        return;
      }
      setFrame(next);
    }
    state.rafId = requestAnimationFrame(tick);
  }
  state.rafId = requestAnimationFrame(tick);
}

/* ── Control event wiring ────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  loadDatasets();

  el("btn-play").addEventListener("click", () => {
    if (state.playing) stopPlayback();
    else startPlayback();
  });

  el("btn-rewind").addEventListener("click", () => {
    stopPlayback();
    setFrame(0);
  });

  el("scrubber").addEventListener("input", e => {
    stopPlayback();
    setFrame(parseInt(e.target.value, 10));
  });

  el("expand-state").addEventListener("click",  () => toggleExpand("state"));
  el("expand-action").addEventListener("click", () => toggleExpand("action"));
});
