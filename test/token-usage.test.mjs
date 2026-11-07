import test from 'node:test';
import assert from 'node:assert/strict';
import { turnUsage } from '../token-usage.mjs';
const stats = (input, output, cached, reasoning) => ({inputTokens:input,outputTokens:output,cachedInputTokens:cached,cacheWriteInputTokens:0,reasoningOutputTokens:reasoning,totalTokens:input+output});
test('counts one resumed turn without earlier thread usage or duplicate events', () => {
  const u=turnUsage();
  u.observe({total:stats(1100,110,400,20),last:stats(100,10,40,2)});
  u.observe({total:stats(1100,110,400,20),last:stats(100,10,40,2)});
  u.observe({total:stats(1300,130,470,25),last:stats(200,20,70,5)});
  assert.deepEqual(u.result(),{inputTokens:300,outputTokens:30,totalTokens:330,cacheReadTokens:110,cacheWriteTokens:0,reasoningTokens:7});
});
test('missing and decreasing counters never invent usage',()=>{
  const missing=turnUsage();missing.observe({last:stats(5,1,0,0)});assert.equal(missing.result(),undefined);
  const u=turnUsage();u.observe({total:stats(10,2,0,0),last:stats(5,1,0,0)});
  u.observe({total:stats(1,1,0,0),last:stats(1,1,0,0)});
  u.observe({total:stats(2,2,0,0),last:stats(1,1,0,0)});assert.equal(u.result(),undefined);
});

test('omits unavailable optional counters',()=>{const u=turnUsage();u.observe({total:{inputTokens:20,outputTokens:3},last:{inputTokens:20,outputTokens:3}});assert.deepEqual(u.result(),{inputTokens:20,outputTokens:3});});
