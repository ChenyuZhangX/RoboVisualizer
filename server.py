from __future__ import annotations

import base64
import io
import json
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from PIL import Image

# Optional video support via cv2 (OpenCV)
try:
    import cv2 as _cv2
    _HAS_CV2 = True
except ImportError:
    _cv2 = None
    _HAS_CV2 = False

_SERVER_START_TIME = time.time()

# ── Metadata caches (keyed by dataset path string) ───────────────────────────
_INFO_CACHE: dict[str, dict] = {}
_TASKS_CACHE: dict[str, list] = {}
_EPISODES_CACHE: dict[str, list] = {}


def _read_jsonl_cached(cache: dict, base: Path, filename: str) -> list[dict]:
    key = str(base)
    if key not in cache:
        cache[key] = [
            json.loads(line)
            for line in (base / "meta" / filename).read_text().splitlines()
            if line.strip()
        ]
    return cache[key]


def read_info_cached(base: Path) -> dict:
    key = str(base)
    if key not in _INFO_CACHE:
        _INFO_CACHE[key] = json.loads((base / "meta" / "info.json").read_text())
    return _INFO_CACHE[key]


def read_tasks_cached(base: Path) -> list[dict]:
    return _read_jsonl_cached(_TASKS_CACHE, base, "tasks.jsonl")


def read_episodes_cached(base: Path) -> list[dict]:
    return _read_jsonl_cached(_EPISODES_CACHE, base, "episodes.jsonl")

DATA_DIR = Path(__file__).parent / "data"
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="LeRobot Visualizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=512)

# ── Parquet table cache (LRU, max 24 tables) ─────────────────────────────────
_TABLE_CACHE: OrderedDict = OrderedDict()
_TABLE_CACHE_MAX = 24


def read_parquet_cached(path: Path, columns: list[str] | None = None):
    """Read a parquet file with LRU caching. Raises HTTPException on corrupt files."""
    key = str(path)
    if key in _TABLE_CACHE:
        _TABLE_CACHE.move_to_end(key)
        table = _TABLE_CACHE[key]
    else:
        try:
            table = pq.read_table(path)
        except Exception as exc:
            raise HTTPException(500, f"Failed to read parquet: {exc}") from exc
        _TABLE_CACHE[key] = table
        _TABLE_CACHE.move_to_end(key)
        if len(_TABLE_CACHE) > _TABLE_CACHE_MAX:
            _TABLE_CACHE.popitem(last=False)
    if columns is not None:
        existing = [c for c in columns if c in table.schema.names]
        return table.select(existing) if existing else table
    return table


def is_valid_dataset(path: Path) -> bool:
    return (path / "meta" / "info.json").exists()


def get_dataset_path(dataset: str) -> Path:
    p = DATA_DIR / dataset
    if not p.exists() or not is_valid_dataset(p):
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    return p


# ── Video helpers ────────────────────────────────────────────────────────────

def episode_chunk(info: dict, episode_index: int) -> int:
    return episode_index // info.get("chunks_size", 1000)


def parquet_path_for(base: Path, episode_index: int, info: dict) -> Path:
    chunk = episode_chunk(info, episode_index)
    return base / "data" / f"chunk-{chunk:03d}" / f"episode_{episode_index:06d}.parquet"


def video_path_for(base: Path, key: str, chunk: int, episode_index: int) -> Path:
    return base / "videos" / f"chunk-{chunk:03d}" / f"{key}_episode_{episode_index:06d}.mp4"


def extract_video_frame(video_path: Path, frame_index: int) -> str | None:
    """Return base64 JPEG data-URI for frame_index from an MP4 file, or None on failure."""
    if not _HAS_CV2:
        return None
    cap = _cv2.VideoCapture(str(video_path))
    try:
        cap.set(_cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, frame = cap.read()
        if not ok:
            return None
        ok2, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok2:
            return None
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    finally:
        cap.release()


# ── API ──────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    dataset_count = sum(1 for d in DATA_DIR.iterdir() if d.is_dir() and is_valid_dataset(d)) if DATA_DIR.exists() else 0
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "data_dir_exists": DATA_DIR.exists(),
        "dataset_count": dataset_count,
        "video_support": _HAS_CV2,
        "uptime_s": round(time.time() - _SERVER_START_TIME, 1),
        "cache_parquet": len(_TABLE_CACHE),
        "cache_info": len(_INFO_CACHE),
        "cache_tasks": len(_TASKS_CACHE),
        "cache_episodes": len(_EPISODES_CACHE),
    }


@app.post("/api/cache/clear")
def clear_cache():
    counts = {
        "parquet": len(_TABLE_CACHE),
        "info": len(_INFO_CACHE),
        "tasks": len(_TASKS_CACHE),
        "episodes": len(_EPISODES_CACHE),
    }
    _TABLE_CACHE.clear()
    _INFO_CACHE.clear()
    _TASKS_CACHE.clear()
    _EPISODES_CACHE.clear()
    return {"cleared": counts, "total": sum(counts.values())}


@app.get("/api/datasets")
def list_datasets():
    if not DATA_DIR.exists():
        return []
    results = []
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir() and is_valid_dataset(d):
            info = read_info_cached(d)
            # Compute total frames from cached episodes if available (fast)
            total_frames: Optional[int] = None
            if str(d) in _EPISODES_CACHE:
                eps = _EPISODES_CACHE[str(d)]
                total_frames = sum(ep.get("length", 0) for ep in eps)
            results.append({
                "name": d.name,
                "path": d.name,
                "total_episodes": info.get("total_episodes", 0),
                "total_tasks": info.get("total_tasks", 0),
                "robot_type": info.get("robot_type", "unknown"),
                "fps": info.get("fps", 10),
                "total_frames": total_frames,
            })
    return results


@app.get("/api/datasets/{dataset}/meta")
def get_dataset_meta(dataset: str):
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    # Include total_frames if episodes cache is populated
    total_frames: Optional[int] = None
    key = str(base)
    if key in _EPISODES_CACHE:
        total_frames = sum(ep.get("length", 0) for ep in _EPISODES_CACHE[key])
    return {
        "name": dataset,
        "total_episodes": info.get("total_episodes", 0),
        "total_tasks": info.get("total_tasks", 0),
        "robot_type": info.get("robot_type", "unknown"),
        "fps": info.get("fps", 10),
        "features": info.get("features", {}),
        "chunks_size": info.get("chunks_size", 1000),
        "total_frames": total_frames,
    }


@app.get("/api/datasets/{dataset}/tasks")
def list_tasks(dataset: str):
    base = get_dataset_path(dataset)

    tasks = {}
    for t in read_tasks_cached(base):
        tasks[t["task_index"]] = {"task_index": t["task_index"], "task": t["task"], "episodes": []}

    info = read_info_cached(base)

    # Build task → name lookup for O(1) matching
    task_by_name: dict[str, int] = {tv["task"]: ti for ti, tv in tasks.items()}

    for ep in read_episodes_cached(base):
        ep_idx = ep["episode_index"]
        if not parquet_path_for(base, ep_idx, info).exists():
            continue
        task_name = ep["tasks"][0] if ep.get("tasks") else ""
        ti = task_by_name.get(task_name)
        if ti is not None:
            tasks[ti]["episodes"].append({
                "episode_index": ep_idx,
                "length": ep.get("length", 0),
            })

    # drop tasks with no local episodes
    return [t for t in sorted(tasks.values(), key=lambda x: x["task_index"]) if t["episodes"]]


@app.get("/api/datasets/{dataset}/stats")
def get_dataset_stats(dataset: str):
    """Aggregate statistics for a dataset: total frames, episode length distribution."""
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    episodes = read_episodes_cached(base)

    lengths = [ep.get("length", 0) for ep in episodes if ep.get("length", 0) > 0]
    if not lengths:
        return {"total_frames": 0, "episode_count": 0, "length_min": 0,
                "length_max": 0, "length_mean": 0.0, "length_p50": 0}

    lengths_sorted = sorted(lengths)
    n = len(lengths_sorted)
    total = sum(lengths_sorted)
    p50 = lengths_sorted[n // 2]
    fps = info.get("fps", 10) or 10
    return {
        "total_frames": total,
        "total_duration_s": round(total / fps, 2),
        "episode_count": n,
        "length_min": lengths_sorted[0],
        "length_max": lengths_sorted[-1],
        "length_mean": round(total / n, 1),
        "length_p50": p50,
        "fps": fps,
    }


@app.get("/api/datasets/{dataset}/episodes")
def list_episodes(dataset: str):
    """List all episodes with their metadata (index, length, tasks)."""
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    return [
        {
            "episode_index": ep["episode_index"],
            "length": ep.get("length", 0),
            "tasks": ep.get("tasks", []),
            "has_data": parquet_path_for(base, ep["episode_index"], info).exists(),
        }
        for ep in read_episodes_cached(base)
    ]


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
    info = read_info_cached(base)

    chunk = episode_chunk(info, episode_index)
    parquet_path = parquet_path_for(base, episode_index, info)

    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    table = read_parquet_cached(parquet_path)
    df_dict = table.to_pydict()

    features = info.get("features", {})

    # detect image keys (embedded bytes in parquet); fall back to schema inspection
    image_keys = (
        [k for k, v in features.items() if v.get("dtype") == "image"]
        or [f.name for f in table.schema if "binary" in str(f.type).lower()]
    )

    # detect video keys (separate MP4 files)
    video_keys = [
        k for k, v in features.items()
        if v.get("dtype") == "video"
        and video_path_for(base, k, chunk, episode_index).exists()
    ]
    # merge; video keys take priority when both present for same logical camera
    all_visual_keys = image_keys + [k for k in video_keys if k not in image_keys]

    # Support both "action" (v1) and "actions" (v2) column names
    action_col = "actions" if "actions" in df_dict else "action"

    state_names = features.get("state", {}).get("names") or [f"state_{i}" for i in range(len(df_dict.get("state", [[]])[0]))]
    action_feat_key = "actions" if "actions" in features else "action"
    action_names = features.get(action_feat_key, {}).get("names") or [f"action_{i}" for i in range(len(df_dict.get(action_col, [[]])[0]))]

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
        "actions": to_list(df_dict.get(action_col, [])),
        "state_names": state_names if isinstance(state_names, list) else list(state_names),
        "action_names": action_names if isinstance(action_names, list) else list(action_names),
        "image_keys": all_visual_keys,
        "has_images": len(all_visual_keys) > 0,
        "video_keys": video_keys,
        "robot_type": info.get("robot_type", "unknown"),
        "dataset": dataset,
    }


@app.get("/api/datasets/{dataset}/episodes/{episode_index}/frame/{frame_index}")
def get_frame(dataset: str, episode_index: int, frame_index: int, response: Response):
    base = get_dataset_path(dataset)
    info = read_info_cached(base)

    chunk = episode_chunk(info, episode_index)
    parquet_path = parquet_path_for(base, episode_index, info)

    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    features = info.get("features", {})
    image_keys = [k for k, v in features.items() if v.get("dtype") == "image"]
    video_keys = [k for k, v in features.items() if v.get("dtype") == "video"]

    result = {}

    # ── Video-based frames ────────────────────────────────────────────────────
    for key in video_keys:
        vp = video_path_for(base, key, chunk, episode_index)
        if not vp.exists():
            continue
        uri = extract_video_frame(vp, frame_index)
        if uri:
            result[key] = uri

    # ── Parquet-embedded images (only for keys not already served from video) ─
    remaining = [k for k in image_keys if k not in result]
    if remaining:
        table = read_parquet_cached(parquet_path, columns=remaining)
        df_dict = table.to_pydict()

        if frame_index < 0 or frame_index >= table.num_rows:
            raise HTTPException(400, f"frame_index {frame_index} out of range")

        for key in remaining:
            col = df_dict.get(key, [])
            if not col or frame_index >= len(col):
                continue
            raw = col[frame_index]
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

    # Frames are immutable; cache for 1 hour in browser, 5 min in CDN
    response.headers["Cache-Control"] = "max-age=3600, stale-while-revalidate=300"
    return result


# ── Static files ─────────────────────────────────────────────────────────────

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8765, reload=True)
