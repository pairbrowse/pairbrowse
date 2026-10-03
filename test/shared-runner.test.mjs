import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSteps } from '../scripts/runner.mjs';

const hooks = { secrets: { values: {}, domains: {} }, status() {}, activity() {} };

test('disconnect cancels passive handoff instead of holding the shared queue', async () => {
  const controller = new AbortController();
  let waiting;
  const entered = new Promise(r => { waiting = r; });
  const page = { bringToFront: async () => {}, getByText: () => ({ first: () => ({ waitFor: () => { waiting(); return new Promise(() => {}); } }) }) };
  const badges = [];
  const task = runSteps(page, [{ handoff: { say: 'Sign in', until: 'Welcome' } }, { press: 'Enter' }], { ...hooks, signal: controller.signal, status: (text, kind) => badges.push(kind) });
  await entered;
  controller.abort();
  const result = await task;
  assert.equal(result.ok, false);
  assert.equal(result.stoppedAt, 1);
  assert.match(result.why, /disconnected/);
  assert.deepEqual(badges, ['you', 'clear'], "the user's turn badge comes down");
});

test('human takeover checkpoint prevents the next fast-mode step', async () => {
  const keys = [];
  const page = { bringToFront: async () => {}, keyboard: { press: async key => keys.push(key) } };
  let step = 0;
  const result = await runSteps(page, [{ press: 'Tab' }, { press: 'Enter' }], { ...hooks, beforeStep: () => { if (++step === 2) throw Error('Human took control'); } });
  assert.deepEqual(keys, ['Tab']);
  assert.equal(result.stoppedAt, 2);
  assert.match(result.why, /Human/);
});
