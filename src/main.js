import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';

import './styles.css';
import {
  buildNaniteLiteAsset,
  normaliseGeometry
} from './buildNaniteLiteAsset.js';
import { NaniteLiteRenderer } from './NaniteLiteRenderer.js';
import { DemoUI } from './ui.js';

const ui = new DemoUI();
const canvas = document.querySelector('#viewport');

let renderer;
let camera;
let controls;
let pipeline = null;
let rebuildGeneration = 0;

function resetCamera() {
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

async function rebuildScene(geometry, displayName) {
  const generation = ++rebuildGeneration;

  ui.showLoading('Building Nanite Lite asset', 'Preparing source geometry…');
  ui.setAssetName(displayName);

  // Yield once so the loading overlay is painted before CPU-side mesh building.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const asset = await buildNaniteLiteAsset(geometry, {
    onProgress(title, detail) {
      if (generation === rebuildGeneration) ui.updateLoading(title, detail);
    }
  });

  if (generation !== rebuildGeneration) return;

  pipeline?.dispose();
  pipeline = new NaniteLiteRenderer(renderer, camera, asset, {
    onStats: (stats) => ui.updateStats(stats)
  });

  ui.createLodBars(asset.lods.length);
  ui.bindPipeline(pipeline);
  resetCamera();
  ui.hideLoading();

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
    document.body.appendChild(WebGPU.getErrorMessage());
    throw new Error(
      'WebGPU is unavailable. Use a current Chrome or Edge build with WebGPU enabled.'
    );
  }

  renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    requiredLimits: { maxStorageBuffersPerShaderStage: 12 }
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  ui.updateLoading('Initialising WebGPU', 'Creating the Three.js WebGPU backend…');
  await renderer.init();

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    500
  );

  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 4;
  controls.maxDistance = 150;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.screenSpacePanning = false;

  resetCamera();

  renderer.setAnimationLoop((time) => {
    controls.update();
    pipeline?.render(time);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    pipeline?.resize();
  });

  ui.onResetCamera = resetCamera;
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
      ui.setStatus('GLB load failed', true);
      window.alert(`Unable to load ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await rebuildScene(createDefaultGeometry(), 'Procedural torus knot');
}

initialise().catch((error) => {
  console.error(error);
  ui.showFatalError(error);
});
