/* ═══════════════════════════════════════════════════════════════════
   AXI4 3D Diagram Viewer — main.js
   Reads metadata/axi4_design.json and builds a Three.js scene showing:
     • One coloured cube per instance (Master / Repeater / Slave)
     • CLK connections entering the BOTTOM of every cube (green)
     • RST_N connections entering the TOP of every cube (red)
     • AXI4 bus arrows between the cubes (amber)
     • A dashed wireframe box for the tb_top testbench
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
  group.add(new THREE.Mesh(geo, mat));

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

// ═══════════════════════════════════════════════════════════════════
// Main build — reads the JSON then populates the scene
// ═══════════════════════════════════════════════════════════════════
async function buildScene() {
  const response = await fetch('./metadata/axi4_design.json');
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
    scene.add(instanceCube(inst, moduleColor[inst.module] ?? 0x888888));
  }

  // ── Geometry helpers ───────────────────────────────────────────
  const xs      = instances.map(i => i.position.x);
  const xMin    = Math.min(...xs);
  const xMax    = Math.max(...xs);

  const clkY    = -HALF - 1.8;   // horizontal CLK rail Y
  const rstY    =  HALF + 1.8;   // horizontal RST rail Y
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

    // CLK: bottom face of cube → CLK rail
    scene.add(solidLine([[x, -HALF, 0], [x, clkY, 0]], CLK_COL));
    scene.add(portDot([x, -HALF, 0], CLK_COL));

    // RST: top face of cube → RST rail
    scene.add(solidLine([[x, HALF, 0], [x, rstY, 0]], RST_COL));
    scene.add(portDot([x, HALF, 0], RST_COL));
  }

  // ── AXI4 bus connections ───────────────────────────────────────
  for (const conn of design.connections) {
    if (conn.type !== 'axi4_bus') continue;

    const fromInst = instances.find(i => i.instance_name === conn.from_instance);
    const toInst   = instances.find(i => i.instance_name === conn.to_instance);
    if (!fromInst || !toInst) continue;

    const fromX = fromInst.position.x + HALF;
    const toX   = toInst.position.x   - HALF;
    const midX  = (fromX + toX) / 2;
    const busY  = 0.25;

    // Arrow
    scene.add(arrow([fromX, busY, 0], [toX, busY, 0], AXI4_COL));

    // Port dots
    scene.add(portDot([fromX, busY, 0], AXI4_COL, 0.16));
    scene.add(portDot([toX,   busY, 0], AXI4_COL, 0.16));

    // Bus label
    const busLabel = makeLabel(
      `<span class="bus-label-text">${conn.label}</span>`, 'bus-label-obj'
    );
    busLabel.position.set(midX, busY + 0.9, 0);
    scene.add(busLabel);
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

  // ── Populate HTML side panel ───────────────────────────────────
  document.getElementById('panel-design-name').textContent = design.design_name;
  document.getElementById('panel-desc').textContent        = design.description;

  const instList = document.getElementById('instance-list');
  for (const inst of instances) {
    const mod = design.modules[inst.module];
    const li  = document.createElement('li');
    li.style.borderLeftColor = mod?.render?.color ?? '#888';
    li.innerHTML =
      `<strong>${inst.instance_name}</strong><br>` +
      `<em>${inst.module}</em><br>` +
      `<small>${mod?.description ?? ''}</small>`;
    instList.appendChild(li);
  }

  const paramTable = document.getElementById('param-table');
  for (const [k, v] of Object.entries(design.parameters)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="pk">${k}</td><td class="pv">${v}</td>`;
    paramTable.appendChild(tr);
  }
}

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
buildScene().catch(err => {
  console.error('buildScene failed:', err);
  document.getElementById('panel-design-name').textContent = '⚠ Load error';
  document.getElementById('panel-desc').textContent        = err.message;
});
