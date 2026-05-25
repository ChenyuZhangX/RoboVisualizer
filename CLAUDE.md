# LeRobot Visualizer — Engineering Notes

## Current State

**Version**: app.js v98, style.css v89, index.html updated
**Status**: Fully functional with annotation system, JSON viewer, SSH remote support, and extensive keyboard navigation

### Architecture

#### Backend (server.py)
- **FastAPI** server on port 8765
- **LRU cache** for Parquet files (OrderedDict, max 24 episodes)
- **GZip middleware** for response compression
- **CORS enabled** for all methods (GET, POST, PUT, DELETE, OPTIONS)
- **Annotation endpoints**: GET/POST/PUT/DELETE for draft management, POST for Parquet commit
- **Frame scalar values endpoint**: Returns all non-binary columns (images excluded)
- **SSH remote endpoints**: POST connect, GET sessions, DELETE session, GET discover

#### Frontend (static/)
- **Single-page app** (no build step)
- **Chart.js** for state/action plots (v4.4.2 CDN)
- **~5500 lines** of vanilla JavaScript (no framework)
- **~2800 lines** of CSS (design tokens, light + dark modes)

#### Key Data Flow
1. User selects episode → `selectEpisode()` → fetch metadata, cache Parquet
2. Playback advances → `setFrame()` → update charts, images, annotation panel
3. User annotates → `saveAnnotationFrame()` → debounced PUT to JSON sidecar
4. User commits → `commitAnnotations()` → read Parquet, write new columns, invalidate cache
5. Frame JSON viewer → `updateFrameJsonViewer()` → fetch from `/frame/{f}/values` endpoint
6. SSH connect → `sshConnect()` → POST `/api/ssh/connect` → GET `.../discover` → `renderSSHSections()`
7. Remote episode access → `get_dataset_path()` returns local cache path → `ensure_parquet()` downloads on demand

---

## Code Organization & Conventions

### JavaScript (app.js)

#### Module-level state
- `state` object: episode, frame, charts, annotations, fill config, etc.
- `_privateVars`: prefixed with `_` for internal tracking (cache, debounce timers, observers)
- No closures or classes; functions read/write global state directly

#### Function naming
- `camelCase` for public functions
- `_leadingUnderscore` for internal helpers
- `build*` — construct DOM elements (e.g. `buildCharts()`, `buildAnnotationPanel()`)
- `update*` — refresh existing UI (e.g. `updateFrameValues()`)
- `set*` / `get*` — manage state (e.g. `setFrame()`)
- `*Cached` — use memoization (e.g. `read_parquet_cached()`)

#### Helpers (alphabetized for easy lookup)
```js
el(id)                 // document.getElementById() shorthand
hide/show(x)           // classList.add/remove('hidden')
toggle(x, cls, force)  // classList.toggle()
attr(x, k, v)          // setAttribute()
isHidden(x)            // classList.contains('hidden')
lsBool(k)              // localStorage bool persistence
```

#### Event handling
- Keyboard: module-level `keydown` listener with `isKey()` helper
- Debounced: `debounce(fn, ms)` utility for timers
- Focus: `inInput` guard to disable shortcuts when user is typing

#### No comments
- Code is self-documenting via function names, variable names, structure
- Only comments for WHY (hidden constraints, workarounds)

### CSS (style.css)

#### Design tokens (root variables)
- **Colors**: `--blue`, `--green`, `--amber`, `--red` + light/dark variants
- **Spacing**: `--radius`, `--radius-lg`, `--radius-md`, `--radius-sm`, `--radius-xs`
- **Typography**: `--font-3xs` through `--font-lg` (px-based, not rem)
- **Shadows**: `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-inset-focus`
- **Breakpoints**: `--bp-lg` (920px), `--bp-md` (720px), `--bp-sm` (480px)

#### Dark mode
- `html.dark` selector overrides colors
- Used by `initDarkMode()` to toggle `.dark` class on `<html>`

#### Layout patterns
- **Sidebar**: fixed left panel (264px); collapses below 720px
- **Charts**: CSS Grid with IntersectionObserver for lazy render
- **Annotations**: tabs + collapsible sections (settings, schema, annotate, annotated, saved)

### Backend (server.py)

#### Helpers
- `get_dataset_path(ds)` — validate & return Path object
- `read_parquet_cached(path)` — LRU cache wrapper
- `read_info_cached()`, `read_tasks_cached()`, `read_episodes_cached()` — metadata caches

#### Annotation flow
1. **Schema**: stored in `meta/annotation_schema.json` (list of {name, type, options?})
2. **Draft sidecar**: `data/annotations/episode_XXXXXX.json` — {frames: {frame_idx: {field: val}}}
3. **Commit**: rewrite Parquet with new PyArrow columns, invalidate cache

#### Pydantic models
- `AnnotationField` — name, type (number|string|boolean|category), options?
- `AnnotationSchemaUpdate` — fields: list[AnnotationField]
- `AnnotationFrameUpdate` — frame_index, values: dict

---

## Recent Changes & Version History

### Session 1: Annotation System Foundation
- Added annotation schema (define fields per dataset)
- Draft storage in JSON sidecar
- Commit endpoint to write Parquet columns
- Fill strategies (none, fixed, forward fill, linear interp)

### Session 2: UI Enhancements
- Annotated tab: stats grid with sparklines for numeric/category/boolean fields
- Tab badges showing field completion counts
- Progress timeline (green = full, amber = partial)
- Keyboard shortcuts (A for tab, Del to clear)

### Session 6: SSH Remote Server Support (Latest)
- **SSH remote dataset visualization**: connect to remote servers (e.g. `ssh H100-SQZ`) via paramiko
  - Backend: `POST /api/ssh/connect`, `GET /api/ssh/sessions`, `DELETE /api/ssh/sessions/{id}`, `GET /api/ssh/sessions/{id}/discover`
  - Discovery algorithm: recursive SFTP walk (max depth 7), detects `meta/info.json` markers
  - Meta files cached to `/tmp/lerobot_ssh_cache/{session_id}/{path_hash}/` on first access
  - Parquet files downloaded on-demand (first episode request triggers SFTP download, cached locally)
  - Virtual dataset names: `__ssh_{session_id}_{path_hash}__` — transparent to all existing API endpoints
  - SSH history persisted to `~/.lerobot_visualizer/ssh_history.json` (deduplicated, last 20 entries)
  - SSH connect reads `~/.ssh/config` for aliases, ProxyJump, IdentityFile etc. via paramiko
  - Added `paramiko>=3.0.0` to requirements.txt
- **Frontend**: SSH button in sidebar header → modal → connect form + history
  - Remote datasets appear in `#ssh-remote-tree` section with 📡 (wifi) badge and blue left border
  - Session disconnect button in sidebar section header and modal
  - History shows recent connections; click → pre-fills form
  - `renderSSHSections()` + `refreshSSHSections()` functions added; called on DOMContentLoaded
- **Fixed state/action names for single-label vectors**: `_resolve_names()` in `get_episode` handles `names:["state"]` with `shape:[9]` → generates `state_0`…`state_8` instead of returning single `["state"]`

### Session 5: Resolution Fix, Droid Dataset & Per-Dataset Config
- **Full-resolution re-downloads**: All datasets now at native resolution (was 128×128):
  - `libero_10_sample` — Franka Panda, 2 tasks × 2 eps, **256×256**, 2 cameras (Camera + Wrist)
  - `aloha_sim_multi` — ALOHA bimanual, 2 tasks × 2 eps, **640×480**, 1 camera (Top View)
  - `ucsd_kitchen_sample` — real kitchen, 2 tasks × 2 eps, **640×480**, 1 camera
  - `droid_sample` — DAVIAN-Robotics/droid_v3 Franka, 4 tasks, **320×180**, **3 cameras** (Wrist/Exterior 1/Exterior 2)
- **Per-dataset config system** (`meta/config.json`): stores `camera_labels` for human-readable display names
  - Server: `GET/PUT /api/datasets/{dataset}/config` endpoints with auto-defaults
  - Frontend: `state.datasetConfig`, `camLabel(key)` helper replaces `unslug(key)` for all camera labels (v97)
  - All existing datasets have `meta/config.json` auto-generated
- **Fixed JSON viewer crash** (v96): `insertBefore(filterInput, rightGroup)` before `rightGroup` was appended → DOM error on every frame render. Fixed to sequential `appendChild`.
- **Fixed utils.py**: actual image H×W stored in `info.json` instead of hardcoded 256×256
- **Tool updates**: `download_v3_dataset.py` defaults to native resolution (0×0), writes `meta/config.json`; `merge_datasets.py` merges camera labels from source configs

### Session 4: Multi-Task Datasets (Previous)
- **3 multi-task datasets downloaded** with real camera frames (PyAV MP4 decoding)
- **New tools**: `tools/download_v3_dataset.py` (v3.0→v2.0 with PyAV), `tools/merge_datasets.py` (combine v2.0 datasets)

### Session 3: JSON Viewer & Polish
- **Filter/search**: search Parquet columns by name (re-renders from cache)
- **Delta display**: green/red badges for frame-to-frame numeric changes
- **Persistence**: remember JSON viewer open/closed state (localStorage)
- **Keyboard nav**: Tab/arrows in annotation chips; Up/Down to seek frames
- **Tab memory**: remember which annotation tab user was on
- **Fixed _jumpToUnannotated**: per-field logic (skip frames unannotated on ANY field)
- **GitHub link**: top-right button to repository
- **CSV export**: download annotations as structured CSV file

---

## Known Limitations & TODOs

### Current Limitations
1. **No concurrent annotation**: only one user can annotate a dataset at a time (file-based sidecar)
2. **No version control**: commits are in-place Parquet rewrites; no undo
3. **Mobile UX**: sidebar collapse works, but small screens are cramped
4. **Array display**: large arrays (>1000 dims) render slowly; consider pagination
5. **Correlation matrix**: computed fresh on every render; cache not implemented

### Potential Future Work
- [ ] Real-time collaboration (WebSocket + conflict resolution)
- [ ] Annotation versioning (keep old Parquet backups, git-style)
- [ ] Bulk operations (apply fill strategy across multiple episodes)
- [ ] Custom chart types (heatmap, correlation, phase plots)
- [ ] A/B comparison of two episodes side-by-side (already has infrastructure)
- [ ] Export to common formats (MJPEG video, GIF, etc.)
- [ ] Performance: lazy-load annotation schema, pagination for large datasets

---

## Development Workflow

### Adding a Feature
1. **Identify scope**: UI change, backend endpoint, or both?
2. **Plan**: sketch component structure, data flow
3. **Implement**: write code, test in browser
4. **Polish**: keyboard shortcuts, accessibility, dark mode support
5. **Commit**: semantic commit message with `Co-Authored-By` footer
6. **Document**: update README.md if user-facing

### Code Quality Standards
- **No dead code**: if unused, delete it
- **No premature abstraction**: 3 similar lines OK; extract at 4+
- **Naming**: self-documenting (bad: `x`, `fn`, `proc`; good: `frameIndex`, `isPlaying`)
- **No comments**: only WHY, not WHAT
- **Keyboard first**: all major actions accessible via shortcuts
- **Dark mode**: test all new UI components in dark mode
- **Error handling**: catch network errors, show toasts; don't swallow silently

---

## Testing Checklist

Before committing:
- [ ] Load a dataset and play it back
- [ ] Test playback controls (pause, seek, speed)
- [ ] Test keyboard shortcuts (arrow keys, Ctrl+S, etc.)
- [ ] Test annotation workflow (add field, annotate frames, fill, commit)
- [ ] Test JSON viewer (toggle, filter, expand arrays)
- [ ] Toggle dark mode (check colors)
- [ ] Test on mobile (sidebar collapse, touch controls)
- [ ] Console has no errors
- [ ] No visual glitches on resize

---

## Performance Tips

### Browser DevTools
- **Lighthouse**: run audit for performance, accessibility, best practices
- **Chrome DevTools**:
  - Performance tab → record playback, check FPS
  - Network tab → check image/chunk sizes, caching headers
  - Console → check for 🔴 errors, ⚠️ warnings

### Profiling
- Slow charts? Check `_visibleCharts` set size and IntersectionObserver
- Slow annotation? Check debounce delay (currently 800ms)
- Slow frame updates? Check frame cache hit rate and Parquet read time

### Optimization Tips
- Precompute expensive operations (norm stats, statistics)
- Batch DOM updates (use DocumentFragment if creating >10 elements)
- Defer non-critical work (load 3rd-party scripts with `defer`)
- Cache computed values (e.g. field completion status)

---

## References

- **LeRobot docs**: https://github.com/huggingface/lerobot
- **FastAPI**: https://fastapi.tiangolo.com/
- **Chart.js**: https://www.chartjs.org/
- **PyArrow**: https://arrow.apache.org/docs/python/
- **Keyboard event codes**: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/values

---

## File Manifest

```
lerobot-visualizer/
├── README.md                    User-facing documentation
├── CLAUDE.md                    This file (engineering notes)
├── server.py                    FastAPI backend (742 lines)
├── requirements.txt             Python dependencies
├── compute_norm_stats.py        Normalization helper
├── static/
│   ├── index.html              Main HTML (v88, 339 lines)
│   ├── app.js                  JavaScript logic (v95, ~5500 lines)
│   └── style.css               Styling (v88, ~2800 lines)
├── tools/
│   ├── utils.py                LeRobot Parquet writer
│   ├── convert_hdf5.py         HDF5 conversion
│   └── convert_folder.py       Folder/CSV conversion
└── data/                        Dataset directory (git-ignored)
```

---

Last updated: 2026-05-25 (v98)
