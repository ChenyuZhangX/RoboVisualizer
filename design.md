# Design of Lerobot Visualizer

## 需求概述

一个运行在本地的 Web 可视化工具，用于浏览和回放 LeRobot 格式的机器人演示数据集。

- **左侧边栏**：文件浏览器，列出 `./data/` 下所有 lerobot dataset；展开后显示 task language descriptions；可选择具体某个 episode
- **右侧主区域**：可视化面板
  - 多路摄像头视频（默认 3 路，不足则灰色占位）
  - State vs Time 折线图（带随时间移动的竖线游标）
  - Action vs Time 折线图（同步游标）
  - Language description 文字展示
- **UI 风格**：白色背景，配色清爽（蓝/绿主色调），响应式布局

---

## 技术选型

| 层级 | 技术 | 理由 |
|------|------|------|
| 后端 | Python FastAPI | 轻量 async，自带 static 文件服务，无需额外配置 |
| 前端 | Vanilla JS + HTML/CSS | 无构建步骤，直接可用，方便快速迭代 |
| 图表 | Chart.js | CDN 引入，API 简洁，支持自定义游标 |
| 数据 | pyarrow / pandas | 读取 parquet 文件 |

---

## 项目结构

```
lerobot_visualizer/
├── server.py              # FastAPI 后端入口
├── requirements.txt       # 依赖清单
├── static/
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑（状态管理 + UI 交互）
│   └── style.css          # 样式
└── data/                  # lerobot datasets（不提交 git）
    └── libero_reduced/
        ├── meta/
        └── data/
```

---

## 后端 API 设计

```
GET  /api/datasets
     → 列出 ./data/ 下所有有效 lerobot dataset（含 meta/info.json）
     返回: [{name, path, total_episodes, total_tasks, robot_type}]

GET  /api/datasets/{dataset}/tasks
     → 读取 meta/tasks.jsonl + meta/episodes.jsonl，按 task 聚合 episode 列表
     返回: [{task_index, task, episodes: [{episode_index, length}]}]

GET  /api/datasets/{dataset}/episodes/{episode_index}
     → 读取对应 parquet 文件
     返回: {
       task: str,
       length: int,
       timestamps: [float],
       state: [[float]],       # shape [T, D]
       actions: [[float]],     # shape [T, D]
       state_names: [str],
       action_names: [str],
       has_images: bool,
       image_keys: [str]       # e.g. ["image", "wrist_image"]
     }

GET  /api/datasets/{dataset}/episodes/{episode_index}/frame/{frame_index}
     → 返回某帧的所有图像
     返回: {image_key: "data:image/png;base64,..." , ...}
```

---

## 前端布局

```
┌─────────────────────────────────────────────────────────┐
│  LeRobot Visualizer                          [dark/light]│
├────────────────┬────────────────────────────────────────┤
│  DATASETS      │  ┌──────────┬──────────┬──────────┐   │
│  ▼ libero_red  │  │ cam1     │ cam2     │ cam3(灰) │   │
│    ▼ Task 0    │  │          │          │          │   │
│      ep_000    │  └──────────┴──────────┴──────────┘   │
│      ep_001    │                                        │
│    ▼ Task 1    │  📝 "put the white mug on the plate…"  │
│      ep_000    │                                        │
│      ep_001    │  ┌─ State vs Time ──────────────────┐  │
│    ...         │  │  ──────╫──────────               │  │
│                │  └────────╫─────────────────────────┘  │
│                │  ┌─ Action vs Time ─────────────────┐  │
│                │  │  ──────╫──────────               │  │
│                │  └────────╫─────────────────────────┘  │
│                │                                        │
│                │  [|◀] [▶] [▶▶]  ━━━━●━━━━━━  12/214  │
└────────────────┴────────────────────────────────────────┘
```

---

## Subgoals（实施计划）

### SG1 — 环境与后端骨架
- 写 `requirements.txt`（fastapi, uvicorn, pyarrow, pillow）
- 写 `server.py`：FastAPI app，挂载 `static/` 为静态文件，实现 `/api/datasets` 端点

### SG2 — 数据 API
- 实现 `/api/datasets/{dataset}/tasks`：读 `meta/tasks.jsonl` + `episodes.jsonl`
- 实现 `/api/datasets/{dataset}/episodes/{idx}`：读 parquet，返回 state/action/timestamp
- 实现 `/api/datasets/{dataset}/episodes/{idx}/frame/{f}`：从 parquet 中的 image bytes 列解码为 base64 PNG

### SG3 — 前端框架与侧边栏
- `index.html`：整体布局（flex，左栏固定宽，右侧自适应）
- `style.css`：配色、字体、侧边栏树形结构样式
- `app.js`：启动时调用 `/api/datasets`，渲染数据集树；点击 episode 加载数据

### SG4 — 摄像头视图
- 右上方 3 格图像区域（CSS grid 1×3）
- 灰色占位（当 image_key 不足 3 个时）
- 根据当前帧索引调用 `/frame/{f}` 更新图像

### SG5 — 折线图与游标
- 用 Chart.js 渲染 State / Action 折线图（多维度叠加，每维一色）
- 自定义 plugin 画竖线游标
- 图表点击/拖动可更新当前帧，图像同步跳转

### SG6 — 播放控制
- 播放/暂停按钮，帧计数器，进度条 scrubber
- `requestAnimationFrame` 驱动，按 dataset fps 播放（info.json 中读取）
- 游标、图像、帧计数同步

### SG7 — 润色与收尾
- 颜色统一（蓝 `#3B82F6` 主色，背景 `#FFFFFF`，边框 `#E5E7EB`）
- 加载状态 spinner，错误提示
- README 写启动方式
