import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPersistedEvents,
  loadPersistedSession,
  sessionEventCount,
  sessionEvents,
  writePersistedSession,
} from '../dsh-compat.mjs';

const EVENTS = Object.freeze([
  Object.freeze({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
  Object.freeze({ type: 'user/message', seq: 1, data: { id: 'message' } }),
]);

test('Session compatibility reads alpha.3 events snapshots', () => {
  const session = { events: EVENTS, seq: EVENTS.length };
  assert.equal(sessionEvents(session), EVENTS);
  assert.deepEqual(sessionEvents(session, 1), [EVENTS[1]]);
  assert.equal(sessionEventCount(session), 2);
});

test('Session compatibility reads rc.1 snapshotEvents and branded seq values', () => {
  const session = {
    seq: EVENTS.length,
    snapshotEvents(from = 0) { return Object.freeze(EVENTS.slice(from)); },
  };
  assert.deepEqual(sessionEvents(session), EVENTS);
  assert.deepEqual(sessionEvents(session, 1), [EVENTS[1]]);
  assert.equal(sessionEventCount(session), 2);
});

test('Session compatibility rejects unknown shapes and invalid offsets', () => {
  assert.throws(() => sessionEvents({}), /neither snapshotEvents/);
  assert.throws(() => sessionEvents({ events: EVENTS }, -1), /non-negative integer/);
});

test('Persistence compatibility uses alpha.3 load and append methods', async () => {
  const calls = [];
  const persistence = {
    load: async id => ({ meta: { id }, events: EVENTS }),
    append: async (id, events) => calls.push({ id, events }),
  };
  assert.deepEqual(await loadPersistedSession(persistence, 'alpha'), {
    meta: { id: 'alpha' },
    events: EVENTS,
  });
  await appendPersistedEvents(persistence, 'alpha', EVENTS);
  assert.deepEqual(calls, [{ id: 'alpha', events: EVENTS }]);
});

test('Persistence compatibility uses post-rc.1 read and write handles', async () => {
  const calls = [];
  const persistence = {
    async open(id, access) {
      calls.push(`open:${id}:${access}`);
      return access === 'read'
        ? {
            header: { id },
            inheritedEventCount: 1,
            read: async () => EVENTS,
            close: async () => calls.push('close:read'),
          }
        : {
            append: async events => calls.push(['append', events]),
            flush: async () => calls.push('flush'),
            close: async () => calls.push('close:write'),
          };
    },
  };
  assert.deepEqual(await loadPersistedSession(persistence, 'rc1'), {
    meta: { id: 'rc1' },
    inheritedEventCount: 1,
    events: EVENTS,
  });
  await appendPersistedEvents(persistence, 'rc1', EVENTS);
  assert.deepEqual(calls, [
    'open:rc1:read',
    'close:read',
    'open:rc1:write',
    ['append', EVENTS],
    'flush',
    'close:write',
  ]);
});

test('Persistence compatibility writes through the alpha.3 and rc.1 service API', async () => {
  const calls = [];
  const persistence = {
    async create(header, inheritedEventCount) {
      calls.push(['create', header, inheritedEventCount]);
    },
    async append(id, events) {
      calls.push(['append', id, events]);
    },
  };
  await writePersistedSession(persistence, { id: 'rc1' }, EVENTS, 1);
  assert.deepEqual(calls, [
    ['create', { id: 'rc1' }, 1],
    ['append', 'rc1', EVENTS],
  ]);
});

test('Persistence compatibility writes through the post-rc.1 create handle', async () => {
  const calls = [];
  const persistence = {
    async create(header, options) {
      calls.push(['create', header, options]);
      return {
        append: async events => calls.push(['append', events]),
        flush: async () => calls.push('flush'),
        close: async () => calls.push('close'),
      };
    },
  };
  await writePersistedSession(persistence, { id: 'rc1' }, EVENTS, 1);
  assert.deepEqual(calls, [
    ['create', { id: 'rc1' }, { inheritedEventCount: 1 }],
    ['append', EVENTS],
    'flush',
    'close',
  ]);
});
