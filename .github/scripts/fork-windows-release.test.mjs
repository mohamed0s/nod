import assert from 'node:assert/strict';
import test from 'node:test';
import { forkVersion } from './fork-windows-release.mjs';

const tags = ['nod-v0.8.3', 'nod-v0.9.1'];

test('fork versions number each n8n release above every tag on the fork', () => {
  assert.deepEqual(forkVersion('0.9.1', tags), { version: '0.9.200' });
  assert.deepEqual(forkVersion('0.9.1', [...tags, 'nod-v0.9.200']), { version: '0.9.201' });
  assert.deepEqual(forkVersion('0.9.2', [...tags, 'nod-v0.9.201']), { version: '0.9.300' });
  assert.deepEqual(forkVersion('0.10.0', [...tags, 'nod-v0.10.0', 'nod-v0.10.1']), {
    version: '0.10.100',
  });
  assert.deepEqual(forkVersion('0.9.1', [...tags, 'nod-v0.9.200'], { automatic: true }), {
    covered: '0.9.200',
  });
  assert.deepEqual(forkVersion('0.9.1', tags, { requested: '0.9.205' }), { version: '0.9.205' });
  assert.deepEqual(forkVersion('0.9.654', []), { version: '0.9.65500' });
});

test('fork versions refuse versions that would collide, block later builds or overflow Windows', () => {
  for (const [base, released, options, message] of [
    ['0.9.1', [...tags, 'nod-v0.9.299'], {}, /already has 100 fork builds/],
    ['0.9.1', [...tags, 'nod-v0.9.300'], {}, /higher than nod-v0\.9\.300/],
    ['0.9.1', [...tags, 'nod-v0.9.300'], { automatic: true }, /higher than nod-v0\.9\.300/],
    ['0.9.1', [...tags, 'nod-v0.9.203'], { requested: '0.9.202' }, /higher than nod-v0\.9\.203/],
    ['0.9.1', tags, { requested: '0.9.250x' }, /like 0\.9\.200/],
    ['0.9.1', tags, { requested: '0.9.300' }, /0\.9\.200 to 0\.9\.299/],
    ['0.9.1', tags, { requested: '0.9.2' }, /0\.9\.200 to 0\.9\.299/],
    ['0.9.655', [], {}, /65535/],
    ['0.9', [], {}, /not X\.Y\.Z/],
  ])
    assert.throws(() => forkVersion(base, released, options), message);
});
