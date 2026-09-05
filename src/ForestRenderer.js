import * as THREE from 'three/webgpu';
import { positionLocal, time, sin, vec3, float } from 'three/tsl';
import { ForestBitmaskRenderer } from './bitmask/ForestBitmaskRenderer.js';
import { NaniteLiteRenderer } from './NaniteLiteRenderer.js';

// Each asset has its own compute/indirect buffers. Both draws share one scene,
// camera and presentation pass; the original indexed instances are the baseline.
export class ForestRenderer {
  constructor(renderer, camera, terrainAsset, treeAsset, world, onStats, options = {}) {
    this.samples = new Map(); this.enabled = true; this.onStats = onStats;
    const receive = key => stats => {
      if (stats.naniteEnabled !== this.enabled) return;
      this.samples.set(key,stats);
      if(this.samples.size!==2) return;
      const values=[...this.samples.values()];
      const sum=key=>values.reduce((total,s)=>total+(s[key]??0),0);
      this.onStats({bitmask:this.enabled?this.bitmask?.metrics:null,naniteEnabled:this.enabled,sourceTriangles:sum('sourceTriangles'),
        sourceSceneTriangles:sum('sourceSceneTriangles'),submittedTriangles:sum('submittedTriangles'),
        visibleMeshlets:sum('visibleMeshlets'),capacity:sum('capacity'),instances:sum('instances'),
        groups:sum('groups'),lockedVertices:sum('lockedVertices'),assetBytes:sum('assetBytes'),
        overflowed:values.some(s=>s.overflowed),
        lodCounts:terrainAsset.lods.map((_,i)=>values.reduce((total,s)=>total+(s.lodCounts[i]??0),0))});
    };
    const fullCapacity=(asset,instances)=>{
      const count=asset.lods[0].clusterCount*instances;
      if(count*8>renderer.backend.device.limits.maxStorageBufferBindingSize)throw new Error('Full-detail visible meshlets exceed this device buffer limit. Choose a lower forest density.');
      return count;
    };
    this.terrain = new NaniteLiteRenderer(renderer,camera,terrainAsset,{sourceGeometry:world.geometry,
      gameScene:true,gridSize:1,fullGeometry:options.fullGeometry,softwareOnly:options.bitmask,maxVisibleClusters:options.fullGeometry?fullCapacity(terrainAsset,1):8192,onStats:receive('terrain')});
    this.trees = new NaniteLiteRenderer(renderer,camera,treeAsset,{sourceGeometry:world.treeGeometry,
      gameScene:true,gridSize:1,fullGeometry:options.fullGeometry,softwareOnly:options.bitmask,instanceData:world.treeInstances,maxVisibleClusters:options.fullGeometry?fullCapacity(treeAsset,world.treeInstances.length/4):32768,onStats:receive('trees')});
    this.pipelines=[this.terrain,this.trees];
    this.asset=terrainAsset;
    const scene=this.terrain.scene;
    scene.add(this.trees.naniteMesh,this.trees.baselineMesh);
    scene.background=new THREE.Color(0xb6d9df);
    scene.fog=new THREE.FogExp2(0xb6d9df,.008);
    // Opaque lake shading is identical in both modes; it is not counted as
    // Nanite geometry, and does not manufacture a geometry speedup.
    const waterMaterial=new THREE.MeshStandardNodeMaterial({color:0x1c8585,roughness:.23,metalness:.35});
    waterMaterial.positionNode=vec3(positionLocal.x,
      positionLocal.y.add(sin(positionLocal.x.mul(.8).add(time)).mul(.025))
        .add(sin(positionLocal.z.mul(.63).sub(time.mul(.8))).mul(.025)),positionLocal.z);
    this.water=new THREE.Mesh(new THREE.CircleGeometry(24,128).rotateX(-Math.PI/2),waterMaterial);
    this.water.position.set(0,.1,-9); scene.add(this.water);
    // A small physical roughness stops the lake becoming a mirror without IBL.
    waterMaterial.roughnessNode=float(.23);
    if(options.bitmask)this.bitmask=new ForestBitmaskRenderer(this,options.bitmaskVariant);
  }
  async initBitmask() { if(this.bitmask)await this.bitmask.init(); }
  render(now) {
    if(this.bitmask&&this.enabled){
      if(!this.bitmask.prepare(now))return false;
      for(const p of this.pipelines){p.naniteMesh.visible=false;p.baselineMesh.visible=false;}
      this.bitmask.render(now);
    }else {this.trees.render(now,true);this.terrain.render(now);}
  }
  setNaniteEnabled(value) {
    this.enabled=Boolean(value); this.samples.clear();
    if(this.bitmask){this.bitmask.metrics=null;this.bitmask.generation++;}
    for(const p of this.pipelines) p.setNaniteEnabled(value);
  }
  setOutputMode(value) { if(this.bitmask)this.bitmask.outputMode=value; for(const p of this.pipelines) p.setOutputMode(value); }
  setLodThreshold(value) { for(const p of this.pipelines) p.setLodThreshold(value); }
  setConeEnabled(value) { for(const p of this.pipelines) p.setConeEnabled(value); }
  setOcclusionEnabled() { for(const p of this.pipelines) p.setOcclusionEnabled(false); }
  setOccludersVisible() { for(const p of this.pipelines) p.setOccludersVisible(false); }
  invalidateOcclusionHistory() { for(const p of this.pipelines) p.invalidateOcclusionHistory(); }
  resize() { for(const p of this.pipelines) p.resize(); this.bitmask?.resize(); }
  dispose() {
    this.bitmask?.dispose();
    this.samples.clear(); this.water.geometry.dispose(); this.water.material.dispose();
    for(const p of this.pipelines) p.dispose();
  }
}
