import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSkillsHandler } from '../native-skills-route.js';

function response() {
  const result = {};
  return { result, writeHead(status) { result.status = status; }, end(body) { result.body = JSON.parse(body); } };
}
test('native catalog uses persisted cwd and ignores a supplied browser path', async () => {
  const handler = createNativeSkillsHandler({ preset: 'relay-test',
    readSession: async id => { assert.equal(id, 'cold'); return { preset: 'relay-test', cwd: '/workspace' }; },
    listSkills: async (id, cwd) => { assert.equal(cwd, '/workspace'); return [{ name: 'example' }]; },
  });
  const res = response();
  await handler({ method: 'GET', url: '/skills?sessionId=cold&cwd=/other' }, res);
  assert.equal(res.result.status, 200);
  assert.equal(res.result.body.skills[0].name, 'example');
});
test('other presets do not query the native runtime', async () => {
  const handler = createNativeSkillsHandler({ preset: 'relay-test',
    readSession: async () => ({ preset: 'other', cwd: '/workspace' }),
    listSkills: () => { throw new Error('should not run'); },
  });
  const res = response(); await handler({ method: 'GET', url: '/skills?sessionId=s' }, res);
  assert.deepEqual(res.result.body, { skills: [] });
});
test('invalid requests and runtime failures remain distinguishable from an empty catalog', async () => {
  const handler = createNativeSkillsHandler({ preset: 'relay-test',
    readSession: async () => { throw new Error('unavailable'); }, listSkills() {},
  });
  for (const [method, url, status] of [['POST', '/skills', 405], ['GET', '/skills', 400], ['GET', '/skills?sessionId=s', 503]]) {
    const res = response(); await handler({ method, url }, res); assert.equal(res.result.status, status);
  }
});
