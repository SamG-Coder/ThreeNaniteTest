import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {GameControls} from '../src/gameControls.js';
test('look recovers after an interrupted touch and supports drag without pointer lock',()=>{
 const element=()=>Object.assign(new EventTarget(),{style:{},capture:null,setPointerCapture(id){this.capture=id;},hasPointerCapture(id){return this.capture===id;},releasePointerCapture(){this.capture=null;}});
 globalThis.window=element();globalThis.document=Object.assign(element(),{body:{classList:{toggle(){}}},pointerLockElement:null});globalThis.matchMedia=()=>({matches:true});
 const canvas=element(),camera=new THREE.PerspectiveCamera(),controls=new GameControls(camera,canvas,{spawn:[0,0,0],heightAt:()=>0,obstacles:[],bounds:100},{stick:element(),thumb:element(),jump:element()});controls.setEnabled(true);
 const emit=(target,type,props)=>target.dispatchEvent(Object.assign(new Event(type),props));
 const drag=(id,pointerType='touch')=>{emit(canvas,'pointerdown',{pointerId:id,pointerType,button:0,clientX:0,clientY:0});emit(document,'pointermove',{pointerId:id,clientX:100,clientY:20});};
 drag(1);const first=camera.rotation.y;assert.notEqual(first,0);window.dispatchEvent(new Event('blur'));assert.equal(controls.lookPointer,null);drag(2);assert.ok(camera.rotation.y<first);
 controls.setEnabled(false);controls.setEnabled(true);const before=camera.rotation.y;drag(3,'mouse');assert.ok(camera.rotation.y<before);controls.dispose();
});
