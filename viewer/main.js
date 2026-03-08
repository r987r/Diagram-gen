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

// ── Scene ────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COL);
scene.fog = new THREE.FogExp2(BG_COL, 0.018);

// ── Camera ───────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 300
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
controls.maxDistance      = 80;
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
const grid = new THREE.GridHelper(50, 50, 0x1a1a3a, 0x1a1a3a);
grid.position.y = -5.5;
scene.add(grid);

// ── Raycaster for click detection ────────────────────────────────────
const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 0.5 };
const pointer = new THREE.Vector2();

// Clickable objects and their metadata
const clickableObjects = [];  // array of THREE.Object3D
const objectMeta = new Map(); // Object3D → { type, data }

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

/** Coloured cube with white wireframe edges and a floating label. */
function instanceCube(inst, hexColor) {
  const group = new THREE.Group();

  // Solid face
  const geo = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
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

  // Floating label above the cube
  const label = makeLabel(
    `<div class="inst-name">${inst.instance_name}</div>` +
    `<div class="mod-name">(${inst.module})</div>`,
    'cube-label'
  );
  label.position.set(0, HALF + 0.5, 0);
  group.add(label);

  group.position.set(inst.position.x, inst.position.y, inst.position.z);
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
      } else if (meta.type === 'connection') {
        showConnectionInfo(meta.connection);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// Main build — reads the JSON then populates the scene
// ═══════════════════════════════════════════════════════════════════

/** Clear all scene objects (except lights and grid) for design switching. */
function clearScene() {
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

async function buildScene(designPath) {
  clearScene();

  const response = await fetch('./' + designPath);
  if (!response.ok) throw new Error(`Cannot load metadata: ${response.status}`);
  const design = await response.json();

  // ── Module → hex colour map ────────────────────────────────────
  const moduleColor = {};
  for (const [name, def] of Object.entries(design.modules)) {
    moduleColor[name] = parseInt(def.render.color.replace('#', ''), 16);
  }

  const instances = design.instances;

  // ── Instance cubes ─────────────────────────────────────────────
  for (const inst of instances) {
    const cubeGroup = instanceCube(inst, moduleColor[inst.module] ?? 0x888888);
    scene.add(cubeGroup);

    // Register for click detection
    clickableObjects.push(cubeGroup);
    objectMeta.set(cubeGroup, {
      type: 'instance',
      instance: inst,
      module: design.modules[inst.module],
    });
  }

  // ── Geometry helpers ───────────────────────────────────────────
  const xs      = instances.map(i => i.position.x);
  const ys      = instances.map(i => i.position.y);
  const xMin    = Math.min(...xs);
  const xMax    = Math.max(...xs);
  const yMin    = Math.min(...ys);
  const yMax    = Math.max(...ys);

  const clkY    = yMin - HALF - 1.8;   // horizontal CLK rail Y
  const rstY    = yMax + HALF + 1.8;   // horizontal RST rail Y
  const railL   = xMin - HALF - 1.5;
  const railR   = xMax + HALF + 1.5;

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

  // ── Per-instance CLK and RST stubs ────────────────────────────
  for (const inst of instances) {
    const x = inst.position.x;
    const y = inst.position.y;

    // CLK: bottom face of cube → CLK rail
    scene.add(solidLine([[x, y - HALF, 0], [x, clkY, 0]], CLK_COL));
    scene.add(portDot([x, y - HALF, 0], CLK_COL));

    // RST: top face of cube → RST rail
    scene.add(solidLine([[x, y + HALF, 0], [x, rstY, 0]], RST_COL));
    scene.add(portDot([x, y + HALF, 0], RST_COL));
  }

  // ── AXI4 bus connections ───────────────────────────────────────
  for (const conn of design.connections) {
    if (conn.type !== 'axi4_bus') continue;

    const fromInst = instances.find(i => i.instance_name === conn.from_instance);
    const toInst   = instances.find(i => i.instance_name === conn.to_instance);
    if (!fromInst || !toInst) continue;

    const fromX = fromInst.position.x + HALF;
    const toX   = toInst.position.x   - HALF;
    const fromY = fromInst.position.y;
    const toY   = toInst.position.y;
    const midX  = (fromX + toX) / 2;
    const midY  = (fromY + toY) / 2;
    const busY  = midY + 0.25;

    // Arrow
    scene.add(arrow([fromX, fromY + 0.25, 0], [toX, toY + 0.25, 0], AXI4_COL));

    // Port dots
    scene.add(portDot([fromX, fromY + 0.25, 0], AXI4_COL, 0.16));
    scene.add(portDot([toX,   toY + 0.25, 0], AXI4_COL, 0.16));

    // Bus label
    const busLabel = makeLabel(
      `<span class="bus-label-text">${conn.label}</span>`, 'bus-label-obj'
    );
    busLabel.position.set(midX, busY + 0.9, 0);
    scene.add(busLabel);

    // Invisible hit zone for click detection
    const hitZone = busHitZone(
      [fromX, fromY + 0.25, 0],
      [toX, toY + 0.25, 0]
    );
    scene.add(hitZone);
    clickableObjects.push(hitZone);
    objectMeta.set(hitZone, { type: 'connection', connection: conn });
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
  const sceneWidth  = xMax - xMin + CUBE * 2 + 6;
  const sceneHeight = (rstY - clkY) + 4;
  const maxDim = Math.max(sceneWidth, sceneHeight);
  if (maxDim > 20) {
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

  // AXI4 Bus
  const busLi = document.createElement('li');
  busLi.innerHTML = `<span class="dot" style="background:#FFC107"></span> AXI4 Bus`;
  legendList.appendChild(busLi);

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
});
