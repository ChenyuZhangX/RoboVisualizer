# RoboVisualizer

A local web-based visualizer for [LeRobot](https://github.com/huggingface/lerobot) v2.0 datasets. Browse episodes, watch multi-camera playback, and inspect state/action trajectories — all from a clean browser UI backed by a lightweight FastAPI server.

---

## Features

- **Dataset browser** — sidebar tree of datasets → tasks → episodes, with episode length shown
- **Multi-camera playback** — up to 3 camera views side-by-side; grey placeholder when fewer cameras are present
- **State & Action charts** — Chart.js line plots with a synchronized red cursor that moves with playback
- **Per-dimension expand** — toggle any chart to split each dimension into its own mini-plot
- **Normalization** — auto-detects `norm_stats.json`; if present, normalizes data to \[−1, 1\] using Q01/Q99 clip normalization with a green badge indicator
- **Playback controls** — play/pause, rewind, scrubber, frame counter; driven by dataset FPS from `info.json`
- **Conversion tools** — scripts to convert HDF5 (ALOHA, RoboMimic, LIBERO) and folder-based datasets into LeRobot format

---

## Quick Start

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

## Interface

```
┌─────────────────────────────────────────────────────────────────┐
│  RoboVisualizer                                                  │
├──────────────────┬──────────────────────────────────────────────┤
│  DATASETS        │  ┌──────────┬──────────┬──────────┐         │
│  ▼ libero        │  │  image   │  wrist   │  (grey)  │         │
│    ▼ Task 0      │  └──────────┴──────────┴──────────┘         │
│      ep_000000   │                                              │
│      ep_000018   │  "put the white mug on the left plate…"      │
│    ▼ Task 1      │                                              │
│      ep_000001   │  State ⊞  [normalized −1,1]                 │
│      ...         │  ──────────╫──────────────────────           │
│                  │                                              │
│                  │  Action ⊞  [normalized −1,1]                 │
│                  │  ──────────╫──────────────────────           │
│                  │                                              │
│                  │  [⏮]  [▶]  ━━━━━●━━━━━━━━━  42 / 214       │
└──────────────────┴──────────────────────────────────────────────┘
```

---

## Normalization

Run the following script against a full LeRobot dataset to generate `meta/norm_stats.json`:

```bash
# Edit DATASET path at the top of the script, then:
python compute_norm_stats.py
```

The script computes per-dimension **mean, std, min, max, Q01, Q99** for `state`, `action`, and `delta_action` (frame-to-frame action differences) across all episodes.

Once `norm_stats.json` is present in `meta/`, the visualizer automatically normalizes state and action plots to \[−1, 1\] using:

```
x_clipped  = clip(x, q01, q99)
x_norm     = 2 × (x_clipped − q01) / (q99 − q01) − 1
```

---

## Conversion Tools

Convert other dataset formats into LeRobot v2.0 parquet format using the scripts in `tools/`.

### HDF5 datasets

Supports **ALOHA/ACT**, **RoboMimic**, and **LIBERO** out of the box, plus a fully configurable custom mode.

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

## Project Structure

```
RoboVisualizer/
├── server.py               FastAPI backend (dataset / episode / frame APIs)
├── requirements.txt
├── compute_norm_stats.py   Compute Q01/Q99 norm stats for a full dataset
├── static/
│   ├── index.html          Single-page UI
│   ├── app.js              Dataset browser, charts, playback logic
│   └── style.css           White-background, blue accent theme
├── tools/
│   ├── utils.py            LeRobotWriter — exact v2.0 parquet schema writer
│   ├── convert_hdf5.py     HDF5 → LeRobot (ALOHA / RoboMimic / LIBERO / custom)
│   └── convert_folder.py   Folder + CSV → LeRobot (layout A & B)
└── data/                   ← place datasets here (git-ignored)
```

---

## API Reference

The FastAPI server exposes the following endpoints (also browsable at `/docs`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/datasets` | List all datasets in `./data/` |
| `GET` | `/api/datasets/{ds}/tasks` | Tasks and their local episodes |
| `GET` | `/api/datasets/{ds}/episodes/{idx}` | Episode state/action/metadata |
| `GET` | `/api/datasets/{ds}/episodes/{idx}/frame/{f}` | Camera images for one frame (base64 JPEG) |
| `GET` | `/api/datasets/{ds}/norm_stats` | Normalization statistics (or `null`) |

---

## Requirements

- Python ≥ 3.9
- `fastapi`, `uvicorn`, `pyarrow`, `pillow`
- A modern browser (Chrome / Firefox / Safari)

For conversion tools, additionally: `h5py` (HDF5), `numpy`

```bash
pip install h5py   # only needed for convert_hdf5.py
```
