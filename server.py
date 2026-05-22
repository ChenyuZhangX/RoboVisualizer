import json
import base64
import io
from pathlib import Path
from typing import Optional

import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from PIL import Image

DATA_DIR = Path(__file__).parent / "data"
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="LeRobot Visualizer")


def is_valid_dataset(path: Path) -> bool:
    return (path / "meta" / "info.json").exists()


def get_dataset_path(dataset: str) -> Path:
    p = DATA_DIR / dataset
    if not p.exists() or not is_valid_dataset(p):
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    return p


# ── API ──────────────────────────────────────────────────────────────────────

@app.get("/api/datasets")
def list_datasets():
    if not DATA_DIR.exists():
        return []
    results = []
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir() and is_valid_dataset(d):
            info = json.loads((d / "meta" / "info.json").read_text())
            results.append({
                "name": d.name,
                "path": d.name,
                "total_episodes": info.get("total_episodes", 0),
                "total_tasks": info.get("total_tasks", 0),
                "robot_type": info.get("robot_type", "unknown"),
                "fps": info.get("fps", 10),
            })
    return results


@app.get("/api/datasets/{dataset}/tasks")
def list_tasks(dataset: str):
    base = get_dataset_path(dataset)

    tasks_file = base / "meta" / "tasks.jsonl"
    episodes_file = base / "meta" / "episodes.jsonl"

    tasks = {}
    for line in tasks_file.read_text().splitlines():
        if line.strip():
            t = json.loads(line)
            tasks[t["task_index"]] = {"task_index": t["task_index"], "task": t["task"], "episodes": []}

    info = json.loads((base / "meta" / "info.json").read_text())
    chunks_size = info.get("chunks_size", 1000)

    for line in episodes_file.read_text().splitlines():
        if line.strip():
            ep = json.loads(line)
            ep_idx = ep["episode_index"]
            chunk = ep_idx // chunks_size
            parquet = base / "data" / f"chunk-{chunk:03d}" / f"episode_{ep_idx:06d}.parquet"
            if not parquet.exists():
                continue
            task_name = ep["tasks"][0] if ep.get("tasks") else ""
            for ti, tv in tasks.items():
                if tv["task"] == task_name:
                    tv["episodes"].append({
                        "episode_index": ep_idx,
                        "length": ep.get("length", 0),
                    })
                    break

    # drop tasks with no local episodes
    return [t for t in sorted(tasks.values(), key=lambda x: x["task_index"]) if t["episodes"]]


@app.get("/api/datasets/{dataset}/norm_stats")
def get_norm_stats(dataset: str):
    base = get_dataset_path(dataset)
    p = base / "meta" / "norm_stats.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


@app.get("/api/datasets/{dataset}/episodes/{episode_index}")
def get_episode(dataset: str, episode_index: int):
    base = get_dataset_path(dataset)
    info = json.loads((base / "meta" / "info.json").read_text())

    chunk = episode_index // info.get("chunks_size", 1000)
    parquet_path = base / "data" / f"chunk-{chunk:03d}" / f"episode_{episode_index:06d}.parquet"

    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    table = pq.read_table(parquet_path)
    df_dict = table.to_pydict()

    features = info.get("features", {})

    # detect image keys (dtype == "image" or column contains bytes/large_binary)
    image_keys = [k for k, v in features.items() if v.get("dtype") == "image"]
    if not image_keys:
        # fallback: check schema
        for field in table.schema:
            if "binary" in str(field.type).lower():
                image_keys.append(field.name)

    state_names = features.get("state", {}).get("names") or [f"state_{i}" for i in range(len(df_dict.get("state", [[]])[0]))]
    action_names = features.get("actions", {}).get("names") or [f"action_{i}" for i in range(len(df_dict.get("actions", [[]])[0]))]

    # Flatten nested arrays if needed
    def to_list(col):
        if not col:
            return []
        first = col[0]
        if isinstance(first, (list, tuple)):
            return [list(row) for row in col]
        return [[v] for v in col]

    return {
        "episode_index": episode_index,
        "length": len(df_dict.get("timestamp", [])),
        "fps": info.get("fps", 10),
        "timestamps": [float(t[0]) if isinstance(t, (list, tuple)) else float(t) for t in df_dict.get("timestamp", [])],
        "state": to_list(df_dict.get("state", [])),
        "actions": to_list(df_dict.get("actions", [])),
        "state_names": state_names if isinstance(state_names, list) else list(state_names),
        "action_names": action_names if isinstance(action_names, list) else list(action_names),
        "image_keys": image_keys,
        "has_images": len(image_keys) > 0,
    }


@app.get("/api/datasets/{dataset}/episodes/{episode_index}/frame/{frame_index}")
def get_frame(dataset: str, episode_index: int, frame_index: int):
    base = get_dataset_path(dataset)
    info = json.loads((base / "meta" / "info.json").read_text())

    chunk = episode_index // info.get("chunks_size", 1000)
    parquet_path = base / "data" / f"chunk-{chunk:03d}" / f"episode_{episode_index:06d}.parquet"

    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    features = info.get("features", {})
    image_keys = [k for k, v in features.items() if v.get("dtype") == "image"]

    table = pq.read_table(parquet_path, columns=image_keys if image_keys else None)
    df_dict = table.to_pydict()

    if frame_index < 0 or frame_index >= table.num_rows:
        raise HTTPException(400, f"frame_index {frame_index} out of range")

    result = {}
    for key in image_keys:
        col = df_dict.get(key, [])
        if not col or frame_index >= len(col):
            continue
        raw = col[frame_index]
        # raw may be bytes or a dict with "bytes" key (lerobot format)
        if isinstance(raw, dict):
            raw = raw.get("bytes", b"")
        if isinstance(raw, (bytes, bytearray)) and raw:
            try:
                img = Image.open(io.BytesIO(raw))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
                result[key] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
            except Exception:
                pass

    return result


# ── Static files ─────────────────────────────────────────────────────────────

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8765, reload=True)
