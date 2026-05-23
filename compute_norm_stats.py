"""
Compute norm_stats.json for a LeRobot dataset.
Calculates per-dim mean/std/min/max/q01/q99 for:
  - state
  - action  (raw)
  - delta_action  (action[t+1] - action[t], within each episode)

Usage:
  python compute_norm_stats.py data/libero_reduced
  python compute_norm_stats.py data/libero_reduced --out data/libero_reduced/meta/norm_stats.json
  python compute_norm_stats.py data/libero_reduced --q 1 99   # custom percentiles
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq


def main():
    parser = argparse.ArgumentParser(description="Compute norm_stats.json for a LeRobot dataset")
    parser.add_argument("dataset", help="Path to LeRobot dataset root (must contain meta/info.json)")
    parser.add_argument("--out", default=None,
                        help="Output path (default: <dataset>/meta/norm_stats.json)")
    parser.add_argument("--q", nargs=2, type=float, default=[1.0, 99.0],
                        metavar=("LO", "HI"),
                        help="Percentile bounds (default: 1 99)")
    args = parser.parse_args()

    DATASET = Path(args.dataset)
    OUT = Path(args.out) if args.out else DATASET / "meta" / "norm_stats.json"
    Q_LO, Q_HI = args.q

    if not (DATASET / "meta" / "info.json").exists():
        parser.error(f"Not a valid LeRobot dataset: {DATASET} (missing meta/info.json)")

    info = json.loads((DATASET / "meta" / "info.json").read_text())
    chunks_size = info.get("chunks_size", 1000)

    episode_indices = []
    for line in (DATASET / "meta" / "episodes.jsonl").read_text().splitlines():
        if line.strip():
            episode_indices.append(json.loads(line)["episode_index"])

    print(f"Processing {len(episode_indices)} episodes…", flush=True)

    all_state, all_action, all_delta = [], [], []

    for i, ep_idx in enumerate(episode_indices):
        chunk = ep_idx // chunks_size
        path = DATASET / "data" / f"chunk-{chunk:03d}" / f"episode_{ep_idx:06d}.parquet"
        if not path.exists():
            continue

        table = pq.read_table(path, columns=["state", "actions"])
        state   = np.array(table["state"].to_pylist(),   dtype=np.float32)
        actions = np.array(table["actions"].to_pylist(), dtype=np.float32)
        delta   = np.diff(actions, axis=0)

        all_state.append(state)
        all_action.append(actions)
        if len(delta):
            all_delta.append(delta)

        if (i + 1) % 200 == 0 or (i + 1) == len(episode_indices):
            print(f"  {i+1}/{len(episode_indices)}", flush=True)

    def compute(arrays):
        data = np.concatenate(arrays, axis=0)   # (N_total, D)
        return {
            "mean": data.mean(0).tolist(),
            "std":  data.std(0).tolist(),
            "min":  data.min(0).tolist(),
            "max":  data.max(0).tolist(),
            "q01":  np.percentile(data, Q_LO, axis=0).tolist(),
            "q99":  np.percentile(data, Q_HI, axis=0).tolist(),
        }

    print("Computing statistics…", flush=True)
    stats = {
        "state":        compute(all_state),
        "action":       compute(all_action),
        "delta_action": compute(all_delta),
    }

    OUT.write_text(json.dumps(stats, indent=2))
    print(f"\nSaved → {OUT}")
    for key in stats:
        q01 = np.round(stats[key]["q01"], 4)
        q99 = np.round(stats[key]["q99"], 4)
        print(f"{key:15s}  q01={q01}  q99={q99}")


if __name__ == "__main__":
    main()
