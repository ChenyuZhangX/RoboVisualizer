"""
Convert folder-based robot datasets to LeRobot v2.0 format.

Expects one of two layouts:

LAYOUT A — per-episode subdirectories:
  dataset/
    episode_000/
      <cam0>/                  # e.g. "image", "wrist_image", "cam_top"
        000000.jpg / .png
        000001.jpg
        ...
      <cam1>/
        ...
      states.csv               # columns: s0, s1, ...  (one row per timestep)
      actions.csv              # columns: a0, a1, ...
      task.txt                 # (optional) task description, one line
    episode_001/
      ...

LAYOUT B — flat CSV with image paths:
  dataset/
    data.csv                   # columns: episode, frame, state_*, action_*, cam*_path
    images/                    # images referenced by paths in data.csv
      ...

Usage:
  # Layout A
  python convert_folder.py /path/to/dataset output/my_dataset

  # Layout B
  python convert_folder.py /path/to/dataset output/my_dataset --layout B \\
      --state-cols state_0 state_1 state_2 \\
      --action-cols action_0 action_1 action_2 \\
      --image-cols image wrist_image

  # Layout A with overrides
  python convert_folder.py /path/to/dataset output/my_dataset \\
      --fps 30 --task "pick up the cube" \\
      --cam-dirs image wrist_image    # only include these camera dirs
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from utils import LeRobotWriter


# ── Layout A ───────────────────────────────────────────────────────────────────

def load_csv(path: Path) -> list[list[float]]:
    rows = []
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader, None)
        for row in reader:
            rows.append([float(x) for x in row])
    return rows


def find_image_dirs(ep_dir: Path, cam_dirs: list[str] | None) -> dict[str, Path]:
    """Return {cam_name: dir_path} for each camera folder found."""
    result = {}
    if cam_dirs:
        for name in cam_dirs:
            p = ep_dir / name
            if p.is_dir():
                result[name] = p
    else:
        for p in sorted(ep_dir.iterdir()):
            if p.is_dir():
                result[p.name] = p
    return result


def load_image(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    return np.array(img, dtype=np.uint8)


def convert_layout_a(
    root: Path,
    writer: LeRobotWriter,
    default_task: str,
    cam_dirs: list[str] | None,
    ep_prefix: str,
) -> None:
    ep_dirs = sorted(
        d for d in root.iterdir()
        if d.is_dir() and d.name.startswith(ep_prefix)
    )
    if not ep_dirs:
        raise FileNotFoundError(
            f"No episode directories starting with '{ep_prefix}' found in {root}"
        )

    print(f"Found {len(ep_dirs)} episode directories")

    for i, ep_dir in enumerate(ep_dirs):
        # ── task ──────────────────────────────────────────────
        task_file = ep_dir / "task.txt"
        task = task_file.read_text().strip() if task_file.exists() else default_task

        # ── states & actions ──────────────────────────────────
        states_path  = ep_dir / "states.csv"
        actions_path = ep_dir / "actions.csv"

        if not states_path.exists() or not actions_path.exists():
            # Try alternative names
            states_path  = next(ep_dir.glob("state*.csv"),  states_path)
            actions_path = next(ep_dir.glob("action*.csv"), actions_path)

        if not states_path.exists():
            raise FileNotFoundError(f"No states.csv in {ep_dir}")
        if not actions_path.exists():
            raise FileNotFoundError(f"No actions.csv in {ep_dir}")

        states  = load_csv(states_path)
        actions = load_csv(actions_path)
        T = min(len(states), len(actions))

        # ── images ────────────────────────────────────────────
        cam_map = find_image_dirs(ep_dir, cam_dirs)
        # Collect sorted image files per camera
        cam_frames: dict[str, list[Path]] = {}
        for cam_name, cam_dir in cam_map.items():
            files = sorted(cam_dir.glob("*.jpg")) + sorted(cam_dir.glob("*.png"))
            if files:
                cam_frames[cam_name] = files

        # ── build frames ──────────────────────────────────────
        frames = []
        for t in range(T):
            frame = {
                "state":   np.array(states[t],  dtype=np.float32),
                "actions": np.array(actions[t], dtype=np.float32),
            }
            for cam_name, files in cam_frames.items():
                if t < len(files):
                    frame[cam_name] = load_image(files[t])
            frames.append(frame)

        ep_idx = writer.add_episode(frames, task)
        print(f"  [{i+1}/{len(ep_dirs)}] {ep_dir.name} → ep_{ep_idx:06d}  "
              f"T={T}  cams={list(cam_frames.keys())}")


# ── Layout B ───────────────────────────────────────────────────────────────────

def convert_layout_b(
    root: Path,
    writer: LeRobotWriter,
    default_task: str,
    state_cols: list[str],
    action_cols: list[str],
    image_cols: list[str],
    task_col: str | None,
) -> None:
    csv_path = root / "data.csv"
    if not csv_path.exists():
        raise FileNotFoundError(f"Expected {csv_path}")

    rows_by_ep: dict[str, list[dict]] = {}
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            ep = row.get("episode", "0")
            rows_by_ep.setdefault(ep, []).append(row)

    print(f"Found {len(rows_by_ep)} episodes in data.csv")

    for i, (ep_key, rows) in enumerate(sorted(rows_by_ep.items())):
        task = rows[0].get(task_col, default_task) if task_col else default_task

        frames = []
        for row in rows:
            state   = np.array([float(row[c]) for c in state_cols],  dtype=np.float32)
            actions = np.array([float(row[c]) for c in action_cols], dtype=np.float32)
            frame   = {"state": state, "actions": actions}
            for col in image_cols:
                if col in row and row[col]:
                    img_path = root / row[col]
                    if img_path.exists():
                        frame[col] = load_image(img_path)
            frames.append(frame)

        ep_idx = writer.add_episode(frames, task)
        print(f"  [{i+1}/{len(rows_by_ep)}] ep={ep_key} → ep_{ep_idx:06d}  T={len(frames)}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Convert folder dataset → LeRobot v2.0")
    parser.add_argument("input",  help="Root dataset directory")
    parser.add_argument("output", help="Output LeRobot dataset directory")
    parser.add_argument("--layout",  choices=["A", "B"], default="A")
    parser.add_argument("--fps",     type=int, default=10)
    parser.add_argument("--task",    default="manipulation task",
                        help="Default task description (used if no task.txt)")
    parser.add_argument("--robot-type", default="unknown", dest="robot_type")
    parser.add_argument("--ep-prefix", default="episode",
                        dest="ep_prefix",
                        help="Layout A: episode directory prefix (default: 'episode')")
    parser.add_argument("--cam-dirs", nargs="+", default=None, dest="cam_dirs",
                        help="Layout A: camera subdirectory names to include (default: all)")
    # Layout B only
    parser.add_argument("--state-cols",  nargs="+", dest="state_cols",  default=[])
    parser.add_argument("--action-cols", nargs="+", dest="action_cols", default=[])
    parser.add_argument("--image-cols",  nargs="+", dest="image_cols",  default=[])
    parser.add_argument("--task-col",    default=None, dest="task_col")

    args = parser.parse_args()
    root = Path(args.input)

    writer = LeRobotWriter(
        args.output,
        fps=args.fps,
        robot_type=args.robot_type,
    )

    if args.layout == "A":
        convert_layout_a(
            root, writer,
            default_task=args.task,
            cam_dirs=args.cam_dirs,
            ep_prefix=args.ep_prefix,
        )
    else:
        if not args.state_cols or not args.action_cols:
            parser.error("--state-cols and --action-cols are required for layout B")
        convert_layout_b(
            root, writer,
            default_task=args.task,
            state_cols=args.state_cols,
            action_cols=args.action_cols,
            image_cols=args.image_cols,
            task_col=args.task_col,
        )

    writer.finalize()


if __name__ == "__main__":
    main()
