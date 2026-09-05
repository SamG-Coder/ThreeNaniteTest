import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameGate,frameOptions,FrameProbe} from '../src/bitmask/FrameExperiment.js';
import {ForestBitmaskRenderer} from '../src/bitmask/ForestBitmaskRenderer.js';
test('frame gate bounds two queued frames and survives lowering limit and failures',async()=>{
 const gate=new FrameGate(2);let a,b;
 const first=gate.track(new Promise(r=>a=r));assert.equal(gate.busy,false);
 const second=gate.track(new Promise((r,j)=>b=j));assert.equal(gate.busy,true);
 gate.limit=1;a();await first;assert.equal(gate.busy,true);
 b(new Error('device lost'));await second;assert.equal(gate.pending,0);assert.equal(gate.busy,false);
});
test('comparison options are independent and conservative for presentation and queue',()=>{
 assert.deepEqual(frameOptions(),{frames:1,batch:true,skipArgs:true,direct:false,profile:false});
 assert.deepEqual(frameOptions('?frames=2&batch=0&skipArgs=0&direct=1&profile=1'),{frames:2,batch:false,skipArgs:false,direct:true,profile:true});
});
test('selection batching preserves clear/cull order, skips only draw args, reuses groups',()=>{
 const calls=[];
 const make=name=>({updateCameraUniforms:()=>calls.push(name+' camera'),computeClear:name+' clear',computeCull:name+' cull',computeDrawArguments:name+' args',requestStatsReadback:()=>{}});
 const trees=make('tree'),terrain=make('terrain');
 const subject={busy:false,options:{batch:true,skipArgs:true},forest:{trees,terrain,pipelines:[terrain,trees]},probe:{begin(){},mark(){}},renderer:{compute:n=>calls.push(n)}};
 assert.equal(ForestBitmaskRenderer.prototype.prepare.call(subject,1),true);
 assert.deepEqual(calls,['tree camera','terrain camera',['tree clear','tree cull','terrain clear','terrain cull']]);
 const group=subject.selectionNodes;ForestBitmaskRenderer.prototype.prepare.call(subject,2);assert.equal(subject.selectionNodes,group);
 subject.options={batch:false,skipArgs:false};calls.length=0;
 ForestBitmaskRenderer.prototype.prepare.call(subject,3);
 assert.deepEqual(calls,['tree camera','terrain camera','tree clear','tree cull','tree args','terrain clear','terrain cull','terrain args']);
 subject.busy=true;subject.gate={skipped:0};subject.updateReadout=()=>{};calls.length=0;
 assert.equal(ForestBitmaskRenderer.prototype.prepare.call(subject,4),false);assert.equal(calls.length,0);assert.equal(subject.gate.skipped,1);
});
test('GPU probe does not use unsupported timestamps',()=>{
 const probe=new FrameProbe({features:new Set()});probe.begin(1000,true);assert.equal(probe.active,false);assert.equal(probe.writes(0),undefined);probe.mark(0);probe.finish();probe.dispose();
});
