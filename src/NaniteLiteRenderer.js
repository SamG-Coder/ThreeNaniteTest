import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicStore,
  bool,
  cameraViewMatrix,
  ceil,
  clamp,
  color,
  cos,
  distance,
  dot,
  float,
  floor,
  instanceIndex,
  int,
  length,
  log2,
  mat4,
  max,
  min,
  mix,
  normalize,
  screenSize,
  sin,
  storage,
  texture,
  uint,
  uv,
  uniform,
  uniformArray,
  uvec2,
  varyingProperty,
  vec4,
  vertexIndex
} from 'three/tsl';

import {
  DEFAULT_LOD_THRESHOLD,
  DEFAULT_OCCLUSION_BIAS,
  INSTANCE_GRID_SIZE,
  INSTANCE_SPACING,
  MAX_HZB_LEVELS,
  MAX_VISIBLE_CLUSTERS,
  MESHLET_MAX_TRIANGLES,
  VERTICES_PER_MESHLET
} from './config.js';

function createInstanceData(gridSize, spacing) {
  const instanceCount = gridSize * gridSize;
  const data = new Float32Array(instanceCount * 4);
  const half = (gridSize - 1) * 0.5;
  let offset = 0;

  for (let z = 0; z < gridSize; z += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const wobble = Math.sin(x * 1.77 + z * 0.63) * 0.18;
      const scale = 0.86 + ((x * 13 + z * 7) % 9) * 0.025;

      data[offset++] = (x - half) * spacing;
      data[offset++] = 1.65 + wobble;
      data[offset++] = (z - half) * spacing;
      data[offset++] = scale;
    }
  }

  return data;
}

function disposeMaterial(material) {
  if (material && typeof material.dispose === 'function') material.dispose();
}

export class NaniteLiteRenderer {
  constructor(renderer, camera, asset, options = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.asset = asset;
    this.gameScene = Boolean(options.gameScene);
    this.sourceColors = options.sourceGeometry?.getAttribute('color');

    this.maxVisibleClusters = options.maxVisibleClusters ?? MAX_VISIBLE_CLUSTERS;
    this.gridSize = options.gridSize ?? INSTANCE_GRID_SIZE;
    this.spacing = options.spacing ?? INSTANCE_SPACING;
    this.customInstanceData = options.instanceData ?? null;
    this.instanceCount = this.customInstanceData ? this.customInstanceData.length / 4 : this.gridSize * this.gridSize;
    this.onStats = options.onStats ?? (() => {});
    if (Math.ceil(this.instanceCount * asset.groupCount / 64) > 65535) {
      throw new Error('Asset group count exceeds the single-dispatch limit. Reduce mesh complexity or instance count.');
    }

    this.settings = {
      lodThreshold: options.lodThreshold ?? DEFAULT_LOD_THRESHOLD,
      occlusionEnabled: options.occlusionEnabled ?? false,
      coneEnabled: options.coneEnabled ?? true,
      outputMode: options.outputMode ?? 'shaded',
      naniteEnabled: true
    };

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d14);

    this.frustum = new THREE.Frustum();
    this.projScreenMatrix = new THREE.Matrix4();
    this.cameraInverse = new THREE.Matrix4();
    this.previousProjScreenMatrix = new THREE.Matrix4();
    this.previousCameraPosition = new THREE.Vector3();
    this.previousCameraQuaternion = new THREE.Quaternion();
    this.previousFrameValid = false;

    this.lastReadbackAt = 0;
    this.readbackInFlight = false;
    this.disposableAttributes = [];
    this.computeNodes = [];

    this.createStaticScene();
    if (this.gameScene) {
      this.floor.visible = false;
      this.occluderGroup.visible = false;
      this.scene.background = new THREE.Color(0xabc6d1);
      this.scene.fog = new THREE.Fog(0xabc6d1, 55, 155);
    }
    this.createScreenResources();
    this.createGpuPipeline();
    this.createBaselineMesh(options.sourceGeometry);
    this.setOutputMode(this.settings.outputMode);
  }

  createStaticScene() {
    const hemisphere = new THREE.HemisphereLight(0xb9d8ff, 0x20222a, 2.1);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight(0xfff0d7, 4.3);
    key.position.set(12, 22, 18);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x7ba8ff, 2.0);
    rim.position.set(-20, 10, -18);
    this.scene.add(rim);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x111923,
      roughness: 0.86,
      metalness: 0.04
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), floorMaterial);
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = 0;
    this.scene.add(floor);
    this.floor = floor;

    const occluderMaterial = new THREE.MeshStandardMaterial({
      color: 0x273548,
      roughness: 0.48,
      metalness: 0.18
    });

    this.occluderGroup = new THREE.Group();
    const occluders = [
      { size: [12, 7, 1.6], position: [-9.5, 3.5, 4.5] },
      { size: [12, 7, 1.6], position: [9.5, 3.5, 4.5] },
      { size: [4.2, 11, 3.0], position: [0, 5.5, 2.8] }
    ];

    for (const definition of occluders) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...definition.size),
        occluderMaterial
      );
      mesh.position.set(...definition.position);
      this.occluderGroup.add(mesh);
    }

    this.scene.add(this.occluderGroup);
  }

  createRenderTarget(width, height) {
    const target = new THREE.RenderTarget(width, height, {
      type: THREE.HalfFloatType
    });
    target.depthTexture = new THREE.DepthTexture(width, height);
    target.depthTexture.type = THREE.FloatType;
    return target;
  }

  createScreenResources() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);

    this.sceneTarget = this.createRenderTarget(size.x, size.y);

    this.hzbLevelTable = uniformArray(
      Array.from({ length: MAX_HZB_LEVELS }, () => new THREE.Vector4()),
      'vec4'
    );
    this.hzbLevelCountUniform = uniform(0.0);

    this.rebuildHzbStorage(size.x, size.y, true);

    this.depthSourceTextureNode = texture(this.sceneTarget.depthTexture);
    this.blitTextureNode = texture(this.sceneTarget.texture);

    const blitMaterial = new THREE.NodeMaterial();
    blitMaterial.colorNode = this.blitTextureNode;
    this.blitQuad = new THREE.QuadMesh(blitMaterial);
    this.blitMaterial = blitMaterial;

    this.createHzbKernels();
  }

  rebuildHzbStorage(width, height, firstBuild = false) {
    let levelWidth = Math.max(1, Math.ceil(width / 2));
    let levelHeight = Math.max(1, Math.ceil(height / 2));
    let totalTexels = 0;
    let levelCount = 0;

    while (levelCount < MAX_HZB_LEVELS) {
      this.hzbLevelTable.array[levelCount].set(
        totalTexels,
        levelWidth,
        levelHeight,
        0
      );

      totalTexels += levelWidth * levelHeight;
      levelCount += 1;

      if (levelWidth === 1 && levelHeight === 1) break;
      levelWidth = Math.max(1, Math.ceil(levelWidth / 2));
      levelHeight = Math.max(1, Math.ceil(levelHeight / 2));
    }

    for (let i = levelCount; i < MAX_HZB_LEVELS; i += 1) {
      this.hzbLevelTable.array[i].set(totalTexels, 1, 1, 0);
    }

    this.hzbLevelCount = levelCount;
    this.hzbLevelCountUniform.value = levelCount;

    const hzbData = new Float32Array(totalTexels).fill(1);
    const nextAttribute = new THREE.StorageBufferAttribute(hzbData, 1);

    if (firstBuild) {
      this.hzbAttribute = nextAttribute;
      this.hzbBuffer = storage(nextAttribute, 'float', totalTexels);
      this.hzbRead = storage(nextAttribute, 'float', totalTexels).toReadOnly();
    } else {
      this.hzbAttribute?.dispose();
      this.hzbAttribute = nextAttribute;
      this.hzbBuffer.value = nextAttribute;
      this.hzbBuffer.bufferCount = totalTexels;
      this.hzbRead.value = nextAttribute;
      this.hzbRead.bufferCount = totalTexels;
    }
  }

  createHzbKernels() {
    const hzbBuffer = this.hzbBuffer;
    const hzbLevelTable = this.hzbLevelTable;
    const depthSourceTextureNode = this.depthSourceTextureNode;

    this.hzbKernels = [];

    for (let level = 0; level < MAX_HZB_LEVELS; level += 1) {
      const initial = this.hzbLevelTable.array[Math.min(level, this.hzbLevelCount - 1)];

      const kernel = Fn(() => {
        const info = hzbLevelTable.element(level);
        const currentWidth = uint(info.y);
        const currentHeight = uint(info.z);
        const currentOffset = uint(info.x);

        If(instanceIndex.lessThan(currentWidth.mul(currentHeight)), () => {
          const x = instanceIndex.mod(currentWidth);
          const y = instanceIndex.div(currentWidth);
          const sourceX = x.mul(2);
          const sourceY = y.mul(2);
          const depthMax = float(0.0).toVar();

          if (level === 0) {
            const sourceWidthMax = uint(screenSize.x).sub(1);
            const sourceHeightMax = uint(screenSize.y).sub(1);

            for (let dy = 0; dy < 2; dy += 1) {
              for (let dx = 0; dx < 2; dx += 1) {
                depthMax.assign(
                  max(
                    depthMax,
                    depthSourceTextureNode.load(
                      uvec2(
                        min(sourceX.add(dx), sourceWidthMax),
                        min(sourceY.add(dy), sourceHeightMax)
                      )
                    ).r
                  )
                );
              }
            }
          } else {
            const sourceInfo = hzbLevelTable.element(level - 1);
            const sourceWidth = uint(sourceInfo.y);
            const sourceHeight = uint(sourceInfo.z);
            const sourceOffset = uint(sourceInfo.x);
            const sourceWidthMax = sourceWidth.sub(1);
            const sourceHeightMax = sourceHeight.sub(1);

            for (let dy = 0; dy < 2; dy += 1) {
              for (let dx = 0; dx < 2; dx += 1) {
                const sampleX = min(sourceX.add(dx), sourceWidthMax);
                const sampleY = min(sourceY.add(dy), sourceHeightMax);
                const sampleOffset = sourceOffset
                  .add(sampleY.mul(sourceWidth))
                  .add(sampleX);
                depthMax.assign(max(depthMax, hzbBuffer.element(sampleOffset)));
              }
            }
          }

          hzbBuffer
            .element(currentOffset.add(y.mul(currentWidth)).add(x))
            .assign(depthMax);
        });
      })()
        .compute(initial.y * initial.z, [64])
        .setName(`Nanite Lite HZB ${level}`);

      this.hzbKernels.push(kernel);
      this.computeNodes.push(kernel);
    }
  }

  createGpuPipeline() {
    const asset = this.asset;

    const createStorageAttribute = (array, itemSize) => {
      const attribute = new THREE.StorageBufferAttribute(array, itemSize);
      this.disposableAttributes.push(attribute);
      return attribute;
    };

    const vertexAttribute = createStorageAttribute(asset.vertices, 4);
    const normalAttribute = createStorageAttribute(asset.normals, 4);
    const uvAttribute = createStorageAttribute(asset.uvs, 2);
    const indexAttribute = createStorageAttribute(asset.indices, 1);
    const boundsAttribute = createStorageAttribute(asset.clusterBounds, 4);
    const coneApexAttribute = createStorageAttribute(asset.clusterConeApex, 4);
    const coneAxisAttribute = createStorageAttribute(asset.clusterConeAxis, 4);
    const clusterLodAttribute = createStorageAttribute(asset.clusterLod, 1);

    const vertexBuffer = storage(vertexAttribute, 'vec4', asset.vertexCount).toReadOnly();
    const normalBuffer = storage(normalAttribute, 'vec4', asset.vertexCount).toReadOnly();
    const uvBuffer = storage(uvAttribute, 'vec2', asset.vertexCount).toReadOnly();
    const indexBuffer = storage(indexAttribute, 'uint', asset.indices.length).toReadOnly();
    const clusterBoundsBuffer = storage(boundsAttribute, 'vec4', asset.totalClusters).toReadOnly();
    const clusterConeApexBuffer = storage(coneApexAttribute, 'vec4', asset.totalClusters).toReadOnly();
    const clusterConeAxisBuffer = storage(coneAxisAttribute, 'vec4', asset.totalClusters).toReadOnly();
    const clusterLodBuffer = storage(clusterLodAttribute, 'uint', asset.totalClusters).toReadOnly();

    const groupBoundsBuffer = storage(
      createStorageAttribute(asset.groupBounds, 4), 'vec4', asset.groupCount
    ).toReadOnly();
    const groupLodBuffer = storage(
      createStorageAttribute(asset.groupLods, 4), 'vec4', asset.groupCount * asset.lods.length
    ).toReadOnly();

    const instanceData = this.customInstanceData ?? (this.gameScene
      ? new Float32Array([0, 0, 0, 1])
      : createInstanceData(this.gridSize, this.spacing));
    this.instanceDataAttribute = createStorageAttribute(instanceData, 4);
    const instanceDataBuffer = storage(
      this.instanceDataAttribute,
      'vec4',
      this.instanceCount
    ).toReadOnly();

    this.instanceWorldAttribute = createStorageAttribute(
      new Float32Array(this.instanceCount * 16),
      16
    );
    const instanceWorldBuffer = storage(
      this.instanceWorldAttribute,
      'mat4',
      this.instanceCount
    );
    const instanceWorldRead = storage(
      this.instanceWorldAttribute,
      'mat4',
      this.instanceCount
    ).toReadOnly();

    this.visibleClustersAttribute = createStorageAttribute(
      new Uint32Array(this.maxVisibleClusters * 2),
      2
    );
    const visibleClustersWrite = storage(
      this.visibleClustersAttribute,
      'uvec2',
      this.maxVisibleClusters
    );
    const visibleClustersRead = storage(
      this.visibleClustersAttribute,
      'uvec2',
      this.maxVisibleClusters
    ).toReadOnly();

    this.visibleCountAttribute = createStorageAttribute(new Uint32Array(1), 1);
    const visibleCountAtomic = storage(this.visibleCountAttribute, 'uint', 1).toAtomic();
    const visibleCountRead = storage(this.visibleCountAttribute, 'uint', 1).toReadOnly();

    this.overflowAttribute = createStorageAttribute(new Uint32Array(1), 1);
    const overflowAtomic = storage(this.overflowAttribute, 'uint', 1).toAtomic();

    this.lodCounterAttribute = createStorageAttribute(
      new Uint32Array(asset.lods.length),
      1
    );
    const lodCounterAtomic = storage(
      this.lodCounterAttribute,
      'uint',
      asset.lods.length
    ).toAtomic();

    this.drawIndirectAttribute = new THREE.IndirectStorageBufferAttribute(
      new Uint32Array(4),
      4
    );
    this.disposableAttributes.push(this.drawIndirectAttribute);
    const drawIndirectBuffer = storage(this.drawIndirectAttribute, 'uint', 4);

    this.projScreenMatrixUniform = uniform(new THREE.Matrix4());
    this.previousProjScreenUniform = uniform(new THREE.Matrix4());
    this.cameraPositionUniform = uniform(new THREE.Vector3());
    this.previousCameraPositionUniform = uniform(new THREE.Vector3());
    this.frustumPlanesUniform = uniformArray(
      [
        new THREE.Vector4(),
        new THREE.Vector4(),
        new THREE.Vector4(),
        new THREE.Vector4(),
        new THREE.Vector4(),
        new THREE.Vector4()
      ],
      'vec4'
    );
    this.cotHalfFovUniform = uniform(1.0);
    this.lodThresholdUniform = uniform(this.settings.lodThreshold);
    this.occlusionBiasUniform = uniform(DEFAULT_OCCLUSION_BIAS);
    this.occlusionEnabledUniform = uniform(0, 'uint');
    this.coneEnabledUniform = uniform(this.settings.coneEnabled ? 1 : 0, 'uint');
    this.hzbValidUniform = uniform(0, 'uint');

    const sphereOccluded = (centre, radius) => {
      const toCamera = this.previousCameraPositionUniform.sub(centre);
      const rawDistance = length(toCamera);
      const safeDistance = max(rawDistance, 0.001);
      const nearPoint = centre.add(toCamera.div(safeDistance).mul(radius));
      const nearClip = this.previousProjScreenUniform.mul(vec4(nearPoint, 1.0));
      const centreClip = this.previousProjScreenUniform.mul(vec4(centre, 1.0));
      const nearestZ = nearClip.z.div(nearClip.w);
      const ndc = centreClip.xy.div(centreClip.w);

      const radiusTexels = radius
        .mul(this.cotHalfFovUniform)
        .mul(float(screenSize.y))
        .div(4.0)
        .div(safeDistance);

      const level = int(
        clamp(
          ceil(log2(max(radiusTexels.mul(2.0), 1.0))),
          0.0,
          this.hzbLevelCountUniform.sub(1.0)
        )
      );

      const info = this.hzbLevelTable.element(level);
      const levelWidth = uint(info.y);
      const levelHeight = uint(info.z);
      const levelOffset = uint(info.x);

      const pixelX = ndc.x.mul(0.5).add(0.5).mul(float(levelWidth));
      const pixelY = float(0.5).sub(ndc.y.mul(0.5)).mul(float(levelHeight));

      const x0 = uint(clamp(pixelX.sub(0.5), 0.0, float(levelWidth.sub(1))));
      const y0 = uint(clamp(pixelY.sub(0.5), 0.0, float(levelHeight.sub(1))));
      const x1 = min(x0.add(1), levelWidth.sub(1));
      const y1 = min(y0.add(1), levelHeight.sub(1));

      const sample = (x, y) =>
        this.hzbRead.element(levelOffset.add(y.mul(levelWidth)).add(x));

      const maximumDepth = max(
        max(sample(x0, y0), sample(x1, y0)),
        max(sample(x0, y1), sample(x1, y1))
      );

      return rawDistance
        .greaterThan(radius.mul(2.0))
        .and(nearClip.w.greaterThan(0.0))
        .and(centreClip.w.greaterThan(0.0))
        .and(nearestZ.greaterThan(maximumDepth.add(this.occlusionBiasUniform)));
    };

    this.computeClear = Fn(() => {
      If(instanceIndex.equal(0), () => {
        atomicStore(visibleCountAtomic.element(0), uint(0));
        atomicStore(overflowAtomic.element(0), uint(0));
      });

      If(instanceIndex.lessThan(asset.lods.length), () => {
        atomicStore(lodCounterAtomic.element(instanceIndex), uint(0));
      });
    })()
      .compute(Math.max(asset.lods.length, 1), [64])
      .setName('Nanite Lite Clear');

    const frustumPlanesUniform = this.frustumPlanesUniform;
    const cameraPositionUniform = this.cameraPositionUniform;
    const lodThresholdUniform = this.lodThresholdUniform;
    const occlusionEnabledUniform = this.occlusionEnabledUniform;
    const coneEnabledUniform = this.coneEnabledUniform;
    const hzbValidUniform = this.hzbValidUniform;
    const maxVisibleClusters = this.maxVisibleClusters;
    const lods = asset.lods;

    this.computeCull = Fn(() => {
      const instanceId = asset.hierarchy ? instanceIndex : instanceIndex.div(uint(asset.groupCount));
      const initialGroup = asset.hierarchy ? uint(0) : instanceIndex.mod(uint(asset.groupCount));
      const data = instanceDataBuffer.element(instanceId);
      const position = data.xyz;
      const scale = data.w;
      const rotation = float(instanceId).mul(0.61803398875);
      const c = cos(rotation);
      const s = sin(rotation);

      const worldMatrix = mat4(
        vec4(c.mul(scale), 0.0, s.mul(scale), 0.0),
        vec4(0.0, scale, 0.0, 0.0),
        vec4(s.negate().mul(scale), 0.0, c.mul(scale), 0.0),
        vec4(position, 1.0)
      );

      // Exactly one writer per matrix; all groups use the identical transform.
      If(initialGroup.equal(0), () => { instanceWorldBuffer.element(instanceId).assign(worldMatrix); });
      const nextNode = uint(0).toVar();
      const processGroup = groupId => {
        if (asset.hierarchy) nextNode.assign(uint(groupLodBuffer.element(groupId.mul(6).add(1)).x));
        const groupBounds = groupBoundsBuffer.element(groupId);
        const groupCentre = worldMatrix.mul(vec4(groupBounds.xyz, 1.0)).xyz.toVar();

        const instanceVisible = bool(true).toVar();
        const instanceRadius = scale.mul(groupBounds.w);

        Loop({ start: 0, end: 6 }, ({ i: planeIndex }) => {
          const plane = frustumPlanesUniform.element(planeIndex);
          const planeDistance = dot(plane.xyz, groupCentre).add(plane.w);

          If(planeDistance.lessThan(instanceRadius.negate()), () => {
            instanceVisible.assign(false);
          });
        });

        If(
          instanceVisible
            .and(occlusionEnabledUniform.equal(1))
            .and(hzbValidUniform.equal(1)),
          () => {
            instanceVisible.assign(sphereOccluded(groupCentre, instanceRadius).not());
          }
        );

        If(instanceVisible, () => {
          const distanceToSurface = max(
            0.01,
            (asset.hierarchy
              ? this.projScreenMatrixUniform.mul(vec4(groupCentre, 1.0)).w
              : distance(cameraPositionUniform, groupCentre)).sub(instanceRadius)
          );
          const pixelFactor = this.cotHalfFovUniform
            .div(distanceToSurface)
            .mul(float(screenSize.y))
            .div(2.0);

          const lodLevel = uint(0).toVar();
          let selection = null;

          for (let level = asset.hierarchy ? 0 : lods.length - 1; level > 0; level -= 1) {
            const acceptable = groupLodBuffer.element(groupId.mul(lods.length).add(level)).x
              .mul(scale)
              .mul(pixelFactor)
              .lessThanEqual(lodThresholdUniform);

            if (selection === null) {
              selection = If(acceptable, () => { lodLevel.assign(level); });
            } else {
              selection = selection.ElseIf(acceptable, () => { lodLevel.assign(level); });
            }
          }

          const lodData = groupLodBuffer.element(groupId.mul(lods.length).add(asset.hierarchy ? uint(0) : lodLevel));
          const clusterStart = uint(lodData.y);
          const clusterCount = uint(lodData.z).toVar();
          if (asset.hierarchy) {
            const traversal = groupLodBuffer.element(groupId.mul(6).add(1));
            lodLevel.assign(uint(traversal.z));
            If(traversal.y.greaterThan(0).and(lodData.x.mul(scale).mul(pixelFactor).greaterThan(lodThresholdUniform)), () => {
              // Refine the whole replacement group. Descendants are never drawn
              // together with an accepted parent; rejected subtrees use escape.
              clusterCount.assign(0);
              nextNode.assign(groupId.add(1));
            });
          }

          Loop(
            {
              name: 'localCluster',
              type: 'uint',
              start: uint(0),
              end: clusterCount,
              condition: '<'
            },
            ({ localCluster }) => {
              const clusterId = clusterStart.add(uint(localCluster));
              const bounds = clusterBoundsBuffer.element(clusterId);
              const localCentre = bounds.xyz;
              const worldCentre = worldMatrix.mul(vec4(localCentre, 1.0)).xyz.toVar();
              const worldRadius = bounds.w.mul(scale).toVar();
              const clusterVisible = bool(true).toVar();

              Loop({ name: 'clusterPlane', start: 0, end: 6 }, ({ clusterPlane }) => {
                const plane = frustumPlanesUniform.element(clusterPlane);
                const planeDistance = dot(plane.xyz, worldCentre).add(plane.w);

                If(planeDistance.lessThan(worldRadius.negate()), () => {
                  clusterVisible.assign(false);
                });
              });

              If(clusterVisible.and(coneEnabledUniform.equal(1)), () => {
                const coneApex = clusterConeApexBuffer.element(clusterId);
                const coneAxis = clusterConeAxisBuffer.element(clusterId);
                const worldApex = worldMatrix.mul(vec4(coneApex.xyz, 1.0)).xyz;
                const worldAxis = normalize(worldMatrix.mul(vec4(coneAxis.xyz, 0.0)).xyz);
                const cameraToApex = normalize(worldApex.sub(cameraPositionUniform));

                If(coneApex.w.greaterThanEqual(0.0)
                  .and(coneApex.w.lessThan(1.0))
                  .and(dot(coneAxis.xyz, coneAxis.xyz).greaterThan(0.5))
                  .and(dot(cameraToApex, worldAxis).greaterThanEqual(coneApex.w)), () => {
                  clusterVisible.assign(false);
                });
              });

              If(
                clusterVisible
                  .and(occlusionEnabledUniform.equal(1))
                  .and(hzbValidUniform.equal(1)),
                () => {
                  clusterVisible.assign(sphereOccluded(worldCentre, worldRadius).not());
                }
              );

              If(clusterVisible, () => {
                const slot = atomicAdd(visibleCountAtomic.element(0), uint(1));

                If(slot.lessThan(maxVisibleClusters), () => {
                  visibleClustersWrite
                    .element(slot)
                    .assign(uvec2(instanceId, clusterId));
                  atomicAdd(lodCounterAtomic.element(lodLevel), uint(1));
                }).Else(() => {
                  atomicStore(overflowAtomic.element(0), uint(1));
                });
              });
            }
          );
        });
      };
      if (asset.hierarchy) {
        const node = uint(0).toVar();
        Loop(node.lessThan(uint(asset.groupCount)), () => {
          processGroup(node);
          node.assign(nextNode);
        });
      } else processGroup(initialGroup);
    })()
      .compute(this.instanceCount * (asset.hierarchy ? 1 : asset.groupCount), [64])
      .setName(asset.hierarchy ? 'Nanite Hierarchy Traversal' : 'Auto LOD Group Cull');

    this.computeDrawArguments = Fn(() => {
      const visibleCount = min(
        visibleCountRead.element(0),
        uint(this.maxVisibleClusters)
      );

      drawIndirectBuffer
        .element(0)
        .assign(visibleCount.mul(VERTICES_PER_MESHLET));
      drawIndirectBuffer.element(1).assign(uint(1));
      drawIndirectBuffer.element(2).assign(uint(0));
      drawIndirectBuffer.element(3).assign(uint(0));
    })()
      .compute(1)
      .setName('Nanite Lite Draw Arguments');

    this.computeNodes.push(
      this.computeClear,
      this.computeCull,
      this.computeDrawArguments
    );

    this.createDrawMesh({
      vertexBuffer,
      normalBuffer,
      uvBuffer,
      indexBuffer,
      clusterLodBuffer,
      visibleClustersRead,
      instanceWorldRead
    });
  }

  createDrawMesh(buffers) {
    const {
      vertexBuffer,
      normalBuffer,
      uvBuffer,
      indexBuffer,
      clusterLodBuffer,
      visibleClustersRead,
      instanceWorldRead
    } = buffers;

    let colorBuffer = null;
    if (this.sourceColors) {
      const colors = new Float32Array(this.asset.vertexCount * 4);
      for (let i = 0; i < this.asset.vertexCount; i++) {
        colors.set([this.sourceColors.getX(i), this.sourceColors.getY(i), this.sourceColors.getZ(i), 1], i * 4);
      }
      const attribute = new THREE.StorageBufferAttribute(colors, 4);
      this.disposableAttributes.push(attribute);
      colorBuffer = storage(attribute, 'vec4', this.asset.vertexCount).toReadOnly();
    }
    const vColor = varyingProperty('vec3', 'vSourceColor');
    const vWorldNormal = varyingProperty('vec3', 'vWorldNormal');
    const vUv = varyingProperty('vec2', 'vUv');
    const vClusterId = varyingProperty('uint', 'vClusterId');
    const vInstanceId = varyingProperty('uint', 'vInstanceId');
    const vLod = varyingProperty('uint', 'vLod');

    const pulledPosition = Fn(() => {
      const visibleSlot = vertexIndex.div(VERTICES_PER_MESHLET);
      const localVertex = vertexIndex.mod(VERTICES_PER_MESHLET);
      const visible = visibleClustersRead.element(visibleSlot);
      const instanceId = visible.x;
      const clusterId = visible.y;
      const packedIndex = clusterId
        .mul(VERTICES_PER_MESHLET)
        .add(localVertex);
      const sourceVertex = indexBuffer.element(packedIndex);
      const worldMatrix = instanceWorldRead.element(instanceId);
      const worldPosition = worldMatrix.mul(vertexBuffer.element(sourceVertex));
      const worldNormal = normalize(
        worldMatrix.mul(vec4(normalBuffer.element(sourceVertex).xyz, 0.0)).xyz
      );

      if (colorBuffer) vColor.assign(colorBuffer.element(sourceVertex).xyz);
      vWorldNormal.assign(worldNormal);
      vUv.assign(uvBuffer.element(sourceVertex));
      vClusterId.assign(clusterId);
      vInstanceId.assign(instanceId);
      vLod.assign(clusterLodBuffer.element(clusterId));

      return worldPosition.xyz;
    })();

    const hashColor = Fn(([sourceId]) => {
      let id = uint(sourceId).toVar();
      id = id.mul(uint(747796405)).add(uint(289559509));
      id = id.shiftRight(16).bitXor(id).mul(uint(277803737));
      id = id.shiftRight(16).bitXor(id);

      const r = float(id.bitAnd(uint(255))).div(255.0);
      const g = float(id.shiftRight(8).bitAnd(uint(255))).div(255.0);
      const b = float(id.shiftRight(16).bitAnd(uint(255))).div(255.0);

      return vec4(
        r.mul(0.72).add(0.18),
        g.mul(0.72).add(0.18),
        b.mul(0.72).add(0.18),
        1.0
      );
    });

    const checker = floor(vUv.x.mul(14.0))
      .add(floor(vUv.y.mul(14.0)))
      .mod(2.0);

    const shadedMaterial = new THREE.MeshStandardNodeMaterial();
    shadedMaterial.positionNode = pulledPosition;
    shadedMaterial.colorNode = colorBuffer ? vColor : mix(
      color(0x36516f),
      color(0xc9b78e),
      checker.mul(0.72)
    );
    shadedMaterial.normalNode = normalize(vWorldNormal).transformNormalByViewMatrix(
      cameraViewMatrix
    );
    shadedMaterial.roughnessNode = float(0.58);
    shadedMaterial.metalnessNode = float(0.12);

    const meshletMaterial = new THREE.NodeMaterial();
    meshletMaterial.positionNode = pulledPosition;
    meshletMaterial.fragmentNode = hashColor(
      vClusterId.add(vInstanceId.mul(131))
    );

    const lodMaterial = new THREE.NodeMaterial();
    lodMaterial.positionNode = pulledPosition;
    lodMaterial.fragmentNode = hashColor(vLod.add(1).mul(7919));

    const normalMaterial = new THREE.NodeMaterial();
    normalMaterial.positionNode = pulledPosition;
    normalMaterial.fragmentNode = vec4(
      normalize(vWorldNormal).mul(0.5).add(0.5),
      1.0
    );

    this.materials = {
      shaded: shadedMaterial,
      meshlets: meshletMaterial,
      lod: lodMaterial,
      normals: normalMaterial
    };

    // The indirect command expands each visible meshlet to 64 triangle slots.
    // This dummy buffer supplies a validated vertex range; positionNode ignores
    // its values and pulls actual geometry from storage buffers.
    const maximumVertices = this.maxVisibleClusters * VERTICES_PER_MESHLET;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(maximumVertices * 3), 3)
    );
    geometry.setIndirect(this.drawIndirectAttribute);
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY
    );

    this.drawGeometry = geometry;
    this.naniteMesh = new THREE.Mesh(geometry, shadedMaterial);
    this.naniteMesh.frustumCulled = false;
    this.naniteMesh.renderOrder = 1;
    this.scene.add(this.naniteMesh);
  }

  createBaselineMesh(sourceGeometry) {
    if (!sourceGeometry) throw new Error('The full-resolution comparison requires source geometry.');
    const geometry = sourceGeometry.clone();
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(
        this.asset.uvs.slice(), 2
      ));
    }
    const checker = floor(uv().x.mul(14)).add(floor(uv().y.mul(14))).mod(2);
    const material = new THREE.MeshStandardNodeMaterial();
    if (geometry.hasAttribute('color')) {
      material.vertexColors = true;
    } else {
      material.colorNode = mix(color(0x36516f), color(0xc9b78e), checker.mul(0.72));
    }
    material.roughnessNode = float(0.58);
    material.metalnessNode = float(0.12);
    this.baselineMesh = new THREE.InstancedMesh(geometry, material, this.instanceCount);
    const data = this.instanceDataAttribute.array;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < this.instanceCount; i++) {
      // Match the column-major matrix in computeCull, including its rotation sign.
      const scale = data[i * 4 + 3];
      matrix.makeRotationY(-i * 0.61803398875);
      matrix.scale(new THREE.Vector3(scale, scale, scale));
      matrix.setPosition(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      this.baselineMesh.setMatrixAt(i, matrix);
    }
    this.baselineMesh.instanceMatrix.needsUpdate = true;
    this.baselineMesh.frustumCulled = false;
    this.baselineMesh.visible = false;
    this.scene.add(this.baselineMesh);
  }

  setNaniteEnabled(enabled) {
    this.settings.naniteEnabled = Boolean(enabled);
    this.naniteMesh.visible = this.settings.naniteEnabled;
    this.baselineMesh.visible = !this.settings.naniteEnabled;
    this.lastReadbackAt = -Infinity;
    this.statsGeneration = (this.statsGeneration ?? 0) + 1;
    this.invalidateOcclusionHistory();
    this.setOutputMode(this.settings.outputMode);
  }

  setOutputMode(mode) {
    if (!this.materials[mode]) return;
    this.settings.outputMode = mode;
    this.naniteMesh.material = this.materials[mode];

    this.renderer.toneMapping =
      !this.settings.naniteEnabled || mode === 'shaded'
        ? THREE.ACESFilmicToneMapping
        : THREE.NoToneMapping;
  }

  setLodThreshold(value) {
    const threshold = THREE.MathUtils.clamp(Number(value), 0.1, 50);
    this.settings.lodThreshold = threshold;
    this.lodThresholdUniform.value = threshold;
    this.invalidateOcclusionHistory();
  }

  setOcclusionEnabled(enabled) {
    this.settings.occlusionEnabled = Boolean(enabled);
    if (!enabled) this.occlusionEnabledUniform.value = 0;
  }

  setConeEnabled(enabled) {
    this.settings.coneEnabled = Boolean(enabled);
    this.coneEnabledUniform.value = enabled ? 1 : 0;
  }

  setOccludersVisible(visible) {
    this.occluderGroup.visible = !this.gameScene && Boolean(visible);
    this.invalidateOcclusionHistory();
  }

  invalidateOcclusionHistory() {
    this.hzbValidUniform.value = 0;
    this.occlusionEnabledUniform.value = 0;
    this.previousFrameValid = false;
  }

  updateCameraUniforms() {
    this.camera.updateMatrixWorld();
    this.cameraInverse.copy(this.camera.matrixWorld).invert();
    this.projScreenMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.cameraInverse
    );

    let cameraCut = true;

    if (this.previousFrameValid) {
      const positionDelta = this.previousCameraPosition.distanceTo(
        this.camera.position
      );
      const angularDelta = 2 * Math.acos(
        Math.min(
          1,
          Math.abs(
            this.previousCameraQuaternion.dot(this.camera.quaternion)
          )
        )
      );
      cameraCut = positionDelta > 1e-6 || angularDelta > 1e-6;
    }

    if (!this.previousFrameValid) {
      this.previousProjScreenMatrix.copy(this.projScreenMatrix);
      this.previousCameraPosition.copy(this.camera.position);
      this.previousCameraQuaternion.copy(this.camera.quaternion);
    }

    this.previousProjScreenUniform.value.copy(
      this.previousProjScreenMatrix
    );
    this.previousCameraPositionUniform.value.copy(
      this.previousCameraPosition
    );

    this.projScreenMatrixUniform.value.copy(this.projScreenMatrix);
    this.cameraPositionUniform.value.copy(this.camera.position);
    this.cotHalfFovUniform.value = this.camera.projectionMatrix.elements[5];

    this.frustum.setFromProjectionMatrix(this.projScreenMatrix, THREE.WebGPUCoordinateSystem);
    const planes = this.frustum.planes;
    const planeArray = this.frustumPlanesUniform.array;

    for (let i = 0; i < 6; i += 1) {
      const plane = planes[i];
      planeArray[i].set(
        plane.normal.x,
        plane.normal.y,
        plane.normal.z,
        plane.constant
      );
    }

    this.occlusionEnabledUniform.value =
      this.settings.occlusionEnabled &&
      this.previousFrameValid &&
      !cameraCut
        ? 1
        : 0;

    this.previousProjScreenMatrix.copy(this.projScreenMatrix);
    this.previousCameraPosition.copy(this.camera.position);
    this.previousCameraQuaternion.copy(this.camera.quaternion);
    this.previousFrameValid = true;
  }

  render(now = performance.now(), prepareOnly = false) {
    if (!this.settings.naniteEnabled) {
      if (!prepareOnly) {
      this.renderer.setRenderTarget(this.sceneTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.blitQuad.render(this.renderer);
      }
      if (now - this.lastReadbackAt >= 500) {
        this.lastReadbackAt = now;
        this.onStats({
          naniteEnabled: false,
          sourceTriangles: this.asset.sourceTriangleCount,
          sourceSceneTriangles: this.asset.sourceTriangleCount * this.instanceCount,
          submittedTriangles: this.asset.sourceTriangleCount * this.instanceCount,
          instances: this.instanceCount, groups: this.asset.groupCount,
          lockedVertices: this.asset.lockedVertexCount, visibleMeshlets: 0,
          capacity: 0, overflowed: false, lodCounts: this.asset.lods.map(() => 0),
          assetBytes: this.asset.bytes
        });
      }
      return;
    }
    this.updateCameraUniforms();

    this.renderer.compute(this.computeClear);
    this.renderer.compute(this.computeCull);
    this.renderer.compute(this.computeDrawArguments);
    if (prepareOnly) { this.requestStatsReadback(now); return; }

    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    if (this.settings.occlusionEnabled) {
      for (let level = 0; level < this.hzbLevelCount; level += 1) {
        this.renderer.compute(this.hzbKernels[level]);
      }
      this.hzbValidUniform.value = 1;
    } else {
      this.hzbValidUniform.value = 0;
    }

    this.renderer.setRenderTarget(null);
    this.blitQuad.render(this.renderer);

    this.requestStatsReadback(now);
  }

  async requestStatsReadback(now) {
    if (this.readbackInFlight || now - this.lastReadbackAt < 500) return;

    const generation = this.statsGeneration ?? 0;
    this.readbackInFlight = true;
    this.lastReadbackAt = now;

    try {
      const [countBuffer, overflowBuffer, lodBuffer] = await Promise.all([
        this.renderer.getArrayBufferAsync(
          this.visibleCountAttribute,
          null,
          0,
          Uint32Array.BYTES_PER_ELEMENT
        ),
        this.renderer.getArrayBufferAsync(
          this.overflowAttribute,
          null,
          0,
          Uint32Array.BYTES_PER_ELEMENT
        ),
        this.renderer.getArrayBufferAsync(
          this.lodCounterAttribute,
          null,
          0,
          this.asset.lods.length * Uint32Array.BYTES_PER_ELEMENT
        )
      ]);

      if (this.disposed || !this.settings.naniteEnabled || generation !== (this.statsGeneration ?? 0)) return;

      const rawVisibleCount = new Uint32Array(countBuffer)[0] ?? 0;
      const visibleCount = Math.min(rawVisibleCount, this.maxVisibleClusters);
      const overflowed = (new Uint32Array(overflowBuffer)[0] ?? 0) !== 0;
      const lodCounts = Array.from(new Uint32Array(lodBuffer));

      this.onStats({
        naniteEnabled: true,
        sourceTriangles: this.asset.sourceTriangleCount,
        sourceSceneTriangles: this.asset.sourceTriangleCount * this.instanceCount,
        instances: this.instanceCount,
        groups: this.asset.groupCount,
        lockedVertices: this.asset.lockedVertexCount,
        visibleMeshlets: visibleCount,
        rawVisibleMeshlets: rawVisibleCount,
        submittedTriangles: visibleCount * MESHLET_MAX_TRIANGLES,
        capacity: this.maxVisibleClusters,
        overflowed,
        lodCounts,
        assetBytes: this.asset.bytes
      });
    } catch (error) {
      // Readback is diagnostic only; rendering should continue if a browser or
      // backend refuses an overlapping asynchronous map operation.
      console.warn('Nanite Lite stats readback failed:', error);
    } finally {
      this.readbackInFlight = false;
    }
  }

  resize() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);

    this.sceneTarget.dispose();
    this.sceneTarget = this.createRenderTarget(size.x, size.y);
    this.blitTextureNode.value = this.sceneTarget.texture;
    this.depthSourceTextureNode.value = this.sceneTarget.depthTexture;

    this.rebuildHzbStorage(size.x, size.y, false);

    // The culling pipeline binds the HZB storage node. Rebuild its GPU
    // pipeline after replacing the underlying buffer on resize.
    this.computeCull?.dispose();

    for (let level = 0; level < this.hzbKernels.length; level += 1) {
      const info = this.hzbLevelTable.array[
        Math.min(level, this.hzbLevelCount - 1)
      ];
      this.hzbKernels[level].count = info.y * info.z;
      this.hzbKernels[level].dispose();
    }

    this.invalidateOcclusionHistory();
  }

  dispose() {
    this.disposed = true;
    this.baselineMesh?.geometry.dispose();
    this.baselineMesh?.material.dispose();
    this.baselineMesh?.dispose();
    this.scene.remove(this.naniteMesh);

    this.drawGeometry?.dispose();
    for (const material of Object.values(this.materials ?? {})) {
      disposeMaterial(material);
    }

    this.floor?.geometry.dispose();
    disposeMaterial(this.floor?.material);

    this.occluderGroup?.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
    });

    const occluderMaterial = this.occluderGroup?.children[0]?.material;
    disposeMaterial(occluderMaterial);

    for (const attribute of this.disposableAttributes) {
      attribute.dispose();
    }

    for (const node of this.computeNodes) {
      if (node && typeof node.dispose === 'function') node.dispose();
    }

    this.hzbAttribute?.dispose();
    this.sceneTarget?.dispose();
    this.blitMaterial?.dispose();
  }
}
