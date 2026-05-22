"""
Convert HDF5-based robot datasets to LeRobot v2.0 format.

Supported profiles (--profile):
  aloha       ALOHA / ACT  (Tony Zhao et al.)
  robomimic   RoboMimic (Mandlekar et al.)
  libero      LIBERO original HDF5 (before LeRobot conversion)
  custom      User-defined field mapping via --config JSON

Usage examples:
  # ALOHA
  python convert_hdf5.py data.hdf5 output/my_dataset --profile aloha --task "pick cup"

  # RoboMimic (task from demo attributes)
  python convert_hdf5.py robosuite.hdf5 output/my_dataset --profile robomimic

  # LIBERO original
  python convert_hdf5.py libero_task.hdf5 output/my_dataset --profile libero

  # Custom field mapping
  python convert_hdf5.py custom.hdf5 output/my_dataset --profile custom --config '{
    "demos_key": "data",
    "state_keys": ["obs/joint_pos", "obs/gripper"],
    "action_key": "actions",
    "image_keys": {"image": "obs/camera_rgb"},
    "task_key": null,
    "task_default": "my task"
  }'
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import h5py
import numpy as np

# Allow running from any directory
sys.path.insert(0, str(Path(__file__).parent))
from utils import LeRobotWriter


# ── Profile definitions ────────────────────────────────────────────────────────

PROFILES = {
    "aloha": {
        # /data/demo_N/
        "demos_key":   "data",
        # concat all obs/<key> arrays → state
        "state_keys":  ["obs/qpos"],
        "action_key":  "action",
        # {lerobot_name: hdf5_path_under_demo}
        "image_keys":  {
            "image":       "obs/images/top",
            "wrist_image": "obs/images/wrist",
        },
        "task_key":     None,   # read from demo attrs or top-level attrs
        "task_default": "manipulation task",
        "fps":          50,
        "robot_type":   "aloha",
    },
    "robomimic": {
        "demos_key":   "data",
        "state_keys":  [],      # auto: all obs keys that are 1-D per timestep
        "action_key":  "actions",
        "image_keys":  {
            "image":       "obs/agentview_image",
            "wrist_image": "obs/robot0_eye_in_hand_image",
        },
        "task_key":     None,
        "task_default": "robot manipulation",
        "fps":          20,
        "robot_type":   "panda",
    },
    "libero": {
        "demos_key":   "data",
        "state_keys":  [
            "obs/joint_states",
            "obs/gripper_states",
            "obs/ee_pos",
            "obs/ee_ori",
        ],
        "action_key":  "actions",
        "image_keys":  {
            "image":       "obs/agentview_rgb",
            "wrist_image": "obs/eye_in_hand_rgb",
        },
        "task_key":     "problem_info",  # top-level HDF5 attr (JSON string)
        "task_default": "libero task",
        "fps":          20,
        "robot_type":   "panda",
    },
    "custom": None,  # filled from --config
}


# ── HDF5 reading helpers ───────────────────────────────────────────────────────

def read_field(demo: h5py.Group, path: str) -> np.ndarray | None:
    """Read a dataset from demo group by slash-separated path."""
    try:
        obj = demo
        for part in path.split("/"):
            obj = obj[part]
        return np.array(obj)
    except KeyError:
        return None


def build_state(demo: h5py.Group, state_keys: list[str]) -> np.ndarray:
    """Concatenate multiple obs arrays into a single state vector (T, D)."""
    arrays = []
    for key in state_keys:
        arr = read_field(demo, key)
        if arr is None:
            continue
        if arr.ndim == 1:
            arr = arr[:, None]
        arrays.append(arr)
    if not arrays:
        raise ValueError(f"No state arrays found for keys: {state_keys}")
    return np.concatenate(arrays, axis=-1).astype(np.float32)


def auto_state_robomimic(demo: h5py.Group) -> np.ndarray:
    """RoboMimic: collect all 1-D obs keys (skip images)."""
    obs = demo["obs"]
    arrays = []
    for key in sorted(obs.keys()):
        arr = np.array(obs[key])
        if arr.ndim == 2 and arr.shape[-1] <= 64:   # exclude images (H,W,C)
            arrays.append(arr.astype(np.float32))
    if not arrays:
        raise ValueError("No state arrays found in obs")
    return np.concatenate(arrays, axis=-1)


def read_images(demo: h5py.Group, image_keys: dict[str, str]) -> dict[str, np.ndarray | None]:
    """Return {lerobot_key: (T,H,W,3) uint8 or None}."""
    result = {}
    for lerobot_key, hdf5_path in image_keys.items():
        arr = read_field(demo, hdf5_path)
        if arr is not None:
            result[lerobot_key] = arr.astype(np.uint8)
        else:
            result[lerobot_key] = None
    return result


def get_task(f: h5py.File, demo: h5py.Group, cfg: dict, demo_name: str) -> str:
    task_key = cfg.get("task_key")
    default  = cfg.get("task_default", "manipulation task")

    if task_key is None:
        return default

    # Check top-level attrs (e.g. LIBERO problem_info)
    if task_key in f.attrs:
        val = f.attrs[task_key]
        if isinstance(val, (bytes, np.bytes_)):
            val = val.decode()
        try:
            info = json.loads(val)
            return info.get("language_instruction", info.get("task", default))
        except (json.JSONDecodeError, TypeError):
            return str(val)

    # Check demo attrs
    if task_key in demo.attrs:
        val = demo.attrs[task_key]
        if isinstance(val, (bytes, np.bytes_)):
            val = val.decode()
        return str(val)

    return default


# ── Conversion entry point ─────────────────────────────────────────────────────

def convert(
    hdf5_path: str,
    output_dir: str,
    cfg: dict,
    max_episodes: int | None = None,
    task_override: str | None = None,
    verbose: bool = True,
) -> None:
    writer = LeRobotWriter(
        output_dir,
        fps=cfg.get("fps", 10),
        robot_type=cfg.get("robot_type", "unknown"),
    )

    with h5py.File(hdf5_path, "r") as f:
        demos_group = f[cfg["demos_key"]]
        demo_names  = sorted(demos_group.keys())

        if max_episodes is not None:
            demo_names = demo_names[:max_episodes]

        print(f"Found {len(demo_names)} demos in {hdf5_path}")

        for i, name in enumerate(demo_names):
            demo = demos_group[name]

            # ── task ──────────────────────────────────────────────
            task = task_override or get_task(f, demo, cfg, name)

            # ── actions ───────────────────────────────────────────
            actions = read_field(demo, cfg["action_key"])
            if actions is None:
                print(f"  [{name}] skipped: action key '{cfg['action_key']}' not found")
                continue
            actions = actions.astype(np.float32)
            T = len(actions)

            # ── state ─────────────────────────────────────────────
            state_keys = cfg.get("state_keys", [])
            if state_keys == [] and cfg.get("_auto_state") == "robomimic":
                state = auto_state_robomimic(demo)
            elif state_keys:
                state = build_state(demo, state_keys)
            else:
                state = np.zeros((T, 1), dtype=np.float32)
            state = state[:T]   # align to action length

            # ── images ────────────────────────────────────────────
            images = read_images(demo, cfg.get("image_keys", {}))

            # ── build frames ──────────────────────────────────────
            frames = []
            for t in range(T):
                frame = {
                    "state":   state[t],
                    "actions": actions[t],
                }
                for lk, arr in images.items():
                    frame[lk] = arr[t] if arr is not None else None
                frames.append(frame)

            ep_idx = writer.add_episode(frames, task)
            if verbose:
                print(f"  [{i+1}/{len(demo_names)}] {name} → ep_{ep_idx:06d}  "
                      f"T={T}  task='{task[:60]}'")

    state_dim  = len(frames[0]["state"])
    action_dim = len(frames[0]["actions"])
    writer.finalize(
        state_names  = [f"state_{i}"  for i in range(state_dim)],
        action_names = [f"action_{i}" for i in range(action_dim)],
    )


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Convert HDF5 → LeRobot v2.0")
    parser.add_argument("input",   help="Input HDF5 file")
    parser.add_argument("output",  help="Output dataset directory")
    parser.add_argument("--profile",  default="aloha",
                        choices=list(PROFILES.keys()), help="Dataset profile")
    parser.add_argument("--config",   default=None,
                        help="JSON config string (required for --profile custom)")
    parser.add_argument("--task",     default=None,
                        help="Override task description for all episodes")
    parser.add_argument("--fps",      type=int, default=None)
    parser.add_argument("--max-episodes", type=int, default=None,
                        dest="max_episodes")
    args = parser.parse_args()

    if args.profile == "custom":
        if not args.config:
            parser.error("--config is required for --profile custom")
        cfg = json.loads(args.config)
    else:
        cfg = dict(PROFILES[args.profile])
        if args.profile == "robomimic":
            cfg["_auto_state"] = "robomimic"

    if args.fps is not None:
        cfg["fps"] = args.fps

    convert(
        hdf5_path     = args.input,
        output_dir    = args.output,
        cfg           = cfg,
        max_episodes  = args.max_episodes,
        task_override = args.task,
    )


if __name__ == "__main__":
    main()
