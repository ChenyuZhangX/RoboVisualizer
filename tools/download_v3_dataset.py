"""
Download a LeRobot v3.0 dataset from Hugging Face and convert it to v2.0 format.

v3.0 stores all episodes in one Parquet file with column names like
'observation.state', 'action'. This script splits them back into
per-episode v2.0 Parquet files so the existing visualizer works.

Images/videos are not decoded (no ffmpeg available); each frame gets a
minimal placeholder JPEG so the visualizer runs without crashing.

Usage:
    HF_ENDPOINT=https://hf-mirror.com python tools/download_v3_dataset.py \\
        --dataset lerobot/pusht \\
        --output data/pusht \\
        --max-episodes 4

    # Multiple datasets at once:
    HF_ENDPOINT=https://hf-mirror.com python tools/download_v3_dataset.py \\
        --dataset lerobot/aloha_sim_insertion_scripted \\
        --output data/aloha_sim_insertion \\
        --max-episodes 4
"""

from __future__ import annotations

import argparse
import json
import io
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from utils import LeRobotWriter

HF_CACHE = "/tmp/hf_v3_cache"


def download_file(dataset: str, filename: str) -> Path:
    from huggingface_hub import hf_hub_download
    return Path(hf_hub_download(
        dataset, filename,
        repo_type="dataset",
        cache_dir=HF_CACHE,
    ))


def load_episodes_meta(dataset: str) -> list[dict]:
    """Load episode metadata from v3.0 meta/episodes/chunk-*/file-*.parquet."""
    # Enumerate available episode meta files
    from huggingface_hub import list_repo_files
    files = list(list_repo_files(dataset, repo_type="dataset"))
    ep_files = sorted(f for f in files if f.startswith("meta/episodes/") and f.endswith(".parquet"))

    rows = []
    for fname in ep_files:
        p = download_file(dataset, fname)
        t = pq.read_table(p)
        d = t.to_pydict()
        n = t.num_rows
        for i in range(n):
            rows.append({k: d[k][i] for k in t.schema.names})
    return rows


def load_tasks_meta(dataset: str) -> dict[int, str]:
    """Return {task_index: task_string} mapping."""
    p = download_file(dataset, "meta/tasks.parquet")
    t = pq.read_table(p)
    d = t.to_pydict()
    # v3.0 tasks.parquet: columns task_index + '__index_level_0__' (or 'task')
    task_col = next(
        (c for c in t.schema.names if c not in ("task_index",)),
        None
    )
    if task_col is None:
        return {}
    result = {}
    for i, ti in enumerate(d.get("task_index", [])):
        result[int(ti)] = d[task_col][i]
    return result


def make_placeholder_img(state: list[float] | None, H: int = 64, W: int = 64) -> np.ndarray:
    """Create a tiny info-image encoding joint angles as colour bars."""
    img = np.full((H, W, 3), 30, dtype=np.uint8)
    if state:
        n = min(len(state), W)
        for j, v in enumerate(state[:n]):
            col = int(np.clip((v + 3.0) / 6.0 * 255, 0, 255))
            x = int(j * W / n)
            w = max(1, int(W / n))
            bar_h = int(np.clip(abs(v) / 3.0 * (H // 2), 2, H // 2))
            y0 = H // 2 - bar_h if v >= 0 else H // 2
            img[y0: y0 + bar_h, x: x + w] = [col, 255 - col, 128]
    return img


def select_episodes(
    episodes_meta: list[dict],
    data_tables: dict[tuple[int, int], dict],
    max_episodes: int | None,
    tasks_per_dataset: int | None,
    eps_per_task: int | None,
) -> list[dict]:
    """
    Select episodes to convert. If tasks_per_dataset and eps_per_task are set,
    pick eps_per_task episodes from each of the first tasks_per_dataset tasks.
    Falls back to plain max_episodes slicing.
    """
    if tasks_per_dataset is None or eps_per_task is None:
        return episodes_meta[:max_episodes]

    # Build task_index lookup from data tables
    ep_to_task: dict[int, int] = {}
    for (ci, fi), dt in data_tables.items():
        ep_idxs = dt.get("episode_index", [])
        task_idxs = dt.get("task_index", [])
        for ei, ti in zip(ep_idxs, task_idxs):
            ep_to_task[int(ei)] = int(ti)

    # Group episodes by task
    from collections import defaultdict
    task_eps: dict[int, list[dict]] = defaultdict(list)
    for ep in episodes_meta:
        ep_idx = ep["episode_index"]
        ti = ep_to_task.get(int(ep_idx), ep.get("task_index", 0))
        task_eps[int(ti)].append(ep)

    selected = []
    for ti in sorted(task_eps.keys())[:tasks_per_dataset]:
        selected.extend(task_eps[ti][:eps_per_task])
    return selected


def convert(
    dataset: str,
    output_dir: str,
    max_episodes: int | None,
    tasks_per_dataset: int | None = None,
    eps_per_task: int | None = None,
    img_h: int = 64,
    img_w: int = 64,
) -> None:
    base = Path(output_dir)
    print(f"Downloading {dataset} → {base}")

    # ── Metadata ──────────────────────────────────────────────────────────────
    info_path = download_file(dataset, "meta/info.json")
    info = json.loads(info_path.read_text())
    fps = info.get("fps", 10)
    robot_type = info.get("robot_type", "unknown")
    chunks_size = info.get("chunks_size", 1000)

    tasks_map = load_tasks_meta(dataset)
    episodes_meta_all = load_episodes_meta(dataset)

    # Pre-download data files for first max_episodes episodes to enable task selection
    candidate_eps = episodes_meta_all[:max(max_episodes or 20, 20)]
    needed_data_files_pre: set[tuple[int, int]] = set()
    for ep in candidate_eps:
        needed_data_files_pre.add((ep["data/chunk_index"], ep["data/file_index"]))

    data_tables_pre: dict[tuple[int, int], dict] = {}
    for ci, fi in sorted(needed_data_files_pre):
        fname = f"data/chunk-{ci:03d}/file-{fi:03d}.parquet"
        print(f"  Downloading {fname} (for task selection) …")
        p = download_file(dataset, fname)
        t = pq.read_table(p)
        data_tables_pre[(ci, fi)] = t.to_pydict()

    episodes_meta = select_episodes(
        candidate_eps, data_tables_pre,
        max_episodes, tasks_per_dataset, eps_per_task
    )
    print(f"  fps={fps}  robot={robot_type}  episodes selected: {len(episodes_meta)}")

    # ── Ensure all needed data files are downloaded ───────────────────────────
    data_tables: dict[tuple[int, int], dict] = dict(data_tables_pre)
    for ep in episodes_meta:
        ci_e, fi_e = ep["data/chunk_index"], ep["data/file_index"]
        if (ci_e, fi_e) not in data_tables:
            fname = f"data/chunk-{ci_e:03d}/file-{fi_e:03d}.parquet"
            print(f"  Downloading {fname} …")
            p = download_file(dataset, fname)
            t = pq.read_table(p)
            data_tables[(ci_e, fi_e)] = t.to_pydict()

    # ── Detect column names (v3.0 uses observation.state / action) ────────────
    sample_table = next(iter(data_tables.values()))
    state_col = next(
        (c for c in ["observation.state", "state", "observation.environment_state"]
         if c in sample_table),
        None,
    )
    action_col = next(
        (c for c in ["action", "actions"] if c in sample_table),
        None,
    )
    if state_col is None or action_col is None:
        raise ValueError(
            f"Cannot find state/action columns. Available: {list(sample_table.keys())}"
        )
    print(f"  state col='{state_col}'  action col='{action_col}'")

    # ── Write v2.0 dataset ────────────────────────────────────────────────────
    writer = LeRobotWriter(output_dir, fps=fps, robot_type=robot_type)

    for ep_meta in episodes_meta:
        ep_idx_src = ep_meta["episode_index"]
        ci = ep_meta["data/chunk_index"]
        fi = ep_meta["data/file_index"]
        from_idx = ep_meta["dataset_from_index"]
        to_idx = ep_meta["dataset_to_index"]
        length = ep_meta["length"]

        # Task string — prefer episodes metadata, fall back to data rows
        ep_tasks = ep_meta.get("tasks", [])
        if ep_tasks:
            task = ep_tasks[0] if isinstance(ep_tasks, list) else ep_tasks
        else:
            # Look up task_index from first row of this episode in data
            dt_check = data_tables[(ci, fi)]
            ep_rows_check = [i for i, eidx in enumerate(dt_check.get("episode_index", []))
                             if eidx == ep_idx_src]
            if ep_rows_check and "task_index" in dt_check:
                ti = int(dt_check["task_index"][ep_rows_check[0]])
                task = tasks_map.get(ti, f"task_{ti}")
            elif ep_meta.get("task_index") is not None:
                task = tasks_map.get(int(ep_meta["task_index"]), "unknown task")
            else:
                task = tasks_map.get(0, "unknown task")

        dt = data_tables[(ci, fi)]
        # Extract rows for this episode
        ep_rows = [i for i, eidx in enumerate(dt.get("episode_index", []))
                   if eidx == ep_idx_src]

        if not ep_rows:
            # Fallback: use dataset_from_index / dataset_to_index range
            ep_rows = list(range(min(from_idx, len(dt["episode_index"])),
                                 min(to_idx, len(dt["episode_index"]))))

        if not ep_rows:
            print(f"  [ep {ep_idx_src}] skipped: no rows found")
            continue

        frames = []
        for row in ep_rows:
            state_val = dt[state_col][row]
            action_val = dt[action_col][row]

            state_arr  = np.array(state_val,  dtype=np.float32) if isinstance(state_val,  (list, tuple)) else np.array([state_val],  dtype=np.float32)
            action_arr = np.array(action_val, dtype=np.float32) if isinstance(action_val, (list, tuple)) else np.array([action_val], dtype=np.float32)

            img = make_placeholder_img(state_arr.tolist(), img_h, img_w)
            frames.append({
                "image": img,
                "state":   state_arr,
                "actions": action_arr,
            })

        new_ep = writer.add_episode(frames, task)
        print(f"  ep_{new_ep:06d} ← src ep_{ep_idx_src:06d}  "
              f"T={len(frames)}  task='{task[:60]}'")

    # infer names
    s_dim = len(frames[0]["state"])
    a_dim = len(frames[0]["actions"])
    features = info.get("features", {})
    state_feat = features.get(state_col, {})
    action_feat = features.get(action_col, {})
    s_names_raw = state_feat.get("names")
    a_names_raw = action_feat.get("names")

    def _flatten_names(names_raw, dim: int, prefix: str) -> list[str]:
        if names_raw is None:
            return [f"{prefix}_{i}" for i in range(dim)]
        if isinstance(names_raw, list):
            if names_raw and isinstance(names_raw[0], str):
                return names_raw[:dim]
        if isinstance(names_raw, dict):
            for v in names_raw.values():
                if isinstance(v, list) and v and isinstance(v[0], str):
                    return v[:dim]
        return [f"{prefix}_{i}" for i in range(dim)]

    s_names = _flatten_names(s_names_raw, s_dim, "state")
    a_names = _flatten_names(a_names_raw, a_dim, "action")
    writer.finalize(state_names=s_names, action_names=a_names)
    print(f"  Done → {base}")


def main():
    parser = argparse.ArgumentParser(
        description="Download LeRobot v3.0 dataset → convert to v2.0 for visualizer"
    )
    parser.add_argument("--dataset", required=True,
                        help="HuggingFace dataset id, e.g. lerobot/pusht")
    parser.add_argument("--output", required=True,
                        help="Output directory for v2.0 dataset")
    parser.add_argument("--max-episodes", type=int, default=4,
                        dest="max_episodes",
                        help="Maximum total episodes to download (default: 4)")
    parser.add_argument("--tasks", type=int, default=None,
                        dest="tasks_per_dataset",
                        help="Number of distinct tasks to sample (default: all)")
    parser.add_argument("--eps-per-task", type=int, default=None,
                        dest="eps_per_task",
                        help="Episodes to include per task (requires --tasks)")
    parser.add_argument("--img-size", type=int, default=64,
                        dest="img_size",
                        help="Placeholder image size (default: 64)")
    args = parser.parse_args()

    convert(
        dataset=args.dataset,
        output_dir=args.output,
        max_episodes=args.max_episodes,
        tasks_per_dataset=args.tasks_per_dataset,
        eps_per_task=args.eps_per_task,
        img_h=args.img_size,
        img_w=args.img_size,
    )


if __name__ == "__main__":
    main()
