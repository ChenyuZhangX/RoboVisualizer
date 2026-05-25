from __future__ import annotations

import base64
import io
import json
import time
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException, Response
from fastapi import Path as _PathParam
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

# Optional video support via cv2 (OpenCV)
try:
    import cv2 as _cv2
    _HAS_CV2 = True
except ImportError:
    _cv2 = None
    _HAS_CV2 = False

_SERVER_START_TIME = time.time()
_JPEG_QUALITY = 85
_FRAME_CACHE_CONTROL = "max-age=3600, stale-while-revalidate=300"

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

# ── Annotation models ─────────────────────────────────────────────────────────

class AnnotationField(BaseModel):
    name: str
    type: str  # "number" | "string" | "boolean" | "category"
    options: Optional[List[str]] = None  # for category type only


class AnnotationSchemaUpdate(BaseModel):
    fields: list[AnnotationField]


class AnnotationFrameUpdate(BaseModel):
    frame_index: int
    values: dict[str, Any]


class CommitBody(BaseModel):
    # Optional pre-filled frames from the client (includes interpolated / default values).
    # Keys are string frame indices; values are {field_name: value}.
    # When provided, these are used instead of the on-disk JSON sidecar.
    filled_frames: Optional[dict] = None


class AnnotationBulkSave(BaseModel):
    # Full frame map to persist atomically to the JSON sidecar.
    # Keys are string frame indices; values are {field_name: value}.
    frames: dict


# ── Annotation helpers ────────────────────────────────────────────────────────

_VALID_ANN_TYPES = {"number", "string", "boolean", "category"}
_FIELD_NAME_RE = __import__("re").compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,63}$")


def _validate_field_name(name: str) -> None:
    if not _FIELD_NAME_RE.match(name):
        raise HTTPException(400, f"Invalid field name '{name}': use letters, digits, underscores (start with letter/underscore, max 64 chars)")


def annotation_dir(base: Path) -> Path:
    return base / "data" / "annotations"


def annotation_path(base: Path, episode_index: int) -> Path:
    return annotation_dir(base) / f"episode_{episode_index:06d}.json"


def annotation_schema_path(base: Path) -> Path:
    return base / "meta" / "annotation_schema.json"


def read_annotations(base: Path, episode_index: int) -> dict:
    p = annotation_path(base, episode_index)
    if not p.exists():
        return {"frames": {}}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"frames": {}}


def write_annotations(base: Path, episode_index: int, data: dict) -> None:
    p = annotation_path(base, episode_index)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(p)  # atomic on POSIX; near-atomic on Windows


DATA_DIR = Path(__file__).parent / "data"
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="LeRobot Visualizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "PUT", "OPTIONS"],
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


_DATA_DIR_RESOLVED = DATA_DIR.resolve()


def get_dataset_path(dataset: str) -> Path:
    resolved = (DATA_DIR / dataset).resolve()
    if not resolved.is_relative_to(_DATA_DIR_RESOLVED) or not is_valid_dataset(resolved):
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    return resolved


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
        ok2, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY])
        if not ok2:
            return None
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    finally:
        cap.release()


def _to_list(col: list) -> list[list]:
    if not col:
        return []
    first = col[0]
    if isinstance(first, (list, tuple)):
        return [list(row) for row in col]
    return [[v] for v in col]


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
            total_frames: int | None = None
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
    total_frames: int | None = None
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
def get_episode(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)]):
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

    _state_data = df_dict.get("state", [])
    _action_data = df_dict.get(action_col, [])
    _state_dim = len(_state_data[0]) if _state_data else 0
    _action_dim = len(_action_data[0]) if _action_data else 0
    action_feat_key = "actions" if "actions" in features else "action"
    state_names = features.get("state", {}).get("names") or [f"state_{i}" for i in range(_state_dim)]
    action_names = features.get(action_feat_key, {}).get("names") or [f"action_{i}" for i in range(_action_dim)]

    return {
        "episode_index": episode_index,
        "length": len(df_dict.get("timestamp", [])),
        "fps": info.get("fps", 10),
        "timestamps": [float(t[0]) if isinstance(t, (list, tuple)) else float(t) for t in df_dict.get("timestamp", [])],
        "state": _to_list(df_dict.get("state", [])),
        "actions": _to_list(df_dict.get(action_col, [])),
        "state_names": state_names if isinstance(state_names, list) else list(state_names),
        "action_names": action_names if isinstance(action_names, list) else list(action_names),
        "image_keys": all_visual_keys,
        "has_images": len(all_visual_keys) > 0,
        "video_keys": video_keys,
        "robot_type": info.get("robot_type", "unknown"),
        "dataset": dataset,
    }


@app.get("/api/datasets/{dataset}/episodes/{episode_index}/frame/{frame_index}")
def get_frame(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)], frame_index: Annotated[int, _PathParam(ge=0)], response: Response):
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
                    img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
                    result[key] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
                except Exception:
                    pass

    # Frames are immutable; cache for 1 hour in browser, 5 min in CDN
    response.headers["Cache-Control"] = _FRAME_CACHE_CONTROL
    return result


@app.get("/api/datasets/{dataset}/episodes/{episode_index}/frame/{frame_index}/values")
def get_frame_scalar_values(
    dataset: str,
    episode_index: Annotated[int, _PathParam(ge=0)],
    frame_index:   Annotated[int, _PathParam(ge=0)],
):
    """Return all non-image/video scalar columns for a single frame as a flat dict."""
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    parquet_path = parquet_path_for(base, episode_index, info)
    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    features = info.get("features", {})
    skip_keys = {k for k, v in features.items() if v.get("dtype") in ("image", "video")}

    table = read_parquet_cached(parquet_path)
    if frame_index >= table.num_rows:
        raise HTTPException(400, f"frame_index {frame_index} out of range (episode has {table.num_rows} frames)")

    df_dict = table.to_pydict()
    result: dict[str, Any] = {}
    for col_name, col_data in df_dict.items():
        if col_name in skip_keys or not col_data or frame_index >= len(col_data):
            continue
        val = col_data[frame_index]
        if isinstance(val, (bytes, bytearray)):
            continue
        if isinstance(val, dict):
            # Embedded-image dict — skip
            if "bytes" in val:
                continue
            result[col_name] = val
        elif isinstance(val, (list, tuple)):
            result[col_name] = [
                round(float(x), 7) if isinstance(x, float) else
                (int(x) if hasattr(x, "__int__") else x)
                for x in val
            ]
        elif isinstance(val, float):
            result[col_name] = round(val, 7)
        elif isinstance(val, bool):
            result[col_name] = val
        elif hasattr(val, "__int__"):
            result[col_name] = int(val)
        else:
            result[col_name] = str(val)
    return result


# ── Annotation API ────────────────────────────────────────────────────────────

@app.get("/api/datasets/{dataset}/annotation_schema")
def get_annotation_schema(dataset: str):
    base = get_dataset_path(dataset)
    p = annotation_schema_path(base)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


@app.post("/api/datasets/{dataset}/annotation_schema")
def save_annotation_schema(dataset: str, body: AnnotationSchemaUpdate):
    base = get_dataset_path(dataset)
    seen: set[str] = set()
    for f in body.fields:
        _validate_field_name(f.name)
        if f.type not in _VALID_ANN_TYPES:
            raise HTTPException(400, f"Invalid type '{f.type}' for field '{f.name}'")
        if f.name in seen:
            raise HTTPException(400, f"Duplicate field name '{f.name}'")
        seen.add(f.name)
    p = annotation_schema_path(base)
    p.write_text(json.dumps([f.model_dump(exclude_none=True) for f in body.fields], ensure_ascii=False))
    return {"ok": True, "count": len(body.fields)}


@app.get("/api/datasets/{dataset}/annotations")
def list_all_annotations(dataset: str):
    """Return summary of every episode that has a saved annotation draft."""
    base = get_dataset_path(dataset)
    ann_dir = annotation_dir(base)
    result = []
    if ann_dir.exists():
        for p in sorted(ann_dir.glob("episode_*.json")):
            try:
                ep_idx = int(p.stem.split("_")[1])
                data = json.loads(p.read_text())
                frames = data.get("frames", {})
                result.append({
                    "episode_index": ep_idx,
                    "frame_count": len(frames),
                    "field_names": sorted({f for fv in frames.values() for f in fv}),
                })
            except Exception:
                continue
    return result


@app.get("/api/datasets/{dataset}/episodes/{episode_index}/annotations")
def get_annotations(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)]):
    base = get_dataset_path(dataset)
    return read_annotations(base, episode_index)


@app.post("/api/datasets/{dataset}/episodes/{episode_index}/annotations")
def save_annotation_frame(
    dataset: str,
    episode_index: Annotated[int, _PathParam(ge=0)],
    body: AnnotationFrameUpdate,
):
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    parquet_path = parquet_path_for(base, episode_index, info)
    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    data = read_annotations(base, episode_index)
    key = str(body.frame_index)
    if body.values:
        data["frames"][key] = body.values
    else:
        data["frames"].pop(key, None)  # remove frame entry when cleared
    write_annotations(base, episode_index, data)
    return {"ok": True, "frame_index": body.frame_index}


@app.delete("/api/datasets/{dataset}/episodes/{episode_index}/annotations")
def clear_annotations(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)]):
    base = get_dataset_path(dataset)
    p = annotation_path(base, episode_index)
    if p.exists():
        p.unlink()
    return {"ok": True}


@app.put("/api/datasets/{dataset}/episodes/{episode_index}/annotations")
def save_all_annotations(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)], body: AnnotationBulkSave):
    """Atomically overwrite the annotation sidecar with the full frame map supplied by the client."""
    base = get_dataset_path(dataset)
    write_annotations(base, episode_index, {"frames": body.frames})
    return {"ok": True, "frame_count": len(body.frames)}


@app.post("/api/datasets/{dataset}/episodes/{episode_index}/annotations/commit")
def commit_annotations(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)], body: CommitBody = None):
    """Write annotation draft JSON as new columns into the episode's Parquet file."""
    if body is None:
        body = CommitBody()
    base = get_dataset_path(dataset)
    info = read_info_cached(base)
    parquet_path = parquet_path_for(base, episode_index, info)
    if not parquet_path.exists():
        raise HTTPException(404, f"Episode {episode_index} not found")

    schema_list = []
    sp = annotation_schema_path(base)
    if sp.exists():
        try:
            schema_list = json.loads(sp.read_text())
        except Exception:
            pass
    if not schema_list:
        raise HTTPException(400, "No annotation schema defined")

    # Use pre-filled frames from client if provided, otherwise read sidecar
    if body.filled_frames is not None:
        frames = body.filled_frames
    else:
        ann_data = read_annotations(base, episode_index)
        frames = ann_data.get("frames", {})
    if not frames:
        raise HTTPException(400, "No annotations to commit")

    table = pq.read_table(parquet_path)
    n_rows = table.num_rows

    _type_map = {
        "number": pa.float64(),
        "string": pa.string(),
        "boolean": pa.bool_(),
        "category": pa.string(),
    }

    new_columns: dict[str, list] = {}
    for field_def in schema_list:
        fname = field_def["name"]
        ftype = field_def.get("type", "string")
        arr = [None] * n_rows
        for fi_str, vals in frames.items():
            fi = int(fi_str)
            if 0 <= fi < n_rows and fname in vals:
                raw = vals[fname]
                if ftype == "number":
                    try:
                        raw = float(raw)
                    except (TypeError, ValueError):
                        raw = None
                elif ftype == "boolean":
                    raw = bool(raw)
                else:
                    raw = str(raw) if raw is not None else None
                arr[fi] = raw
        pa_type = _type_map.get(ftype, pa.string())
        new_columns[fname] = pa.array(arr, type=pa_type)

    # Drop any existing columns with the same names (re-commit)
    existing_names = table.schema.names
    keep_cols = [c for c in existing_names if c not in new_columns]
    if keep_cols != existing_names:
        table = table.select(keep_cols)

    for col_name, col_arr in new_columns.items():
        table = table.append_column(col_name, col_arr)

    pq.write_table(table, parquet_path, compression="snappy")
    # Invalidate LRU cache entry so next read reflects new columns
    key = str(parquet_path)
    _TABLE_CACHE.pop(key, None)

    return {"ok": True, "columns_written": list(new_columns.keys()), "rows": n_rows}


# ── Static files ─────────────────────────────────────────────────────────────

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8765, reload=True)
