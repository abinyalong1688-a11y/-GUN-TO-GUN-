import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAll } from '../test/map-validate.mjs';

test('four-map placement, assembly, mounting and reachability validation', () => {
  const { issues } = validateAll();
  assert.deepEqual(issues, [], issues.map(x =>
    `${x.map} ${x.category} ${x.object} @ ${x.pos.join(',')}: ${x.detail}`).join('\n'));
});
