"""
LeRobotWriter — writes episodes to LeRobot v2.0 parquet format.

Exact schema (matching HuggingFace LeRobot v2.0):
  image / wrist_image : struct<bytes: binary, path: string>
  state               : fixed_size_list<float>[D]
  actions             : fixed_size_list<float>[D]
  timestamp           : float  (scalar)
  frame_index         : int64  (scalar)
  episode_index       : int64  (scalar)
  index               : int64  (scalar)
  task_index          : int64  (scalar)
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image


# ── Schema helpers ─────────────────────────────────────────────────────────────

IMAGE_STRUCT = pa.struct([("bytes", pa.binary()), ("path", pa.string())])


def _image_field(name: str) -> pa.Field:
    return pa.field(name, IMAGE_STRUCT)


def _fsl_field(name: str, dim: int) -> pa.Field:
    return pa.field(name, pa.list_(pa.field("element", pa.float32()), dim))


def build_schema(image_keys: list[str], state_dim: int, action_dim: int) -> pa.Schema:
    fields = [_image_field(k) for k in image_keys]
    fields += [
        _fsl_field("state",   state_dim),
        _fsl_field("actions", action_dim),
        pa.field("timestamp",     pa.float32()),
        pa.field("frame_index",   pa.int64()),
        pa.field("episode_index", pa.int64()),
        pa.field("index",         pa.int64()),
        pa.field("task_index",    pa.int64()),
    ]
    return pa.schema(fields)


# ── Image encoding ─────────────────────────────────────────────────────────────

def encode_image(arr: np.ndarray, quality: int = 85) -> bytes:
    """numpy (H,W,3) uint8 → JPEG bytes."""
    if arr is None:
        return b""
    buf = io.BytesIO()
    img = Image.fromarray(arr.astype(np.uint8))
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def image_struct(raw: bytes, path: str = "") -> dict:
    return {"bytes": raw, "path": path}


# ── LeRobotWriter ──────────────────────────────────────────────────────────────

class LeRobotWriter:
    """
    Incrementally writes episodes to LeRobot v2.0 format.

    Usage:
        writer = LeRobotWriter("output/my_dataset", fps=10, robot_type="panda")
        for ep_frames, task in episodes:
            writer.add_episode(ep_frames, task)
        writer.finalize(state_names=[...], action_names=[...])

    Each frame dict must contain:
        "<cam_key>": np.ndarray (H,W,3) uint8   — one per camera
        "state":     np.ndarray (D_state,)
        "actions":   np.ndarray (D_action,)
    Camera keys are auto-detected from the first frame's keys
    (anything that is not "state" or "actions").

    To specify camera order explicitly, pass image_keys= to __init__.
    """

    RESERVED = {"state", "actions"}

    def __init__(
        self,
        output_dir: str,
        fps: int = 10,
        robot_type: str = "unknown",
        chunks_size: int = 1000,
        image_keys: list[str] | None = None,
        jpeg_quality: int = 85,
    ):
        self.out = Path(output_dir)
        self.fps = fps
        self.robot_type = robot_type
        self.chunks_size = chunks_size
        self.image_keys = image_keys  # set on first add_episode if None
        self.jpeg_quality = jpeg_quality

        self._tasks: dict[str, int] = {}   # task_str → task_index
        self._episodes: list[dict] = []
        self._global_idx: int = 0
        self._ep_idx: int = 0
        self._schema: pa.Schema | None = None

        (self.out / "data").mkdir(parents=True, exist_ok=True)
        (self.out / "meta").mkdir(parents=True, exist_ok=True)

    # ── Public API ─────────────────────────────────────────────────────────────

    def add_episode(self, frames: list[dict], task: str) -> int:
        """
        Write one episode and return its episode_index.
        frames: list of per-timestep dicts (see class docstring).
        """
        if not frames:
            return -1

        # Auto-detect image keys from first frame
        if self.image_keys is None:
            self.image_keys = [k for k in frames[0] if k not in self.RESERVED]

        # Register task
        if task not in self._tasks:
            self._tasks[task] = len(self._tasks)
        task_idx = self._tasks[task]

        ep_idx = self._ep_idx
        chunk  = ep_idx // self.chunks_size
        chunk_dir = self.out / "data" / f"chunk-{chunk:03d}"
        chunk_dir.mkdir(exist_ok=True)

        # Infer dims on first episode
        state_dim  = len(frames[0]["state"].flatten())
        action_dim = len(frames[0]["actions"].flatten())
        if self._schema is None:
            self._schema = build_schema(self.image_keys, state_dim, action_dim)

        # Build columns
        n = len(frames)
        cols: dict[str, list] = {k: [] for k in self.image_keys}
        cols.update({"state": [], "actions": [], "timestamp": [],
                     "frame_index": [], "episode_index": [], "index": [], "task_index": []})

        for t, frame in enumerate(frames):
            for k in self.image_keys:
                raw = encode_image(frame.get(k), self.jpeg_quality)
                cols[k].append(image_struct(raw, ""))
            cols["state"].append(frame["state"].flatten().astype(np.float32).tolist())
            cols["actions"].append(frame["actions"].flatten().astype(np.float32).tolist())
            cols["timestamp"].append(float(t) / self.fps)
            cols["frame_index"].append(t)
            cols["episode_index"].append(ep_idx)
            cols["index"].append(self._global_idx)
            cols["task_index"].append(task_idx)
            self._global_idx += 1

        table = self._build_table(cols, state_dim, action_dim)
        pq.write_table(
            table,
            chunk_dir / f"episode_{ep_idx:06d}.parquet",
            compression="snappy",
        )

        self._episodes.append({"episode_index": ep_idx, "tasks": [task], "length": n})
        self._ep_idx += 1
        return ep_idx

    def finalize(
        self,
        state_names: list[str] | None = None,
        action_names: list[str] | None = None,
    ) -> None:
        """Write meta/info.json, tasks.jsonl, episodes.jsonl."""
        if not self._episodes:
            raise ValueError("No episodes written — nothing to finalize.")

        # Read dims from first parquet
        ep0   = self._episodes[0]["episode_index"]
        chunk = ep0 // self.chunks_size
        t0 = pq.read_table(
            self.out / "data" / f"chunk-{chunk:03d}" / f"episode_{ep0:06d}.parquet",
            columns=["state", "actions"],
        )
        state_dim  = t0.schema.field("state").type.list_size
        action_dim = t0.schema.field("actions").type.list_size

        features: dict = {}
        for k in (self.image_keys or []):
            features[k] = {
                "dtype": "image",
                "shape": [256, 256, 3],
                "names": ["height", "width", "channel"],
            }
        features["state"] = {
            "dtype": "float32",
            "shape": [state_dim],
            "names": state_names or ["state"],
        }
        features["actions"] = {
            "dtype": "float32",
            "shape": [action_dim],
            "names": action_names or ["actions"],
        }
        for col, dtype in [
            ("timestamp", "float32"), ("frame_index", "int64"),
            ("episode_index", "int64"), ("index", "int64"), ("task_index", "int64"),
        ]:
            features[col] = {"dtype": dtype, "shape": [1], "names": None}

        n_chunks = max(
            ep["episode_index"] // self.chunks_size
            for ep in self._episodes
        ) + 1

        info = {
            "codebase_version": "v2.0",
            "robot_type": self.robot_type,
            "total_episodes": len(self._episodes),
            "total_frames": self._global_idx,
            "total_tasks": len(self._tasks),
            "total_videos": 0,
            "total_chunks": n_chunks,
            "chunks_size": self.chunks_size,
            "fps": self.fps,
            "splits": {"train": f"0:{len(self._episodes)}"},
            "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
            "video_path": "",
            "features": features,
        }

        (self.out / "meta" / "info.json").write_text(json.dumps(info, indent=2))
        (self.out / "meta" / "tasks.jsonl").write_text(
            "\n".join(
                json.dumps({"task_index": idx, "task": task})
                for task, idx in sorted(self._tasks.items(), key=lambda x: x[1])
            )
        )
        (self.out / "meta" / "episodes.jsonl").write_text(
            "\n".join(json.dumps(ep) for ep in self._episodes)
        )

        print(
            f"✓ {len(self._episodes)} episodes · "
            f"{self._global_idx} frames · "
            f"{len(self._tasks)} tasks → {self.out}"
        )

    # ── Internal ───────────────────────────────────────────────────────────────

    def _build_table(self, cols: dict, state_dim: int, action_dim: int) -> pa.Table:
        arrays: dict[str, pa.Array] = {}

        for k in self.image_keys:
            arrays[k] = pa.array(cols[k], type=IMAGE_STRUCT)

        arrays["state"] = pa.array(
            cols["state"], type=pa.list_(pa.field("element", pa.float32()), state_dim)
        )
        arrays["actions"] = pa.array(
            cols["actions"], type=pa.list_(pa.field("element", pa.float32()), action_dim)
        )
        arrays["timestamp"]     = pa.array(cols["timestamp"],     type=pa.float32())
        arrays["frame_index"]   = pa.array(cols["frame_index"],   type=pa.int64())
        arrays["episode_index"] = pa.array(cols["episode_index"], type=pa.int64())
        arrays["index"]         = pa.array(cols["index"],         type=pa.int64())
        arrays["task_index"]    = pa.array(cols["task_index"],    type=pa.int64())

        return pa.table(arrays, schema=self._schema)
