import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMetadata,decodeMetadata,encodePages,decodePages} from '../src/cluster/cookedFormat.js';
test('prepared geometry preserves typed metadata, UVs and variable page bytes',()=>{
 const asset={uvs:new Float32Array([-.3,4.25,10.1,0]),indices:new Uint32Array([0,65000,130000]),sourceColors:{array:new Float32Array([.1,.2,.3]),itemSize:3},sourceSurface:{array:new Float32Array([3]),itemSize:1},pages:[new Uint32Array([1,17,128]),new Uint32Array([0xffffffff])],groupCount:9};
 const decoded=decodeMetadata(encodeMetadata(asset).buffer);assert.deepEqual(decoded.uvs,asset.uvs);assert.deepEqual(decoded.indices,asset.indices);assert.deepEqual(decoded.sourceColors,asset.sourceColors);assert.equal(decoded.groupCount,9);assert.equal(decoded.pages,undefined);assert.deepEqual(decodePages(encodePages(asset.pages).buffer),asset.pages);
});
