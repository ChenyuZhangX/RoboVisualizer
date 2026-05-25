#!/usr/bin/env bash
# Convert the three synthetic source datasets into LeRobot v2.0 format.
# Run from the project root: bash tools/convert_synth.sh

set -euo pipefail
cd "$(dirname "$0")/.."

RAW="data/_raw_synth"

# 1. ALOHA HDF5 → synth_aloha
echo "=== Converting ALOHA HDF5 ==="
python3 tools/convert_hdf5.py \
    "$RAW/aloha.hdf5" \
    "data/synth_aloha" \
    --profile custom \
    --config '{
        "demos_key":   "data",
        "state_keys":  ["obs/qpos"],
        "action_key":  "action",
        "image_keys":  {"image": "obs/images/top", "wrist_image": "obs/images/wrist"},
        "task_key":    "task",
        "task_default":"manipulation task",
        "fps":         50,
        "robot_type":  "aloha"
    }'

# 2. RoboMimic HDF5 → synth_robomimic
echo "=== Converting RoboMimic HDF5 ==="
python3 tools/convert_hdf5.py \
    "$RAW/robomimic.hdf5" \
    "data/synth_robomimic" \
    --profile custom \
    --config '{
        "demos_key":   "data",
        "state_keys":  [],
        "_auto_state": "robomimic",
        "action_key":  "actions",
        "image_keys":  {"image": "obs/agentview_image", "wrist_image": "obs/robot0_eye_in_hand_image"},
        "task_key":    "task",
        "task_default":"robot manipulation",
        "fps":         20,
        "robot_type":  "panda"
    }'

# 3. Folder Layout A → synth_folder
echo "=== Converting Folder Layout A ==="
python3 tools/convert_folder.py \
    "$RAW/folder_dataset" \
    "data/synth_folder" \
    --fps 10 \
    --robot-type "unknown"

echo ""
echo "All done! Datasets ready in data/:"
ls data/ | grep synth
