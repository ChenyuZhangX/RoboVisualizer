# LeRobot Visualizer

A browser-based viewer for [LeRobot](https://github.com/huggingface/lerobot) v2.0 robot datasets, built on FastAPI + vanilla JS.

- **Playback** — browse datasets → tasks → episodes; multi-camera video with synchronized state/action charts
- **Annotation** — define custom fields per dataset, annotate per frame, commit to Parquet with one click
- **SSH remote** — connect to a GPU server and browse its datasets without copying files locally
- **Inspection** — raw Parquet data viewer per frame, delta display, normalization, histogram, correlation matrix
- **Polish** — 40+ keyboard shortcuts, dark mode, mirror mode, episode compare overlay

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

Python ≥ 3.9 required. `paramiko` (for SSH remote datasets) is included by default.

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

## 🖥️ Interface Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  LeRobot Visualizer                              🌙  GitHub  ?      │
├──────────────────────┬───────────────────────────────────────────────┤
│  🔍 Search           │                                               │
│                      │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  LOCAL               │  │  cam_top │  │  wrist   │  │  ext_1   │   │
│  ▼ my_dataset        │  └──────────┘  └──────────┘  └──────────┘   │
│    ▼ pick up cup     │                                               │
│      ep_000000  214f │  "put the white mug on the left plate"        │
│      ep_000001  267f │                                               │
│    ▼ place down      │  [Video]  [Annotate]    C  CSV  V  Z  ↓     │
│      ep_000002  281f │                                               │
│                      │  State ────────────────────────────  ⊞  [N]  │
│  REMOTE (gpu-server)  │  ──────╫──────────────────────────────────   │
│  ▼ bridge_dataset 📡 │                                               │
│    ▼ pick up …       │  Action ───────────────────────────  ⊞  [N]  │
│      ep_000000  450f │  ──────╫──────────────────────────────────   │
│                      │                                               │
│  Recent              │  Raw Data (JSON Viewer)                       │
│  • ep_000000         │  Frame 42 · 15 cols    🔍          📋        │
│  • ep_000001         │  ┌──────────────────────────────────────┐    │
│                      │  │ quality      4      Δ+1              │    │
│                      │  │ state_0   1.234     Δ−0.012          │    │
│                      │  └──────────────────────────────────────┘    │
│                      │                                               │
│  [⏮] [▶] ━━━●━ 42/213  Speed: 1×  Loop  ⏱ 21fps                  │
└──────────────────────┴───────────────────────────────────────────────┘
```

---

## 📡 SSH Remote Datasets

Connect to a remote server and browse its datasets without copying files locally.

### Connect

1. Click the **SSH** button in the sidebar header (or open it from the modal).
2. Enter the SSH command — exactly as you'd type it in a terminal:

   ```
   ssh myserver
   ssh user@192.168.1.100
   ssh -p 2222 user@host
   ```

   Aliases, `ProxyJump`, and `IdentityFile` in `~/.ssh/config` are all honoured automatically.

3. Enter the **remote path** — the directory that contains your dataset folders.
4. Click **Connect**. The server walks the remote directory, detects all LeRobot datasets, and lists them in the sidebar under a **Remote** section.

### What happens under the hood

- `meta/info.json` is written locally immediately (so datasets appear in the sidebar at once).
- `tasks.jsonl`, `episodes.jsonl`, and other meta files are downloaded in the background.
- Parquet files are fetched on demand the first time you open an episode; subsequent opens use the local cache.
- The cache lives at `/tmp/lerobot_ssh_cache/` and is evicted when it exceeds 4 GB.
- Sessions are in-memory and lost on server restart; the connection history is persisted to `~/.lerobot_visualizer/ssh_history.json`.

---

## 🎯 Data Annotation

### Workflow

#### 1. Define fields — Schema tab
Add annotation fields for the dataset. Each field has a name and one of four types:

| Type | Input | Parquet column type |
|------|-------|---------------------|
| `number` | numeric input | `float64` |
| `string` | text input | `string` |
| `boolean` | checkbox | `bool` |
| `category` | dropdown | `string` |

Schema is stored in `meta/annotation_schema.json` inside the dataset directory.

#### 2. Annotate — Annotate tab
Navigate through frames and fill in the input chips. Each change auto-saves to a JSON sidecar (`data/annotations/episode_XXXXXX.json`) after an 800 ms debounce. Keyboard shortcuts:

| Key | Action |
|-----|--------|
| `←` / `→` | Step frame |
| `Tab` / `Shift+Tab` | Move between annotation fields |
| `↑` / `↓` | Jump to previous / next unannotated frame for the focused field |
| `Ctrl+S` | Fill unannotated frames and save |
| `Del` | Clear all annotations for the episode |

#### 3. View stats — Annotated tab
Once you've annotated at least one frame, the **Annotated** tab shows per-field completion stats: sparklines, min/avg/max for numbers, top-value distributions for categories, and true/false counts for booleans.

#### 4. Configure fill — Settings ⚙️
For each field, choose what to do with unannotated frames at commit time:

| Strategy | Description |
|----------|-------------|
| `None` | Leave as `null` |
| `Fixed value` | Fill every unannotated frame with a constant |
| `Forward fill` | Propagate the last annotated value forward |
| `Linear interpolation` | Interpolate between annotated keyframes *(numbers only)* |

#### 5. Commit to Parquet
Click **Commit** to permanently write annotation columns into the episode's Parquet file. The existing columns are preserved; annotation fields are appended (or replaced if they already exist). The JSON sidecar is kept as a backup.

#### 6. Export as CSV
```
frame_index,quality,note,success
0,4,open,true
1,4,open,true
2,3,closed,false
```

---

## 🛠️ Normalization

Run `compute_norm_stats.py` to compute per-dimension statistics for a dataset:

```bash
# Edit the DATASET constant at the top, then:
python compute_norm_stats.py
```

Outputs `meta/norm_stats.json` with **mean, std, min, max, Q01, Q99** for `state`, `action`, and `delta_action` across all episodes. Once present, the visualizer's **N** toggle normalizes all charts to [−1, 1] using:

```
x_norm = 2 × (clip(x, q01, q99) − q01) / (q99 − q01) − 1
```

---

## 🔄 Conversion Tools

Convert existing datasets into LeRobot v2.0 Parquet format using scripts in `tools/`.

### HDF5 datasets

Supports ALOHA/ACT, RoboMimic, and LIBERO out of the box, plus a fully configurable custom mode.

```bash
# ALOHA / ACT
python tools/convert_hdf5.py dataset.hdf5 output/my_dataset \
    --profile aloha --task "pick up the cup"

# RoboMimic (task description inferred from demo attributes)
python tools/convert_hdf5.py robosuite.hdf5 output/my_dataset \
    --profile robomimic

# LIBERO original HDF5
python tools/convert_hdf5.py libero_task.hdf5 output/my_dataset \
    --profile libero

# Custom — configure keys explicitly
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

| Profile | Format | State | Cameras |
|---------|--------|-------|---------|
| `aloha` | ALOHA / ACT | `obs/qpos` | `obs/images/top`, `obs/images/wrist` |
| `robomimic` | RoboMimic | all 1-D obs fields | `obs/agentview_image`, `obs/robot0_eye_in_hand_image` |
| `libero` | LIBERO | joint + gripper + EE pos/ori | `obs/agentview_rgb`, `obs/eye_in_hand_rgb` |
| `custom` | any HDF5 | `--config` | `--config` |

### Folder-based datasets

**Layout A** — one subdirectory per episode:

```
dataset/
  episode_000/
    image/            ← camera frames (*.jpg / *.png, sorted by name)
    wrist_image/
    states.csv        ← one row per timestep
    actions.csv
    task.txt          ← optional task description
  episode_001/
    ...
```

```bash
python tools/convert_folder.py /path/to/dataset output/my_dataset \
    --fps 10 --task "default task"
```

**Layout B** — flat CSV with image paths:

```
dataset/
  data.csv            ← columns: episode, frame, state_*, action_*, <cam>_path
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

## ✨ Full Feature List

### Playback & Navigation
- **Dataset browser** — sidebar tree: datasets → tasks → episodes with frame counts and durations
- **Multi-camera playback** — up to 6 synchronized camera views with grey placeholders for missing feeds
- **Smooth scrubbing** — click/drag timeline, click frame counter to jump-by-number, frame history with Alt+←/→
- **Speed control** — 0.25× to 4× in half-steps; loop mode; rewind; jump to 0–90% with digit keys
- **Episode navigation** — `[` / `]` to step episodes, `Shift+[`/`Shift+]` for first/last, `Backspace` for previous
- **Compare overlay** — Ctrl+click any episode to overlay its trajectory as a dashed line over the active one

### Charts & Inspection
- **State & Action charts** — Chart.js line plots with live playback cursor and per-frame highlight
- **Per-dimension expand** — split any chart into individual mini-plots; Ctrl+click to isolate one dimension
- **Time × dimension heatmap** — colour-coded magnitude map across the full episode
- **Action correlation matrix** — interactive heatmap of pairwise correlations
- **Normalization** — auto-detects `norm_stats.json`; Q01/Q99 clip-normalize to [−1, 1] with one keypress
- **Histogram overlay** — per-dimension distribution bars overlaid on the chart

### Frame Inspection
- **Raw data viewer** — JSON-style display of every Parquet column (scalars, vectors, annotations)
- **Column search** — filter keys by name with live re-render, no re-fetch
- **Delta display** — green/red badges show numeric change vs previous frame
- **Expandable arrays** — inline vector/array expansion; large arrays truncated with "show more"

### Data Annotation
- **Custom fields** — define number, string, boolean, or category fields per dataset
- **Input chips** — one compact chip per field at the current frame; auto-saves on change (800 ms debounce)
- **Fill strategies** — fixed value, forward fill, or linear interpolation for unannotated frames
- **Draft → Commit** — edits land in a JSON sidecar first; one click permanently writes new Parquet columns
- **Stats tab** — sparklines, min/avg/max, category distributions, and boolean counts per field
- **Progress timeline** — canvas bar shows annotation coverage at a glance; click to seek
- **CSV export** — download all annotations for an episode as a structured CSV

### SSH Remote Datasets
- **Connect to any server** — paste an SSH command (`ssh user@host` or an alias from `~/.ssh/config`)
- **Auto-discovery** — recursive SFTP walk finds all LeRobot datasets under the remote path
- **On-demand download** — Parquet files are fetched the first time an episode is opened and cached locally
- **Connection history** — recent connections remembered; one click to reconnect
- **Transparent integration** — remote datasets appear alongside local ones; all features work identically

### UI / UX
- **Dark mode** — polished light and dark themes with persistent preference
- **Keyboard first** — 40+ shortcuts for every action; `?` shows the full reference
- **Mirror mode** — hide all labels and UI chrome for clean screen recordings
- **Episode info strip** — task description, episode index, fps, duration, and camera list
- **Responsive layout** — sidebar collapses on small screens; mobile-friendly touch controls
- **Recent episodes** — quick-access list of the last 8 visited episodes
- **Toast notifications** — feedback for save, commit, copy, and error events

---

## ⌨️ Keyboard Shortcuts

### Playback
| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Step ±1 frame |
| `Shift+←` / `Shift+→` | Step ±10 frames |
| `Alt+←` / `Alt+→` | Navigate frame history |
| `0`–`9` | Jump to 0%–90% of episode |
| `Home` / `R` | Rewind to first frame |
| `End` | Jump to last frame |
| `PageUp` / `PageDown` | Jump ±10% |
| `Shift+PageUp/Down` | Jump ±25% |
| `+` / `−` | Speed up / slow down |
| `L` | Toggle loop |
| `Shift+R` | Random episode |

### Navigation
| Key | Action |
|-----|--------|
| `[` / `]` | Previous / next episode |
| `Shift+[` / `Shift+]` | First / last episode |
| `Backspace` | Previous episode |
| `Ctrl+J` | Jump to frame number |
| `/` / `G` / `Ctrl+K` | Focus search |
| `O` | Collapse all task groups except current |
| `Ctrl+R` | Reload current episode (clears frame cache) |

### Charts & View
| Key | Action |
|-----|--------|
| `H` / `Shift+H` | Toggle state / action histogram |
| `E` / `Shift+E` | Expand state / action chart by dimension |
| `T` | Toggle time × dimension heatmap |
| `K` | Toggle action correlation matrix |
| `N` | Toggle normalization |
| `I` | Toggle episode info strip |
| `Ctrl+M` | Jump to midpoint of episode |

### Annotations
| Key | Action |
|-----|--------|
| `A` | Toggle Annotate tab |
| `Ctrl+S` | Fill & save annotations |
| `Del` | Clear all annotations for episode |
| `Tab` / `Shift+Tab` | Move between annotation fields |
| `↑` / `↓` | Prev / next unannotated frame |

### Export & UI
| Key | Action |
|-----|--------|
| `C` | Copy episode URL |
| `Ctrl+Shift+C` | Copy current frame values as JSON |
| `X` | Export episode annotations as CSV |
| `J` | Export episode as JSON |
| `W` | Export timestamps as CSV |
| `D` | Download current camera frame |
| `Ctrl+D` | Toggle dark mode |
| `V` / `P` | Toggle frame values panel |
| `Z` | Toggle raw data JSON viewer |
| `F` | Fullscreen camera |
| `M` | Mirror mode (hide labels) |
| `B` | Toggle sidebar |
| `?` | Show keyboard shortcut reference |
| `Escape` | Close lightbox / modal; clear compare overlay |

---

## 🔌 API Reference

The FastAPI server exposes a REST API at port 8765. Interactive docs are available at `/docs`.

### Dataset endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/datasets` | List all local datasets |
| `GET` | `/api/datasets/{ds}/meta` | Dataset metadata (info.json) |
| `GET` | `/api/datasets/{ds}/tasks` | Tasks and their episodes |
| `GET` | `/api/datasets/{ds}/stats` | Per-task episode count and length stats |
| `GET` | `/api/datasets/{ds}/norm_stats` | Normalization statistics (or `null`) |
| `GET` | `/api/datasets/{ds}/config` | Per-dataset config (camera labels, etc.) |
| `PUT` | `/api/datasets/{ds}/config` | Update per-dataset config |

### Episode endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/datasets/{ds}/episodes/{idx}` | Full episode data (state, action, timestamps) |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/frame/{f}` | Camera images for one frame (base64 JPEG) |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/frame/{f}/values` | All scalar + vector columns for a frame |

### Annotation endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/datasets/{ds}/annotation_schema` | Schema field definitions |
| `POST` | `/api/datasets/{ds}/annotation_schema` | Update schema |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Draft annotations for an episode |
| `PUT` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Bulk save annotations to JSON sidecar |
| `DELETE` | `/api/datasets/{ds}/episodes/{idx}/annotations` | Clear draft annotations |
| `POST` | `/api/datasets/{ds}/episodes/{idx}/annotations/commit` | Write annotations as Parquet columns |

### SSH endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ssh/connect` | Open SSH + SFTP connection |
| `GET` | `/api/ssh/sessions` | List active sessions and history |
| `DELETE` | `/api/ssh/sessions/{id}` | Disconnect session |
| `GET` | `/api/ssh/sessions/{id}/discover` | Discover datasets on remote server |
| `GET` | `/api/ssh/dl_status/{ds}/{idx}` | Download progress for a remote episode |

---

## 📁 Project Structure

```
lerobot-visualizer/
├── server.py               FastAPI backend (~1280 lines)
├── requirements.txt        Python dependencies
├── compute_norm_stats.py   Compute Q01/Q99 normalization stats
├── static/
│   ├── index.html          Single-page app shell (~390 lines)
│   ├── app.js              All client logic — playback, charts, annotation, SSH (~5900 lines)
│   └── style.css           Light + dark themes, design tokens (~2970 lines)
├── tools/
│   ├── utils.py            LeRobotWriter — exact v2.0 Parquet schema
│   ├── convert_hdf5.py     HDF5 → LeRobot (ALOHA / RoboMimic / LIBERO / custom)
│   └── convert_folder.py   Folder + CSV → LeRobot (layout A & B)
└── data/                   Datasets go here (git-ignored)
```

---

## 📋 Requirements

| Package | Purpose |
|---------|---------|
| `fastapi >= 0.100` | HTTP server |
| `uvicorn >= 0.20` | ASGI runner |
| `pyarrow >= 12.0` | Parquet read/write |
| `pillow >= 10.0` | Image encoding |
| `paramiko >= 3.0` | SSH / SFTP remote datasets |

Optional:

```bash
pip install h5py        # HDF5 conversion (convert_hdf5.py)
pip install opencv-python  # video dataset support (dtype="video")
```

Python ≥ 3.9, any modern browser (Chrome / Firefox / Safari).

---

## 📝 License

MIT

---

## 🤝 Contributing

Bug reports and pull requests are welcome. For larger changes, please open an issue first to discuss the approach.

---

## 📚 Related

- [LeRobot](https://github.com/huggingface/lerobot) — Hugging Face robot learning library and dataset format
- [LeRobot datasets on HuggingFace](https://huggingface.co/datasets?other=LeRobot) — Community datasets
