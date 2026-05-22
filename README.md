# LeRobot Visualizer

Web-based visualizer for [LeRobot](https://github.com/huggingface/lerobot) format datasets.

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
python server.py
```

Then open **http://localhost:8765** in your browser.

## Data layout

Place LeRobot datasets under `./data/`. Each dataset must have a `meta/info.json`:

```
data/
└── libero_reduced/
    ├── meta/
    │   ├── info.json
    │   ├── tasks.jsonl
    │   └── episodes.jsonl
    └── data/
        └── chunk-000/
            └── episode_000000.parquet
```

## Features

- Browse all datasets and tasks in the sidebar
- Camera views (up to 3, gray placeholder if fewer)
- State & Action vs Time charts with a scrubable cursor
- Play / pause / rewind playback at dataset fps
