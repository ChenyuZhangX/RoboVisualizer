# LeRobot Visualizer

A clean, modern web-based visualizer for [LeRobot](https://github.com/huggingface/lerobot) v2.0 datasets. Browse episodes, watch multi-camera playback, inspect state/action trajectories, and annotate frames with custom metadata — all from a polished browser UI backed by a lightweight FastAPI server.

---

## ✨ Features

### Playback & Visualization
- **Dataset browser** — sidebar tree view: datasets → tasks → episodes with frame counts
- **Multi-camera playback** — up to 6 synchronized camera views; grey placeholders for missing feeds
- **State & Action charts** — Chart.js line plots with synchronized playback cursor; real-time updates as frame advances
- **Per-dimension expand** — split any chart into individual mini-plots; isolate dimensions via Ctrl+click
- **Normalization** — auto-detects `norm_stats.json`; Q01/Q99 clip normalization to [−1, 1] with toggle badge
- **Playback controls** — play/pause, rewind, scrubber, speed (0.25×–4×), frame counter, loop mode
- **Keyboard shortcuts** — 40+ shortcuts for navigation, chart control, speed adjustment, and more

### Frame Inspection
- **Raw frame data viewer** — JSON-style display of all Parquet columns (scalars, arrays, annotations)
- **Column filter/search** — search Parquet keys by name; live re-render without refetch
- **Frame-to-frame delta display** — green/red badges showing numeric changes between consecutive frames
- **Expandable arrays** — inline view of vector/image array dimensions
- **Copy-to-clipboard** — export current frame as JSON or CSV

### Data Annotation
- **Per-frame metadata** — define custom annotation fields (number, string, boolean, category)
- **Interactive UI** — dedicated Annotate tab with input chips, progress timeline, and sparkline charts
- **Fill strategies** — auto-fill unannotated frames using fixed value, forward fill, or linear interpolation
- **Draft & commit workflow** — save annotations to JSON sidecar; commit to Parquet when ready
- **Annotated tab** — view completion stats, distribution charts, and per-field sparklines
- **Keyboard navigation** — arrow keys move between fields/frames; Tab to cycle through annotation inputs
- **CSV export** — download episode annotations as structured CSV file
- **Persistent storage** — draft annotations saved in `data/annotations/episode_XXXXXX.json`

### UI/UX Polish
- **Dark mode** — toggle between light and dark themes with persistent preference
- **Responsive layout** — mobile-friendly sidebar collapse; adapts to small screens
- **Recent episodes** — quick-access list of last 8 visited episodes
- **Mirror mode** — hide labels and UI chrome for clean screen recordings
- **Compare overlay** — Ctrl+click episodes to overlay two episode videos side-by-side
- **GitHub link** — top-right button links to repository
- **Toast notifications** — user feedback for copy, save, commit, and error events
- **Accessibility** — keyboard navigation, ARIA labels, focus rings, semantic HTML

### Performance
- **LRU frame cache** — in-memory Parquet caching (24 most-recent episodes)
- **Lazy image loading** — prefetch frames ahead of playback
- **Debounced updates** — chart renders throttled during playback
- **GZip compression** — API responses compressed on-the-fly

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Add a dataset

Place any LeRobot v2.0 dataset under `./data/`:

```
data/
└── my_dataset/
    ├── meta/
    │   ├── info.json
    │   ├── tasks.jsonl
    │   └── episodes.jsonl
    └── data/
        └── chunk-000/
            └── episode_000000.parquet
```

### 3. Start the server

```bash
python server.py
```

Open **http://localhost:8765** in your browser.

---

## 📺 Interface Walkthrough

### Main Layout
```
┌──────────────────────────────────────────────────────────────────────┐
│  LeRobot Visualizer                                  🌙  GitHub  ?    │
├──────────────────────┬─────────────────────────────────────────────┤
│  DATASETS            │ ┌────────┬────────┬────────┐                │
│  ▼ libero_reduced    │ │ top    │ wrist  │ (grey) │                │
│    ▼ pick_cup        │ └────────┴────────┴────────┘                │
│      ep_000000  214f │                                              │
│      ep_000018  267f │ "put the white mug on the left plate…"       │
│    ▼ put_down       │                                              │
│      ep_000001  281f │ [Video] [Annotate]  C  CSV  V  Z  Export   │
│                      │                                              │
│  Recent             │ State    ⊞  [normalized −1,1]  ◀  ▶          │
│  • ep_000000        │ ───────────╫────────────────────              │
│  • ep_000018        │                                              │
│                      │ Action   ⊞  [normalized −1,1]  ◀  ▶          │
│                      │ ───────────╫────────────────────              │
│                      │                                              │
│                      │ Raw Data (JSON Viewer)                      │
│                      │ Frame 42 · 23 cols  🔍 [ ] 📋             │
│                      │ ┌────────────────────────────┐              │
│                      │ │ annotations                │              │
│                      │ │ - progress: 2 +0.05       │              │
│                      │ │ - quality:  4 (unchanged) │              │
│                      │ │ metadata                   │              │
│                      │ │ - state_0: 1.234          │              │
│                      │ │ - action_0: -0.456        │              │
│                      │ └────────────────────────────┘              │
│                      │                                              │
│ [⏮] [▶] ━●━ 42/213  Speed: 1×  Loop  ⏱️ 21fps                    │
└──────────────────────┴─────────────────────────────────────────────┘
```

### Annotation Tab
```
┌────────────────────────────────────────────┐
│ Annotation   [Annotate] [Annotated] [→]  ⚙️ │
├────────────────────────────────────────────┤
│ quality:     [====●======]  4/5 frames    │
│ note:        [open text input]             │
│ success:     [checkbox: ☑️]                │
│                                            │
│ ← Prev unannotated    Next unannotated →  │
│ [Fill & Save] [Export CSV] [Commit]      │
│                                            │
│ Timeline: ████▓░░░░░░░░░░░░░░░░░░░░░░░░ │
└────────────────────────────────────────────┘
```

---

## 🎯 Annotation Workflow

### 1. Define Fields (Schema Tab)
Create annotation fields in the **Schema** tab:
- Field name: `quality`, Type: `number` (min 0, max 5)
- Field name: `note`, Type: `string`
- Field name: `success`, Type: `boolean`

Schema is stored in `meta/annotation_schema.json`.

### 2. Annotate Frames (Annotate Tab)
- Navigate through frames using playback or ← / → keys
- Fill in input chips for current frame
- Auto-saves to `data/annotations/episode_XXXXXX.json` (800ms debounce)
- **Keyboard navigation**: Arrow keys move between fields; Up/Down seek frames

### 3. View Stats (Annotated Tab)
Once all frames are annotated for a field, it appears in the **Annotated** tab showing:
- **Numeric**: min, avg, max + sparkline chart (click to seek)
- **Category**: top 5 values + percentages
- **Boolean**: true/false counts + percentages
- **Progress**: current frame's value highlighted

### 4. Fill Unannotated Frames (Settings ⚙️)
Configure fill strategies per field:
- `None` — leave null
- `Fixed value` — fill all unannotated with a constant
- `Forward fill` — propagate last known value forward
- `Linear interpolation` — (numbers only) linearly interpolate between keyframes

Then click **Fill & Save** (Ctrl+S) to apply and save to sidecar.

### 5. Commit to Dataset
When satisfied, click **Commit** to permanently write annotations as new Parquet columns.
- This overwrites the episode's parquet file with new columns
- Commits use fill strategies to ensure all frames are covered
- JSON sidecar is not deleted; can be used for version control

### 6. Export Annotations
Click **Export as CSV** to download a structured CSV file:
```
frame_index,quality,note,success
0,4,open,true
1,4,open,true
2,3,closed,false
...
```

---

## 🛠️ Normalization

Run the following script to compute normalization statistics for a dataset:

```bash
# Edit DATASET path at the top of the script, then:
python compute_norm_stats.py
```

The script computes per-dimension **mean, std, min, max, Q01, Q99** for `state`, `action`, and `delta_action` across all episodes.

Once `meta/norm_stats.json` is in place, the visualizer automatically normalizes to [−1, 1]:

```
x_clipped  = clip(x, q01, q99)
x_norm     = 2 × (x_clipped − q01) / (q99 − q01) − 1
```

---

## 🔄 Conversion Tools

Convert HDF5 or folder-based datasets into LeRobot v2.0 Parquet format using scripts in `tools/`.

### HDF5 datasets

Supports **ALOHA/ACT**, **RoboMimic**, **LIBERO**, plus fully configurable custom mode.

```bash
# ALOHA / ACT
python tools/convert_hdf5.py dataset.hdf5 output/my_dataset \
    --profile aloha --task "pick up the cup"

# RoboMimic (task inferred from demo attributes)
python tools/convert_hdf5.py robosuite.hdf5 output/my_dataset \
    --profile robomimic

# LIBERO original HDF5
python tools/convert_hdf5.py libero_task.hdf5 output/my_dataset \
    --profile libero

# Custom field mapping
python tools/convert_hdf5.py custom.hdf5 output/my_dataset \
    --profile custom --config '{
        "demos_key":    "data",
        "state_keys":   ["obs/joint_pos", "obs/gripper"],
        "action_key":   "actions",
        "image_keys":   {"image": "obs/camera_rgb"},
        "task_default": "my task",
        "fps":          20
    }'
```

| Profile | Format | State source | Camera keys |
|---|---|---|---|
| `aloha` | ALOHA / ACT | `obs/qpos` | `obs/images/top`, `obs/images/wrist` |
| `robomimic` | RoboMimic | all 1-D obs fields (auto) | `obs/agentview_image`, `obs/robot0_eye_in_hand_image` |
| `libero` | LIBERO original | joint + gripper + ee pos/ori | `obs/agentview_rgb`, `obs/eye_in_hand_rgb` |
| `custom` | any HDF5 | configured via `--config` | configured via `--config` |

### Folder-based datasets

**Layout A** — one subdirectory per episode:

```
dataset/
  episode_000/
    image/          ← camera frames (*.jpg / *.png, sorted)
    wrist_image/
    states.csv      ← one row per timestep
    actions.csv
    task.txt        ← (optional) task description
  episode_001/
    ...
```

```bash
python tools/convert_folder.py /path/to/dataset output/my_dataset \
    --fps 10 --task "default task description"
```

**Layout B** — flat CSV with image paths:

```
dataset/
  data.csv          ← columns: episode, frame, state_*, action_*, <cam>_path
  images/
```

```bash
python tools/convert_folder.py /path/to/dataset output/my_dataset \
    --layout B \
    --state-cols  state_0 state_1 state_2 state_3 state_4 state_5 state_6 \
    --action-cols action_0 action_1 action_2 action_3 action_4 action_5 action_6 \
    --image-cols  image wrist_image
```

---

## 📁 Project Structure

```
lerobot-visualizer/
├── server.py               FastAPI backend (dataset / episode / frame / annotation APIs)
├── requirements.txt
├── compute_norm_stats.py   Compute Q01/Q99 normalization stats for a full dataset
├── static/
│   ├── index.html          Single-page UI (v88)
│   ├── app.js              Playback, charts, annotation, keyboard shortcuts (v95)
│   └── style.css           Polished light/dark theme with blue accent (v88)
├── tools/
│   ├── utils.py            LeRobotWriter — exact v2.0 Parquet schema
│   ├── convert_hdf5.py     HDF5 → LeRobot (ALOHA / RoboMimic / LIBERO / custom)
│   └── convert_folder.py   Folder + CSV → LeRobot (layout A & B)
└── data/                   ← place datasets here (git-ignored)
```

---

## 🔌 API Reference

FastAPI server endpoints (also browsable at `/docs`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/datasets` | List all datasets in `./data/` |
| `GET` | `/api/datasets/{ds}/tasks` | Tasks and their local episodes |
| `GET` | `/api/datasets/{ds}/episodes/{idx}` | Episode state/action/metadata |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/frame/{f}` | Camera images for one frame (base64 JPEG) |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/frame/{f}/values` | All scalar + array columns for a frame (excluding images) |
| `GET` | `/api/datasets/{ds}/norm_stats` | Normalization statistics (or `null` if not present) |
| `GET` | `/api/datasets/{ds}/annotation_schema` | Annotation field definitions |
| `POST` | `/api/datasets/{ds}/annotation_schema` | Update annotation schema |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Get draft annotations for an episode |
| `PUT` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Bulk save/update annotations (JSON sidecar) |
| `POST` | `/api/datasets/{ds}/episodes/{idx}/annotations/commit` | Commit annotations to Parquet (permanent write) |
| `DELETE` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Clear draft annotations for an episode |

---

## ⌨️ Keyboard Shortcuts

### Playback
| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Step ±1 frame |
| `Shift+←` / `Shift+→` | Step ±10 frames |
| `Alt+←` / `Alt+→` | Navigate frame history |
| `R` / `Home` | Rewind to start |
| `End` | Jump to last frame |
| `+` / `−` | Speed up / slow down |
| `L` | Toggle loop |

### Navigation
| Key | Action |
|---|---|
| `Ctrl+J` | Jump to frame (with timestamp support) |
| `[` / `]` | Previous / next episode |
| `Shift+[` / `Shift+]` | First / last episode |
| `0`–`9` | Jump to 0%–90% of episode |
| `/` / `G` / `Ctrl+K` | Focus search |

### Charts & View
| Key | Action |
|---|---|
| `H` / `Shift+H` | Toggle state / action histogram |
| `E` / `Shift+E` | Split state / action chart by dimension |
| `T` | Toggle time × dimension heatmap |
| `K` | Toggle action correlation matrix |
| `N` | Toggle normalization |
| `I` | Toggle episode info strip |

### Annotations
| Key | Action |
|---|---|
| `A` | Switch to Annotate tab |
| `Ctrl+S` | Fill & Save annotations (Annotate tab) |
| `Del` | Clear all annotations for episode |
| `Arrow keys` | Navigate between fields / frames (in Annotate tab) |

### Export & UI
| Key | Action |
|---|---|
| `C` | Copy episode URL |
| `Ctrl+Shift+C` | Copy current frame values as JSON |
| `X` | Export episode as CSV |
| `J` | Export episode as JSON |
| `D` | Download current frame / image |
| `Ctrl+D` | Toggle dark mode |
| `V` / `P` | Toggle frame values panel |
| `Z` | Toggle raw frame data (JSON) viewer |
| `F` | Fullscreen camera |
| `M` | Mirror mode (hide labels) |
| `B` | Toggle sidebar |
| `?` | Show this help |

---

## 📋 Requirements

- Python ≥ 3.9
- `fastapi`, `uvicorn`, `pyarrow`, `pillow`
- Modern browser (Chrome / Firefox / Safari)

For conversion tools, additionally: `h5py` (HDF5), `numpy`

```bash
pip install h5py   # only needed for convert_hdf5.py
```

---

## 📝 License

MIT

---

## 🤝 Contributing

Bug reports and pull requests welcome! This is an active research project.

---

## 📚 Related

- [LeRobot](https://github.com/huggingface/lerobot) — Main robot learning dataset framework
- [HuggingFace](https://huggingface.co/) — Model and dataset hub
