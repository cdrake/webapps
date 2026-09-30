import test from 'node:test';
import assert from 'node:assert/strict';
import { writeVolume } from '../../synthsr/src/volume.js';
import { decodeStacks, prepareTraining } from '../src/input.js';
import { Tape, transform } from '../src/training/index.js';
import { browserConfig } from '../src/config.js';

function input(affine) {
  return [{image:writeVolume({dims:[3,3,3],affine,data:Float32Array.from({length:27},(_,i)=>1+i/27)}),thickness:3}];
}

test('canonical reflected stacks retain scanner coordinates and physical slice thickness', () => {
  const affine = [[-1,0,0,10],[0,2,0,20],[0,0,4,30],[0,0,0,1]];
  const stacks = decodeStacks(input(affine));
  const prepared = prepareTraining(stacks);
  assert.deepEqual(stacks[0].resolution,[1,2,4]);
  assert.deepEqual(Array.from(prepared.resolutions.slice(0,3)),[1,2,3]);
  assert.equal(stacks[0].data[0],Math.fround(1+2/27));
  for (let i=0;i<prepared.observations.length;i++) {
    const observation = prepared.observations[i];
    const tape = new Tape();
    const pose = prepared.poses.slice(observation.slice*6,observation.slice*6+6).map(v=>tape.constant(v));
    const world = transform(tape,pose,observation.xyz.map(v=>tape.constant(v))).map((v,a)=>v.value*30+prepared.center[a]);
    const expected = [8+i%3,20+2*(Math.floor(i/3)%3),30+4*Math.floor(i/9)];
    world.forEach((v,a)=>assert.ok(Math.abs(v-expected[a])<1e-5));
  }
});

test('scanner origin cancels from training coordinates and invalid settings fail before workers start', () => {
  const first=prepareTraining(decodeStacks(input([[1,0,0,10],[0,1,0,20],[0,0,3,30],[0,0,0,1]])));
  const shifted=prepareTraining(decodeStacks(input([[1,0,0,1010],[0,1,0,-1980],[0,0,3,3030],[0,0,0,1]])));
  first.poses.forEach((v,i)=>assert.ok(Math.abs(v-shifted.poses[i])<1e-12));
  assert.deepEqual(first.boundingBox,shifted.boundingBox);
  const stacks=input([[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]);
  assert.equal(browserConfig({stacks}).registration, 'svort');
  assert.equal(browserConfig({stacks,options:{registration:'none',deformable:true}}).deformable, true);
  assert.throws(()=>browserConfig({stacks,options:{registration:'none',iterations:NaN}}),/iterations/);
});
