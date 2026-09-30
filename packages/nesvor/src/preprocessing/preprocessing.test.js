import test from 'node:test';
import assert from 'node:assert/strict';
import { otsuThreshold, dilateBall, preprocessStacks } from './index.js';

test('Otsu separates tissue from background and ball dilation preserves topology at borders', async () => {
  const threshold = otsuThreshold(Float32Array.from([0,0,0,1,1,1]));
  assert.ok(threshold > 0 && threshold < 1);
  const mask = new Uint8Array(125);
  mask[62] = 1;
  const output = await dilateBall(mask, [5,5,5], {radius:1});
  assert.equal(output.reduce((a,b) => a+b,0),7);
  assert.equal(output[62],1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dilateBall(mask,[5,5,5],{signal:controller.signal}),{name:'AbortError'});
});

test('preprocessing intersects physical volume masks, preserves inputs and normalizes tissue', async () => {
  const make = (origin) => ({dims:[3,3,3],affine:[[1,0,0,origin],[0,1,0,0],[0,0,1,0],[0,0,0,1]],data:Float32Array.from({length:27},(_,i)=>i+1),mask:new Uint8Array(27).fill(1)});
  const input = [make(0),make(1)];
  const result = await preprocessStacks(input,{stacksIntersection:true});
  assert.equal(result.stacks[0].mask.reduce((a,b)=>a+b,0),18);
  assert.equal(result.stacks[1].mask.reduce((a,b)=>a+b,0),18);
  assert.equal(input[0].mask.reduce((a,b)=>a+b,0),27);
  assert.equal(input[0].data[26],27);
  assert.ok(result.stacks[0].data[26] < 1.02);
});
