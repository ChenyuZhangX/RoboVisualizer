from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import stat as _stat
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import Body, FastAPI, HTTPException, Response
from fastapi import Path as _PathParam
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

# Optional SSH support
try:
    import paramiko as _paramiko
    _HAS_PARAMIKO = True
except ImportError:
    _paramiko = None
    _HAS_PARAMIKO = False

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
_CONFIG_CACHE: dict[str, dict] = {}


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


def _config_path(base: Path) -> Path:
    return base / "meta" / "config.json"


def _default_cam_label(key: str) -> str:
    """Convert a raw camera key to a human-readable label."""
    _MAP = {
        "image": "Camera", "top": "Top View", "wrist_image": "Wrist Camera",
        "wrist_left": "Wrist (Left)", "wrist_right": "Wrist (Right)",
        "exterior_1_left": "Exterior 1", "exterior_2_left": "Exterior 2",
        "exterior_1_right": "Exterior 1 (R)", "exterior_2_right": "Exterior 2 (R)",
        "side_image": "Side View", "agentview": "Agent View",
    }
    return _MAP.get(key, key.replace("_", " ").title())


def read_config_cached(base: Path) -> dict:
    key = str(base)
    if key not in _CONFIG_CACHE:
        p = _config_path(base)
        stored = json.loads(p.read_text()) if p.exists() else {}
        # Auto-fill camera labels for any key not already in stored config
        info = read_info_cached(base)
        feats = info.get("features", {})
        cam_keys = [k for k, v in feats.items() if v.get("dtype") == "image"]
        labels = {k: _default_cam_label(k) for k in cam_keys}
        labels.update(stored.get("camera_labels", {}))  # stored overrides defaults
        _CONFIG_CACHE[key] = {**stored, "camera_labels": labels}
    return _CONFIG_CACHE[key]

# ── SSH remote dataset support ────────────────────────────────────────────────

SSH_CACHE_BASE = Path("/tmp/lerobot_ssh_cache")
SSH_HISTORY_FILE = Path.home() / ".lerobot_visualizer" / "ssh_history.json"

_SSH_SESSIONS: dict[str, dict] = {}      # session_id → {client, sftp, ssh_command, remote_path, label}
_SSH_DATASET_MAP: dict[str, dict] = {}   # virtual_name → {session_id, remote_path, local_hash}
_SFTP_DOWNLOADS: dict[str, dict] = {}    # dl_key → {status, downloaded, total, local_path}
_SSH_SFTP_LOCKS: dict[str, threading.Lock] = {}  # session_id → per-session SFTP lock


def _ssh_vname(session_id: str, remote_path: str) -> str:
    h = hashlib.md5(f"{session_id}:{remote_path}".encode()).hexdigest()[:8]
    return f"__ssh_{session_id}_{h}__"


def _ssh_local_dir(session_id: str, remote_path: str) -> Path:
    h = hashlib.md5(f"{session_id}:{remote_path}".encode()).hexdigest()[:8]
    return SSH_CACHE_BASE / session_id / h


def _get_sftp_lock(session_id: str) -> threading.Lock:
    if session_id not in _SSH_SFTP_LOCKS:
        _SSH_SFTP_LOCKS[session_id] = threading.Lock()
    return _SSH_SFTP_LOCKS[session_id]


def _is_ssh_dataset(base: Path) -> bool:
    try:
        return base.resolve().is_relative_to(SSH_CACHE_BASE.resolve())
    except Exception:
        return False


def _ssh_entry_for(base: Path) -> dict | None:
    if not _is_ssh_dataset(base):
        return None
    for entry in _SSH_DATASET_MAP.values():
        local = _ssh_local_dir(entry["session_id"], entry["remote_path"])
        if base == local or str(base).startswith(str(local)):
            return entry
    return None


def _ensure_remote_file(session_id: str, remote_base: str, local_base: Path, rel_path: str) -> Path:
    local_path = local_base / rel_path
    if local_path.exists():
        return local_path
    if session_id not in _SSH_SESSIONS:
        raise HTTPException(503, "SSH session expired — please reconnect")
    sftp = _SSH_SESSIONS[session_id]["sftp"]
    remote_path = remote_base.rstrip("/") + "/" + rel_path
    local_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        sftp.get(remote_path, str(local_path))
    except Exception as exc:
        raise HTTPException(404, f"Remote file not found: {rel_path} ({exc})") from exc
    return local_path


def ensure_parquet(base: Path, episode_index: int, info: dict) -> Path:
    p = parquet_path_for(base, episode_index, info)
    if p.exists():
        return p
    entry = _ssh_entry_for(base)
    if entry is None:
        raise HTTPException(404, f"Episode {episode_index} not found")
    session_id = entry["session_id"]
    if session_id not in _SSH_SESSIONS:
        raise HTTPException(503, "SSH session expired — please reconnect")
    chunk = episode_chunk(info, episode_index)
    rel = f"data/chunk-{chunk:03d}/episode_{episode_index:06d}.parquet"
    dl_key = f"{session_id}:{entry['remote_path']}/{rel}"
    # If another thread is already downloading this file, wait for it
    if dl_key in _SFTP_DOWNLOADS and _SFTP_DOWNLOADS[dl_key]["status"] == "downloading":
        for _ in range(600):   # wait up to 60s
            time.sleep(0.1)
            if p.exists():
                return p
            if _SFTP_DOWNLOADS.get(dl_key, {}).get("status") != "downloading":
                break
        if p.exists():
            return p
        raise HTTPException(504, "Remote download timed out")
    # Start download with progress tracking
    sftp = _SSH_SESSIONS[session_id]["sftp"]
    remote_path = entry["remote_path"].rstrip("/") + "/" + rel
    p.parent.mkdir(parents=True, exist_ok=True)
    _SFTP_DOWNLOADS[dl_key] = {"status": "downloading", "downloaded": 0, "total": 0, "local_path": str(p)}
    lock = _get_sftp_lock(session_id)
    def _progress(downloaded: int, total: int) -> None:
        _SFTP_DOWNLOADS[dl_key].update({"downloaded": downloaded, "total": total})
    try:
        with lock:
            sftp.get(remote_path, str(p), callback=_progress)
        _SFTP_DOWNLOADS[dl_key]["status"] = "done"
    except Exception as exc:
        _SFTP_DOWNLOADS[dl_key]["status"] = "error"
        _SFTP_DOWNLOADS[dl_key]["error"] = str(exc)
        if p.exists():
            p.unlink(missing_ok=True)
        raise HTTPException(404, f"Remote file unavailable: {rel} ({exc})") from exc
    return p


def _parse_ssh_command(ssh_command: str) -> tuple[str, str | None, int]:
    """Return (hostname, username, port) from an ssh command string."""
    cmd = ssh_command.strip()
    if cmd.lower().startswith("ssh "):
        cmd = cmd[4:].strip()
    # Parse optional -p port flag
    port = 22
    port_m = re.search(r"-p\s+(\d+)", cmd)
    if port_m:
        port = int(port_m.group(1))
        cmd = cmd[:port_m.start()].strip()
    # Parse user@host or just host
    username = None
    if "@" in cmd:
        username, hostname = cmd.rsplit("@", 1)
        hostname = hostname.strip()
        username = username.strip()
    else:
        hostname = cmd.strip()
    return hostname, username, port


def _ssh_connect(ssh_command: str) -> tuple[Any, Any]:
    if not _HAS_PARAMIKO:
        raise HTTPException(501, "paramiko not installed — run: pip install paramiko")
    hostname, username, port = _parse_ssh_command(ssh_command)
    # Load ~/.ssh/config for host aliases (HostName, User, Port, IdentityFile, ProxyJump etc.)
    ssh_cfg = _paramiko.SSHConfig()
    cfg_path = Path.home() / ".ssh" / "config"
    if cfg_path.exists():
        with open(cfg_path) as f:
            ssh_cfg.parse(f)
    hcfg = ssh_cfg.lookup(hostname)
    hostname = hcfg.get("hostname", hostname)
    if username is None:
        username = hcfg.get("user", os.environ.get("USER", "root"))
    if port == 22:
        port = int(hcfg.get("port", 22))
    ident = hcfg.get("identityfile", [])
    key_file = ident[0] if ident else None
    # Handle ProxyJump / ProxyCommand via sock
    proxy_sock = None
    proxy_jump = hcfg.get("proxyjump", None)
    proxy_cmd = hcfg.get("proxycommand", None)
    if proxy_jump:
        pj_host, pj_user, pj_port = _parse_ssh_command(f"ssh {proxy_jump}")
        pj_cfg = ssh_cfg.lookup(pj_host)
        pj_host = pj_cfg.get("hostname", pj_host)
        pj_user = pj_user or pj_cfg.get("user", username)
        pj_port = pj_port if pj_port != 22 else int(pj_cfg.get("port", 22))
        pj_ident = pj_cfg.get("identityfile", [])
        pj_key = pj_ident[0] if pj_ident else None
        pj_client = _paramiko.SSHClient()
        pj_client.set_missing_host_key_policy(_paramiko.AutoAddPolicy())
        pj_client.connect(pj_host, username=pj_user, port=pj_port,
                          key_filename=pj_key, timeout=15,
                          allow_agent=True, look_for_keys=True)
        transport = pj_client.get_transport()
        proxy_sock = transport.open_channel("direct-tcpip", (hostname, port), ("127.0.0.1", 0))
    elif proxy_cmd:
        proxy_sock = _paramiko.ProxyCommand(proxy_cmd)
    client = _paramiko.SSHClient()
    client.set_missing_host_key_policy(_paramiko.AutoAddPolicy())
    client.connect(hostname, username=username, port=port,
                   key_filename=key_file, timeout=15,
                   allow_agent=True, look_for_keys=True,
                   sock=proxy_sock)
    sftp = client.open_sftp()
    return client, sftp


def _discover_remote_datasets(sftp: Any, root_path: str, max_depth: int = 7) -> list[dict]:
    results = []
    def _walk(path: str, depth: int):
        if depth > max_depth:
            return
        try:
            entries = sftp.listdir_attr(path)
        except Exception:
            return
        # Check if this is a dataset root
        entry_names = {e.filename for e in entries}
        if "meta" in entry_names:
            try:
                meta_entries = sftp.listdir(path + "/meta")
                if "info.json" in meta_entries:
                    try:
                        info_bytes = sftp.open(path + "/meta/info.json").read()
                        info = json.loads(info_bytes)
                    except Exception:
                        info = {}
                    results.append({
                        "path": path,
                        "name": Path(path).name,
                        "fps": info.get("fps", 10),
                        "total_episodes": info.get("total_episodes", 0),
                        "total_tasks": info.get("total_tasks", 1),
                        "robot_type": info.get("robot_type", "unknown"),
                    })
                    return  # don't recurse into dataset subdirectories
            except Exception:
                pass
        for e in entries:
            if e.filename.startswith("."):
                continue
            if _stat.S_ISDIR(e.st_mode):
                _walk(path + "/" + e.filename, depth + 1)
            elif _stat.S_ISLNK(e.st_mode):
                # Follow symlinks — they may point to dataset directories
                try:
                    target = sftp.stat(path + "/" + e.filename)
                    if _stat.S_ISDIR(target.st_mode):
                        _walk(path + "/" + e.filename, depth + 1)
                except Exception:
                    pass
    _walk(root_path.rstrip("/"), 0)
    return results


def _cache_remote_meta(session_id: str, remote_path: str, sftp: Any) -> Path:
    """Download meta files from remote dataset to local cache. Returns local base dir."""
    local_base = _ssh_local_dir(session_id, remote_path)
    meta_local = local_base / "meta"
    meta_local.mkdir(parents=True, exist_ok=True)
    meta_files = ["info.json", "tasks.jsonl", "episodes.jsonl",
                  "config.json", "annotation_schema.json"]
    for fname in meta_files:
        local_f = meta_local / fname
        if not local_f.exists():
            try:
                sftp.get(f"{remote_path}/meta/{fname}", str(local_f))
            except Exception:
                pass  # optional files may not exist
    return local_base


def _load_ssh_history() -> list[dict]:
    try:
        if SSH_HISTORY_FILE.exists():
            return json.loads(SSH_HISTORY_FILE.read_text())
    except Exception:
        pass
    return []


def _save_ssh_history(entry: dict) -> None:
    history = _load_ssh_history()
    history = [h for h in history
               if not (h.get("ssh_command") == entry["ssh_command"]
                       and h.get("remote_path") == entry["remote_path"])]
    history.insert(0, {**entry, "last_used": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    SSH_HISTORY_FILE.parent.mkdir(exist_ok=True)
    SSH_HISTORY_FILE.write_text(json.dumps(history[:20], indent=2))


class SSHConnectRequest(BaseModel):
    ssh_command: str
    remote_path: str
    label: Optional[str] = None


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
    # SSH remote dataset
    if dataset in _SSH_DATASET_MAP:
        entry = _SSH_DATASET_MAP[dataset]
        local = _ssh_local_dir(entry["session_id"], entry["remote_path"])
        if is_valid_dataset(local):
            return local
        raise HTTPException(404, f"Remote dataset '{dataset}' not cached — please reconnect SSH")
    # Local dataset
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

    is_ssh = _is_ssh_dataset(base)
    for ep in read_episodes_cached(base):
        ep_idx = ep["episode_index"]
        if not is_ssh and not parquet_path_for(base, ep_idx, info).exists():
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
    is_ssh = _is_ssh_dataset(base)
    return [
        {
            "episode_index": ep["episode_index"],
            "length": ep.get("length", 0),
            "tasks": ep.get("tasks", []),
            "has_data": is_ssh or parquet_path_for(base, ep["episode_index"], info).exists(),
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
    parquet_path = ensure_parquet(base, episode_index, info)

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

    def _resolve_names(raw, dim: int, prefix: str) -> list[str]:
        if not raw or not isinstance(raw, list):
            return [f"{prefix}_{i}" for i in range(dim)]
        if len(raw) == dim:
            return list(raw)
        # Single descriptive name for the whole vector → generate per-dim names
        if len(raw) == 1 and dim > 1:
            return [f"{raw[0]}_{i}" for i in range(dim)]
        return list(raw) + [f"{prefix}_{i}" for i in range(len(raw), dim)]

    state_names = _resolve_names(features.get("state", {}).get("names"), _state_dim, "state")
    action_names = _resolve_names(features.get(action_feat_key, {}).get("names"), _action_dim, "action")

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
    parquet_path = ensure_parquet(base, episode_index, info)

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
    features = info.get("features", {})
    skip_keys = {k for k, v in features.items() if v.get("dtype") in ("image", "video")}

    parquet_path = ensure_parquet(base, episode_index, info)
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


# ── Dataset config API ───────────────────────────────────────────────────────

@app.get("/api/datasets/{dataset}/config")
def get_dataset_config(dataset: str):
    base = get_dataset_path(dataset)
    return read_config_cached(base)


@app.put("/api/datasets/{dataset}/config")
def save_dataset_config(dataset: str, body: dict = Body(...)):
    base = get_dataset_path(dataset)
    p = _config_path(base)
    p.write_text(json.dumps(body, indent=2, ensure_ascii=False))
    # Invalidate cache so next read picks up new values
    _CONFIG_CACHE.pop(str(base), None)
    return {"ok": True}


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
    parquet_path = ensure_parquet(base, episode_index, info)

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


# ── SSH API ───────────────────────────────────────────────────────────────────

@app.get("/api/ssh/status")
def ssh_status():
    return {"paramiko_available": _HAS_PARAMIKO, "active_sessions": len(_SSH_SESSIONS)}


@app.post("/api/ssh/connect")
def ssh_connect(body: SSHConnectRequest):
    if not _HAS_PARAMIKO:
        raise HTTPException(501, "paramiko not installed — run: pip install paramiko")
    try:
        client, sftp = _ssh_connect(body.ssh_command)
    except Exception as exc:
        raise HTTPException(500, f"SSH connection failed: {exc}") from exc
    session_id = uuid.uuid4().hex[:8]
    label = body.label or body.ssh_command.split()[-1]
    _SSH_SESSIONS[session_id] = {
        "client": client,
        "sftp": sftp,
        "ssh_command": body.ssh_command,
        "remote_path": body.remote_path,
        "label": label,
        "connected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _save_ssh_history({"ssh_command": body.ssh_command, "remote_path": body.remote_path, "label": label})
    return {"session_id": session_id, "label": label, "status": "connected"}


@app.get("/api/ssh/sessions")
def list_ssh_sessions():
    active = [
        {
            "session_id": sid,
            "ssh_command": info["ssh_command"],
            "remote_path": info["remote_path"],
            "label": info["label"],
            "connected_at": info["connected_at"],
            # Return full discover results if available, else minimal info from dataset map
            "datasets": info.get("datasets") or [
                {"virtual_name": vn, "remote_path": e["remote_path"],
                 "name": Path(e["remote_path"]).name,
                 "fps": 10, "total_episodes": 0, "total_tasks": 1, "robot_type": "unknown"}
                for vn, e in _SSH_DATASET_MAP.items()
                if e["session_id"] == sid
            ],
        }
        for sid, info in _SSH_SESSIONS.items()
    ]
    return {"active": active, "history": _load_ssh_history()}


@app.delete("/api/ssh/sessions/{session_id}")
def disconnect_ssh(session_id: str):
    info = _SSH_SESSIONS.pop(session_id, None)
    if info:
        try:
            info["sftp"].close()
            info["client"].close()
        except Exception:
            pass
    # Remove associated datasets and invalidate caches
    to_remove = [(vn, e) for vn, e in _SSH_DATASET_MAP.items() if e["session_id"] == session_id]
    removed_names = []
    for vn, entry in to_remove:
        _SSH_DATASET_MAP.pop(vn, None)
        removed_names.append(vn)
        local = _ssh_local_dir(session_id, entry["remote_path"])
        for cache in [_INFO_CACHE, _TASKS_CACHE, _EPISODES_CACHE, _CONFIG_CACHE]:
            cache.pop(str(local), None)
    return {"ok": True, "removed_datasets": removed_names}


@app.get("/api/ssh/sessions/{session_id}/discover")
def discover_ssh_datasets(session_id: str):
    if session_id not in _SSH_SESSIONS:
        raise HTTPException(404, f"SSH session {session_id} not found")
    sess = _SSH_SESSIONS[session_id]
    sftp = sess["sftp"]
    root_path = sess["remote_path"]
    try:
        found = _discover_remote_datasets(sftp, root_path)
    except Exception as exc:
        raise HTTPException(500, f"Discovery failed: {exc}") from exc
    results = []
    for ds in found:
        remote_ds_path = ds["path"]
        vname = _ssh_vname(session_id, remote_ds_path)
        _SSH_DATASET_MAP[vname] = {
            "session_id": session_id,
            "remote_path": remote_ds_path,
            "local_hash": hashlib.md5(f"{session_id}:{remote_ds_path}".encode()).hexdigest()[:8],
        }
        # Cache meta files locally
        try:
            _cache_remote_meta(session_id, remote_ds_path, sftp)
        except Exception:
            pass
        results.append({
            "virtual_name": vname,
            "remote_path": remote_ds_path,
            "name": ds["name"],
            "fps": ds["fps"],
            "total_episodes": ds["total_episodes"],
            "total_tasks": ds["total_tasks"],
            "robot_type": ds["robot_type"],
        })
    # Update session's list in _SSH_SESSIONS (for listing)
    _SSH_SESSIONS[session_id]["datasets"] = results
    # Background-prefetch episode 0 for each dataset so first click feels instant
    def _prefetch_all():
        for ds in results:
            vname = ds["virtual_name"]
            if vname not in _SSH_DATASET_MAP:
                continue
            try:
                base = _ssh_local_dir(session_id, ds["remote_path"])
                info = read_info_cached(base)
                ensure_parquet(base, 0, info)
            except Exception:
                pass
    threading.Thread(target=_prefetch_all, daemon=True).start()
    return results


@app.get("/api/ssh/datasets/{virtual_name}/meta")
def get_ssh_dataset_meta(virtual_name: str):
    """Redirect to the standard meta endpoint using virtual name."""
    return get_dataset_meta(virtual_name)


@app.get("/api/ssh/dl_status/{dataset}/{episode_index}")
def ssh_dl_status(dataset: str, episode_index: Annotated[int, _PathParam(ge=0)]):
    """Return download progress for a remote episode parquet file."""
    if dataset not in _SSH_DATASET_MAP:
        return {"cached": True}  # local dataset
    entry = _SSH_DATASET_MAP[dataset]
    base = _ssh_local_dir(entry["session_id"], entry["remote_path"])
    if not is_valid_dataset(base):
        raise HTTPException(404, "Dataset not cached")
    info = read_info_cached(base)
    p = parquet_path_for(base, episode_index, info)
    if p.exists():
        return {"cached": True, "size": p.stat().st_size}
    chunk = episode_chunk(info, episode_index)
    rel = f"data/chunk-{chunk:03d}/episode_{episode_index:06d}.parquet"
    dl_key = f"{entry['session_id']}:{entry['remote_path']}/{rel}"
    if dl_key in _SFTP_DOWNLOADS:
        dl = _SFTP_DOWNLOADS[dl_key]
        return {
            "cached": False,
            "status": dl["status"],
            "downloaded": dl.get("downloaded", 0),
            "total": dl.get("total", 0),
            "error": dl.get("error"),
        }
    return {"cached": False, "status": "not_started"}


# ── Static files ─────────────────────────────────────────────────────────────

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8765, reload=True)
