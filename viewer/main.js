/* ═══════════════════════════════════════════════════════════════════
   AXI4 3D Diagram Viewer — main.js
   Reads a design JSON and builds a Three.js scene showing:
     • One coloured cube per instance
     • CLK connections entering the BOTTOM of every cube (green)
     • RST_N connections entering the TOP of every cube (red)
     • AXI4 bus arrows between the cubes (amber)
     • A dashed wireframe box for the tb_top testbench
   Click any cube or bus arrow for details in the info popup.
   ═══════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { OrbitControls }                       from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject }          from 'three/addons/renderers/CSS2DRenderer.js';

// ── Constants ────────────────────────────────────────────────────────
const CUBE      = 3;          // cube side length
const HALF      = CUBE / 2;
const CLK_COL   = 0x00E676;   // bright green
const RST_COL   = 0xFF5252;   // red
const AXI4_COL  = 0xFFC107;   // amber
const TB_COL    = 0x546E7A;   // blue-grey
const BG_COL    = 0x0d0d1a;   // deep navy
const CAM_AUTO_FIT = 20;      // scene size threshold for auto camera refit

// ── Scene ────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COL);
scene.fog = new THREE.FogExp2(BG_COL, 0.008);

// ── Camera ───────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 600
);
camera.position.set(0, 13, 30);

// ── WebGL Renderer ───────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

// ── CSS2D Renderer (HTML labels in 3D space) ─────────────────────────
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(labelRenderer.domElement.style, {
  position:      'absolute',
  top:           '0px',
  pointerEvents: 'none',
});
document.body.appendChild(labelRenderer.domElement);

// ── Orbit Controls ───────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.06;
controls.autoRotate       = true;
controls.autoRotateSpeed  = 0.4;
controls.minDistance      = 8;
controls.maxDistance      = 200;
controls.target.set(0, 0, 0);

// ── Lights ───────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(12, 20, 10);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x4488ff, 0.25);
fill.position.set(-12, -6, -10);
scene.add(fill);

// ── Ground grid ──────────────────────────────────────────────────────
const grid = new THREE.GridHelper(200, 100, 0x1a1a3a, 0x1a1a3a);
grid.position.y = -5.5;
scene.add(grid);

// ── Raycaster for click detection ────────────────────────────────────
const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 0.5 };
const pointer = new THREE.Vector2();

// Clickable objects and their metadata
const clickableObjects = [];  // array of THREE.Object3D
const objectMeta = new Map(); // Object3D → { type, data }

// Currently highlighted selection (added to scene, removed on deselect)
let currentHighlight = null;

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Create a CSS2DObject from an HTML string. */
function makeLabel(html, className) {
  const div = document.createElement('div');
  div.className = className || '';
  div.innerHTML = html;
  return new CSS2DObject(div);
}

/** Solid line through an array of [x,y,z] tuples. */
function solidLine(pts, color) {
  const geo = new THREE.BufferGeometry().setFromPoints(
    pts.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  );
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
}

/** Dashed line through an array of [x,y,z] tuples. */
function dashedLine(pts, color) {
  const geo = new THREE.BufferGeometry().setFromPoints(
    pts.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  );
  const mat = new THREE.LineDashedMaterial({ color, dashSize: 0.45, gapSize: 0.2 });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  return line;
}

/** THREE.ArrowHelper from [x,y,z] to [x,y,z]. */
function arrow(from, to, color) {
  const origin = new THREE.Vector3(...from);
  const dir    = new THREE.Vector3(...to).sub(origin);
  const len    = dir.length();
  dir.normalize();
  return new THREE.ArrowHelper(dir, origin, len, color, 0.55, 0.38);
}

/** Draw an orthogonal polyline path with an arrowhead at the end.
 *  `pts` is an array of [x,y,z] waypoints (minimum 2). */
function arrowPath(pts, color) {
  const group = new THREE.Group();
  // Draw line segments
  group.add(solidLine(pts, color));
  // Arrowhead cone at the final point
  const last = new THREE.Vector3(...pts[pts.length - 1]);
  const prev = new THREE.Vector3(...pts[pts.length - 2]);
  const dir  = last.clone().sub(prev).normalize();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.19, 0.55, 8),
    new THREE.MeshBasicMaterial({ color })
  );
  cone.position.copy(last);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  group.add(cone);
  return group;
}

/** Small sphere dot at a port. */
function portDot(pos, color, r = 0.18) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 10, 10),
    new THREE.MeshBasicMaterial({ color })
  );
  m.position.set(...pos);
  return m;
}

/** Dashed wireframe box centred at cx,cy,cz with given w,h,d. */
function dashedBox(cx, cy, cz, w, h, d, color) {
  const geo   = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(geo);
  const mat   = new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.25 });
  const ls    = new THREE.LineSegments(edges, mat);
  ls.computeLineDistances();
  ls.position.set(cx, cy, cz);
  return ls;
}

/** Coloured block with white wireframe edges and a floating label.
 *  Supports cuboid shapes via `renderSize` { w, h, d } or uniform `scale`.
 *  `scale` multiplies the default CUBE size (1 = normal, >1 = bigger).
 *  When `compact` is true, only the instance name is shown (no module name). */
function instanceCube(inst, hexColor, scale = 1, renderSize = null, compact = false) {
  const group = new THREE.Group();
  const w = renderSize?.w ?? CUBE * scale;
  const h = renderSize?.h ?? CUBE * scale;
  const d = renderSize?.d ?? CUBE * scale;
  const halfW = w / 2;
  const halfH = h / 2;

  // Solid face
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshLambertMaterial({
    color: hexColor, transparent: true, opacity: 0.82,
  });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // White wireframe edges
  const edges = new THREE.EdgesGeometry(geo);
  group.add(new THREE.LineSegments(
    edges, new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1.5 })
  ));

  // Floating label above the block
  const modLine = compact ? '' : `<div class="mod-name">(${inst.module})</div>`;
  const label = makeLabel(
    `<div class="inst-name">${inst.instance_name}</div>` + modLine,
    'cube-label'
  );
  label.position.set(0, halfH + 0.5, 0);
  group.add(label);

  group.position.set(inst.position.x, inst.position.y, inst.position.z);
  group.userData.cubeHalf  = halfW;      // expose for connection wiring (x-extent)
  group.userData.cubeHalfH = halfH;      // y-extent
  return group;
}

/** Invisible hit-target cylinder along an arrow path (for easier click). */
function busHitZone(from, to) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(0.4, 0.4, len, 8, 1);
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(mid);
  // Rotate cylinder to align with the arrow direction
  const dir = b.clone().sub(a).normalize();
  const up  = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  mesh.quaternion.copy(quat);
  return mesh;
}

/** Check if an axis-aligned segment (x1,y1)→(x2,y2) intersects a box
 *  centred at (bx,by) with half-extents (bhx,bhy), expanded by pad. */
function segHitsBox(x1, y1, x2, y2, bx, by, bhx, bhy, pad) {
  const l = bx - bhx - pad, r = bx + bhx + pad;
  const b = by - bhy - pad, t = by + bhy + pad;
  return Math.min(x1, x2) < r && Math.max(x1, x2) > l &&
         Math.min(y1, y2) < t && Math.max(y1, y2) > b;
}

/** Compute an L-shaped orthogonal route that avoids obstacle boxes.
 *  Returns array of [x,y,z] waypoints. */
function routeConnection(fromX, fromY, toX, toY, exitHorizontal, obstacles) {
  const PAD = 0.5;
  const aligned = (Math.abs(fromX - toX) < 0.01) || (Math.abs(fromY - toY) < 0.01);

  if (aligned) {
    const blocked = obstacles.some(o =>
      segHitsBox(fromX, fromY, toX, toY, o.x, o.y, o.hw, o.hh, PAD));
    if (!blocked) return [[fromX, fromY, 0], [toX, toY, 0]];
    // Detour around obstacles
    if (Math.abs(fromY - toY) < 0.01) {
      for (const sign of [1, -1]) {
        const dy = fromY + sign * 3;
        if (!obstacles.some(o => segHitsBox(fromX, dy, toX, dy, o.x, o.y, o.hw, o.hh, PAD)))
          return [[fromX, fromY, 0], [fromX, dy, 0], [toX, dy, 0], [toX, toY, 0]];
      }
    } else {
      for (const sign of [1, -1]) {
        const dx = fromX + sign * 3;
        if (!obstacles.some(o => segHitsBox(dx, fromY, dx, toY, o.x, o.y, o.hw, o.hh, PAD)))
          return [[fromX, fromY, 0], [dx, fromY, 0], [dx, toY, 0], [toX, toY, 0]];
      }
    }
    return [[fromX, fromY, 0], [toX, toY, 0]]; // fallback
  }

  if (exitHorizontal) {
    let cornerX = (fromX + toX) / 2;
    const isBlocked = (cx) => obstacles.some(o =>
      segHitsBox(cx, Math.min(fromY, toY), cx, Math.max(fromY, toY), o.x, o.y, o.hw, o.hh, PAD));
    if (isBlocked(cornerX)) {
      const cands = [];
      for (const o of obstacles) {
        cands.push(o.x - o.hw - PAD - 0.5);
        cands.push(o.x + o.hw + PAD + 0.5);
      }
      cands.sort((a, b) => Math.abs(a - cornerX) - Math.abs(b - cornerX));
      for (const cx of cands) { if (!isBlocked(cx)) { cornerX = cx; break; } }
    }
    return [[fromX, fromY, 0], [cornerX, fromY, 0], [cornerX, toY, 0], [toX, toY, 0]];
  }

  // Vertical first
  let cornerY = (fromY + toY) / 2;
  const isBlocked = (cy) => obstacles.some(o =>
    segHitsBox(Math.min(fromX, toX), cy, Math.max(fromX, toX), cy, o.x, o.y, o.hw, o.hh, PAD));
  if (isBlocked(cornerY)) {
    const cands = [];
    for (const o of obstacles) {
      cands.push(o.y - o.hh - PAD - 0.5);
      cands.push(o.y + o.hh + PAD + 0.5);
    }
    cands.sort((a, b) => Math.abs(a - cornerY) - Math.abs(b - cornerY));
    for (const cy of cands) { if (!isBlocked(cy)) { cornerY = cy; break; } }
  }
  return [[fromX, fromY, 0], [fromX, cornerY, 0], [toX, cornerY, 0], [toX, toY, 0]];
}

// ═══════════════════════════════════════════════════════════════════
// Info Popup
// ═══════════════════════════════════════════════════════════════════
const popup      = document.getElementById('info-popup');
const popupBody  = document.getElementById('popup-body');
const popupHint  = popup.querySelector('.popup-hint');
const popupToggle = document.getElementById('popup-toggle');
const popupHandle = document.getElementById('popup-handle');

let popupExpanded = false;

function expandPopup() {
  popup.classList.remove('collapsed');
  popup.classList.add('expanded');
  popupExpanded = true;
}

function collapsePopup() {
  popup.classList.remove('expanded');
  popup.classList.add('collapsed');
  popupExpanded = false;
}

popupHandle.addEventListener('click', () => {
  if (popupExpanded) collapsePopup();
  else expandPopup();
});

/** Show instance info in the popup. */
function showInstanceInfo(inst, mod) {
  let html = `<h3>${inst.instance_name}</h3>`;
  html += `<div class="info-module">${inst.module}</div>`;
  html += `<div class="info-desc">${mod?.description ?? inst.description ?? ''}</div>`;

  if (mod?.ports?.length) {
    // Group ports by channel
    const channels = {};
    for (const p of mod.ports) {
      const ch = p.channel || 'GLOBAL';
      if (!channels[ch]) channels[ch] = [];
      channels[ch].push(p);
    }

    for (const [ch, ports] of Object.entries(channels)) {
      html += `<div class="channel-group">`;
      html += `<div class="info-section-title">${ch} Channel</div>`;
      html += `<table><tr><th>Port</th><th>Dir</th><th>Width</th><th>Info</th></tr>`;
      for (const p of ports) {
        const dirClass = p.direction === 'input' ? 'port-dir-in' : 'port-dir-out';
        const dirLabel = p.direction === 'input' ? '→ in' : '← out';
        html += `<tr>`;
        html += `<td><code>${p.name}</code></td>`;
        html += `<td class="${dirClass}">${dirLabel}</td>`;
        html += `<td>${p.width}</td>`;
        html += `<td>${p.description ?? ''}</td>`;
        html += `</tr>`;
      }
      html += `</table></div>`;
    }
  }

  popupBody.innerHTML = html;
  popupHint.textContent = inst.instance_name;
  expandPopup();
}

/** Show connection info in the popup. */
function showConnectionInfo(conn) {
  let html = `<h3>${conn.label || conn.id}</h3>`;
  html += `<div class="info-module">${conn.from_instance} → ${conn.to_instance}</div>`;
  html += `<div class="info-desc">${conn.description ?? ''}</div>`;

  if (conn.channel_signals) {
    for (const [ch, signals] of Object.entries(conn.channel_signals)) {
      html += `<div class="channel-group">`;
      html += `<div class="channel-name">${ch} Channel</div>`;
      html += `<table><tr><th>From Port</th><th>Wire</th><th>To Port</th></tr>`;
      for (const sig of signals) {
        html += `<tr>`;
        html += `<td><code>${sig.from_port}</code></td>`;
        html += `<td><code>${sig.wire}</code></td>`;
        html += `<td><code>${sig.to_port}</code></td>`;
        html += `</tr>`;
      }
      html += `</table></div>`;
    }
  }

  popupBody.innerHTML = html;
  popupHint.textContent = conn.label || conn.id;
  expandPopup();
}

/** Show group info in the popup. */
function showGroupInfo(grp) {
  let html = `<h3>${grp.label || grp.name}</h3>`;
  html += `<div class="info-desc">${grp.description ?? ''}</div>`;
  if (grp.members?.length) {
    html += `<div class="info-section-title">Members</div><ul>`;
    for (const m of grp.members) {
      html += `<li><code>${m}</code></li>`;
    }
    html += `</ul>`;
  }
  popupBody.innerHTML = html;
  popupHint.textContent = grp.label || grp.name;
  expandPopup();
}

// ═══════════════════════════════════════════════════════════════════
// Selection highlight (bright outline around clicked box / connection)
// ═══════════════════════════════════════════════════════════════════

/** Remove the current highlight overlay from the scene. */
function clearHighlight() {
  if (currentHighlight) {
    currentHighlight.traverse(c => {
      c.geometry?.dispose();
      c.material?.dispose();
    });
    scene.remove(currentHighlight);
    currentHighlight = null;
  }
}

/** Add a bright outline around a clicked instance. */
function highlightInstance(meta) {
  clearHighlight();
  const inst = meta.instance;
  const hw = meta.halfW ?? HALF;
  const hh = meta.halfH ?? HALF;
  const d  = meta.module?.render?.size?.d ?? CUBE;
  const group = new THREE.Group();
  const pad = 0.3;

  // Bright wireframe outline (slightly larger than the cube)
  const geo   = new THREE.BoxGeometry((hw + pad) * 2, (hh + pad) * 2, d + pad * 2);
  const edges = new THREE.EdgesGeometry(geo);
  const outline = new THREE.LineSegments(
    edges, new THREE.LineBasicMaterial({ color: 0xffffff })
  );
  outline.position.set(inst.position.x, inst.position.y, inst.position.z);
  group.add(outline);

  // Semi-transparent glow shell
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry((hw + pad) * 2, (hh + pad) * 2, d + pad * 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.10, side: THREE.BackSide })
  );
  shell.position.set(inst.position.x, inst.position.y, inst.position.z);
  group.add(shell);

  scene.add(group);
  currentHighlight = group;
}

/** Add a thick glow tube along a clicked connection path. */
function highlightConnection(meta) {
  clearHighlight();
  const pts = meta.routePts;
  if (!pts || pts.length < 2) return;

  const group = new THREE.Group();
  for (let i = 0; i < pts.length - 1; i++) {
    const a   = new THREE.Vector3(...pts[i]);
    const b   = new THREE.Vector3(...pts[i + 1]);
    const len = a.distanceTo(b);
    if (len < 0.01) continue;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).normalize();
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, len, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })
    );
    tube.position.copy(mid);
    tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(tube);
  }
  scene.add(group);
  currentHighlight = group;
}

// ═══════════════════════════════════════════════════════════════════
// Overview overlay
// ═══════════════════════════════════════════════════════════════════
const overviewOverlay = document.getElementById('overview-overlay');
const btnOverview = document.getElementById('btn-overview');

btnOverview.addEventListener('click', () => {
  overviewOverlay.classList.toggle('hidden');
});

// Close overlay on backdrop click or close button
overviewOverlay.addEventListener('click', (e) => {
  if (e.target === overviewOverlay || e.target.dataset.close) {
    overviewOverlay.classList.add('hidden');
  }
});

// ═══════════════════════════════════════════════════════════════════
// Click handling (raycasting)
// ═══════════════════════════════════════════════════════════════════
let pointerDownPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  // Only treat as click if pointer didn't move much (not a drag)
  if (Math.sqrt(dx * dx + dy * dy) > 5) return;

  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(clickableObjects, true);
  if (hits.length > 0) {
    // Walk up to find the registered clickable object
    let obj = hits[0].object;
    while (obj && !objectMeta.has(obj)) {
      obj = obj.parent;
    }
    if (obj && objectMeta.has(obj)) {
      const meta = objectMeta.get(obj);
      if (meta.type === 'instance') {
        showInstanceInfo(meta.instance, meta.module);
        highlightInstance(meta);
      } else if (meta.type === 'connection') {
        showConnectionInfo(meta.connection);
        highlightConnection(meta);
      } else if (meta.type === 'group') {
        showGroupInfo(meta.group);
        clearHighlight();
      }
    }
  } else {
    clearHighlight();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Main build — reads the JSON then populates the scene
// ═══════════════════════════════════════════════════════════════════

/** Clear all scene objects (except lights and grid) for design switching. */
function clearScene() {
  clearHighlight();
  const keep = new Set();
  scene.traverse((obj) => {
    if (obj instanceof THREE.Light || obj === grid || obj === scene) keep.add(obj);
  });
  const toRemove = [];
  for (const child of scene.children) {
    if (!keep.has(child)) toRemove.push(child);
  }
  for (const obj of toRemove) {
    // Remove CSS2D label DOM elements
    obj.traverse?.((c) => {
      if (c instanceof CSS2DObject && c.element?.parentNode) {
        c.element.parentNode.removeChild(c.element);
      }
      c.geometry?.dispose();
      c.material?.dispose?.();
    });
    scene.remove(obj);
  }
  clickableObjects.length = 0;
  objectMeta.clear();
}

// ═══════════════════════════════════════════════════════════════════
// Resolve hierarchical includes: blocks → sub-blocks → leaf blocks
// ═══════════════════════════════════════════════════════════════════

/**
 * Recursively resolve a design/block JSON that may contain an `includes`
 * array referencing other block JSONs.  Each included file can itself
 * contain `includes`, forming a tree.
 *
 * Resolution rules (applied depth-first):
 *   1. Fetch every file listed in `includes`.
 *   2. Recursively resolve each included file.
 *   3. Merge included data into the parent:
 *        • Leaf blocks contribute their module definition
 *          (block_name → { description, render, ports }).
 *        • Composite blocks contribute modules, instances & connections.
 *   4. Inline `modules` in the parent override anything from includes
 *      (lets a design carry variant definitions).
 *
 * @param {string} jsonPath  Path to the JSON file (relative to site root).
 * @param {Set}    visited   Cycle guard – paths already being resolved.
 * @returns {object}  The fully-resolved design object.
 */
async function resolveDesign(jsonPath, visited = new Set()) {
  if (visited.has(jsonPath))
    throw new Error(`Circular include detected: ${jsonPath}`);
  visited.add(jsonPath);

  const resp = await fetch('./' + jsonPath);
  if (!resp.ok) throw new Error(`Cannot load ${jsonPath}: ${resp.status}`);
  const raw = await resp.json();

  // Determine the base directory for resolving relative include paths
  const baseDir = jsonPath.substring(0, jsonPath.lastIndexOf('/') + 1);

  // Containers that will accumulate data from includes
  const mergedModules     = {};
  const mergedInstances   = [];
  const mergedConnections = [];

  // ── Process includes (depth-first) ────────────────────────────
  if (Array.isArray(raw.includes)) {
    for (const incPath of raw.includes) {
      // Resolve path relative to parent directory
      const fullPath = baseDir + incPath;
      const child = await resolveDesign(fullPath, new Set(visited));

      // Leaf block: has block_name + ports → becomes a module
      if (child.block_name && child.ports) {
        mergedModules[child.block_name] = {
          description: child.description || '',
          render:      child.render || {},
          ports:       child.ports,
        };
      }

      // Merge child modules (from composite blocks or other designs)
      if (child.modules) {
        Object.assign(mergedModules, child.modules);
      }

      // Merge child instances & connections (composite blocks)
      if (Array.isArray(child.instances)) {
        mergedInstances.push(...child.instances);
      }
      if (Array.isArray(child.connections)) {
        mergedConnections.push(...child.connections);
      }
    }
  }

  // ── Build resolved design ─────────────────────────────────────
  // Inline modules override includes (design-specific variants)
  const resolvedModules = Object.assign(mergedModules, raw.modules || {});

  // Concatenate: included instances first, then any defined at this level
  const resolvedInstances = mergedInstances.concat(raw.instances || []);

  // Concatenate: included connections first, then this level's connections
  const resolvedConnections = mergedConnections.concat(raw.connections || []);

  // Return a fully-resolved object keeping all original top-level keys
  return Object.assign({}, raw, {
    modules:     resolvedModules,
    instances:   resolvedInstances,
    connections: resolvedConnections,
  });
}

// ── Loading overlay control ──────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');
function showLoading() { loadingOverlay.classList.remove('hidden'); }
function hideLoading() { loadingOverlay.classList.add('hidden'); }

async function buildScene(designPath) {
  showLoading();
  clearScene();

  const design = await resolveDesign(designPath);

  // ── Module → hex colour map ────────────────────────────────────
  const moduleColor = {};
  for (const [name, def] of Object.entries(design.modules)) {
    moduleColor[name] = parseInt(def.render.color.replace('#', ''), 16);
  }

  const instances = design.instances;

  // ── Compute fan-out per instance (number of bus connections) ───
  const fanOut = {};
  for (const inst of instances) fanOut[inst.instance_name] = 0;
  for (const conn of design.connections) {
    if (conn.type === 'clock' || conn.type === 'reset') continue;
    if (conn.from_instance && fanOut[conn.from_instance] !== undefined) fanOut[conn.from_instance]++;
    if (conn.to_instance   && fanOut[conn.to_instance]   !== undefined) fanOut[conn.to_instance]++;
  }
  const maxFan = Math.max(1, ...Object.values(fanOut));

  // Scale: 1× for fan-out ≤ 1, up to 2× for the highest fan-out.
  // A module-level render.scale in the JSON overrides this.
  function scaleFor(inst) {
    const mod = design.modules[inst.module];
    if (mod?.render?.scale) return mod.render.scale;
    const f = fanOut[inst.instance_name] || 0;
    if (f <= 1 || maxFan <= 1) return 1;
    return 1 + (f - 1) / (maxFan - 1);   // linear interpolation: f=1→1.0, f=maxFan→2.0
  }

  // Map instance name → its cube half-size for wiring
  const instHalf = {};

  // ── Instance cubes / cuboids ────────────────────────────────────
  // Hide module name labels when many instances (reduces clutter)
  const compact = instances.length > 12;
  const instHalfH = {};   // y-extent per instance
  for (const inst of instances) {
    const s = scaleFor(inst);
    const mod = design.modules[inst.module];
    const renderSize = mod?.render?.size ?? null;   // { w, h, d } for cuboid
    const cubeGroup = instanceCube(inst, moduleColor[inst.module] ?? 0x888888, s, renderSize, compact);
    scene.add(cubeGroup);
    instHalf[inst.instance_name]  = cubeGroup.userData.cubeHalf;
    instHalfH[inst.instance_name] = cubeGroup.userData.cubeHalfH ?? cubeGroup.userData.cubeHalf;

    // Register for click detection
    clickableObjects.push(cubeGroup);
    objectMeta.set(cubeGroup, {
      type: 'instance',
      instance: inst,
      module: design.modules[inst.module],
      halfW: cubeGroup.userData.cubeHalf,
      halfH: cubeGroup.userData.cubeHalfH ?? cubeGroup.userData.cubeHalf,
    });
  }

  // ── Encapsulation groups (dashed wireframe cuboids around children) ──
  if (Array.isArray(design.groups)) {
    for (const grp of design.groups) {
      // Compute bounding box of member instances
      const members = instances.filter(i => grp.members.includes(i.instance_name));
      if (members.length === 0) continue;

      let gxMin = Infinity, gxMax = -Infinity;
      let gyMin = Infinity, gyMax = -Infinity;
      let gzMin = Infinity, gzMax = -Infinity;
      for (const m of members) {
        const hx = instHalf[m.instance_name]  || HALF;
        const hy = instHalfH[m.instance_name] || HALF;
        gxMin = Math.min(gxMin, m.position.x - hx);
        gxMax = Math.max(gxMax, m.position.x + hx);
        gyMin = Math.min(gyMin, m.position.y - hy);
        gyMax = Math.max(gyMax, m.position.y + hy);
        gzMin = Math.min(gzMin, m.position.z - HALF);
        gzMax = Math.max(gzMax, m.position.z + HALF);
      }

      const pad = grp.padding ?? 1.2;
      gxMin -= pad; gxMax += pad;
      gyMin -= pad; gyMax += pad;
      gzMin -= pad; gzMax += pad;

      const gw = gxMax - gxMin;
      const gh = gyMax - gyMin;
      const gd = gzMax - gzMin;
      const gcx = (gxMin + gxMax) / 2;
      const gcy = (gyMin + gyMax) / 2;
      const gcz = (gzMin + gzMax) / 2;

      const grpColor = parseInt((grp.color || '#42A5F5').replace('#', ''), 16);
      const box = dashedBox(gcx, gcy, gcz, gw, gh, gd, grpColor);
      scene.add(box);

      // Group label
      const grpLabel = makeLabel(
        `<span class="group-label-text">${grp.label || grp.name}</span>`,
        'group-label-obj'
      );
      grpLabel.position.set(gxMin + 0.6, gyMax + 0.4, gcz);
      scene.add(grpLabel);

      // Make group clickable
      clickableObjects.push(box);
      objectMeta.set(box, {
        type: 'group',
        group: grp,
      });
    }
  }

  // ── Geometry helpers (use per-instance half for extents) ───────
  // Requires at least one instance; designs without instances have nothing to render.
  if (instances.length === 0) return;

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const inst of instances) {
    const hx = instHalf[inst.instance_name];
    const hy = instHalfH[inst.instance_name] || hx;
    xMin = Math.min(xMin, inst.position.x - hx);
    xMax = Math.max(xMax, inst.position.x + hx);
    yMin = Math.min(yMin, inst.position.y - hy);
    yMax = Math.max(yMax, inst.position.y + hy);
  }

  const clkY    = yMin - 1.8;            // horizontal CLK rail Y
  const rstY    = yMax + 1.8;            // horizontal RST rail Y
  const railL   = xMin - 1.5;
  const railR   = xMax + 1.5;

  // ── CLK horizontal rail ────────────────────────────────────────
  scene.add(solidLine([[railL, clkY, 0], [railR, clkY, 0]], CLK_COL));

  const clkLabel = makeLabel(
    '<span class="rail-label clk-text">clk ← tb_top</span>', 'rail-label-obj'
  );
  clkLabel.position.set(railL - 0.3, clkY, 0);
  scene.add(clkLabel);

  // ── RST horizontal rail ────────────────────────────────────────
  scene.add(solidLine([[railL, rstY, 0], [railR, rstY, 0]], RST_COL));

  const rstLabel = makeLabel(
    '<span class="rail-label rst-text">rst_n ← tb_top</span>', 'rail-label-obj'
  );
  rstLabel.position.set(railL - 0.3, rstY, 0);
  scene.add(rstLabel);

  // ── Build set of instances in clock/reset fanout ────────────
  const clkInstances = new Set();
  const rstInstances = new Set();
  for (const conn of design.connections) {
    if (conn.type === 'clock') {
      for (const t of (conn.to || [])) clkInstances.add(t.instance);
    } else if (conn.type === 'reset') {
      for (const t of (conn.to || [])) rstInstances.add(t.instance);
    }
  }

  // ── Per-instance CLK and RST stubs (only for instances in fanout) ─
  for (const inst of instances) {
    const x = inst.position.x;
    const y = inst.position.y;
    const hy = instHalfH[inst.instance_name] || instHalf[inst.instance_name];

    if (clkInstances.has(inst.instance_name)) {
      scene.add(solidLine([[x, y - hy, 0], [x, clkY, 0]], CLK_COL));
      scene.add(portDot([x, y - hy, 0], CLK_COL));
    }

    if (rstInstances.has(inst.instance_name)) {
      scene.add(solidLine([[x, y + hy, 0], [x, rstY, 0]], RST_COL));
      scene.add(portDot([x, y + hy, 0], RST_COL));
    }
  }

  // ── Bus / TLM connections ────────────────────────────────────
  // Build a colour lookup from optional design.connection_types,
  // falling back to AXI4_COL for any unlisted type.
  const connColor = {};
  if (design.connection_types) {
    for (const [t, def] of Object.entries(design.connection_types)) {
      connColor[t] = parseInt(def.color.replace('#', ''), 16);
    }
  }

  // Hide bus labels when there are many connections to reduce clutter
  const busConns = design.connections.filter(c => c.type !== 'clock' && c.type !== 'reset');
  const showBusLabels = busConns.length <= 20;

  // Precompute obstacle data for all instances (used for routing)
  const allObstacles = instances.map(i => ({
    name: i.instance_name,
    x: i.position.x, y: i.position.y,
    hw: instHalf[i.instance_name] || HALF,
    hh: instHalfH[i.instance_name] || HALF,
  }));

  for (const conn of design.connections) {
    if (conn.type === 'clock' || conn.type === 'reset') continue;

    const fromInst = instances.find(i => i.instance_name === conn.from_instance);
    const toInst   = instances.find(i => i.instance_name === conn.to_instance);
    if (!fromInst || !toInst) continue;

    const fromH = instHalf[conn.from_instance] || HALF;
    const toH   = instHalf[conn.to_instance]   || HALF;

    // Compute arrow endpoints: choose exit face based on relative position
    const dx = toInst.position.x - fromInst.position.x;
    const dy = toInst.position.y - fromInst.position.y;
    let fromX, fromY, toX, toY;
    let exitHorizontal;

    if (Math.abs(dx) >= Math.abs(dy)) {
      // Horizontal connection (exit from left/right face)
      exitHorizontal = true;
      fromX = fromInst.position.x + (dx >= 0 ? fromH : -fromH);
      fromY = fromInst.position.y;
      toX   = toInst.position.x   + (dx >= 0 ? -toH  :  toH);
      toY   = toInst.position.y;
    } else {
      // Vertical connection (exit from top/bottom face)
      exitHorizontal = false;
      const fromHy = instHalfH[conn.from_instance] || HALF;
      const toHy   = instHalfH[conn.to_instance]   || HALF;
      fromX = fromInst.position.x;
      fromY = fromInst.position.y + (dy >= 0 ? fromHy : -fromHy);
      toX   = toInst.position.x;
      toY   = toInst.position.y   + (dy >= 0 ? -toHy  :  toHy);
    }

    const col = connColor[conn.type] ?? AXI4_COL;

    // Build route points: L-shaped routing that avoids unconnected boxes
    const obstacles = allObstacles.filter(
      o => o.name !== conn.from_instance && o.name !== conn.to_instance
    );
    const routePts = routeConnection(fromX, fromY, toX, toY, exitHorizontal, obstacles);

    // Draw connection with arrowhead
    if (routePts.length === 2) {
      scene.add(arrow(routePts[0], routePts[1], col));
    } else {
      scene.add(arrowPath(routePts, col));
    }

    // Port dots
    scene.add(portDot([fromX, fromY, 0], col, 0.16));
    scene.add(portDot([toX,   toY, 0], col, 0.16));

    // Bus label (only for small designs)
    const midX  = (fromX + toX) / 2;
    const midY  = (fromY + toY) / 2;
    if (showBusLabels && conn.label) {
      const busLabel = makeLabel(
        `<span class="bus-label-text">${conn.label}</span>`, 'bus-label-obj'
      );
      busLabel.position.set(midX, midY + 0.9, 0);
      scene.add(busLabel);
    }

    // Invisible hit zones for click detection (one per route segment)
    for (let i = 0; i < routePts.length - 1; i++) {
      const segLen = Math.hypot(
        routePts[i + 1][0] - routePts[i][0],
        routePts[i + 1][1] - routePts[i][1],
        routePts[i + 1][2] - routePts[i][2]);
      if (segLen < 0.01) continue;
      const hitZone = busHitZone(routePts[i], routePts[i + 1]);
      scene.add(hitZone);
      clickableObjects.push(hitZone);
      objectMeta.set(hitZone, { type: 'connection', connection: conn, routePts });
    }
  }

  // ── Testbench (tb_top) wireframe ──────────────────────────────
  const tbL  = railL  - 1;
  const tbR  = railR  + 1;
  const tbB  = clkY   - 1;
  const tbT  = rstY   + 1;
  const tbZ  = 3.5;

  const tbCX = (tbL + tbR) / 2;
  const tbCY = (tbB + tbT) / 2;
  const tbW  = tbR - tbL;
  const tbH  = tbT - tbB;

  scene.add(dashedBox(tbCX, tbCY, 0, tbW, tbH, tbZ * 2, TB_COL));

  const tbLabel = makeLabel(
    '<span class="tb-label-text">tb_top</span>', 'tb-label-obj'
  );
  tbLabel.position.set(tbL + 0.8, tbT + 0.35, 0);
  scene.add(tbLabel);

  // ── Adjust camera for larger designs ──────────────────────────
  const sceneWidth  = (xMax - xMin) + 6;
  const sceneHeight = (rstY - clkY) + 4;
  const maxDim = Math.max(sceneWidth, sceneHeight);
  if (maxDim > CAM_AUTO_FIT) {
    camera.position.set(tbCX, tbCY + maxDim * 0.5, maxDim * 1.5);
    controls.target.set(tbCX, tbCY, 0);
    controls.update();
  }

  // ── Populate overview overlay ─────────────────────────────────
  document.getElementById('panel-design-name').textContent = design.design_name;
  document.getElementById('panel-desc').textContent        = design.description;

  // Title bar
  document.getElementById('design-title').textContent = design.design_name;
  document.getElementById('design-subtitle').textContent = design.description.split('.')[0];

  const instList = document.getElementById('instance-list');
  instList.innerHTML = '';
  for (const inst of instances) {
    const mod = design.modules[inst.module];
    const li  = document.createElement('li');
    li.style.borderLeftColor = mod?.render?.color ?? '#888';
    li.innerHTML =
      `<strong>${inst.instance_name}</strong><br>` +
      `<em>${inst.module}</em><br>` +
      `<small>${mod?.description ?? ''}</small>`;
    li.addEventListener('click', () => {
      showInstanceInfo(inst, mod);
      overviewOverlay.classList.add('hidden');
    });
    instList.appendChild(li);
  }

  // Build legend dynamically from modules + testbench signals
  const legendList = document.getElementById('legend');
  legendList.innerHTML = '';

  // CLK and RST from testbench
  for (const sig of (design.testbench?.global_signals ?? [])) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${sig.render.color}"></span> ${sig.name.toUpperCase()} (${sig.render.face} of cube)`;
    legendList.appendChild(li);
  }

  // Connection types (from config or default AXI4)
  if (design.connection_types) {
    for (const [t, def] of Object.entries(design.connection_types)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot" style="background:${def.color}"></span> ${def.description || t}`;
      legendList.appendChild(li);
    }
  } else {
    const busLi = document.createElement('li');
    busLi.innerHTML = `<span class="dot" style="background:#FFC107"></span> AXI4 Bus`;
    legendList.appendChild(busLi);
  }

  // Modules
  for (const [name, mod] of Object.entries(design.modules)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${mod.render.color}"></span> ${name}`;
    legendList.appendChild(li);
  }

  // Testbench
  const tbLi = document.createElement('li');
  tbLi.innerHTML = `<span class="dot" style="background:#546E7A; outline:1px dashed #546E7A"></span> tb_top (testbench)`;
  legendList.appendChild(tbLi);

  const paramTable = document.getElementById('param-table');
  paramTable.innerHTML = '';
  for (const [k, v] of Object.entries(design.parameters)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="pk">${k}</td><td class="pv">${v}</td>`;
    paramTable.appendChild(tr);
  }

  // Reset popup
  popupBody.innerHTML = '';
  popupHint.textContent = 'Click a box or connection for details';
  collapsePopup();
  hideLoading();
}

// ═══════════════════════════════════════════════════════════════════
// Design selector
// ═══════════════════════════════════════════════════════════════════
const designSelect = document.getElementById('design-select');
designSelect.addEventListener('change', () => {
  buildScene(designSelect.value).catch(err => {
    console.error('buildScene failed:', err);
    document.getElementById('panel-design-name').textContent = '⚠ Load error';
    document.getElementById('panel-desc').textContent        = err.message;
    hideLoading();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Resize handler
// ═══════════════════════════════════════════════════════════════════
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ═══════════════════════════════════════════════════════════════════
// Animation loop
// ═══════════════════════════════════════════════════════════════════
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
})();

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════
buildScene(designSelect.value).catch(err => {
  console.error('buildScene failed:', err);
  document.getElementById('panel-design-name').textContent = '⚠ Load error';
  document.getElementById('panel-desc').textContent        = err.message;
  hideLoading();
});
