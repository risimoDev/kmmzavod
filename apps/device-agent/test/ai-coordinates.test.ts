import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiCoordinates } from '../src/publish';

const screen = { width: 1080, height: 2400 };

test('0–1000 scale is always scaled to pixels, never taken as pixels', () => {
  assert.deepEqual(parseAiCoordinates(500, 500, screen), { x: 540, y: 1200 });
  // A point that would be ambiguous if pixels were guessed: stays a relative point.
  assert.deepEqual(parseAiCoordinates(540, 900, screen), { x: 583, y: 2160 });
});

test('fractions 0..1 are accepted', () => {
  assert.deepEqual(parseAiCoordinates(0.5, 0.25, screen), { x: 540, y: 600 });
});

test('edges are clamped inside the screen', () => {
  assert.deepEqual(parseAiCoordinates(1000, 1000, screen), { x: 1079, y: 2399 });
});

test('values outside the contract are rejected, not tapped', () => {
  assert.equal(parseAiCoordinates(540, 1800, screen), null);
  assert.equal(parseAiCoordinates(0, 500, screen), null);
  assert.equal(parseAiCoordinates(-5, 500, screen), null);
  assert.equal(parseAiCoordinates(undefined, 500, screen), null);
  assert.equal(parseAiCoordinates(Number.NaN, 500, screen), null);
  assert.equal(parseAiCoordinates('500' as unknown as number, 500, screen), null);
});
