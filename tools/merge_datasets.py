"""
Merge multiple v2.0 LeRobot datasets into one, each source becoming a separate task.

Usage:
    python tools/merge_datasets.py \\
        --inputs data/aloha_sim_insertion data/aloha_sim_transfer_cube \\
        --output data/aloha_sim_multi \\
        --eps-per-source 2

Each source dataset contributes --eps-per-source episodes.
The task string from the source's tasks.jsonl is preserved.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from utils import LeRobotWriter, encode_image


def load_meta(dataset_dir: Path) -> tuple[dict, list[dict], list[dict]]:
    info = json.loads((dataset_dir / "meta" / "info.json").read_text())
    tasks = [json.loads(l) for l in (dataset_dir / "meta" / "tasks.jsonl").read_text().splitlines() if l]
    episodes = [json.loads(l) for l in (dataset_dir / "meta" / "episodes.jsonl").read_text().splitlines() if l]
    return info, tasks, episodes


def episode_parquet_path(dataset_dir: Path, ep_idx: int, chunks_size: int = 1000) -> Path:
    chunk = ep_idx // chunks_size
    return dataset_dir / "data" / f"chunk-{chunk:03d}" / f"episode_{ep_idx:06d}.parquet"


def read_episode_frames(dataset_dir: Path, ep_idx: int, chunks_size: int = 1000) -> list[dict]:
    path = episode_parquet_path(dataset_dir, ep_idx, chunks_size)
    t = pq.read_table(path)
    d = t.to_pydict()
    n = t.num_rows

    # Detect image columns (StructType = image struct<bytes, path>)
    img_cols = [name for name in t.schema.names
                if pa.types.is_struct(t.schema.field(name).type)]

    frames = []
    for i in range(n):
        frame: dict = {}

        for col in img_cols:
            struct_val = d[col][i]
            img_bytes = struct_val.get("bytes", b"") if struct_val else b""
            if img_bytes:
                from io import BytesIO
                arr = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
            else:
                arr = np.zeros((64, 64, 3), dtype=np.uint8)
            frame[col] = arr

        frame["state"] = np.array(d["state"][i], dtype=np.float32)
        frame["actions"] = np.array(d["actions"][i], dtype=np.float32)
        frames.append(frame)
    return frames


def merge(
    input_dirs: list[str],
    output_dir: str,
    eps_per_source: int,
) -> None:
    sources = [Path(d) for d in input_dirs]

    # Validate
    for src in sources:
        if not (src / "meta" / "info.json").exists():
            raise FileNotFoundError(f"Not a valid v2.0 dataset: {src}")

    # Determine fps and robot_type from first source
    first_info, _, _ = load_meta(sources[0])
    fps = first_info.get("fps", 10)
    robot_type = first_info.get("robot_type", "unknown")
    chunks_size = first_info.get("chunks_size", 1000)

    writer = LeRobotWriter(output_dir, fps=fps, robot_type=robot_type)

    for src in sources:
        info, tasks_meta, episodes_meta = load_meta(src)
        src_chunks_size = info.get("chunks_size", 1000)
        task_map = {t["task_index"]: t["task"] for t in tasks_meta}

        selected_eps = episodes_meta[:eps_per_source]
        print(f"\n{src.name}  ({len(selected_eps)} eps selected)")

        for ep_meta in selected_eps:
            ep_idx = ep_meta["episode_index"]
            task_list = ep_meta.get("tasks", [])
            task = task_list[0] if task_list else task_map.get(0, "unknown task")

            frames = read_episode_frames(src, ep_idx, src_chunks_size)
            new_ep = writer.add_episode(frames, task)
            print(f"  ep_{new_ep:06d} ← {src.name}/ep_{ep_idx:06d}  T={len(frames)}  task='{task[:60]}'")

    # Get dim names from first source
    first_info, _, _ = load_meta(sources[0])
    feats = first_info.get("features", {})

    def _names(feat_key, fallback_prefix, dim):
        f = feats.get(feat_key, {})
        names = f.get("names", [])
        if isinstance(names, list) and names and isinstance(names[0], str):
            return names[:dim]
        return [f"{fallback_prefix}_{i}" for i in range(dim)]

    # Read dims from writer's first episode
    first_ep = writer._episodes[0]["episode_index"]
    t0 = pq.read_table(
        Path(output_dir) / "data" / f"chunk-{first_ep // writer.chunks_size:03d}"
        / f"episode_{first_ep:06d}.parquet",
        columns=["state", "actions"],
    )
    s_dim = t0.schema.field("state").type.list_size
    a_dim = t0.schema.field("actions").type.list_size

    writer.finalize(
        state_names=_names("state", "state", s_dim),
        action_names=_names("actions", "action", a_dim),
    )

    # Merge camera label configs from all sources
    cam_labels: dict[str, str] = {}
    for src in sources:
        cfg_p = src / "meta" / "config.json"
        if cfg_p.exists():
            src_cfg = json.loads(cfg_p.read_text())
            cam_labels.update(src_cfg.get("camera_labels", {}))
        else:
            for k in (writer.image_keys or []):
                if k not in cam_labels:
                    cam_labels[k] = k.replace("_", " ").title()
    config_p = Path(output_dir) / "meta" / "config.json"
    config_p.write_text(json.dumps({"camera_labels": cam_labels}, indent=2, ensure_ascii=False))

    print(f"\nMerged → {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Merge v2.0 LeRobot datasets")
    parser.add_argument("--inputs", nargs="+", required=True, help="Source dataset dirs")
    parser.add_argument("--output", required=True, help="Output dataset dir")
    parser.add_argument("--eps-per-source", type=int, default=2, dest="eps_per_source",
                        help="Episodes to take from each source (default 2)")
    args = parser.parse_args()
    merge(args.inputs, args.output, args.eps_per_source)


if __name__ == "__main__":
    main()
