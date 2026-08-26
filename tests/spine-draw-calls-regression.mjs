import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeSpineDrawCalls,
  analyzeSpineFrame,
  collectAnimationSampleTimes,
} from '../renderer/js/spine/spineDrawCalls.js';
import { loadWithRuntime } from '../renderer/js/spine/spinePreview.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function page(name, overrides = {}) {
  return { name, pma: false, ...overrides };
}

function regionAttachment(name, texturePage, overrides = {}) {
  return {
    type: 'region',
    name,
    region: { name, page: texturePage },
    uvs: new Float32Array(8),
    ...overrides,
  };
}

function meshAttachment(name, texturePage, triangleCount = 3, overrides = {}) {
  return {
    type: 'mesh',
    name,
    region: { name, page: texturePage },
    triangles: Array.from({ length: triangleCount * 3 }, (_, index) => index),
    worldVerticesLength: triangleCount * 2 + 2,
    uvs: new Float32Array(triangleCount * 2 + 2),
    ...overrides,
  };
}

function slot(name, attachment, blendMode = 'normal', overrides = {}) {
  return {
    data: { name, blendMode, ...(overrides.data || {}) },
    attachment,
    getAttachment() {
      return this.attachment;
    },
    ...overrides,
  };
}

function skeleton(slots) {
  return { slots, drawOrder: slots };
}

test('same-blend attachments from multiple pages share a Pixi batch', () => {
  const a = page('a.png');
  const b = page('b.png');
  const frame = analyzeSpineFrame(
    skeleton([
      slot('one', regionAttachment('one', a)),
      slot('two', meshAttachment('two', b, 4)),
      // Alpha-zero drawables still enter spine-pixi-v8's batcher.
      slot('transparent', regionAttachment('transparent', a), 'normal', { color: { a: 0 } }),
    ]),
    { maxTextures: 16 }
  );

  assert.equal(frame.drawCalls, 1);
  assert.equal(frame.drawableAttachments, 3);
  assert.equal(frame.triangles, 8);
  assert.equal(frame.texturePages, 2);
  assert.deepEqual(frame.texturePageNames.sort(), ['a.png', 'b.png']);
  assert.deepEqual(frame.batchSequence, ['default:normal:triangle-list']);
});

test('blend islands produce distinct batches in draw order', () => {
  const atlasPage = page('atlas.png');
  const frame = analyzeSpineFrame(
    skeleton([
      slot('normal-a', regionAttachment('normal-a', atlasPage), 'normal'),
      slot('multiply', regionAttachment('multiply', atlasPage), 'multiply'),
      slot('normal-b', regionAttachment('normal-b', atlasPage), 'normal'),
    ])
  );

  assert.equal(frame.drawCalls, 3);
  assert.equal(frame.breakReasons.blendMode, 2);
  assert.deepEqual(frame.batchSequence, [
    'default:normal:triangle-list',
    'default:multiply:triangle-list',
    'default:normal:triangle-list',
  ]);
  assert.deepEqual(frame.breakSequence.map((entry) => entry.reason), [
    'start',
    'blendMode',
    'blendMode',
  ]);
});

test('texture capacity, topology, and batcher changes are reported separately', () => {
  const pages = ['a', 'b', 'c', 'd', 'e'].map((name) => page(`${name}.png`));
  const slots = [
    slot('a', regionAttachment('a', pages[0])),
    slot('b', regionAttachment('b', pages[1])),
    slot('c', regionAttachment('c', pages[2])),
    slot('strip', regionAttachment('strip', pages[3], { topology: 'triangle-strip' })),
    slot('dark', regionAttachment('dark', pages[4]), 'normal', { data: { batcher: 'darkTint' } }),
  ];
  const frame = analyzeSpineFrame(skeleton(slots), {
    maxTextures: 2,
    batcherResolver: ({ slot: current }) => current.data.batcher ?? 'default',
  });

  assert.equal(frame.drawCalls, 4);
  assert.deepEqual(frame.breakReasons, {
    blendMode: 0,
    batcher: 1,
    // Entering and then leaving the triangle-strip batch both break topology.
    topology: 2,
    textureCapacity: 1,
  });
  assert.equal(frame.batches[0].drawableAttachments, 2);
  assert.deepEqual(frame.batches[0].texturePages, ['a.png', 'b.png']);
  assert.equal(frame.batches.at(-1).batcher, 'darkTint');
});

test('dark tint follows spine-pixi-v8 whole-skeleton inference', () => {
  const atlasPage = page('atlas.png');
  const first = slot('first', regionAttachment('first', atlasPage));
  const second = slot('second', regionAttachment('second', atlasPage), 'normal', {
    data: { darkColor: { r: 0, g: 0, b: 0, a: 1 } },
  });
  const frame = analyzeSpineFrame(skeleton([first, second]));

  assert.equal(frame.drawCalls, 1);
  assert.equal(frame.batches[0].batcher, 'darkTint');
});

test('sample times include 60 Hz points and both sides of timeline keys', () => {
  const animation = {
    duration: 0.1,
    timelines: [
      {
        frames: new Float32Array([0.05, 10, 0.075, 20]),
        getFrameEntries: () => 2,
        getFrameCount: () => 2,
      },
    ],
  };
  const times = collectAnimationSampleTimes(animation, {
    sampleRate: 60,
    keyframeEpsilon: 0.000001,
  });

  assert.ok(times.includes(0));
  assert.ok(times.includes(0.1));
  const near = (expected, tolerance = 2e-9) =>
    times.some((time) => Math.abs(time - expected) <= tolerance);
  // Runtime timeline storage uses Float32 values, so compare to the stored key.
  const firstKey = animation.timelines[0].frames[0];
  const secondKey = animation.timelines[0].frames[2];
  assert.ok(near(firstKey));
  assert.ok(near(firstKey - 0.000001));
  assert.ok(near(firstKey + 0.000001));
  assert.ok(near(secondKey));
});

test('invalid SkeletonData fails without throwing', () => {
  const report = analyzeSpineDrawCalls({ skeletonData: null });
  assert.equal(report.ok, false);
  assert.match(report.error, /Invalid skeletonData/);
});

test('updated sample_atlas stays at seven expected isolated Pixi calls', () => {
  const atlasText = readFileSync(join(root, 'sample_atlas', 'character.atlas'), 'utf8');
  const skeletonJson = JSON.parse(
    readFileSync(join(root, 'sample_atlas', 'character.json'), 'utf8')
  );
  const image = { width: 895, height: 895 };
  const loaded = loadWithRuntime({ atlasText, skeletonJson, image });
  assert.equal(loaded.ok, true, loaded.error);

  const report = analyzeSpineDrawCalls({
    skeletonData: loaded.skeletonData,
    sampleRate: 60,
    maxTextures: 16,
  });

  assert.equal(report.ok, true, report.warnings.join('\n'));
  assert.equal(report.animations.length, 10);
  assert.equal(report.summary.minDrawCalls, 7);
  assert.equal(report.summary.maxDrawCalls, 7);
  assert.equal(report.summary.texturePages.min, 1);
  assert.equal(report.summary.texturePages.max, 1);
  assert.ok(report.summary.attachments.min >= 68);
  assert.ok(report.summary.attachments.max <= 78);
  for (const animation of report.animations) {
    assert.equal(animation.minDrawCalls, 7, animation.animation);
    assert.equal(animation.maxDrawCalls, 7, animation.animation);
    assert.equal(animation.worstFrame.breakReasons.blendMode, 6, animation.animation);
  }
});
