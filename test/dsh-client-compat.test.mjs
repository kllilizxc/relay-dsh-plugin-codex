import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionPreset, currentSessionId } from '../dsh-client-compat.mjs';

test('current cleared preset wins over stale legacy state', () => {
  assert.equal(sessionPreset({ agentPreset: 'relay-codex', projectionValues: { agentPreset: null } }), null);
  assert.equal(sessionPreset({ agentPreset: 'relay-claude' }), 'relay-claude');
  assert.equal(sessionPreset(undefined), undefined);
});

test('main view selection ignores retained histories and follows replacement references', () => {
  const byId = { history: { id: 'history', retainedBy: { workaHistory: 1 } }, main: { id: 'main', retainedBy: { mainView: 1 } } };
  assert.equal(currentSessionId({ byId }), 'main');
  assert.equal(currentSessionId({ byId: { ...byId, main: { ...byId.main, retainedBy: {} } } }), undefined);
  assert.equal(currentSessionId({ current: 'legacy' }), 'legacy');
});
