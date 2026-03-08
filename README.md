# Diagram-gen — AXI4 Interconnect 3D Diagram

Interactive 3D diagram of an **AXI4 Master → AXI4 Repeater Pipeline → AXI4 Slave**
design, rendered with [Three.js](https://threejs.org/) and served from a single Docker
container — no runtime internet dependency.

![AXI4 3D Diagram](https://github.com/user-attachments/assets/7b91c7f7-82f1-460c-84f4-13252c4f73b0)

```
tb_top (testbench)
┌────────────────────────────────────────────────────────────────────┐
│  rst_n ────────────────────────────────────────────────── (TOP)   │
│                                                                    │
│  ┌───────────┐   AXI4 M→R   ┌────────────┐  AXI4 R→S ┌─────────┐ │
│  │           │ ────────────>│            │──────────> │         │ │
│  │  axi4_    │              │  axi4_     │            │  axi4_  │ │
│  │  master   │              │  repeater  │            │  slave  │ │
│  │           │              │            │            │         │ │
│  └───────────┘              └────────────┘            └─────────┘ │
│                                                                    │
│  clk ──────────────────────────────────────────────────── (BTM)   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Repository layout

```
.
├── metadata/
│   └── axi4_design.json    <- machine-readable design metadata (source of truth)
├── vendor/
│   └── three/              <- vendored Three.js r0.160.0 (checked in, no npm needed)
│       ├── build/three.module.js
│       └── examples/jsm/
│           ├── controls/OrbitControls.js
│           └── renderers/CSS2DRenderer.js
├── viewer/
│   ├── index.html          <- Three.js viewer entry point (importmap -> /vendor/)
│   ├── main.js             <- 3D scene code (ES modules, data-driven from JSON)
│   └── style.css           <- dark-theme styles + CSS2D label styles
├── Dockerfile              <- single-stage nginx build (no internet needed)
├── docker-compose.yml      <- one-command deploy
└── .dockerignore
```

---

## Quick start (Docker — recommended)

> **Requires:** Docker >= 20.10 and Docker Compose v2 (or `docker-compose` v1).

```bash
# 1. Clone the repository
git clone https://github.com/r987r/Diagram-gen.git
cd Diagram-gen

# 2. Build and start the container
docker compose up --build -d

# 3. Open the diagram in your browser
open http://localhost:8080
```

The container serves the viewer on **port 8080**. There is **no internet dependency**
at build or runtime — Three.js is pre-vendored in `vendor/` and copied into the image.

### Stop / rebuild

```bash
docker compose down                    # stop
docker compose up --build -d           # rebuild after any file change
```

---

## What is rendered

| Element | Visual |
|---|---|
| **AXI4 Master** (`u_master`) | Blue cube |
| **AXI4 Repeater** (`u_repeater`) | Purple cube |
| **AXI4 Slave** (`u_slave`) | Green cube |
| **tb_top testbench** | Dashed wireframe box surrounding all cubes |
| **CLK** (from `tb_top`) | Bright-green horizontal rail + vertical stub at the **bottom face** of each cube |
| **RST_N** (from `tb_top`) | Red horizontal rail + vertical stub at the **top face** of each cube |
| **AXI4 bus M→R** | Amber arrow from master to repeater |
| **AXI4 bus R→S** | Amber arrow from repeater to slave |

**Mouse controls:** left-drag to orbit · scroll to zoom · right-drag to pan.
Auto-rotation runs until you interact.

---

## Design metadata (`metadata/axi4_design.json`)

The JSON file is the single source of truth for both the 3D viewer and any downstream
scripting. It is deliberately flat and consistent so that `jq`, Python, or any other tool
can parse it without knowledge of the viewer.

### Top-level keys

| Key | Description |
|---|---|
| `design_name` | Identifier string |
| `version` | Semantic version |
| `description` | Human-readable summary |
| `parameters` | Bus parameters (`DATA_WIDTH`, `ADDR_WIDTH`, `ID_WIDTH`, `STRB_WIDTH`) |
| `testbench` | Top-level testbench module and its global signals |
| `modules` | Module definitions with full port lists |
| `instances` | Instance list with 3-D positions used by the viewer |
| `connections` | Net-level connections (clock, reset, AXI4 bus) |

### `modules[<name>].ports[]` fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Port name |
| `direction` | `"input"` or `"output"` | Signal direction |
| `width` | integer | Bit-width |
| `channel` | `"GLOBAL"` / `"AW"` / `"W"` / `"B"` / `"AR"` / `"R"` | AXI4 channel group |
| `side` | `"master"` or `"slave"` | Repeater side (repeater ports only) |
| `description` | string | Optional human-readable note |

### `connections[]` types

| `type` | Description |
|---|---|
| `"clock"` | `clk` fan-out from tb_top to all instances |
| `"reset"` | `rst_n` fan-out from tb_top to all instances |
| `"axi4_bus"` | Full AXI4 connection with per-channel signal maps and wire names |

### Scripting examples

**Python — list all wire names for the master-to-repeater connection:**

```python
import json

with open("metadata/axi4_design.json") as f:
    design = json.load(f)

conn = next(c for c in design["connections"] if c["id"] == "master_to_repeater")
for ch, sigs in conn["channel_signals"].items():
    for s in sigs:
        print(f"{ch:2s}  {s['wire']:20s}  {s['from_port']} -> {s['to_port']}")
```

**jq — list all instance names:**

```bash
jq -r '.instances[].instance_name' metadata/axi4_design.json
```

**jq — list every wire between repeater and slave:**

```bash
jq -r '
  .connections[]
  | select(.id == "repeater_to_slave")
  | .channel_signals[][]
  | .wire
' metadata/axi4_design.json
```

---

## How the Docker build works

```
Dockerfile (single stage — nginx:alpine):
  COPY viewer/          -> /usr/share/nginx/html/
  COPY metadata/        -> /usr/share/nginx/html/metadata/
  COPY vendor/          -> /usr/share/nginx/html/vendor/
  EXPOSE 80
```

`viewer/index.html` contains an `importmap` that maps the bare ES-module specifiers
`"three"` and `"three/addons/"` to the local `/vendor/three/…` paths, so the browser
loads Three.js entirely from the container:

```json
{
  "imports": {
    "three":         "/vendor/three/build/three.module.js",
    "three/addons/": "/vendor/three/examples/jsm/"
  }
}
```

The vendored files (`vendor/`) are committed to this repository. They were extracted
from `three@0.160.0` via `npm install three@0.160.0` and only the three files actually
imported by the viewer were kept:

| File | Size |
|---|---|
| `vendor/three/build/three.module.js` | ~1.3 MB |
| `vendor/three/examples/jsm/controls/OrbitControls.js` | ~30 KB |
| `vendor/three/examples/jsm/renderers/CSS2DRenderer.js` | ~4 KB |

---

## AXI4 signal reference

| Channel | Key signals | Direction (master view) |
|---|---|---|
| Write Address (AW) | AWID, AWADDR, AWLEN, AWSIZE, AWBURST, AWVALID, AWREADY | M -> S |
| Write Data (W) | WDATA, WSTRB, WLAST, WVALID, WREADY | M -> S |
| Write Response (B) | BID, BRESP, BVALID, BREADY | S -> M |
| Read Address (AR) | ARID, ARADDR, ARLEN, ARSIZE, ARBURST, ARVALID, ARREADY | M -> S |
| Read Data (R) | RID, RDATA, RRESP, RLAST, RVALID, RREADY | S -> M |

Parameters: `DATA_WIDTH=64`, `ADDR_WIDTH=32`, `ID_WIDTH=4`, `STRB_WIDTH=8`.

---

## Development (without Docker)

The viewer requires a local HTTP server because browsers block `fetch()` from `file://` URLs.

```bash
# Copy metadata next to the viewer files, then serve with Python
cp -r metadata viewer/
python3 -m http.server 8080 --directory viewer
open http://localhost:8080
```

---

## Modifying the diagram

1. **Add or move an instance** — edit `instances[]` in `axi4_design.json`.
   `position.x` places it on the horizontal axis; the viewer reads it directly.

2. **Change a colour** — edit `modules.<name>.render.color` (CSS hex string).

3. **Add a new AXI4 bus** — add a `"type": "axi4_bus"` entry to `connections[]`
   with matching `from_instance` / `to_instance` names.

4. **Rebuild** — `docker compose up --build -d` (seconds, no network needed).
