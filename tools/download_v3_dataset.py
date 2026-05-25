"""
Download a LeRobot v3.0 dataset from Hugging Face and convert it to v2.0 format.

v3.0 stores all episodes in one Parquet file with observation.state / action
column names, and camera images as separate MP4 video files.
This script extracts real camera frames using PyAV and writes v2.0 Parquet.

Usage:
    HF_ENDPOINT=https://hf-mirror.com HF_HOME=/tmp/hf_home \\
        python tools/download_v3_dataset.py \\
        --dataset lerobot/pusht --output data/pusht --max-episodes 4

    # Multi-task (2 tasks × 2 eps):
    HF_ENDPOINT=https://hf-mirror.com HF_HOME=/tmp/hf_home \\
        python tools/download_v3_dataset.py \\
        --dataset lerobot/libero_10 --output data/libero_10_sample \\
        --tasks 2 --eps-per-task 2 --max-episodes 20
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from utils import LeRobotWriter

HF_CACHE = "/tmp/hf_v3_cache"

try:
    import av as _av
    _HAS_AV = True
except ImportError:
    _HAS_AV = False


# ── HuggingFace helpers ──────────────────────────────────────────────────────

def download_file(dataset: str, filename: str) -> Path:
    from huggingface_hub import hf_hub_download
    return Path(hf_hub_download(
        dataset, filename,
        repo_type="dataset",
        cache_dir=HF_CACHE,
    ))


def list_dataset_files(dataset: str) -> list[str]:
    from huggingface_hub import list_repo_files
    return list(list_repo_files(dataset, repo_type="dataset"))


# ── Metadata loading ─────────────────────────────────────────────────────────

def load_info(dataset: str) -> dict:
    p = download_file(dataset, "meta/info.json")
    return json.loads(p.read_text())


def load_tasks_meta(dataset: str) -> dict[int, str]:
    """Return {task_index: task_string}."""
    p = download_file(dataset, "meta/tasks.parquet")
    t = pq.read_table(p)
    d = t.to_pydict()
    task_col = next((c for c in t.schema.names if c != "task_index"), None)
    if task_col is None:
        return {}
    return {int(ti): d[task_col][i] for i, ti in enumerate(d.get("task_index", []))}


def load_episodes_meta(dataset: str) -> list[dict]:
    """Load all episode rows from meta/episodes/chunk-*/file-*.parquet."""
    files = list_dataset_files(dataset)
    ep_files = sorted(f for f in files if f.startswith("meta/episodes/") and f.endswith(".parquet"))
    rows = []
    for fname in ep_files:
        t = pq.read_table(download_file(dataset, fname))
        d = t.to_pydict()
        for i in range(t.num_rows):
            rows.append({k: d[k][i] for k in t.schema.names})
    return rows


# ── Video frame extraction ───────────────────────────────────────────────────

class VideoFrameReader:
    """
    Reads frames from an MP4 file by global dataset index.
    In v3.0 all episodes are concatenated, so frame N of episode E
    is at position (dataset_from_index_of_E + N) in the video file.
    """

    def __init__(self, path: Path, target_w: int = 0, target_h: int = 0):
        if not _HAS_AV:
            raise RuntimeError("PyAV not installed — cannot decode video")
        self.path = path
        self.target_w = target_w
        self.target_h = target_h
        self._frames: list[np.ndarray] | None = None

    def _load_all(self) -> None:
        """Decode all frames into memory once."""
        frames = []
        with _av.open(str(self.path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for packet in container.demux(stream):
                for frame in packet.decode():
                    img = frame.to_ndarray(format="rgb24")
                    if self.target_w and self.target_h:
                        pil = Image.fromarray(img).resize(
                            (self.target_w, self.target_h), Image.BILINEAR
                        )
                        img = np.array(pil, dtype=np.uint8)
                    frames.append(img)
        self._frames = frames

    def get_frame(self, global_idx: int) -> np.ndarray:
        if self._frames is None:
            self._load_all()
        if global_idx >= len(self._frames):
            return np.zeros(
                (self.target_h or 64, self.target_w or 64, 3), dtype=np.uint8
            )
        return self._frames[global_idx]

    def total_frames(self) -> int:
        if self._frames is None:
            self._load_all()
        return len(self._frames)


def make_placeholder_img(H: int = 64, W: int = 64) -> np.ndarray:
    """Fallback grey image when video unavailable."""
    return np.full((H, W, 3), 80, dtype=np.uint8)


# ── Episode selection ────────────────────────────────────────────────────────

def select_episodes(
    episodes_meta: list[dict],
    data_tables: dict[tuple[int, int], dict],
    max_episodes: int | None,
    tasks_per_dataset: int | None,
    eps_per_task: int | None,
) -> list[dict]:
    if tasks_per_dataset is None or eps_per_task is None:
        return episodes_meta[:max_episodes]

    ep_to_task: dict[int, int] = {}
    for dt in data_tables.values():
        for ei, ti in zip(dt.get("episode_index", []), dt.get("task_index", [])):
            ep_to_task[int(ei)] = int(ti)

    task_eps: dict[int, list[dict]] = defaultdict(list)
    for ep in episodes_meta:
        ti = ep_to_task.get(int(ep["episode_index"]), 0)
        task_eps[ti].append(ep)

    selected = []
    for ti in sorted(task_eps.keys())[:tasks_per_dataset]:
        selected.extend(task_eps[ti][:eps_per_task])
    return selected


# ── Main conversion ──────────────────────────────────────────────────────────

def convert(
    dataset: str,
    output_dir: str,
    max_episodes: int | None,
    tasks_per_dataset: int | None = None,
    eps_per_task: int | None = None,
    img_w: int = 128,
    img_h: int = 128,
) -> None:
    print(f"Downloading {dataset} → {output_dir}")

    info = load_info(dataset)
    fps = info.get("fps", 10)
    robot_type = info.get("robot_type", "unknown")
    features = info.get("features", {})

    # Video keys: features where dtype == "video"
    video_keys = {k: v for k, v in features.items() if v.get("dtype") == "video"}
    if video_keys:
        print(f"  Video keys: {list(video_keys.keys())}")
        if not _HAS_AV:
            print("  WARNING: PyAV not installed — using placeholder images")
    else:
        print("  No video features found (state-only dataset)")

    tasks_map = load_tasks_meta(dataset)
    episodes_meta_all = load_episodes_meta(dataset)

    # Pre-download data parquets for task selection
    candidate_eps = episodes_meta_all[:max(max_episodes or 20, 20)]
    needed_pre: set[tuple[int, int]] = {(ep["data/chunk_index"], ep["data/file_index"])
                                         for ep in candidate_eps}

    data_tables: dict[tuple[int, int], dict] = {}
    for ci, fi in sorted(needed_pre):
        fname = f"data/chunk-{ci:03d}/file-{fi:03d}.parquet"
        print(f"  Downloading {fname} …")
        data_tables[(ci, fi)] = pq.read_table(download_file(dataset, fname)).to_pydict()

    episodes_meta = select_episodes(
        candidate_eps, data_tables, max_episodes, tasks_per_dataset, eps_per_task
    )
    print(f"  fps={fps}  robot={robot_type}  episodes: {len(episodes_meta)}")

    # Ensure all needed data files are present
    for ep in episodes_meta:
        key = (ep["data/chunk_index"], ep["data/file_index"])
        if key not in data_tables:
            ci, fi = key
            fname = f"data/chunk-{ci:03d}/file-{fi:03d}.parquet"
            print(f"  Downloading {fname} …")
            data_tables[key] = pq.read_table(download_file(dataset, fname)).to_pydict()

    # Detect state/action column names
    sample = next(iter(data_tables.values()))
    state_col = next(
        (c for c in ["observation.state", "state", "observation.environment_state"] if c in sample),
        None,
    )
    action_col = next((c for c in ["action", "actions"] if c in sample), None)
    if state_col is None or action_col is None:
        raise ValueError(f"Cannot find state/action columns. Available: {list(sample.keys())}")
    print(f"  state='{state_col}'  action='{action_col}'")

    # Pre-download and open video readers for each (video_key, chunk, file)
    # Map: (video_key, chunk_index, file_index) → VideoFrameReader
    video_readers: dict[tuple[str, int, int], VideoFrameReader] = {}

    def get_video_reader(vkey: str, ci: int, fi: int) -> VideoFrameReader | None:
        rkey = (vkey, ci, fi)
        if rkey in video_readers:
            return video_readers[rkey]
        # Derive path in v3.0: videos/{video_key}/chunk-{ci:03d}/file-{fi:03d}.mp4
        safe_key = vkey.replace(".", "/")  # e.g. "observation.images.top" → "observation/images/top"
        # Actually v3.0 uses the full key with slashes as a path segment
        # Some datasets use "observation.images.top" literally as a dir name
        # Try both formats
        for vid_path_template in [
            f"videos/{vkey}/chunk-{ci:03d}/file-{fi:03d}.mp4",
            f"videos/{safe_key}/chunk-{ci:03d}/file-{fi:03d}.mp4",
        ]:
            try:
                local = download_file(dataset, vid_path_template)
                reader = VideoFrameReader(local, target_w=img_w, target_h=img_h)
                video_readers[rkey] = reader
                print(f"  Loaded video: {vid_path_template}")
                return reader
            except Exception:
                continue
        return None

    # ── Write v2.0 ───────────────────────────────────────────────────────────
    writer = LeRobotWriter(output_dir, fps=fps, robot_type=robot_type)

    last_frames = None
    for ep_meta in episodes_meta:
        ep_idx_src = int(ep_meta["episode_index"])
        ci = int(ep_meta["data/chunk_index"])
        fi = int(ep_meta["data/file_index"])
        from_idx = int(ep_meta["dataset_from_index"])
        to_idx = int(ep_meta["dataset_to_index"])

        # Task string
        dt = data_tables[(ci, fi)]
        ep_rows = [i for i, eidx in enumerate(dt.get("episode_index", [])) if eidx == ep_idx_src]
        if not ep_rows:
            ep_rows = list(range(min(from_idx, len(dt["episode_index"])),
                                 min(to_idx, len(dt["episode_index"]))))
        if not ep_rows:
            print(f"  [ep {ep_idx_src}] skipped: no rows")
            continue

        if "tasks" in ep_meta and ep_meta["tasks"]:
            task = ep_meta["tasks"][0] if isinstance(ep_meta["tasks"], list) else ep_meta["tasks"]
        elif ep_rows and "task_index" in dt:
            ti = int(dt["task_index"][ep_rows[0]])
            task = tasks_map.get(ti, f"task_{ti}")
        else:
            task = tasks_map.get(0, "unknown task")

        # Open video readers for this episode's cameras
        cam_readers: dict[str, VideoFrameReader | None] = {}
        for vkey in video_keys:
            # Get video file index from episode metadata
            vi_ci_key = f"videos/{vkey}/chunk_index"
            vi_fi_key = f"videos/{vkey}/file_index"
            v_ci = int(ep_meta.get(vi_ci_key, ci))
            v_fi = int(ep_meta.get(vi_fi_key, fi))
            cam_readers[vkey] = get_video_reader(vkey, v_ci, v_fi)

        # Build frames
        frames = []
        for row_i, row in enumerate(ep_rows):
            state_val = dt[state_col][row]
            action_val = dt[action_col][row]
            state_arr = np.array(state_val, dtype=np.float32) if isinstance(state_val, (list, tuple)) else np.array([state_val], dtype=np.float32)
            action_arr = np.array(action_val, dtype=np.float32) if isinstance(action_val, (list, tuple)) else np.array([action_val], dtype=np.float32)

            frame: dict = {"state": state_arr, "actions": action_arr}

            global_frame_idx = from_idx + row_i
            for vkey, reader in cam_readers.items():
                # Map v3.0 camera key → short name for v2.0
                short = _short_cam_name(vkey)
                if reader is not None:
                    frame[short] = reader.get_frame(global_frame_idx)
                else:
                    frame[short] = make_placeholder_img(img_h, img_w)

            frames.append(frame)

        new_ep = writer.add_episode(frames, task)
        print(f"  ep_{new_ep:06d} ← src ep_{ep_idx_src:06d}  T={len(frames)}  task='{task[:60]}'")
        last_frames = frames

    if last_frames is None:
        raise RuntimeError("No episodes written")

    s_dim = len(last_frames[0]["state"])
    a_dim = len(last_frames[0]["actions"])
    state_feat = features.get(state_col, {})
    action_feat = features.get(action_col, {})

    def _names(raw, dim, prefix):
        if isinstance(raw, list) and raw and isinstance(raw[0], str):
            return raw[:dim]
        if isinstance(raw, dict):
            for v in raw.values():
                if isinstance(v, list) and v and isinstance(v[0], str):
                    return v[:dim]
        return [f"{prefix}_{i}" for i in range(dim)]

    writer.finalize(
        state_names=_names(state_feat.get("names"), s_dim, "state"),
        action_names=_names(action_feat.get("names"), a_dim, "action"),
    )
    _write_config(output_dir, list(video_keys.keys()))
    print(f"  Done → {output_dir}")


_CAM_LABEL_MAP = {
    "image": "Camera", "top": "Top View", "wrist_image": "Wrist Camera",
    "wrist_left": "Wrist (Left)", "wrist_right": "Wrist (Right)",
    "exterior_1_left": "Exterior 1", "exterior_2_left": "Exterior 2",
    "exterior_1_right": "Exterior 1 (R)", "exterior_2_right": "Exterior 2 (R)",
    "side_image": "Side View", "agentview": "Agent View",
}


def _default_cam_label(key: str) -> str:
    return _CAM_LABEL_MAP.get(key, key.replace("_", " ").title())


def _write_config(output_dir: str, orig_video_keys: list[str]) -> None:
    """Write meta/config.json with human-readable camera labels."""
    cam_labels = {_short_cam_name(vk): _default_cam_label(_short_cam_name(vk))
                  for vk in orig_video_keys}
    config = {"camera_labels": cam_labels}
    p = Path(output_dir) / "meta" / "config.json"
    p.write_text(json.dumps(config, indent=2, ensure_ascii=False))


def _short_cam_name(vkey: str) -> str:
    """Strip observation[.images]. prefix → natural camera name.

    observation.images.top            → top
    observation.images.image          → image
    observation.images.wrist_image    → wrist_image
    observation.images.wrist_left     → wrist_left
    observation.images.exterior_1_left → exterior_1_left
    observation.image                 → image
    """
    for prefix in ("observation.images.", "observation."):
        if vkey.startswith(prefix):
            return vkey[len(prefix):]
    return vkey.split(".")[-1]


def main():
    parser = argparse.ArgumentParser(
        description="Download LeRobot v3.0 dataset → v2.0 for visualizer"
    )
    parser.add_argument("--dataset", required=True,
                        help="HuggingFace dataset id, e.g. lerobot/pusht")
    parser.add_argument("--output", required=True,
                        help="Output directory")
    parser.add_argument("--max-episodes", type=int, default=4, dest="max_episodes")
    parser.add_argument("--tasks", type=int, default=None, dest="tasks_per_dataset",
                        help="Number of distinct tasks to sample")
    parser.add_argument("--eps-per-task", type=int, default=None, dest="eps_per_task")
    parser.add_argument("--img-w", type=int, default=0, dest="img_w",
                        help="Output image width (0 = native, default)")
    parser.add_argument("--img-h", type=int, default=0, dest="img_h",
                        help="Output image height (0 = native, default)")
    args = parser.parse_args()

    convert(
        dataset=args.dataset,
        output_dir=args.output,
        max_episodes=args.max_episodes,
        tasks_per_dataset=args.tasks_per_dataset,
        eps_per_task=args.eps_per_task,
        img_w=args.img_w,
        img_h=args.img_h,
    )


if __name__ == "__main__":
    main()
