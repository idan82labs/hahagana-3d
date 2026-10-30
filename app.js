// Hahagana 43 — explorable WebGL site viewer (three.js, offline / static hosting).
// Frame: see ../CONTRACT.md. glTF/three world = Blender local with (x, y, z)_three = (x, Z, -y)_blender.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

// ------------------------------------------------------------------ constants / frame
const SITE = { lat: 32.577, lon: 34.944, tz: 'Asia/Jerusalem' };
const FRAME = { E0: 194963.715, N0: 720367.5, u: [0.940179, -0.340680], v: [-0.340680, -0.940179], zOff: 77.0 };
const EYE = 1.6, STEP = 0.2, RADIUS = 0.25, BODY = 1.78;
const Q = new URLSearchParams(location.search);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const $ = (id) => document.getElementById(id);

const L2W = (x, y, z) => new THREE.Vector3(x, z, -y);              // Blender local -> three world
const W2L = (p) => ({ x: p.x, y: -p.z, z: p.y });                  // three world -> Blender local
// local horizontal direction from compass bearing (deg, 0 = map north, clockwise)
function bearingToLocal(bDeg) {
  const b = THREE.MathUtils.degToRad(bDeg), dE = Math.sin(b), dN = Math.cos(b);
  return { x: dE * FRAME.v[0] + dN * FRAME.v[1], y: dE * FRAME.u[0] + dN * FRAME.u[1] };
}
function localToBearing(lx, ly) {               // local horizontal vector -> bearing deg
  const E = lx * FRAME.v[0] + ly * FRAME.u[0], N = lx * FRAME.v[1] + ly * FRAME.u[1];
  return (THREE.MathUtils.radToDeg(Math.atan2(E, N)) + 360) % 360;
}
const toITM = (lx, ly) => ({ E: FRAME.E0 + lx * FRAME.v[0] + ly * FRAME.u[0], N: FRAME.N0 + lx * FRAME.v[1] + ly * FRAME.u[1] });

// ------------------------------------------------------------------ renderer / scene
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, reversedDepthBuffer: Q.get('rdb') !== '0' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 30000);
camera.position.copy(L2W(55, -45, 70));
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = THREE.MathUtils.degToRad(89); controls.minDistance = 0.8; controls.maxDistance = 2500;
controls.zoomToCursor = true; controls.screenSpacePanning = true;
controls.target.copy(L2W(0, 22, 12));
const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const QUALITY = {
  high: { pr: 2, shadow: 4096, ao: true, bloom: true, msaa: 4, glass: 'physical' },
  balanced: { pr: 1.5, shadow: 2048, ao: false, bloom: true, msaa: 4, glass: 'physical' },
  low: { pr: 1, shadow: 1024, ao: false, bloom: false, msaa: 0, glass: 'simple' },
};
const state = {
  mode: 'orbit', scenario: 'proposed', pool: false, furniture: true, roofs: true, context: true, vegetation: true, far: true,
  section: false, sectionY: 12, sectionFlip: false, levelCut: null, measure: false,
  quality: Q.get('q') || (IS_TOUCH || Math.min(screen.width, screen.height) < 700 ? 'balanced' : 'high'),
  ao: true, bloom: true, env: 'hdr', date: null, minutes: 15 * 60,
};

// ------------------------------------------------------------------ lights
const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.castShadow = true;
sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.035; sun.shadow.radius = 2.5;
const SH = 42; Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a45, 0.0); scene.add(hemi); // tiny fill at night/dusk
const shadowFocus = L2W(0, 22, 12);

// ------------------------------------------------------------------ sky, env, fog
const sky = new Sky(); sky.scale.setScalar(1000);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 3.2; skyU.rayleigh.value = 1.25; skyU.mieCoefficient.value = 0.004; skyU.mieDirectionalG.value = 0.82;
const skyScene = new THREE.Scene(); skyScene.add(sky);
const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(1, 2000, cubeRT); skyScene.add(cubeCam);
scene.background = cubeRT.texture;
const pmrem = new THREE.PMREMGenerator(renderer);
let hdrEnv = null, skyEnv = null;
scene.fog = new THREE.FogExp2(0xb9c6d2, 0.00011);

// ------------------------------------------------------------------ post-processing
let composer, renderPass, gtaoPass, bloomPass, smaaPass, outputPass;
function buildComposer() {
  const q = QUALITY[state.quality];
  const pr = Math.min(window.devicePixelRatio || 1, q.pr);
  renderer.setPixelRatio(pr);
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer?.dispose();
  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: q.msaa });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr); composer.setSize(w, h);
  renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
  gtaoPass = new GTAOPass(scene, camera, w, h);
  gtaoPass.output = GTAOPass.OUTPUT.Default; gtaoPass.blendIntensity = 0.9;
  gtaoPass.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
  gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  const ov = gtaoPass._overrideVisibility.bind(gtaoPass);
  gtaoPass._overrideVisibility = function () {           // glass / water / helpers do not occlude in AO
    ov(); scene.traverse((o) => { if (o.visible && (o.userData.noAO || o.isSprite)) { o.visible = false; this._visibilityCache.push(o); } });
  };
  composer.addPass(gtaoPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.07, 0.2, 12.0); composer.addPass(bloomPass);
  outputPass = new OutputPass(); composer.addPass(outputPass);
  if (!q.msaa) { smaaPass = new SMAAPass(); composer.addPass(smaaPass); } else smaaPass = null;
  applyPostToggles();
  sun.shadow.mapSize.set(q.shadow, q.shadow); sun.shadow.map?.dispose(); sun.shadow.map = null;
}
function applyPostToggles() {
  if (!composer) return;
  gtaoPass.enabled = state.ao && !!QUALITY[state.quality].ao || (state.ao && state.qualityAoForced);
  bloomPass.enabled = state.bloom && QUALITY[state.quality].bloom;
  // the AO prepass must see the same section/level cuts as the architecture
  gtaoPass.normalMaterial.clippingPlanes = activePlanes();
}

// ------------------------------------------------------------------ model registry
const groups = {};               // group -> { root, file, layers: Map(name -> [Object3D]) }
const layerNodes = new Map();    // layer name -> [Object3D]
const rooms = [];                // { name, label, floor, group, pos(Vector3 eye) }
const views = [];                // { label, pos, target } (three world)
const archMaterials = new Set(); // clipped materials (existing + new)
const pocheMeshes = [];          // back-face section fill meshes
const waterMats = [];
let terrainBoxLocal = null;      // xy extent of SITE_Terrain (local)
const KNOWN_LAYERS = ['SITE_Terrain', 'SITE_Context', 'SITE_Vegetation_Kept', 'SITE_Vegetation_Existing',
  'EX_Exterior', 'EX_Interior', 'EX_Furniture', 'EX_Pool', 'NEW_Structure', 'NEW_HomeA_Interior', 'NEW_HomeB_Interior',
  'NEW_Furniture', 'NEW_Garden', 'NEW_Garden_NoPool', 'NEW_Pool_Optional', 'NEW_Access'];
const NON_COLLIDING = /Vegetation|Water/i;
const DEFAULT_MANIFEST = { files: [
  { file: 'site.glb', group: 'site', layers: ['SITE_Terrain', 'SITE_Context', 'SITE_Vegetation_Kept'] },
  { file: 'veg_existing.glb', group: 'veg_existing', layers: ['SITE_Vegetation_Existing'] },
  { file: 'existing.glb', group: 'existing', layers: ['EX_Exterior', 'EX_Interior', 'EX_Furniture', 'EX_Pool'] },
  { file: 'new.glb', group: 'new', layers: ['NEW_Structure', 'NEW_HomeA_Interior', 'NEW_HomeB_Interior', 'NEW_Furniture', 'NEW_Garden', 'NEW_Garden_NoPool', 'NEW_Pool_Optional', 'NEW_Access'] },
] };
const cleanName = (n) => (n || '').replace(/[._]?\d{3}$/, '');   // Blender ".001" (sanitised by GLTFLoader to "001")

function layerOf(obj, fileLayers) {
  for (let o = obj; o; o = o.parent) {
    const n = cleanName(o.name);
    if (fileLayers.includes(n) || KNOWN_LAYERS.includes(n)) return n;
    const ex = o.userData?.layer || o.userData?.collection;
    if (ex) return ex;
  }
  return null;
}
// 'roof' role = everything overhead that the dollhouse view removes: roofs, parapets, ceilings (by node name or extras.roof)
const ROOF_RE = /roof|ceiling|parapet|skylight/i;
const isRoofName = (obj) => { for (let o = obj; o; o = o.parent) { if (ROOF_RE.test(o.name) || o.userData?.roof) return true; if (KNOWN_LAYERS.includes(cleanName(o.name))) break; } return false; };

// ------------------------------------------------------------------ materials
let waterNormal = null;
function tuneMaterial(m, ctx) {
  if (!m || m.userData._tuned) return m;
  m.userData._tuned = true;
  const n = (m.name || '').toLowerCase();
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) m[k].anisotropy = maxAniso;
  if (/water/.test(n)) {
    m.userData.isWater = true;
    Object.assign(m, { transmission: 1, thickness: 1.4, ior: 1.333, roughness: 0.03, metalness: 0, transparent: false });
    m.color?.setRGB(1, 1, 1);
    if (m.attenuationColor) { m.attenuationColor.setRGB(0.16, 0.66, 0.74); m.attenuationDistance = 1.6; }
    if (m.normalMap) { m.normalScale?.set(0.35, 0.35); }
    waterMats.push(m);
  } else if ((m.transmission > 0) || /glass/.test(n)) {
    m.userData.isGlass = true;
    if (QUALITY[state.quality].glass === 'simple' || !m.isMeshPhysicalMaterial) {
      const g = new THREE.MeshPhysicalMaterial({ name: m.name, color: m.color, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.18, envMapIntensity: 1.2, depthWrite: false });
      g.userData = { _tuned: true, isGlass: true }; return g;
    }
    Object.assign(m, { transmission: 1, thickness: 0, ior: 1.5, roughness: Math.min(m.roughness, 0.05), metalness: 0, specularIntensity: 1 });
    if (/frosted/.test(n)) m.roughness = 0.35;
  } else if (/needle|leaves|scrub|foliage|leaf/.test(n)) {
    m.side = THREE.DoubleSide; m.roughness = Math.max(m.roughness ?? 0.8, 0.75);
    if (m.sheen !== undefined) m.sheen = 0.25;
  }
  if (m.map && /ortho/.test(n)) { m.roughness = 0.95; m.metalness = 0; }
  if (ctx.clip) archMaterials.add(m);
  return m;
}

// ------------------------------------------------------------------ batching (draw-call reduction, keeps layer/roof/material splits)
function toFloatAttr(attr) {
  const n = attr.count, s = attr.itemSize, a = new Float32Array(n * s);
  for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) a[i * s + k] = attr.getComponent(i, k);
  return new THREE.BufferAttribute(a, s);
}
function bakeGeometry(mesh) {
  let g = mesh.geometry.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1', 'color', 'tangent'].includes(k)) g.deleteAttribute(k);
  for (const k of Object.keys(g.attributes)) g.setAttribute(k, toFloatAttr(g.attributes[k]));
  g.morphAttributes = {};
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.index) { const idx = []; for (let i = 0; i < g.attributes.position.count; i++) idx.push(i); g.setIndex(idx); }
  g.clearGroups();
  return g;
}
function batchGroup(root, fileLayers, group) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh || o.isSkinnedMesh) { keep.push(o); return; }
    const layer = layerOf(o, fileLayers) || fileLayers[0] || group;
    const roof = isRoofName(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.length > 1) { keep.push(o); return; }
    const m = mats[0];
    const sig = Object.keys(o.geometry.attributes).filter(k => ['position', 'normal', 'uv', 'uv1', 'color', 'tangent'].includes(k)).sort().join(',');
    const key = `${layer}|${roof}|${m.uuid}|${sig}`;
    if (!buckets.has(key)) buckets.set(key, { layer, roof, material: m, meshes: [] });
    buckets.get(key).meshes.push(o);
  });
  const out = new THREE.Group(); out.name = `${group}_batched`;
  const layerGroups = new Map();
  const lg = (layer) => { if (!layerGroups.has(layer)) { const g = new THREE.Group(); g.name = layer; out.add(g); layerGroups.set(layer, g); } return layerGroups.get(layer); };
  for (const b of buckets.values()) {
    let geom;
    try { geom = mergeGeometries(b.meshes.map(bakeGeometry), false); } catch (e) { geom = null; }
    if (!geom) { for (const m of b.meshes) keep.push(m); continue; }
    geom.computeBoundingSphere(); geom.computeBoundingBox();
    const mesh = new THREE.Mesh(geom, b.material);
    mesh.name = `${b.layer}${b.roof ? '_Roof' : ''}_${b.material.name || 'mat'}`;
    mesh.userData = { layer: b.layer, roof: b.roof, sources: b.meshes.length };
    lg(b.layer).add(mesh);
  }
  for (const o of keep) {            // instanced / multi-material meshes: reparent with world transform preserved
    const layer = layerOf(o, fileLayers) || fileLayers[0] || group;
    const wm = o.matrixWorld.clone(); o.removeFromParent();
    o.matrix.copy(wm); o.matrix.decompose(o.position, o.quaternion, o.scale);
    o.userData.layer = layer; o.userData.roof = isRoofName(o);
    if (o.isInstancedMesh) { o.computeBoundingSphere(); o.computeBoundingBox?.(); }
    lg(layer).add(o);
  }
  return { out, layerGroups };
}

// ------------------------------------------------------------------ loading
const loader = new GLTFLoader();
const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/three/examples/jsm/libs/basis/').detectSupport(renderer);
const draco = new DRACOLoader().setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
loader.setKTX2Loader(ktx2).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
const MODEL = Q.get('model') || './model/';
let manifest = DEFAULT_MANIFEST;
const progress = { loaded: {}, total: {} };
function setProgress(text) {
  const L = Object.values(progress.loaded).reduce((a, b) => a + b, 0), T = Object.values(progress.total).reduce((a, b) => a + b, 0);
  const f = T ? Math.min(1, L / T) : 0;
  $('loadbar').style.width = `${(f * 92 + (text === 'done' ? 8 : 0)).toFixed(1)}%`;
  if (text && text !== 'done') $('loadtext').textContent = text;
}
async function loadAll() {
  try { const r = await fetch(MODEL + 'manifest.json', { cache: 'no-cache' }); if (r.ok) manifest = await r.json(); } catch { /* default */ }
  for (const f of manifest.files) progress.total[f.file] = f.bytes || 4e6;
  setProgress('Loading model…');
  const envP = loadHDR();
  const farP = loadFarTerrain().catch((e) => console.warn('far terrain', e));
  const missing = [];
  await Promise.all(manifest.files.map(async (f) => {
    try {
      const gltf = await loader.loadAsync(MODEL + f.file, (e) => { progress.loaded[f.file] = e.loaded; if (e.total) progress.total[f.file] = e.total; setProgress(`Loading ${f.file} · ${(e.loaded / 1e6).toFixed(1)} MB`); });
      progress.loaded[f.file] = progress.total[f.file];
      ingest(f, gltf);
    } catch (e) { console.warn('missing', f.file, e); missing.push(f.file); progress.total[f.file] = 0; }
  }));
  setProgress('Building collision & lighting…');
  await envP; await farP;
  if (missing.length) toast(`Not found: ${missing.join(', ')}`, 6000);
  if (!Object.keys(groups).length) { $('loadtext').textContent = `No model files found in ${MODEL} (see README).`; }
  finishSetup();
}

function ingest(f, gltf) {
  const group = f.group || f.file.replace(/\.glb$/i, '');
  const fileLayers = f.layers || [];
  const root = gltf.scene; root.name = group;
  const clip = /^(existing|new)$/.test(group) || f.clip === true;
  // markers first (empties)
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const n = o.name || '';
    if (/^ROOM_/.test(n)) {
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const part = n.split('_')[1] || '';
      const floor = o.userData.floor ?? +(p.y + FRAME.zOff - EYE).toFixed(2);
      rooms.push({ name: n, label: o.userData.label || n.replace(/^ROOM_[^_]+_/, '').replace(/_/g, ' '), floor: +floor, group, part, building: o.userData.building || buildingOf(part, group), pos: p, yaw: o.userData.yaw });
    } else if (/^VIEW_/.test(n)) {
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      let t;
      if (Array.isArray(o.userData.target)) t = L2W(...o.userData.target);
      else { const d = new THREE.Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())); t = p.clone().addScaledVector(d, 30); }
      views.push({ label: o.userData.label || n.slice(5).replace(/_/g, ' '), pos: p, target: t, order: o.userData.order ?? 50 });
    }
  });
  // materials & shadows
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(m => tuneMaterial(m, { clip })) : tuneMaterial(o.material, { clip });
    const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
    const glassy = m0.userData.isGlass || m0.userData.isWater;
    o.castShadow = !glassy; o.receiveShadow = true;
    if (glassy) o.userData.noAO = true;
  });
  const { out, layerGroups } = batchGroup(root, fileLayers, group);
  out.traverse((o) => {
    if (!o.isMesh || o.userData.poche) return;
    const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
    const glassy = m0.userData.isGlass || m0.userData.isWater;
    o.castShadow = !glassy; o.receiveShadow = true; if (glassy) o.userData.noAO = true;
    if (/Vegetation/.test(o.userData.layer)) { o.receiveShadow = true; }
    if (clip && !glassy) {
      const back = new THREE.Mesh(o.geometry, pocheMat); back.name = o.name + '_poche'; back.visible = false;
      back.castShadow = false; back.receiveShadow = false; back.userData.noAO = true; back.userData.poche = true;
      if (o.isInstancedMesh) return;
      o.add(back); pocheMeshes.push(back);
    }
  });
  for (const [ly, g] of layerGroups) {
    if (!layerNodes.has(ly)) layerNodes.set(ly, []);
    layerNodes.get(ly).push(g);
  }
  if (layerGroups.has('SITE_Terrain')) {
    const b = new THREE.Box3().setFromObject(layerGroups.get('SITE_Terrain'));
    terrainBoxLocal = { x0: b.min.x, x1: b.max.x, y0: -b.max.z, y1: -b.min.z, zMin: b.min.y };
  }
  scene.add(out);
  groups[group] = { root: out, file: f.file, layers: layerGroups };
  let tris = 0; out.traverse(o => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); });
  console.info(`[viewer] ${f.file}: ${layerGroups.size} layers, ${tris.toLocaleString()} tris, ${out.children.reduce((a, g) => a + g.children.length, 0)} draw batches`);
}
function buildingOf(part, group) {
  if (/^EX/i.test(part)) return 'Existing villa';
  if (/^NEWA|^NEW_?A$|HomeA/i.test(part)) return 'New · Home A';
  if (/^NEWB|^NEW_?B$|HomeB/i.test(part)) return 'New · Home B';
  if (/^NEW/i.test(part)) return 'New · shared / outdoor';
  if (/^SITE/i.test(part)) return 'Site';
  return group === 'existing' ? 'Existing villa' : group === 'new' ? 'New' : 'Other';
}
const pocheMat = new THREE.MeshBasicMaterial({ color: 0x3b3430, side: THREE.BackSide, fog: false });
pocheMat.userData._tuned = true; archMaterials.add(pocheMat);

async function loadHDR() {
  try {
    const tex = await new HDRLoader().setDataType(THREE.FloatType).loadAsync('./assets/sky_1k.hdr');
    // clamp the baked-in sun (≈6e4) so the IBL is sky + ground fill only; the DirectionalLight is the sun
    const d = tex.image.data; for (let i = 0; i < d.length; i++) if ((i & 3) !== 3 && d[i] > 6) d[i] = 6;
    tex.needsUpdate = true;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    hdrEnv = pmrem.fromEquirectangular(tex).texture; tex.dispose(); envDirty = true;
  } catch (e) { console.warn('HDR env failed', e); }
}

// ------------------------------------------------------------------ distant terrain + sea + haze
let farMesh = null, sea = null, seaNormal = null;
async function loadFarTerrain() {
  const meta = await (await fetch('./assets/far_terrain.json')).json();
  const buf = await (await fetch('./assets/far_terrain.bin')).arrayBuffer();
  const Z = new Float32Array(buf);
  const { nx, ny, x0, y0, step } = meta;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), col = new Float32Array(nx * ny * 3);
  const o = meta.ortho; const rnd = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = x0 + i * step, y = y0 + j * step;
    let z = Z[k]; if (z < -77.4) z = -92;
    pos.set([x, z, -y], k * 3);
    uv.set([(x - o.x0) / (o.x1 - o.x0), (y - o.y0) / (o.y1 - o.y0)], k * 2);
    const a = z + 77, r = rnd(i, j) * 0.06;
    const c = a < 4 ? [0.62, 0.56, 0.44] : a < 60 ? [0.30 + r, 0.31 + r, 0.20] : [0.21 + r, 0.25 + r, 0.15];
    col.set(c, k * 3);
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('fcol', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const map = await new THREE.TextureLoader().loadAsync('./assets/' + o.file);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = maxAniso;
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.97, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 fcol; varying vec3 vF;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvF = fcol;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vF;').replace('#include <map_fragment>', `
      vec2 fuv = vMapUv; vec2 e = smoothstep(vec2(0.0), vec2(0.04), fuv) * (1.0 - smoothstep(vec2(0.96), vec2(1.0), fuv));
      vec4 texelColor = texture2D(map, clamp(fuv, 0.0, 1.0));
      diffuseColor.rgb *= mix(vF, texelColor.rgb, e.x * e.y);`);
  };
  farMesh = new THREE.Mesh(g, m); farMesh.name = 'FAR_Terrain'; farMesh.receiveShadow = false; farMesh.userData.noAO = true;
  farMesh.userData.positions = pos;
  scene.add(farMesh);
  // sea at absolute 0.0
  seaNormal = await new THREE.TextureLoader().loadAsync('./assets/water_nor.png').catch(() => null);
  if (seaNormal) { seaNormal.wrapS = seaNormal.wrapT = THREE.RepeatWrapping; seaNormal.repeat.set(900, 900); }
  const seaM = new THREE.MeshPhysicalMaterial({ color: 0x0b2a38, roughness: 0.08, metalness: 0, normalMap: seaNormal, normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 1.0, specularIntensity: 1 });
  sea = new THREE.Mesh(new THREE.CircleGeometry(28000, 96).rotateX(-Math.PI / 2), seaM);
  sea.position.y = -FRAME.zOff; sea.name = 'FAR_Sea'; sea.userData.noAO = true; scene.add(sea);
}
function sinkFarTerrainUnderSite() {
  if (!farMesh || !terrainBoxLocal) return;
  const p = farMesh.geometry.attributes.position, t = terrainBoxLocal, m = 12;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = -p.getZ(i);
    if (x > t.x0 + m && x < t.x1 - m && y > t.y0 + m && y < t.y1 - m) p.setY(i, Math.min(p.getY(i), t.zMin) - 30);
    else if (x >= t.x0 - 1 && x <= t.x1 + 1 && y >= t.y0 - 1 && y <= t.y1 + 1) p.setY(i, p.getY(i) - 2.0);
  }
  p.needsUpdate = true; farMesh.geometry.computeVertexNormals();
}

// ------------------------------------------------------------------ sun (astronomical)
function tzOffsetMinutes(dateUTC) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: SITE.tz, timeZoneName: 'shortOffset' }).formatToParts(dateUTC).find(p => p.type === 'timeZoneName').value;
    const m = s.match(/GMT([+-]\d+)(?::(\d+))?/); return m ? (+m[1]) * 60 + Math.sign(+m[1]) * (+(m[2] || 0)) : 120;
  } catch { return 120; }
}
function sunPosition(dateUTC, lat, lon) {
  const rad = Math.PI / 180;
  const d = dateUTC.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) * rad - ra);
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(H) * Math.sin(phi));
  return { az: (az / rad + 360) % 360, el: el / rad };
}
const sunDirW = new THREE.Vector3();
let envDirty = true;
function updateSun() {
  const [Y, M, D] = state.date.split('-').map(Number);
  const h = Math.floor(state.minutes / 60), mi = state.minutes % 60;
  const guess = new Date(Date.UTC(Y, M - 1, D, h, mi));
  const off = tzOffsetMinutes(guess);
  const utc = new Date(guess.getTime() - off * 60000);
  const { az, el } = sunPosition(utc, SITE.lat, SITE.lon);
  const hor = bearingToLocal(az), ce = Math.cos(el * Math.PI / 180), se = Math.sin(el * Math.PI / 180);
  sunDirW.copy(L2W(hor.x * ce, hor.y * ce, se)).normalize();
  // sky + light colour by elevation
  const elC = Math.max(el, -6);
  skyU.sunPosition.value.copy(sunDirW);
  const day = THREE.MathUtils.smoothstep(el, -4, 12);
  const warm = 1 - THREE.MathUtils.smoothstep(el, 2, 28);
  sun.color.setRGB(1, 0.97 - 0.30 * warm, 0.92 - 0.52 * warm);
  sun.intensity = 3.2 * THREE.MathUtils.smoothstep(elC, -1.5, 8);
  sun.visible = el > -2;
  hemi.intensity = 0.25 * (1 - day) + 0.05;
  scene.environmentIntensity = (0.08 + 0.5 * day) * (state.env === 'sky' ? 0.3 : 1);   // Sky shader radiance is ~3x the clamped HDR
  scene.backgroundIntensity = 0.25 + 0.75 * day;
  const fog = new THREE.Color().setRGB(0.70, 0.76, 0.84).lerp(new THREE.Color(0.86, 0.66, 0.50), warm * 0.8).multiplyScalar(0.18 + 0.82 * day);
  scene.fog.color.copy(fog);
  $('sunInfo').textContent = `Sun azimuth ${az.toFixed(0)}° · elevation ${el.toFixed(1)}°  (UTC${off >= 0 ? '+' : ''}${off / 60})`;
  $('sunTimeo').textContent = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  envDirty = true;
}
function refreshSkyEnv() {
  if (!envDirty) return; envDirty = false;
  cubeCam.update(renderer, skyScene);
  if (state.env === 'sky') {
    skyEnv?.dispose(); skyEnv = pmrem.fromScene(skyScene, 0, 1, 2000).texture;
    scene.environment = skyEnv;
  } else scene.environment = hdrEnv || null;
}
function updateShadowFocus() {
  // follow the walker / orbit target but stay on the buildings when far away; snap to shadow texels (no shimmer)
  const f = state.mode === 'walk' ? player.feet.clone() : controls.target.clone();
  const home = L2W(0, 25, 14);
  if (f.distanceTo(home) > 120) f.copy(home);
  const texel = (2 * SH) / sun.shadow.mapSize.x;
  const lightMat = new THREE.Matrix4().lookAt(new THREE.Vector3(), sunDirW.clone().negate(), new THREE.Vector3(0, 1, 0));
  const inv = lightMat.clone().invert();
  const lp = f.clone().applyMatrix4(inv); lp.x = Math.round(lp.x / texel) * texel; lp.y = Math.round(lp.y / texel) * texel;
  shadowFocus.copy(lp.applyMatrix4(lightMat));
  sun.target.position.copy(shadowFocus);
  sun.position.copy(shadowFocus).addScaledVector(sunDirW, 250);
}

// ------------------------------------------------------------------ visibility / layers / cuts
function setLayerVisible(name, v) { for (const g of layerNodes.get(name) || []) g.visible = v; }
const roofMeshes = () => { const r = []; for (const gs of layerNodes.values()) for (const g of gs) g.traverse(o => { if (o.isMesh && o.userData.roof) r.push(o); }); return r; };
function applyLayers() {
  const prop = state.scenario === 'proposed';
  if (groups.new) groups.new.root.visible = prop;
  if (groups.veg_existing) groups.veg_existing.root.visible = !prop && state.vegetation;
  setLayerVisible('SITE_Vegetation_Existing', !prop && state.vegetation);
  setLayerVisible('SITE_Vegetation_Kept', state.vegetation);
  setLayerVisible('NEW_Pool_Optional', state.pool);
  setLayerVisible('NEW_Garden_NoPool', !state.pool);
  setLayerVisible('EX_Furniture', state.furniture); setLayerVisible('NEW_Furniture', state.furniture);
  setLayerVisible('SITE_Context', state.context);
  for (const m of roofMeshes()) m.visible = state.roofs;
  if (farMesh) farMesh.visible = state.far; if (sea) sea.visible = state.far;
  $('subtitle').textContent = prop ? 'Proposed' + (state.pool ? ' · with pool' : '') : 'Existing condition';
  for (const b of $('scenSeg').children) b.classList.toggle('on', b.dataset.s === state.scenario);
  $('lyPool').disabled = !prop;
  scheduleCollision();
}
const planeSec = new THREE.Plane(), planeLvl = new THREE.Plane();
function activePlanes() {
  const ps = [];
  if (state.section) { if (state.sectionFlip) planeSec.set(new THREE.Vector3(0, 0, -1), -state.sectionY); else planeSec.set(new THREE.Vector3(0, 0, 1), state.sectionY); ps.push(planeSec); }
  if (state.levelCut != null) { planeLvl.set(new THREE.Vector3(0, -1, 0), state.levelCut - FRAME.zOff); ps.push(planeLvl); }
  return ps;
}
function applyCuts() {
  const ps = activePlanes();
  for (const m of archMaterials) { m.clippingPlanes = ps.length ? ps : null; m.clipShadows = true; m.needsUpdate = true; }
  for (const b of pocheMeshes) b.visible = ps.length > 0;
  $('secYo').textContent = `y ${state.sectionY.toFixed(1)}`;
  applyPostToggles();
  applyLayers();
}

// ------------------------------------------------------------------ collision BVH (architecture + terrain + context; not vegetation)
let bvh = null, bvhMesh = null, collisionTimer = 0;
function scheduleCollision() { clearTimeout(collisionTimer); collisionTimer = setTimeout(buildCollision, 250); }
function isVisibleDeep(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }
function buildCollision() {
  const t0 = performance.now();
  const geoms = [];
  scene.updateMatrixWorld(true);
  for (const g of Object.values(groups)) g.root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.poche) return;
    if (NON_COLLIDING.test(o.userData.layer || '') || o.material?.userData?.isWater) return;
    // roofs / level cut hide geometry visually only; keep walls solid even when hidden roofs
    if (!isVisibleDeep(o) && !o.userData.roof) return;
    const src = o.geometry; const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', src.attributes.position.clone()); g2.setIndex(src.index.clone());
    g2.applyMatrix4(o.matrixWorld); geoms.push(g2);
  });
  if (!geoms.length) { bvh = null; return; }
  const merged = mergeGeometries(geoms, false);
  bvh = new MeshBVH(merged, { targetLeafSize: 12 });
  bvhMesh = new THREE.Mesh(merged); bvhMesh.geometry.boundsTree = bvh;
  console.info(`[viewer] collision BVH: ${(merged.index.count / 3).toLocaleString()} tris in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ------------------------------------------------------------------ walk mode
const player = { feet: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, grounded: false, fly: false };
const keys = new Set();
const joy = { x: 0, y: 0, active: false };
const tmp = { seg: new THREE.Line3(), box: new THREE.Box3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(), ray: new THREE.Ray() };
function groundAt(x, y, z, maxDown) {
  // highest floor below (x, y + STEP + RADIUS, z) within maxDown, sampled with 5 rays (centre + ring)
  if (!bvh) return null;
  let best = null;
  const o = RADIUS * 0.6;
  for (const [dx, dz] of [[0, 0], [o, 0], [-o, 0], [0, o], [0, -o]]) {
    tmp.ray.origin.set(x + dx, y, z + dz); tmp.ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(tmp.ray, THREE.DoubleSide, 0, maxDown);
    if (hit && (best === null || hit.point.y > best)) best = hit.point.y;
  }
  return best;
}
function capsulePush(feet) {
  if (!bvh) return;
  const seg = tmp.seg;
  seg.start.set(feet.x, feet.y + STEP + RADIUS, feet.z); seg.end.set(feet.x, feet.y + BODY - RADIUS, feet.z);
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    tmp.box.makeEmpty(); tmp.box.expandByPoint(seg.start); tmp.box.expandByPoint(seg.end);
    tmp.box.min.addScalar(-RADIUS); tmp.box.max.addScalar(RADIUS);
    bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(tmp.box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(seg, tmp.v1, tmp.v2);
        if (d < RADIUS) {
          const dir = tmp.v2.sub(tmp.v1); const len = dir.length();
          if (len < 1e-6) { tri.getNormal(dir); } else dir.divideScalar(len);
          const depth = RADIUS - d;
          dir.y = 0; if (dir.lengthSq() < 1e-8) return; dir.normalize();       // horizontal push only; floors via rays
          seg.start.addScaledVector(dir, depth); seg.end.addScaledVector(dir, depth); moved = true;
        }
      },
    });
    if (!moved) break;
  }
  feet.x = seg.start.x; feet.z = seg.start.z;
}
function ceilingAt(feet) {
  if (!bvh) return Infinity;
  tmp.ray.origin.set(feet.x, feet.y + STEP + RADIUS, feet.z); tmp.ray.direction.set(0, 1, 0);
  const hit = bvh.raycastFirst(tmp.ray, THREE.DoubleSide, 0, 3);
  return hit ? hit.point.y : Infinity;
}
function walkUpdate(dt) {
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  let fx = 0, fz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fz -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fz += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) fx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) fx += 1;
  if (joy.active) { fx += joy.x; fz += joy.y; }
  const len = Math.hypot(fx, fz); if (len > 1) { fx /= len; fz /= len; }
  const speed = player.fly ? (run ? 14 : 5) : (run ? 4.2 : 1.7);
  const cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
  const wish = new THREE.Vector3(fx * cy + fz * sy, 0, -fx * sy + fz * cy).multiplyScalar(speed);
  // smooth acceleration
  const k = 1 - Math.exp(-dt * (player.grounded || player.fly ? 12 : 2));
  player.vel.x += (wish.x - player.vel.x) * k; player.vel.z += (wish.z - player.vel.z) * k;
  const p = player.feet;
  if (player.fly) {
    p.x += player.vel.x * dt; p.z += player.vel.z * dt;
    if (keys.has('Space')) p.y += speed * dt; if (keys.has('KeyC') || keys.has('ControlLeft')) p.y -= speed * dt;
    player.vel.y = 0; return;
  }
  const substeps = Math.ceil(Math.hypot(player.vel.x, player.vel.z) * dt / 0.12) || 1;
  for (let s = 0; s < substeps; s++) {
    p.x += player.vel.x * dt / substeps; p.z += player.vel.z * dt / substeps;
    capsulePush(p);
  }
  // gravity + ground snap / step-up
  player.vel.y -= 9.81 * dt;
  p.y += player.vel.y * dt;
  const g = groundAt(p.x, p.y + STEP + RADIUS + Math.max(0, -player.vel.y * dt), p.z, STEP + RADIUS + (player.grounded ? 0.45 : 0.05) + Math.max(0, -player.vel.y * dt));
  if (g !== null && player.vel.y <= 0 && g >= p.y - (player.grounded ? 0.45 : 0.02)) {
    // step up smoothly (stairs), snap down to follow slopes / descending stairs
    p.y = g > p.y ? p.y + Math.min(g - p.y, 2.2 * dt + 0.6 * (g - p.y)) : g;
    if (Math.abs(g - p.y) < 0.02) p.y = g;
    player.vel.y = 0; player.grounded = true;
  } else player.grounded = false;
  const ceil = ceilingAt(p);
  if (p.y + BODY > ceil && player.vel.y > 0) player.vel.y = 0;
  if (p.y < -150) { toast('Fell off the world — respawned'); teleportFeet(lastSafe.clone()); }
  if (player.grounded) lastSafe.copy(p);
}
const lastSafe = new THREE.Vector3();
function teleportFeet(feet, yaw) {
  player.feet.copy(feet); player.vel.set(0, 0, 0); player.grounded = false; lastSafe.copy(feet);
  if (yaw !== undefined) player.yaw = yaw;
}
function eyeFromPlayer() {
  camera.position.set(player.feet.x, player.feet.y + EYE, player.feet.z);
  camera.quaternion.setFromEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
}
function setMode(mode, opts = {}) {
  if (mode === state.mode && !opts.force) return;
  state.mode = mode;
  document.body.classList.toggle('walk', mode === 'walk');
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.mode === mode);
  if (mode === 'walk') {
    controls.enabled = false;
    if (!opts.keepPlayer) {
      // drop the walker where the camera looks (on the ground), facing the same way
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
      let feet = controls.target.clone();
      const g = groundAt(feet.x, feet.y + 2.5, feet.z, 8);
      if (g !== null) feet.y = g;
      player.yaw = Math.atan2(-dir.x, -dir.z); player.pitch = 0;
      teleportFeet(feet);
    }
    camera.near = 0.08; camera.updateProjectionMatrix();
    $('hint').textContent = IS_TOUCH ? 'Left stick to move · drag to look' : 'Click to look around · WASD to move · Esc to release';
    if (!bvh) buildCollision();
  } else {
    controls.enabled = true;
    if (document.pointerLockElement) document.exitPointerLock();
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    controls.target.copy(camera.position).addScaledVector(dir, 6);
    $('hint').textContent = '';
  }
}

// ------------------------------------------------------------------ camera fly-to (orbit)
let flight = null;
function flyTo(pos, target, dur = 1.4) {
  setMode('orbit');
  flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), t: 0, dur };
}
function flightUpdate(dt) {
  if (!flight) return;
  flight.t = Math.min(1, flight.t + dt / flight.dur);
  const e = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
  camera.position.lerpVectors(flight.p0, flight.p1, e);
  controls.target.lerpVectors(flight.t0, flight.t1, e);
  if (flight.t >= 1) flight = null;
}
function gotoRoom(r) {
  const feet = r.pos.clone(); feet.y -= EYE;
  // yaw: extras.yaw = compass bearing; default: face downhill (sea)
  let yaw;
  if (r.yaw !== undefined) { const d = bearingToLocal(+r.yaw); yaw = Math.atan2(-d.x, d.y); }
  else yaw = Math.PI;        // three -Z is local +Y (uphill); yaw PI looks toward +Z = downhill
  setMode('walk', { keepPlayer: true, force: true });
  teleportFeet(feet, yaw); player.pitch = -0.05;
  const g = groundAt(feet.x, feet.y + 1.0, feet.z, 2.0); if (g !== null) player.feet.y = g;
  toast(`${r.building} · ${r.label}`);
}

// ------------------------------------------------------------------ measure tool
const measure = { pts: [], objs: [], label: null };
const mLineMat = new THREE.LineBasicMaterial({ color: 0xe9b872, depthTest: false, transparent: true });
const mDotMat = new THREE.MeshBasicMaterial({ color: 0xe9b872, depthTest: false, transparent: true });
const raycaster = new THREE.Raycaster();
function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [];
  for (const g of Object.values(groups)) if (g.root.visible) targets.push(g.root);
  if (farMesh?.visible) targets.push(farMesh);
  const ps = activePlanes();
  const hits = raycaster.intersectObjects(targets, true).filter(h => isVisibleDeep(h.object) && !h.object.userData.poche && !(h.object.material?.userData?.isGlass && state.measure === false)
    && (!archMaterials.has(h.object.material) || ps.every(p => p.distanceToPoint(h.point) >= -1e-3)));
  return hits[0] || null;
}
function clearMeasure() { for (const o of measure.objs) { scene.remove(o); o.geometry?.dispose(); } measure.objs = []; measure.pts = []; $('labels').innerHTML = ''; measure.label = null; }
function addMeasurePoint(p) {
  if (measure.pts.length >= 2) clearMeasure();
  measure.pts.push(p.clone());
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), mDotMat); dot.position.copy(p); dot.renderOrder = 999; dot.userData.noAO = true;
  scene.add(dot); measure.objs.push(dot);
  if (measure.pts.length === 2) {
    const [a, b] = measure.pts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mLineMat); line.renderOrder = 999; scene.add(line); measure.objs.push(line);
    const d = a.distanceTo(b), dz = b.y - a.y, dh = Math.hypot(b.x - a.x, b.z - a.z);
    const el = document.createElement('div'); el.className = 'mlabel';
    el.innerHTML = `${d.toFixed(2)} m<small>horiz ${dh.toFixed(2)} · Δh ${dz >= 0 ? '+' : ''}${dz.toFixed(2)}</small>`;
    $('labels').appendChild(el); measure.label = { el, at: a.clone().add(b).multiplyScalar(0.5) };
  }
}
function setMeasure(on) {
  state.measure = on; document.body.classList.toggle('measure', on);
  $('measureBtn').setAttribute('aria-pressed', on);
  if (!on) clearMeasure();
  $('hint').textContent = on ? (state.mode === 'walk' ? 'Click: measure at the crosshair' : 'Click two points to measure · Esc to clear') : (state.mode === 'walk' ? $('hint').textContent : '');
}

// ------------------------------------------------------------------ HUD
let hudT = 0;
function updateHUD(dt) {
  hudT += dt; if (hudT < 0.12) return; hudT = 0;
  const p = W2L(camera.position);
  $('elev').textContent = `+${(p.z + FRAME.zOff).toFixed(2)} m`;
  const itm = toITM(p.x, p.y);
  $('coords').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  ·  ITM ${itm.E.toFixed(0)} / ${itm.N.toFixed(0)}`;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const bearing = localToBearing(dir.x, -dir.z);
  $('needle').style.transform = `rotate(${-bearing}deg)`;
  const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
  $('heading').textContent = `${card} ${bearing.toFixed(0)}°`;
  // room label
  let label = '';
  if (state.mode === 'walk' && rooms.length) {
    const eye = camera.position; let best = null, bd = 1e9;
    for (const r of rooms) {
      if (!isVisibleGroup(r.group)) continue;
      const dy = Math.abs(r.pos.y - eye.y); if (dy > 1.4) continue;
      const d = Math.hypot(r.pos.x - eye.x, r.pos.z - eye.z); if (d > 9 || d >= bd) continue;
      if (bvh && d > 0.3) { tmp.ray.origin.copy(eye); tmp.ray.direction.copy(r.pos).sub(eye).normalize(); const h = bvh.raycastFirst(tmp.ray, THREE.DoubleSide, 0, d); if (h) continue; }
      best = r; bd = d;
    }
    if (best) label = `${best.label} · +${best.floor.toFixed(2)}`;
  }
  $('room').textContent = label;
}
const isVisibleGroup = (g) => groups[g]?.root.visible !== false;

// ------------------------------------------------------------------ UI wiring
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
function buildRoomMenu() {
  const sel = $('roomSel');
  const byB = new Map();
  for (const r of rooms) { if (!byB.has(r.building)) byB.set(r.building, []); byB.get(r.building).push(r); }
  const order = ['Existing villa', 'New · Home A', 'New · Home B', 'New · shared / outdoor', 'New', 'Site', 'Other'];
  for (const b of [...byB.keys()].sort((a, c) => order.indexOf(a) - order.indexOf(c))) {
    const og = document.createElement('optgroup'); og.label = b;
    for (const r of byB.get(b).sort((a, c) => c.floor - a.floor || a.label.localeCompare(c.label))) {
      const o = document.createElement('option'); o.value = r.name; o.textContent = `+${r.floor.toFixed(2)}  ${r.label}`; og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.onchange = () => { const r = rooms.find(x => x.name === sel.value); if (r) { if (r.group === 'new' && state.scenario !== 'proposed') { state.scenario = 'proposed'; applyLayers(); } gotoRoom(r); } sel.value = ''; canvas.focus(); };
  // level cuts from the floors present
  const floors = [...new Set(rooms.map(r => r.floor))].sort((a, b) => b - a);
  const ls = $('lvlSel');
  for (const f of floors) { const o = document.createElement('option'); o.value = f; o.textContent = `Cut above +${f.toFixed(2)} (plan)`; ls.appendChild(o); }
  ls.onchange = () => { state.levelCut = ls.value === '' ? null : +ls.value + 1.35; applyCuts(); };
}
function defaultViews() {
  const V = (label, p, t, order) => ({ label, pos: L2W(...p), target: L2W(...t), order });
  return [V('Aerial', [55, -45, 70], [0, 22, 12], 1), V('From the sea', [-12, -95, 14], [0, 20, 12], 2), V('Street', [8, 64, 27.5], [0, 34, 19], 3),
    V('Pool deck', [6, 21, 19.9], [-14, -40, 5], 4), V('New homes garden', [-7, 0.5, 10.1], [2, 12, 11.5], 5)];
}
function buildViewChips() {
  let vs = views.length ? views : [];
  if (manifest.views) vs = manifest.views.map((v, i) => ({ label: v.label, pos: L2W(...v.pos), target: L2W(...v.target), order: i }));
  if (!vs.length) vs = defaultViews();
  vs.sort((a, b) => a.order - b.order);
  const box = $('views');
  for (const v of vs) {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = v.label;
    b.onclick = () => flyTo(v.pos, v.target); box.appendChild(b);
  }
  window.__views = vs;
}
function wireUI() {
  for (const b of $('modeSeg').children) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $('scenSeg').children) b.onclick = () => { state.scenario = b.dataset.s; applyLayers(); };
  const tg = (id, key, fn = applyLayers) => { const el = $(id); el.checked = state[key]; el.onchange = () => { state[key] = el.checked; fn(); }; };
  tg('lyPool', 'pool'); tg('lyFurn', 'furniture'); tg('lyRoof', 'roofs'); tg('lyCtx', 'context'); tg('lyVeg', 'vegetation'); tg('lyFar', 'far');
  tg('secOn', 'section', applyCuts); tg('secFlip', 'sectionFlip', applyCuts);
  $('secY').oninput = () => { state.sectionY = +$('secY').value; if (!state.section) { state.section = true; $('secOn').checked = true; } applyCuts(); };
  $('dollBtn').onclick = () => toggleDollhouse();
  $('sunDate').value = state.date; $('sunDate').onchange = () => { state.date = $('sunDate').value || state.date; updateSun(); };
  $('sunTime').value = state.minutes; $('sunTime').oninput = () => { state.minutes = +$('sunTime').value; updateSun(); };
  $('sunPlay').onclick = () => { playing = !playing; $('sunPlay').classList.toggle('on', playing); };
  $('qual').value = state.quality; $('qual').onchange = () => { state.quality = $('qual').value; buildComposer(); };
  $('tone').onchange = () => { renderer.toneMapping = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping }[$('tone').value]; composer.passes.forEach(p => p.isOutputPass && (p._outputColorSpace = null)); };
  $('envSel').onchange = () => { state.env = $('envSel').value; updateSun(); };
  $('expo').oninput = () => { renderer.toneMappingExposure = Math.pow(2, +$('expo').value); };
  $('aoOn').checked = state.ao; $('aoOn').onchange = () => { state.ao = $('aoOn').checked; state.qualityAoForced = state.ao; applyPostToggles(); };
  $('bloomOn').onchange = () => { state.bloom = $('bloomOn').checked; applyPostToggles(); };
  $('measureBtn').onclick = () => setMeasure(!state.measure);
  $('panelBtn').onclick = () => $('panel').classList.toggle('hidden');
  $('helpLink').onclick = (e) => { e.preventDefault(); $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  if (innerWidth < 720) $('panel').classList.add('hidden');
  if (IS_TOUCH) document.body.classList.add('touch');
}
function syncUI() {
  const m = { lyPool: 'pool', lyFurn: 'furniture', lyRoof: 'roofs', lyCtx: 'context', lyVeg: 'vegetation', lyFar: 'far', secOn: 'section', secFlip: 'sectionFlip', aoOn: 'ao', bloomOn: 'bloom' };
  for (const [id, k] of Object.entries(m)) $(id).checked = !!state[k];
  $('secY').value = state.sectionY; $('qual').value = state.quality;
}
let dollPrev = null;
function toggleDollhouse() {
  const on = !dollPrev;
  if (on) {
    // dollhouse = roofs, parapets and ceilings removed (every building keeps its own top floor); no global cut
    dollPrev = { roofs: state.roofs, levelCut: state.levelCut, lvl: $('lvlSel').value };
    state.roofs = false; $('lyRoof').checked = false; state.levelCut = null; $('lvlSel').value = '';
    flyTo(L2W(24, -14, 46), L2W(0, 22, 12));
  } else {
    state.roofs = dollPrev.roofs; $('lyRoof').checked = state.roofs; state.levelCut = dollPrev.levelCut; $('lvlSel').value = dollPrev.lvl; dollPrev = null;
  }
  $('dollBtn').classList.toggle('on', on);
  applyCuts();
}

// pointer / keyboard
let drag = null, playing = false;
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, t: performance.now() };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (state.mode === 'walk' && !document.pointerLockElement) {
    look(dx * (IS_TOUCH ? 2.2 : 1.6), dy * (IS_TOUCH ? 2.2 : 1.6)); drag.x = e.clientX; drag.y = e.clientY;
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const click = !drag.moved && performance.now() - drag.t < 400; drag = null;
  if (!click) return;
  if (state.measure) {
    const h = document.pointerLockElement ? pick(innerWidth / 2, innerHeight / 2) : pick(e.clientX, e.clientY);
    if (h) addMeasurePoint(h.point);
    return;
  }
  if (state.mode === 'walk' && !IS_TOUCH && !document.pointerLockElement && e.pointerType === 'mouse') canvas.requestPointerLock?.();
});
canvas.addEventListener('dblclick', (e) => {
  if (state.mode !== 'orbit' || state.measure) return;
  const h = pick(e.clientX, e.clientY); if (!h) return;
  const off = camera.position.clone().sub(controls.target);
  const len = Math.min(off.length(), 40); off.setLength(len);
  flyTo(h.point.clone().add(off), h.point, 0.8);
});
function look(dx, dy) {
  player.yaw -= dx * 0.0025; player.pitch = THREE.MathUtils.clamp(player.pitch - dy * 0.0025, -1.45, 1.45);
}
document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) look(e.movementX, e.movementY); });
document.addEventListener('pointerlockchange', () => { $('hint').textContent = state.mode === 'walk' ? (document.pointerLockElement ? 'WASD move · Shift run · Space jump · F fly · Esc release' : 'Click to look around · WASD to move') : ''; });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (state.mode === 'walk' && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyO': setMode('orbit'); break;
    case 'KeyG': setMode('walk'); break;
    case 'KeyM': setMeasure(!state.measure); break;
    case 'KeyR': state.roofs = !state.roofs; $('lyRoof').checked = state.roofs; applyLayers(); break;
    case 'KeyL': toggleDollhouse(); break;
    case 'KeyE': state.scenario = state.scenario === 'proposed' ? 'existing' : 'proposed'; applyLayers(); break;
    case 'KeyP': $('panel').classList.toggle('hidden'); break;
    case 'KeyF': if (state.mode === 'walk') { player.fly = !player.fly; toast(player.fly ? 'Fly / no-clip on' : 'Walking'); } break;
    case 'BracketLeft': state.minutes = Math.max(240, state.minutes - 15); $('sunTime').value = state.minutes; updateSun(); break;
    case 'BracketRight': state.minutes = Math.min(1260, state.minutes + 15); $('sunTime').value = state.minutes; updateSun(); break;
    case 'Space': if (state.mode === 'walk' && player.grounded && !player.fly) { player.vel.y = 3.6; player.grounded = false; } break;
    case 'Escape': if (state.measure) clearMeasure(); $('help').hidden = true; break;
    case 'Slash': if (e.shiftKey) $('help').hidden = !$('help').hidden; break;
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// touch joystick
(() => {
  const j = $('joy'), k = $('joyKnob'); let id = null, cx = 0, cy = 0;
  j.addEventListener('pointerdown', (e) => { id = e.pointerId; const r = j.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; j.setPointerCapture(id); joy.active = true; move(e); });
  const move = (e) => { if (e.pointerId !== id) return; let dx = (e.clientX - cx) / 50, dy = (e.clientY - cy) / 50; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } joy.x = dx; joy.y = dy; k.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`; };
  j.addEventListener('pointermove', move);
  const end = (e) => { if (e.pointerId !== id) return; id = null; joy.active = false; joy.x = joy.y = 0; k.style.transform = ''; };
  j.addEventListener('pointerup', end); j.addEventListener('pointercancel', end);
})();
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); buildComposer(); });

// ------------------------------------------------------------------ main loop
const clock = new THREE.Timer(); clock.connect?.(document);
let frames = 0, fpsT = 0, fps = 0;
function tick() {
  clock.update(); const dt = Math.min(clock.getDelta(), 0.05);
  if (playing) { state.minutes += dt * 40; if (state.minutes > 1260) state.minutes = 240; $('sunTime').value = state.minutes; updateSun(); }
  if (state.mode === 'walk') { walkUpdate(dt); eyeFromPlayer(); }
  else {
    flightUpdate(dt); controls.update(dt);
    const dist = camera.position.distanceTo(controls.target);
    const near = THREE.MathUtils.clamp(dist * 0.004, 0.08, 4);
    if (Math.abs(near - camera.near) / camera.near > 0.15) { camera.near = near; camera.updateProjectionMatrix(); }
  }
  for (const m of waterMats) if (m.normalMap) { m.normalMap.offset.x += dt * 0.010; m.normalMap.offset.y += dt * 0.006; }
  if (seaNormal) { seaNormal.offset.x += dt * 0.0012; seaNormal.offset.y += dt * 0.0007; }
  refreshSkyEnv();
  updateShadowFocus();
  composer.render(dt);
  if (measure.label) {
    const p = measure.label.at.clone().project(camera);
    measure.label.el.style.display = p.z < 1 ? '' : 'none';
    measure.label.el.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`; measure.label.el.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`;
  }
  updateHUD(dt);
  frames++; fpsT += dt; if (fpsT > 1) { fps = frames / fpsT; frames = 0; fpsT = 0; window.__fps = fps; }
  requestAnimationFrame(tick);
}

function finishSetup() {
  // manifest defaults (scenario / pool / furniture / roofs / context / vegetation / far) and URL overrides (?scenario=existing&pool=1)
  const d = manifest.defaults || {};
  for (const k of ['scenario', 'pool', 'furniture', 'roofs', 'context', 'vegetation', 'far']) {
    if (d[k] !== undefined) state[k] = d[k];
    if (Q.has(k)) state[k] = k === 'scenario' ? Q.get(k) : Q.get(k) === '1' || Q.get(k) === 'true';
  }
  for (const ly of d.hidden || []) setLayerVisible(ly, false);
  syncUI();
  sinkFarTerrainUnderSite();
  buildRoomMenu(); buildViewChips();
  // initial view
  const v0 = (window.__views || []).find(v => /aerial/i.test(v.label));
  if (v0) { camera.position.copy(v0.pos); controls.target.copy(v0.target); }
  if (Q.get('view')) { const v = window.__views.find(x => x.label.toLowerCase().includes(Q.get('view').toLowerCase())); if (v) { camera.position.copy(v.pos); controls.target.copy(v.target); } }
  applyCuts(); applyLayers(); buildCollision();
  if (Q.get('room')) { const r = rooms.find(x => x.name === Q.get('room')); if (r) gotoRoom(r); }
  setProgress('done');
  setTimeout(() => $('loading').classList.add('done'), 150);
  window.__ready = true;
}

// ------------------------------------------------------------------ boot
const today = new Date();
state.date = Q.get('date') || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
if (Q.get('time')) { const [h, m] = Q.get('time').split(':').map(Number); state.minutes = h * 60 + (m || 0); }
wireUI();
buildComposer();
updateSun();
camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
requestAnimationFrame(tick);
loadAll();

// test / automation hooks (used by tools/shoot.mjs)
window.viewer = {
  THREE, scene, camera, controls, state, rooms, groups, layerNodes, player, renderer,
  setMode, gotoRoom: (name) => gotoRoom(rooms.find(r => r.name === name)), flyTo,
  view: (label) => { const v = window.__views.find(x => x.label.toLowerCase().includes(label.toLowerCase())); setMode('orbit'); flight = null; camera.position.copy(v.pos); controls.target.copy(v.target); },
  set: (patch) => { Object.assign(state, patch); syncUI(); applyLayers(); applyCuts(); applyPostToggles(); },
  setTime: (hhmm, date) => { const [h, m] = hhmm.split(':').map(Number); state.minutes = h * 60 + (m || 0); if (date) state.date = date; $('sunTime').value = state.minutes; updateSun(); },
  dollhouse: toggleDollhouse, measurePts: (a, b) => { clearMeasure(); addMeasurePoint(a); addMeasurePoint(b); },
  look: (yawDeg, pitchDeg) => { player.yaw = THREE.MathUtils.degToRad(yawDeg); player.pitch = THREE.MathUtils.degToRad(pitchDeg); },
  keys, buildCollision, stats: () => renderer.info.render, groundAt, getBVH: () => bvh,
};
