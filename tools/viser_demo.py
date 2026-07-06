"""Viser demo: visualize Franka Panda joint trajectory from a LeRobot episode.

Uses viser.extras.ViserUrdf to load the actual panda_arm.urdf in static/robot/,
then drives each frame's joint angles from the Parquet state data.

Usage:
  ~/viser-env/bin/python tools/viser_demo.py
  ~/viser-env/bin/python tools/viser_demo.py --dataset droid_sample --episode 0 --port 8080
"""

import argparse
import time
import math
from pathlib import Path

import numpy as np
import viser
import viser.extras
import viser.transforms as tf


# ── paths ──────────────────────────────────────────────────────────────────────
REPO_ROOT  = Path(__file__).resolve().parent.parent
URDF_PATH  = REPO_ROOT / "static" / "robot" / "panda_arm.urdf"
DATA_ROOT  = REPO_ROOT / "data"


# ── load episode data ──────────────────────────────────────────────────────────
def load_states(dataset: str, episode: int) -> np.ndarray:
    """Return (N, 7) float32 joint angles. Falls back to a sine sweep."""
    ep_str = f"episode_{episode:06d}"
    path = DATA_ROOT / dataset / "data" / "chunk-000" / f"{ep_str}.parquet"

    if not path.exists():
        print(f"[warn] {path} not found — using synthetic sine-wave trajectory")
        n = 200
        t = np.linspace(0, 2 * math.pi, n)
        amplitudes = [0.6, 0.4, 0.5, 0.6, 0.7, 0.4, 0.3]
        return np.column_stack([a * np.sin(t + i * 0.7) for i, a in enumerate(amplitudes)]).astype(np.float32)

    import pyarrow.parquet as pq
    df = pq.read_table(path).to_pandas()

    # Try to find 7 joint-angle columns in order
    scalar_cols = [c for c in df.columns if isinstance(df[c].iloc[0], (int, float, np.floating, np.integer))]
    state_cols  = [c for c in scalar_cols if "state" in c.lower()]

    if state_cols and len(state_cols) >= 7:
        data = df[state_cols[:7]].values.astype(np.float32)
        print(f"Loaded {len(data)} frames  cols={state_cols[:7]}")
        return data

    # Fallback: look for a column that contains arrays
    for col in df.columns:
        sample = df[col].iloc[0]
        if hasattr(sample, "__len__") and len(sample) >= 7:
            data = np.stack(df[col].values)[:, :7].astype(np.float32)
            print(f"Loaded {len(data)} frames from array col '{col}'")
            return data

    print("[warn] no usable state columns; using zeros")
    return np.zeros((len(df), 7), dtype=np.float32)


# ── main ───────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset",  default="droid_sample")
    ap.add_argument("--episode",  type=int, default=0)
    ap.add_argument("--port",     type=int, default=8080)
    args = ap.parse_args()

    states = load_states(args.dataset, args.episode)
    n_frames = len(states)

    # ── viser server ───────────────────────────────────────────────────────
    server = viser.ViserServer(port=args.port)
    print(f"\n  ✦ Open browser → http://localhost:{args.port}\n")

    server.scene.set_up_direction("+z")
    server.scene.add_grid("ground", width=2.0, height=2.0, cell_size=0.1)
    server.scene.configure_default_lights()

    # ── load URDF ─────────────────────────────────────────────────────────
    if not URDF_PATH.exists():
        print(f"[error] URDF not found at {URDF_PATH}")
        return

    robot = viser.extras.ViserUrdf(
        server,
        URDF_PATH,
        mesh_color_override=(0.85, 0.85, 0.85),
        root_node_name="/panda",
    )
    joint_names = robot.get_actuated_joint_names()
    joint_limits = robot.get_actuated_joint_limits()  # dict name → (lo, hi)
    print(f"URDF joints ({len(joint_names)}): {joint_names}")

    # ── end-effector trajectory (spline) ──────────────────────────────────
    # We'll collect FK tip positions; viser can't do FK itself, so we skip for now
    # and just let the URDF animation speak for itself.

    # ── GUI ───────────────────────────────────────────────────────────────
    with server.gui.add_folder("Episode"):
        gui_dataset = server.gui.add_text("Dataset", initial_value=args.dataset)
        gui_ep      = server.gui.add_text("Episode", initial_value=str(args.episode))

    with server.gui.add_folder("Playback"):
        gui_play   = server.gui.add_button("⏸ Pause")
        gui_speed  = server.gui.add_slider("Speed ×", min=0.1, max=5.0, step=0.1, initial_value=1.0)
        gui_frame  = server.gui.add_slider("Frame", min=0, max=n_frames - 1, step=1, initial_value=0)

    playing = [True]

    @gui_play.on_click
    def _(_):
        playing[0] = not playing[0]
        gui_play.label = "▶ Play" if not playing[0] else "⏸ Pause"

    # ── per-frame update ──────────────────────────────────────────────────
    def update(f: int):
        joints_7 = states[f].tolist()
        # Map first 7 joints to URDF actuated joints (in order)
        cfg = {}
        for i, name in enumerate(joint_names[:7]):
            lo, hi = joint_limits.get(name, (-math.pi, math.pi))
            val = max(lo, min(hi, joints_7[i] if i < len(joints_7) else 0.0))
            cfg[name] = val
        robot.update_cfg(cfg)

    # ── playback loop ─────────────────────────────────────────────────────
    frame = 0
    try:
        while True:
            if playing[0]:
                frame = (frame + 1) % n_frames
                gui_frame.value = frame
            else:
                frame = int(gui_frame.value)

            update(frame)
            time.sleep(1.0 / (30.0 * gui_speed.value))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
