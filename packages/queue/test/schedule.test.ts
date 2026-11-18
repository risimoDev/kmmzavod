import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isValidCron, isValidTimeZone, nextCronDate } from '../src/schedule';

test('monthly schedules and minute boundaries retain standard cron semantics', () => {
  assert.equal(nextCronDate('0 12 1 * *', 'UTC', new Date('2026-11-02T00:00:00Z'))?.toISOString(), '2026-12-01T12:00:00.000Z');
  assert.equal(nextCronDate('* * * * *', 'UTC', new Date('2026-11-19T05:00:42Z'))?.toISOString(), '2026-11-19T05:01:00.000Z');
  assert.equal(nextCronDate('0 9 * * 1', 'Europe/Moscow', new Date('2026-11-19T00:00:00Z'))?.toISOString(), '2026-11-23T06:00:00.000Z');
  assert.equal(isValidCron('* * * * * *'), false);
  assert.equal(isValidCron('91 12 * * *'), false);
  assert.equal(isValidTimeZone('Invalid/Zone'), false);
});
