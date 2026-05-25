"""
Generate synthetic test datasets in 3 different source formats:

  1. synth_aloha     — ALOHA-style HDF5  (2 tasks × 2 eps)
  2. synth_robomimic — RoboMimic-style HDF5  (2 tasks × 2 eps)
  3. synth_folder    — Folder Layout A  (2 tasks × 2 eps)

Run:
  python tools/generate_test_datasets.py
"""

from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

import h5py
import numpy as np
from PIL import Image

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "tools"))

T      = 40    # frames per episode
H, W   = 64, 64
S_DIM  = 7    # state / qpos dimension
A_DIM  = 7    # action dimension

RNG = np.random.default_rng(42)


# ── image helpers ────────────────────────────────────────────────────────────

def synth_img(t: int, cam: int, task_id: int, ep_id: int) -> np.ndarray:
    """Return a (H,W,3) uint8 image with a distinct colour per (task,cam)."""
    base = np.zeros((H, W, 3), dtype=np.uint8)
    # Different hue per (task, camera)
    r = (task_id * 80 + cam * 40) % 255
    g = (ep_id  * 60 + t * 3)    % 255
    b = (cam    * 50 + task_id * 70) % 255
    base[:, :] = [r, g, b]
    # Add a small moving square so each frame is different
    x = (t * 2) % (W - 8)
    y = (t * 3) % (H - 8)
    base[y:y+8, x:x+8] = 255
    return base


# ── Dataset 1: ALOHA-style HDF5 ──────────────────────────────────────────────

def make_aloha_hdf5(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tasks = [
        "pick up the red block",
        "place block on the plate",
    ]

    with h5py.File(path, "w") as f:
        data = f.create_group("data")
        demo_i = 0
        for task_id, task in enumerate(tasks):
            for ep in range(2):  # 2 episodes per task
                demo = data.create_group(f"demo_{demo_i}")
                demo.attrs["task"] = task  # stored per-demo for custom profile

                qpos    = RNG.standard_normal((T, S_DIM)).astype(np.float32)
                action  = RNG.standard_normal((T, A_DIM)).astype(np.float32) * 0.1

                obs = demo.create_group("obs")
                obs.create_dataset("qpos", data=qpos)

                imgs_top   = np.stack([synth_img(t, 0, task_id, ep) for t in range(T)])
                imgs_wrist = np.stack([synth_img(t, 1, task_id, ep) for t in range(T)])
                images = obs.create_group("images")
                images.create_dataset("top",   data=imgs_top)
                images.create_dataset("wrist", data=imgs_wrist)

                demo.create_dataset("action", data=action)
                demo_i += 1

    print(f"  Created ALOHA HDF5: {path}  ({demo_i} demos)")


# ── Dataset 2: RoboMimic-style HDF5 ─────────────────────────────────────────

def make_robomimic_hdf5(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tasks = [
        "lift cube to target height",
        "push cube to goal region",
    ]

    with h5py.File(path, "w") as f:
        data = f.create_group("data")
        demo_i = 0
        for task_id, task in enumerate(tasks):
            for ep in range(2):
                demo = data.create_group(f"demo_{demo_i}")
                demo.attrs["task"] = task

                obs = demo.create_group("obs")
                # RoboMimic uses 1-D obs arrays
                obs.create_dataset("joint_pos",  data=RNG.standard_normal((T, 7)).astype(np.float32))
                obs.create_dataset("gripper_qpos", data=RNG.standard_normal((T, 2)).astype(np.float32))
                obs.create_dataset("ee_pos",     data=RNG.standard_normal((T, 3)).astype(np.float32))
                obs.create_dataset("ee_quat",    data=RNG.standard_normal((T, 4)).astype(np.float32))

                imgs_agent = np.stack([synth_img(t, 0, task_id, ep) for t in range(T)])
                imgs_wrist = np.stack([synth_img(t, 1, task_id, ep) for t in range(T)])
                obs.create_dataset("agentview_image",         data=imgs_agent)
                obs.create_dataset("robot0_eye_in_hand_image", data=imgs_wrist)

                demo.create_dataset("actions", data=RNG.standard_normal((T, A_DIM)).astype(np.float32))
                demo_i += 1

    print(f"  Created RoboMimic HDF5: {path}  ({demo_i} demos)")


# ── Dataset 3: Folder Layout A ───────────────────────────────────────────────

def make_folder_layout_a(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    tasks = [
        "grasp object from table",
        "insert peg into hole",
    ]

    ep_i = 0
    for task_id, task in enumerate(tasks):
        for ep in range(2):
            ep_dir = root / f"episode_{ep_i:03d}"

            # Camera images
            for cam_id, cam_name in enumerate(["image", "wrist_image"]):
                cam_dir = ep_dir / cam_name
                cam_dir.mkdir(parents=True, exist_ok=True)
                for t in range(T):
                    img = Image.fromarray(synth_img(t, cam_id, task_id, ep))
                    img.save(cam_dir / f"{t:06d}.png")

            # states.csv
            states = RNG.standard_normal((T, S_DIM)).astype(np.float32)
            with open(ep_dir / "states.csv", "w", newline="") as fh:
                writer = csv.writer(fh)
                writer.writerow([f"s{i}" for i in range(S_DIM)])
                writer.writerows(states.tolist())

            # actions.csv
            actions = RNG.standard_normal((T, A_DIM)).astype(np.float32) * 0.1
            with open(ep_dir / "actions.csv", "w", newline="") as fh:
                writer = csv.writer(fh)
                writer.writerow([f"a{i}" for i in range(A_DIM)])
                writer.writerows(actions.tolist())

            # task.txt
            (ep_dir / "task.txt").write_text(task)

            ep_i += 1

    print(f"  Created folder dataset: {root}  ({ep_i} episodes)")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    raw = ROOT / "data" / "_raw_synth"
    raw.mkdir(parents=True, exist_ok=True)

    print("Generating synthetic source data...")
    make_aloha_hdf5(raw / "aloha.hdf5")
    make_robomimic_hdf5(raw / "robomimic.hdf5")
    make_folder_layout_a(raw / "folder_dataset")
    print("Done. Run convert.sh to produce LeRobot datasets.")
