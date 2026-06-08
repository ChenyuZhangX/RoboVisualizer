#!/usr/bin/env python3
"""Convert our custom HDF5 format → LeRobot v2.0 parquet dataset.

Usage:
    python3 hdf5_to_lerobot.py <input.h5> <output_dir> [--task "description"]

Output layout:
    <output_dir>/
        meta/info.json
        meta/episodes.jsonl
        meta/tasks.jsonl
        data/chunk-000/episode_000000.parquet
        data/chunk-000/episode_000001.parquet
        ...
"""

import argparse
import io
import json
import struct
import sys
from pathlib import Path

import h5py
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

# ── Image encoding ─────────────────────────────────────────────────────────────

def encode_jpeg(frame_rgb: np.ndarray, quality: int = 85) -> bytes:
    """RGB uint8 [H,W,3] → JPEG bytes."""
    img = Image.fromarray(frame_rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


# ── Main conversion ─────────────────────────────────────────────────────────────

def convert(h5_path: Path, out_dir: Path, task: str, fps: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    chunk_dir = out_dir / "data" / "chunk-000"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    meta_dir = out_dir / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)

    with h5py.File(h5_path, "r") as f:
        demo_keys = sorted(f.keys())   # demo_0000, demo_0001, ...
        print(f"Found {len(demo_keys)} demos in {h5_path.name}")

        total_frames = 0
        episode_meta = []

        for ep_idx, key in enumerate(demo_keys):
            grp = f[key]["replay"]

            joint_pos = grp["joint_pos"][:]           # [T, 7]
            actions   = grp["actions"][:]             # [T, 8]
            gripper   = grp["gripper_state"][:]       # [T]
            timestamps = grp["timestamps"][:]         # [T]

            # state = [joint_pos×7, gripper×1]
            state = np.concatenate(
                [joint_pos, gripper[:, None]], axis=1
            ).astype(np.float32)                      # [T, 8]

            T = len(timestamps)
            has_wrist = "wrist_zed" in grp
            has_third = "third_rs"  in grp

            print(f"  [{key}]  T={T}  "
                  f"wrist={'yes' if has_wrist else 'no'}  "
                  f"third={'yes' if has_third else 'no'}")

            # Build per-frame rows
            rows = {
                "state":         [],
                "actions":       [],
                "timestamp":     [],
                "frame_index":   [],
                "episode_index": [],
                "index":         [],
                "task_index":    [],
            }
            if has_wrist:
                rows["wrist_zed"] = []
            if has_third:
                rows["third_rs"] = []

            wrist_frames = grp["wrist_zed"][:] if has_wrist else None  # [T,H,W,3]
            third_frames = grp["third_rs"][:]  if has_third else None

            for t in range(T):
                rows["state"].append(state[t].tolist())
                rows["actions"].append(actions[t].tolist())
                rows["timestamp"].append(float(timestamps[t]))
                rows["frame_index"].append(t)
                rows["episode_index"].append(ep_idx)
                rows["index"].append(total_frames + t)
                rows["task_index"].append(0)

                if has_wrist:
                    jpeg = encode_jpeg(wrist_frames[t])
                    rows["wrist_zed"].append({"bytes": jpeg, "path": None})
                if has_third:
                    jpeg = encode_jpeg(third_frames[t])
                    rows["third_rs"].append({"bytes": jpeg, "path": None})

            # Build PyArrow table
            img_type = pa.struct([
                pa.field("bytes", pa.binary()),
                pa.field("path",  pa.string()),
            ])

            fields = []
            arrays = []

            if has_wrist:
                fields.append(pa.field("wrist_zed", img_type))
                arrays.append(pa.array(rows["wrist_zed"], type=img_type))
            if has_third:
                fields.append(pa.field("third_rs", img_type))
                arrays.append(pa.array(rows["third_rs"], type=img_type))

            fields += [
                pa.field("state",         pa.list_(pa.float32(), list_size=8)),
                pa.field("actions",       pa.list_(pa.float32(), list_size=8)),
                pa.field("timestamp",     pa.float32()),
                pa.field("frame_index",   pa.int64()),
                pa.field("episode_index", pa.int64()),
                pa.field("index",         pa.int64()),
                pa.field("task_index",    pa.int64()),
            ]
            arrays += [
                pa.array([r for r in rows["state"]],
                         type=pa.list_(pa.float32(), list_size=8)),
                pa.array([r for r in rows["actions"]],
                         type=pa.list_(pa.float32(), list_size=8)),
                pa.array(rows["timestamp"],     type=pa.float32()),
                pa.array(rows["frame_index"],   type=pa.int64()),
                pa.array(rows["episode_index"], type=pa.int64()),
                pa.array(rows["index"],         type=pa.int64()),
                pa.array(rows["task_index"],    type=pa.int64()),
            ]

            schema = pa.schema(fields)
            table  = pa.table(dict(zip(schema.names, arrays)), schema=schema)

            out_parquet = chunk_dir / f"episode_{ep_idx:06d}.parquet"
            pq.write_table(table, out_parquet, compression="snappy")
            print(f"    → {out_parquet.name}  ({out_parquet.stat().st_size/1e6:.1f} MB)")

            episode_meta.append({
                "episode_index": ep_idx,
                "tasks":         [task],
                "length":        T,
            })
            total_frames += T

    # ── meta/info.json ──────────────────────────────────────────────────────────
    # Detect image shape from last group
    img_h, img_w = 224, 224
    with h5py.File(h5_path, "r") as f:
        last = f[demo_keys[-1]]["replay"]
        if "wrist_zed" in last:
            img_h, img_w = last["wrist_zed"].shape[1:3]

    cam_features = {}
    if has_wrist:
        cam_features["wrist_zed"] = {
            "dtype": "image",
            "shape": [img_h, img_w, 3],
            "names": ["height", "width", "channel"],
        }
    if has_third:
        cam_features["third_rs"] = {
            "dtype": "image",
            "shape": [img_h, img_w, 3],
            "names": ["height", "width", "channel"],
        }

    info = {
        "codebase_version": "v2.0",
        "robot_type":       "Franka",
        "total_episodes":   len(demo_keys),
        "total_frames":     total_frames,
        "total_tasks":      1,
        "total_videos":     0,
        "total_chunks":     1,
        "chunks_size":      1000,
        "fps":              fps,
        "splits":           {"train": f"0:{len(demo_keys)}"},
        "data_path":        "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path":       "",
        "features": {
            **cam_features,
            "state": {
                "dtype": "float32",
                "shape": [8],
                "names": [f"joint_{i}" for i in range(7)] + ["gripper"],
            },
            "actions": {
                "dtype": "float32",
                "shape": [8],
                "names": [f"joint_{i}" for i in range(7)] + ["gripper"],
            },
            "timestamp":     {"dtype": "float32", "shape": [1], "names": None},
            "frame_index":   {"dtype": "int64",   "shape": [1], "names": None},
            "episode_index": {"dtype": "int64",   "shape": [1], "names": None},
            "index":         {"dtype": "int64",   "shape": [1], "names": None},
            "task_index":    {"dtype": "int64",   "shape": [1], "names": None},
        },
    }
    (meta_dir / "info.json").write_text(json.dumps(info, indent=2))

    # ── meta/episodes.jsonl ──────────────────────────────────────────────────────
    with open(meta_dir / "episodes.jsonl", "w") as fh:
        for ep in episode_meta:
            fh.write(json.dumps(ep) + "\n")

    # ── meta/tasks.jsonl ────────────────────────────────────────────────────────
    (meta_dir / "tasks.jsonl").write_text(
        json.dumps({"task_index": 0, "task": task}) + "\n"
    )

    print(f"\n✓ Done → {out_dir}")
    total_mb = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file()) / 1e6
    print(f"  Total size: {total_mb:.1f} MB")


# ── CLI ─────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("input",      type=Path)
    ap.add_argument("output_dir", type=Path)
    ap.add_argument("--task", default="pick up cup", type=str)
    ap.add_argument("--fps",  default=15, type=int)
    args = ap.parse_args()

    convert(args.input, args.output_dir, task=args.task, fps=args.fps)
