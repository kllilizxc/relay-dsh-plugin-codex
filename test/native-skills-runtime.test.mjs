import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRuntimeController } from '../plugin.mjs';
test('Codex catalog reads the requested workspace and excludes disabled skills', async () => {
  const runtime = new CodexRuntimeController();
  runtime.request = async (method, params) => {
    assert.equal(method, 'skills/list');
    assert.deepEqual(params, { cwds: ['/workspace'], forceReload: true });
    return { data: [{ cwd: '/workspace', skills: [
      { name: 'example', description: 'Example', path: '/workspace/.agents/skills/example/SKILL.md', enabled: true },
      { name: 'disabled', enabled: false },
    ] }] };
  };
  assert.deepEqual(await runtime.listSkills('/workspace'), [
    { name: 'example', description: 'Example', path: '/workspace/.agents/skills/example/SKILL.md' },
  ]);
});
