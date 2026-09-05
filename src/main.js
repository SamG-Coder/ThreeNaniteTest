import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';

import './styles.css';
import {
  buildNaniteLiteAsset,
  normaliseGeometry
} from './buildNaniteLiteAsset.js';
import { buildHierarchyAsset } from './buildHierarchyAsset.js';
import { NaniteLiteRenderer } from './NaniteLiteRenderer.js';
import { DemoUI } from './ui.js';
import { createGameScene } from './gameScene.js';
import { GameControls } from './gameControls.js';
import { FrameMeter } from './frameMeter.js';
import { createForestScene } from './forestScene.js';
import { ForestRenderer } from './ForestRenderer.js';

const ui = new DemoUI();
const canvas = document.querySelector('#viewport');

let renderer;
let camera;
let controls;
let pipeline = null;
let activeSource = null;
let activeMode = null;
let rebuildGeneration = 0;
let gameControls = null;
let activeWorld = null;
let sceneBuilding = true;
let lastFrameAt = null;
const frameMeter = new FrameMeter(sample => ui.updateFps(sample));
ui.onRenderModeChange = async () => {
  frameMeter.reset(); ui.clearFps();
  if (!activeSource || sceneBuilding) return;
  const mode = ui.elements.renderMode.value;
  if (mode === 'full' || mode === activeMode) {
    pipeline.setNaniteEnabled(mode !== 'full');
    ui.syncRendererControls();
    return;
  }
  try {
    await rebuildScene(activeSource.geometry, activeSource.displayName, activeSource.world, true);
  } catch (error) {
    ui.elements.renderMode.value = activeMode;
    ui.bindPipeline(pipeline);
    ui.hideLoading(); sceneBuilding = false;
    gameControls?.setEnabled(!controls.enabled);
    window.alert(`Unable to build ${mode}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const mobileProfile = window.matchMedia('(pointer: coarse)').matches;
const pixelRatioLimit = mobileProfile ? 1 : 2;
ui.elements.geometryDensity.value = mobileProfile ? 'high' : 'ultra';

function resetCamera() {
  if (activeWorld) {
    if (gameControls?.enabled) gameControls.reset();
    else {
      camera.position.set(35, 36, 48);
      controls.target.set(0, 5, -20);
      controls.update();
    }
    pipeline?.invalidateOcclusionHistory();
    return;
  }
  camera.position.set(0, 21, 55);
  controls.target.set(0, 1.5, -7);
  controls.update();
  pipeline?.invalidateOcclusionHistory();
}

function createDefaultGeometry() {
  // 65,536 source triangles before instancing. The browser builds six LODs and
  // 64/64 meshlets from this geometry at startup.
  return normaliseGeometry(
    new THREE.TorusKnotGeometry(1.25, 0.42, 512, 64, 2, 3)
  );
}

function triangleCountForMesh(mesh) {
  const geometry = mesh.geometry;
  if (!geometry?.getAttribute('position')) return 0;
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

async function geometryFromGlb(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const gltf = await new GLTFLoader().loadAsync(objectUrl);
    gltf.scene.updateMatrixWorld(true);

    let selectedMesh = null;
    let selectedTriangleCount = 0;

    gltf.scene.traverse((child) => {
      if (!child.isMesh || child.isSkinnedMesh) return;
      const triangles = triangleCountForMesh(child);
      if (triangles > selectedTriangleCount) {
        selectedMesh = child;
        selectedTriangleCount = triangles;
      }
    });

    if (!selectedMesh) {
      throw new Error('The GLB does not contain a supported static triangle mesh.');
    }

    const geometry = selectedMesh.geometry.clone();
    geometry.applyMatrix4(selectedMesh.matrixWorld);

    return {
      geometry: normaliseGeometry(geometry),
      displayName: `${file.name} · ${new Intl.NumberFormat('en-AU').format(selectedTriangleCount)} triangles`
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function rebuildScene(geometry, displayName, world = null, preserveCamera = false) {
  if(ui.elements.renderMode.value==='bitmask'&&!world?.forest)ui.elements.renderMode.value='hierarchy';
  const selectedMode=ui.elements.renderMode.value;
  const mode = ui.elements.renderMode.value === 'auto' || ui.elements.renderMode.value === 'full' ? 'auto' : 'hierarchy';
  const sourceRecord = preserveCamera ? activeSource : { geometry, displayName, world, assets: new Map() };
  const wasWalking = gameControls?.enabled;
  const generation = ++rebuildGeneration;
  sceneBuilding = true;
  frameMeter.reset();
  ui.clearFps();
  gameControls?.setEnabled(false);

  ui.showLoading(`Building ${mode === 'hierarchy' ? 'cluster hierarchy' : 'Patch LOD'}`, 'Preparing source geometry…');
  ui.setAssetName(displayName);

  // Yield once so the loading overlay is painted before CPU-side mesh building.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const buildAsset = mode === 'hierarchy' ? buildHierarchyAsset : buildNaniteLiteAsset;
  const cached = sourceRecord.assets.get(mode);
  const asset = cached?.asset ?? await buildAsset(geometry, {
    meshletsPerGroup: world ? 64 : 16,
    onProgress(title, detail) {
      if (generation === rebuildGeneration) ui.updateLoading(title, detail);
    }
  });

  if (generation !== rebuildGeneration) { geometry.dispose(); return; }

  let nextPipeline;
  if (world?.forest) {
    const treeAsset = cached?.treeAsset ?? await buildAsset(world.treeGeometry, {
      meshletsPerGroup: 64,
      onProgress(title, detail) { ui.updateLoading(`Forest · ${title}`, detail); }
    });
    if (generation !== rebuildGeneration) { geometry.dispose(); world.treeGeometry.dispose(); return; }
    nextPipeline = new ForestRenderer(renderer, camera, asset, treeAsset, world, stats => ui.updateStats(stats), {bitmask:selectedMode==='bitmask'});
    try { await nextPipeline.initBitmask(); } catch(error) { nextPipeline.dispose(); throw error; }
    sourceRecord.assets.set(mode, { asset, treeAsset });
  } else {
    sourceRecord.assets.set(mode, { asset });
    nextPipeline = new NaniteLiteRenderer(renderer, camera, asset, {
    sourceGeometry: geometry,
    gridSize: world ? 1 : mobileProfile ? 7 : 14,
    gameScene: Boolean(world),
    maxVisibleClusters: mobileProfile ? 8192 : 16384,
    onStats: (stats) => ui.updateStats(stats)
  });

  }

  pipeline?.dispose();
  pipeline = nextPipeline;
  activeMode = selectedMode==='bitmask'?'bitmask':mode;
  if (!preserveCamera) {
    if (activeSource) {
      activeSource.geometry.dispose(); activeSource.world?.treeGeometry?.dispose();
    }
    gameControls?.dispose();
    gameControls = null;
    activeWorld = world;
    controls.enabled = !world;
    if (world) {
      gameControls = new GameControls(camera, canvas, world, ui.gameElements);
      gameControls.setEnabled(true);
    }
    ui.setGameScene(Boolean(world), Boolean(world?.forest));
  } else gameControls?.setEnabled(wasWalking);
  activeSource = sourceRecord;
  ui.bindPipeline(pipeline);
  ui.createLodBars(asset.lods.length);
  if (!preserveCamera) resetCamera();
  ui.hideLoading();
  sceneBuilding = false;
  frameMeter.reset();

  console.table(
    asset.lods.map((lod) => ({
      lod: lod.level,
      geometricError: lod.geometricError,
      triangles: lod.triangleCount,
      meshlets: lod.clusterCount
    }))
  );
}

async function initialise() {
  if (!WebGPU.isAvailable()) {
    throw new Error(
      'WebGPU is unavailable on this browser or device. Open this HTTPS page in a WebGPU-capable browser.'
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter || adapter.limits.maxStorageBuffersPerShaderStage < 12) {
    throw new Error('This device cannot run the geometry compute pipeline. It requires WebGPU with at least 12 storage buffers per shader stage.');
  }

  renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    requiredLimits: { maxStorageBuffersPerShaderStage: 12 }
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioLimit));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  ui.updateLoading('Initialising WebGPU', 'Creating the Three.js WebGPU backend…');
  await renderer.init();
  renderer.backend.device.addEventListener('uncapturederror', event => {
    if(activeMode==='bitmask'){sceneBuilding=true;ui.showFatalError(event.error);}
  });
  renderer.backend.device.lost.then(info => {
    sceneBuilding=true;
    ui.showFatalError(new Error(`WebGPU device lost: ${info.message}. Reload to choose another mode.`));
  });

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    500
  );

  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();

  controls = new OrbitControls(camera, canvas);
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 4;
  controls.maxDistance = 150;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.screenSpacePanning = false;

  resetCamera();

  renderer.setAnimationLoop((time) => {
    const dt = lastFrameAt === null ? 0 : (time - lastFrameAt) / 1000;
    lastFrameAt = time;
    if (controls.enabled) controls.update();
    if (!sceneBuilding) gameControls?.update(dt);
    let submitted;
    try { if (!sceneBuilding) submitted=pipeline?.render(time); }
    catch(error) { sceneBuilding=true; ui.showFatalError(error); }
    const active=Boolean(pipeline)&&!sceneBuilding&&!document.hidden;
    if(!active)frameMeter.tick(time,false);
    else if(submitted!==false)frameMeter.tick(time,true);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioLimit));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    pipeline?.resize();
  });

  document.addEventListener('visibilitychange', () => { frameMeter.reset(); lastFrameAt = null; });
  ui.onResetCamera = resetCamera;
  ui.onNavigationMode = walking => {
    if (!gameControls) return;
    gameControls.setEnabled(walking);
    controls.enabled = !walking;
    resetCamera();
  };
  ui.onForest = async () => {
    try {
      ui.showLoading('Preparing forest', 'Building detailed branches, foliage and terrain…');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const world = createForestScene(ui.elements.geometryDensity.value);
      const triangles = world.geometry.index.count / 3 + world.treeGeometry.index.count / 3 * world.treeInstances.length / 4;
      await rebuildScene(world.geometry, `Emerald Basin · ${world.treeInstances.length / 4} trees · ${(triangles/1e6).toFixed(1)}M source triangles`, world);
    } catch (error) { ui.showFatalError(error); }
  };
  ui.onTerrain = async () => {
    try {
      ui.showLoading('Preparing landscape', 'Generating the selected geometry density…');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const world = createGameScene(mobileProfile, ui.elements.geometryDensity.value);
      await rebuildScene(world.geometry, 'Mountain terrain sample', world);
    } catch (error) { ui.showFatalError(error); }
  };
  ui.onRestoreDefault = async () => {
    try {
      await rebuildScene(createDefaultGeometry(), 'Procedural torus knot');
    } catch (error) {
      ui.showFatalError(error);
    }
  };

  ui.onAssetFile = async (file) => {
    try {
      ui.showLoading('Loading GLB', `Reading ${file.name}…`);
      const loaded = await geometryFromGlb(file);
      await rebuildScene(loaded.geometry, loaded.displayName);
    } catch (error) {
      console.error(error);
      ui.hideLoading();
      sceneBuilding = false;
      if (activeWorld) gameControls?.setEnabled(true);
      ui.setStatus('GLB load failed', true);
      window.alert(`Unable to load ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Comparison links start in the same forest, camera and raster mode.
  if(new URLSearchParams(location.search).has('bitmaskReference'))ui.elements.renderMode.value='bitmask';
  await ui.onForest();
}

initialise().catch((error) => {
  console.error(error);
  ui.showFatalError(error);
});
