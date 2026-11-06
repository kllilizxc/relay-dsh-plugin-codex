import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRuntimeController, createCodexExecutionPlugin } from '../plugin.mjs';
import { PluginHost } from '../internal/plugin-sdk.mjs';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail('lifecycle transition did not settle');
}
class Client extends EventEmitter {
  constructor(command, request, close) {
    super(); this.command = command; this.handler = request; this.finish = close; this.closed = false;
    this.runtimeInfo = {source:'fake', path:command, modelCount:1};
  }
  async start() {}
  async request(method, params) {
    if (method === 'model/list') return {data:[{id:this.command, isDefault:true}]};
    if (method === 'account/read') return null;
    if (method === 'thread/list') return {data:[]};
    if (this.handler) return this.handler(method, params);
    if (method === 'thread/read') return {thread:{id:params.threadId, turns:[]}};
    return 'ok';
  }
  async close() { await this.finish?.(); this.closed = true; }
}
function harness(t, request, close) {
  const clients = [];
  const controller = new CodexRuntimeController({cwd:'/workspace', idleTimeoutMs:15,
    clientFactory(command) { const client = new Client(command, request, close); clients.push(client); return client; }});
  t.after(() => controller.close());
  return {controller, clients};
}

test('unused child parks, retains catalog, and concurrent reads share one fresh child', async t => {
  const {controller, clients} = harness(t);
  await controller.start('codex-test');
  await until(() => controller.current === null);
  assert.equal(clients[0].closed, true);
  assert.equal(controller.status().state, 'standby');
  assert.deepEqual(controller.listModels().map(x => x.id), ['codex-test']);
  await controller.whenReady();
  assert.equal(clients.length, 1);
  const values = await Promise.all([controller.readThread('one'), controller.readThread('two')]);
  assert.deepEqual(values.map(x => x.id), ['one', 'two']);
  assert.equal(clients.length, 2);
  assert.equal(clients[1].closed, false);
});

test('an admitted read retains its child until the real result settles', async t => {
  const pending = gate();
  const {controller, clients} = harness(t, (method, params) => method === 'thread/read'
    ? pending.promise : null);
  await controller.start('codex-test');
  const result = controller.readThread('one');
  await delay(40);
  assert.equal(clients[0].closed, false);
  pending.resolve({thread:{id:'one'}});
  await result;
  await until(() => controller.current === null);
  assert.equal(clients[0].closed, true);
});

test('a native thread request with unknown result pins the child without retrying', async t => {
  let attempts = 0;
  const {controller, clients} = harness(t, () => { attempts++; throw new Error('unknown result'); });
  await controller.start('codex-test');
  await assert.rejects(controller.createSession(), /unknown result/);
  await delay(40);
  assert.equal(attempts, 1);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, false);
});

test('opaque terminal ownership retains the child after its RPC returns', async t => {
  const {controller, clients} = harness(t);
  const host = new PluginHost(); t.after(() => host.dispose());
  await host.activate([createCodexExecutionPlugin({controller, command:'codex-test'})]);
  const terminal = host.capabilities.require('relay.terminal.codex.v1');
  await terminal.whenReady();
  await terminal.request('terminal/test', {});
  await delay(40);
  assert.equal(clients[0].closed, false);
});

test('calls arriving during shutdown wait for drain before sharing one replacement', async t => {
  const closing = gate(); let starts = 0;
  const {controller, clients} = harness(t, undefined, () => ++starts === 1 ? closing.promise : undefined);
  await controller.start('codex-test');
  await until(() => controller.parking !== null);
  const reads = [controller.readThread('one'), controller.readThread('two')];
  await delay(20);
  assert.equal(clients.length, 1);
  closing.resolve();
  await Promise.all(reads);
  assert.equal(clients[0].closed, true);
  assert.equal(clients.length, 2);
});

test('host disposal while parked or draining never starts another child', async t => {
  const closing = gate();
  const {controller, clients} = harness(t, undefined, () => closing.promise);
  await controller.start('codex-test');
  await until(() => controller.parking !== null);
  const disposed = controller.close();
  const read = controller.readThread('one');
  const rejected = assert.rejects(read, {code:'CODEX_RUNTIME_NOT_STARTED'});
  closing.resolve();
  await Promise.all([disposed, rejected]);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);
});

test('configuration reload from standby refreshes the authoritative model catalog', async t => {
  const {controller, clients} = harness(t);
  await controller.start('old');
  await until(() => controller.current === null);
  await controller.reload('new');
  assert.deepEqual(controller.listModels().map(x => x.id), ['new']);
  assert.equal(clients.length, 2);
  assert.equal(clients[1].command, 'new');
});
