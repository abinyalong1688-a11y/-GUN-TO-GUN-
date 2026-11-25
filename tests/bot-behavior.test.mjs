// bot-behavior.test.mjs — behavior-tree composite semantics and decorators
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BTStatus, Selector, Sequence, Parallel, Condition, Action, Inverter, Cooldown} from '../src/botBehaviorTree.js';

const ok = () => BTStatus.SUCCESS;
const fail = () => BTStatus.FAILURE;
const run = () => BTStatus.RUNNING;
const leaf = status => new Action(() => status);

test('Selector: first SUCCESS wins, RUNNING short-circuits, all FAILURE fails', () => {
  assert.equal(new Selector([leaf(BTStatus.FAILURE), leaf(BTStatus.SUCCESS), leaf(BTStatus.FAILURE)]).tick({}, {}), BTStatus.SUCCESS);
  assert.equal(new Selector([leaf(BTStatus.FAILURE), leaf(BTStatus.RUNNING), leaf(BTStatus.SUCCESS)]).tick({}, {}), BTStatus.RUNNING);
  assert.equal(new Selector([leaf(BTStatus.FAILURE), leaf(BTStatus.FAILURE)]).tick({}, {}), BTStatus.FAILURE);
  assert.equal(new Selector([]).tick({}, {}), BTStatus.FAILURE, 'an empty selector fails');
});

test('Selector evaluates in priority order and stops at the first non-failure', () => {
  const calls = [];
  const node = new Selector([
    new Action(() => { calls.push('a'); return BTStatus.FAILURE; }),
    new Action(() => { calls.push('b'); return BTStatus.SUCCESS; }),
    new Action(() => { calls.push('c'); return BTStatus.SUCCESS; }),
  ]);
  node.tick({}, {});
  assert.deepEqual(calls, ['a', 'b'], 'the third child must not be ticked after a success');
});

test('Sequence: first FAILURE aborts, RUNNING pauses, all SUCCESS succeeds', () => {
  const calls = [];
  const seq = new Sequence([
    new Action(() => { calls.push('a'); return BTStatus.SUCCESS; }),
    new Action(() => { calls.push('b'); return BTStatus.FAILURE; }),
    new Action(() => { calls.push('c'); return BTStatus.SUCCESS; }),
  ]);
  assert.equal(seq.tick({}, {}), BTStatus.FAILURE);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(new Sequence([leaf(BTStatus.SUCCESS), leaf(BTStatus.RUNNING), leaf(BTStatus.SUCCESS)]).tick({}, {}), BTStatus.RUNNING);
  assert.equal(new Sequence([leaf(BTStatus.SUCCESS), leaf(BTStatus.SUCCESS)]).tick({}, {}), BTStatus.SUCCESS);
  assert.equal(new Sequence([]).tick({}, {}), BTStatus.SUCCESS, 'an empty sequence succeeds');
});

test('Parallel: ticks every child, failure dominates, all success is success, otherwise running', () => {
  let ticks = 0;
  const counting = status => new Action(() => { ticks++; return status; });
  assert.equal(new Parallel([counting(BTStatus.SUCCESS), counting(BTStatus.SUCCESS)]).tick({}, {}), BTStatus.SUCCESS);
  assert.equal(ticks, 2);
  ticks = 0;
  assert.equal(new Parallel([counting(BTStatus.RUNNING), counting(BTStatus.SUCCESS)]).tick({}, {}), BTStatus.RUNNING);
  assert.equal(ticks, 2, 'Parallel must tick siblings even after RUNNING');
  assert.equal(new Parallel([counting(BTStatus.RUNNING), counting(BTStatus.FAILURE)]).tick({}, {}), BTStatus.FAILURE);
});

test('Condition returns SUCCESS/FAILURE from the predicate', () => {
  let hp = 10;
  const wounded = new Condition(() => hp < 30);
  assert.equal(wounded.tick({}, {}), BTStatus.SUCCESS);
  hp = 90;
  assert.equal(wounded.tick({}, {}), BTStatus.FAILURE);
});

test('Inverter flips SUCCESS/FAILURE but passes RUNNING through', () => {
  assert.equal(new Inverter(leaf(BTStatus.SUCCESS)).tick({}, {}), BTStatus.FAILURE);
  assert.equal(new Inverter(leaf(BTStatus.FAILURE)).tick({}, {}), BTStatus.SUCCESS);
  assert.equal(new Inverter(leaf(BTStatus.RUNNING)).tick({}, {}), BTStatus.RUNNING);
});

test('Cooldown rate-limits a successful child for the configured window', () => {
  const node = new Cooldown(leaf(BTStatus.SUCCESS), 2);
  const ctx = {now: 1};
  assert.equal(node.tick({}, ctx), BTStatus.SUCCESS, 'first success is allowed');
  ctx.now = 2.5;
  assert.equal(node.tick({}, ctx), BTStatus.FAILURE, 'blocked during the cooldown');
  ctx.now = 3.1;
  assert.equal(node.tick({}, ctx), BTStatus.SUCCESS, 'allowed after the cooldown');
});

test('reset walks the whole tree (respawn must not keep decorator state)', () => {
  const child = new Cooldown(leaf(BTStatus.SUCCESS), 10);
  const root = new Selector([new Sequence([child])]);
  root.tick({}, {now: 0});
  assert.equal(child.readyAt, 10);
  root.reset();
  assert.equal(child.readyAt, 0);
});
