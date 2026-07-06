"""Standalone viser 3-D robot server.

Started as a subprocess by server.py via ~/viser-env/bin/python.
Communicates with the parent via two temp files:
  /tmp/lerobot_viser_joints.json  – parent writes {joints: [f0..f7]} here
  /tmp/lerobot_viser_ready        – this script touches it when URDF is loaded

Usage (via server.py):
  ~/viser-env/bin/python tools/viser_server.py [--port 8090]
"""

import argparse
import json
import math
import time
from pathlib import Path

import viser
import viser.extras

JOINTS_FILE = Path("/tmp/lerobot_viser_joints.json")
READY_FILE  = Path("/tmp/lerobot_viser_ready")
REPO_ROOT   = Path(__file__).resolve().parent.parent
URDF_PATH   = REPO_ROOT / "static" / "robot" / "panda_arm.urdf"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    args = ap.parse_args()

    # ── Start viser server ─────────────────────────────────────────────────
    server = viser.ViserServer(host="0.0.0.0", port=args.port)
    server.scene.set_up_direction("+z")
    server.scene.add_grid("ground", width=2.0, height=2.0, cell_size=0.1)
    server.scene.configure_default_lights()

    # ── Load Franka Panda URDF ─────────────────────────────────────────────
    if not URDF_PATH.exists():
        print(f"[viser_server] URDF not found: {URDF_PATH}", flush=True)
        while True:
            time.sleep(1)

    robot = viser.extras.ViserUrdf(
        server,
        URDF_PATH,
        mesh_color_override=(0.82, 0.82, 0.85),
        root_node_name="/panda",
    )
    joint_names  = list(robot.get_actuated_joint_names())
    joint_limits = robot.get_actuated_joint_limits()   # dict name → (lo, hi)

    # Signal to the parent that the robot is ready
    READY_FILE.touch()
    print(f"[viser_server] ready on port {args.port}, joints: {joint_names}", flush=True)

    # ── Joint-update loop ──────────────────────────────────────────────────
    last_mtime = 0.0
    while True:
        try:
            st = JOINTS_FILE.stat()
            if st.st_mtime != last_mtime:
                last_mtime = st.st_mtime
                data   = json.loads(JOINTS_FILE.read_text())
                joints = data.get("joints", [])
                cfg: dict[str, float] = {}
                for i, name in enumerate(joint_names[:7]):
                    lo, hi = joint_limits.get(name, (-math.pi, math.pi))
                    val    = float(joints[i]) if i < len(joints) else 0.0
                    cfg[name] = max(lo, min(hi, val))
                robot.update_cfg(cfg)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        except Exception as exc:
            print(f"[viser_server] update error: {exc}", flush=True)
        time.sleep(0.025)   # 40 Hz poll


if __name__ == "__main__":
    main()
