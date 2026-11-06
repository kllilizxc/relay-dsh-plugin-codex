import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CodexDshAdapter } from '../codex-adapter.js';
import { CodexLinkStore } from '../codex-link-store.js';
import { CodexSessionRuntime } from '../session-runtime.mjs';
import { NATIVE_TOOL_RESTRICTION_INSTRUCTIONS, READ_ONLY_NATIVE_TOOL_INSTRUCTIONS } from '../native-tool-policy.mjs';

class Runtime extends EventEmitter {
  sessions = new Map(); models = [{ id: 'model', isDefault: true }]; created = 0; forked = 0; updates = []; resumed = [];
  async createSession(config) { const session = { id: `new-${++this.created}`, turns: [], ...config }; this.sessions.set(session.id, session); return session; }
  async resumeSession(id, config) { this.resumed.push(id); const session = { id, turns: [], ...config }; this.sessions.set(id, session); return session; }
  async forkSession(_id, config) { const session = { id: `fork-${++this.forked}`, turns: [], ...config }; this.sessions.set(session.id, session); return session; }
  async applyTrustedPolicy(threadId, text) { this.updates.push({ threadId, text }); if (this.failAck) { this.failAck = false; throw Error('lost acknowledgement'); } }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'links.json'), store = new CodexLinkStore(path), runtime = new Runtime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), linkStore: store, executionGuidance: false });
  const ensure = (policy = 'POLICY_A', native = []) => adapter.ensureThread('home', [], null, native, policy);
  const saved = async (id = 'home') => JSON.parse(await readFile(path, 'utf8')).sessions[id];
  return { path, store, runtime, adapter, ensure, saved };
}

test('fresh policy uses initial instructions; changed policy materializes once, with no raw policy in the link receipt', async t => {
  const f = await fixture(t), thread = await f.ensure();
  assert.equal(f.runtime.updates.length, 0);
  const first = await f.saved();
  assert.match(first.trustedPolicy.hash, /^[a-f0-9]{64}$/); assert.equal(first.trustedPolicy.threadId, thread);
  assert.doesNotMatch(JSON.stringify(first), /POLICY_A|native Codex tools/);
  const [left, right] = await Promise.all([f.ensure('POLICY_B'), f.ensure('POLICY_B')]);
  assert.equal(left, thread); assert.equal(right, thread); assert.equal(f.runtime.updates.length, 1);
  assert.match(f.runtime.updates[0].text, /supersede earlier host-provided instructions/);
  assert.match(f.runtime.updates[0].text, /POLICY_B/); assert.doesNotMatch(f.runtime.updates[0].text, /POLICY_A/);
  assert.ok(f.runtime.updates[0].text.includes(NATIVE_TOOL_RESTRICTION_INSTRUCTIONS));
  const next = await f.saved(); assert.notEqual(next.trustedPolicy.hash, first.trustedPolicy.hash);
  await f.ensure('POLICY_B'); assert.equal(f.runtime.updates.length, 1);
});

test('an unchanged trusted policy survives detach and restart without another developer item', async t => {
  const f = await fixture(t); const thread = await f.ensure();
  await f.ensure('POLICY_B'); f.adapter.detachAgent('home'); await f.ensure('POLICY_B');
  assert.equal(f.runtime.updates.length, 1);
  const runtime = new Runtime(), adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), linkStore: new CodexLinkStore(f.path), executionGuidance: false });
  assert.equal(await adapter.ensureThread('home', [], null, [], 'POLICY_B'), thread);
  assert.equal(runtime.updates.length, 0); assert.equal(runtime.created, 0);
});

test('unknown, malformed or wrong-thread policy receipts preserve the binding and apply current policy once', async t => {
  for (const receipt of [undefined, { threadId: 'old', hash: 'invalid' }, { threadId: 'unrelated', hash: 'a'.repeat(64) }]) {
    const f = await fixture(t);
    f.store.set('home', { threadId: 'old', config: { cwd: '/isolated' }, ...(receipt ? { trustedPolicy: receipt } : {}) });
    const runtime = new Runtime(), adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), linkStore: new CodexLinkStore(f.path), executionGuidance: false });
    assert.equal(await adapter.ensureThread('home', [], null, [], 'CURRENT'), 'old');
    assert.equal(runtime.created, 0); assert.equal(runtime.updates.length, 1);
    await adapter.ensureThread('home', [], null, [], 'CURRENT'); assert.equal(runtime.updates.length, 1);
  }
});

test('a legacy binding with already-current configuration still materializes its missing policy receipt', async t => {
  const f = await fixture(t); const thread = await f.ensure('CURRENT');
  const { trustedPolicy: _receipt, ...legacy } = await f.saved();
  f.store.set('home', legacy); f.adapter.trustedPolicies.delete('home');
  const resumes = f.runtime.resumed.length;
  assert.equal(await f.ensure('CURRENT'), thread);
  assert.equal(f.runtime.resumed.length, resumes);
  assert.equal(f.runtime.updates.length, 1);
  await f.ensure('CURRENT'); assert.equal(f.runtime.updates.length, 1);
});

test('native restriction changes are part of the effective policy hash', async t => {
  const f = await fixture(t); await f.ensure();
  await f.adapter.ensureThread('home', [], null, undefined, 'POLICY_A');
  assert.equal(f.runtime.updates.length, 1); assert.doesNotMatch(f.runtime.updates[0].text, /native Codex tools/);
  await f.ensure('POLICY_A', []); assert.equal(f.runtime.updates.length, 2);
  assert.ok(f.runtime.updates[1].text.includes(NATIVE_TOOL_RESTRICTION_INSTRUCTIONS));
});

test('each new fork materializes current policy because its selected turn may predate the parent receipt', async t => {
  const f = await fixture(t), parent = await f.ensure();
  const provenance = { threadId: parent, turnId: 'completed', itemId: 'answer' };
  const same = await f.adapter.ensureThread('same-child', [], provenance, [], 'POLICY_A');
  assert.deepEqual(f.runtime.updates.map(row => row.threadId), [same]);
  assert.equal((await f.saved('same-child')).trustedPolicy.threadId, same);
  await f.adapter.ensureThread('same-child', [], provenance, [], 'POLICY_A');
  assert.equal(f.runtime.updates.length, 1);
  const changed = await f.adapter.ensureThread('changed-child', [], provenance, [], 'POLICY_B');
  assert.deepEqual(f.runtime.updates.map(row => row.threadId), [same, changed]);
  f.adapter.bindImportedThread('unknown-parent', 'imported-thread', { cwd: '/isolated' });
  const unknown = await f.adapter.ensureThread('unknown-child', [], { threadId: 'imported-thread', turnId: 'done' }, [], 'POLICY_A');
  assert.equal(f.runtime.updates.at(-1).threadId, unknown);
});

test('import replacement transfers the receipt and preserves other binding metadata', async t => {
  const f = await fixture(t);
  f.adapter.bindImportedThread('imported', 'source-thread', { cwd: '/isolated' });
  await f.adapter.ensureThread('imported', [], null, [], 'POLICY_A');
  f.adapter.markImportState('imported', 'committed');
  f.adapter.dshOwnedTurnIds.set('imported', new Set(['own-turn'])); f.adapter.persistLink('imported');
  const before = await f.saved('imported'); f.adapter.replaceImportedSession('imported', 'replacement');
  const after = await f.saved('replacement');
  assert.deepEqual(after.trustedPolicy, before.trustedPolicy); assert.deepEqual(after.dshTurnIds, ['own-turn']);
  assert.equal(after.bindingMode, 'imported'); assert.equal(after.importState, 'committed');
  await f.adapter.ensureThread('replacement', [], null, [], 'POLICY_A');
  assert.equal(f.runtime.updates.length, 1);
});

test('lost injection acknowledgement leaves the receipt old and permits an identical at-least-once retry', async t => {
  const f = await fixture(t); await f.ensure(); const before = await f.saved();
  f.runtime.failAck = true;
  await assert.rejects(f.ensure('POLICY_B'), /lost acknowledgement/);
  assert.deepEqual((await f.saved()).trustedPolicy, before.trustedPolicy);
  await f.ensure('POLICY_B');
  assert.equal(f.runtime.updates.length, 2); assert.deepEqual(f.runtime.updates[0], f.runtime.updates[1]);
  assert.notEqual((await f.saved()).trustedPolicy.hash, before.trustedPolicy.hash);
});

test('receipt persistence failure rolls back in-memory acknowledgements as well as the link store', async t => {
  const f = await fixture(t); await f.ensure(); const before = await f.saved(), persist = f.store.persist.bind(f.store);
  f.store.persist = () => { throw Error('receipt write failed'); };
  await assert.rejects(f.ensure('POLICY_B'), /receipt write failed/);
  assert.deepEqual(f.store.entries()[0][1].trustedPolicy, before.trustedPolicy);
  assert.deepEqual(f.adapter.trustedPolicies.get('home'), before.trustedPolicy);
  f.store.persist = persist; await f.ensure('POLICY_B');
  assert.equal(f.runtime.updates.length, 2); assert.deepEqual(f.runtime.updates[0], f.runtime.updates[1]);
});

test('an empty replacement explicitly withdraws earlier host policy without resetting user/project instructions', async t => {
  const f = await fixture(t); await f.ensure(); await f.adapter.ensureThread('home', [], null, undefined, '');
  const text = f.runtime.updates.at(-1).text;
  assert.match(text, /No additional host-provided instructions apply/);
  assert.match(text, /User and project instructions remain/);
});

test('an absent host policy preserves omitted provider instructions and does not replace a saved receipt', async t => {
  const f = await fixture(t);
  const thread = await f.adapter.ensureThread('home', [], null, undefined);
  assert.equal(Object.hasOwn(f.runtime.sessions.get(thread), 'developerInstructions'), false);
  assert.equal(f.runtime.updates.length, 0); assert.equal((await f.saved()).trustedPolicy, undefined);
  await f.ensure(); const receipt = (await f.saved()).trustedPolicy;
  await f.adapter.ensureThread('home', [], null, undefined);
  assert.equal(f.runtime.updates.length, 1);
  assert.deepEqual((await f.saved()).trustedPolicy, receipt);
  await f.adapter.ensureThread('home', [], null, []);
  assert.equal(f.runtime.updates.length, 1);
  assert.deepEqual((await f.saved()).trustedPolicy, receipt);
  assert.deepEqual(f.runtime.sessions.get(thread).nativeToolAllowlist, []);
});

test('explicit null base instructions are normalized consistently for create, resume, fingerprint and materialization', async t => {
  const f = await fixture(t), runtime = new Runtime();
  f.store.set('home', { threadId: null, config: { cwd: '/isolated', developerInstructions: null } });
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), linkStore: f.store });
  const thread = await adapter.ensureThread('home', [], null, undefined);
  assert.equal(runtime.sessions.get(thread).developerInstructions, null);
  await adapter.ensureThread('home', [], null, undefined); assert.equal(runtime.updates.length, 0);
  adapter.configure('home', { developerInstructions: 'EXPLICIT_BASE_POLICY' });
  await adapter.ensureThread('home', [], null, undefined);
  assert.equal(runtime.updates.length, 1); assert.match(runtime.updates[0].text, /EXPLICIT_BASE_POLICY/);
  const saved = await f.saved(); f.store.set('home', { ...saved, config: { ...saved.config, developerInstructions: null } });
  const cleared = new CodexDshAdapter({ runtime, ready: Promise.resolve(), linkStore: new CodexLinkStore(f.path) });
  await cleared.ensureThread('home', [], null, undefined);
  assert.equal(runtime.sessions.get(thread).developerInstructions, null);
  assert.match(runtime.updates[1].text, /No additional host-provided instructions apply/);
  assert.doesNotMatch(runtime.updates[1].text, /EXPLICIT_BASE_POLICY/);
});

test('runtime materializes only developer text, while authoritative active status fails closed even with empty cached turns', async () => {
  class Client extends EventEmitter {
    requests = []; status = 'idle';
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'thread', status: { type: this.status } } };
      if (method === 'thread/inject_items') return {};
      throw Error(`Unexpected ${method}`);
    }
  }
  const client = new Client(), runtime = new CodexSessionRuntime({ client });
  runtime.sessions.set('thread', { id: 'thread', turns: [] });
  await runtime.applyTrustedPolicy('thread', 'TRUSTED');
  assert.deepEqual(client.requests[1], { method: 'thread/inject_items', params: { threadId: 'thread', items: [{
    type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'TRUSTED' }],
  }] } });
  client.requests = []; client.status = 'active';
  await assert.rejects(runtime.applyTrustedPolicy('thread', 'CHANGED'), /unless.*idle/);
  assert.deepEqual(client.requests.map(row => row.method), ['thread/read']);
  client.requests = []; runtime.sessions.get('thread').turns = [{ status: 'inProgress' }];
  await assert.rejects(runtime.applyTrustedPolicy('thread', 'CHANGED'), /running/);
  assert.deepEqual(client.requests, []);
});

test('injected developer response items never become assistant activity or cached turn content', async () => {
  class Client extends EventEmitter {
    async request(method, params) {
      if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } };
      if (method === 'thread/inject_items') {
        this.emit('notification', { method: 'rawResponseItem/completed', params: {
          threadId: 'thread', turnId: 'prior-turn', item: params.items[0],
        } });
        return {};
      }
      throw Error(`Unexpected ${method}`);
    }
  }
  const client = new Client(), runtime = new CodexSessionRuntime({ client }), activity = [];
  runtime.sessions.set('thread', { id: 'thread', turns: [] });
  runtime.on('activity', event => activity.push(event));
  await runtime.applyTrustedPolicy('thread', 'PRIVATE_HOST_POLICY <notebook>protocol</notebook>');
  assert.deepEqual(activity, []);
  assert.deepEqual(runtime.sessions.get('thread').turns, []);
});


test('read-only native policy gets its own stable trusted receipt and never claims all native reads are disabled', async t => {
  const f = await fixture(t); await f.ensure();
  const empty = await f.saved();
  await f.ensure('POLICY_A', ['read', 'read_image', 'glob', 'grep']);
  assert.equal(f.runtime.updates.length, 1);
  assert.ok(f.runtime.updates[0].text.includes(READ_ONLY_NATIVE_TOOL_INSTRUCTIONS));
  assert.ok(!f.runtime.updates[0].text.includes(NATIVE_TOOL_RESTRICTION_INSTRUCTIONS));
  assert.notEqual((await f.saved()).trustedPolicy.hash, empty.trustedPolicy.hash);
  await f.ensure('POLICY_A', ['read', 'read_image', 'glob', 'grep']);
  assert.equal(f.runtime.updates.length, 1);
});
