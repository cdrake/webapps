import assert from 'node:assert/strict';
import test from 'node:test';
import { DATE_VERSION, nextVersion, releaseDate, validateReleaseDate } from '../scripts/lib/app-versions.mjs';

// The date-version arithmetic of `pnpm release`, new-app and the daily desktop
// stamp. It reads no workspace files, so its mutation run needs only this file.

test('the version scheme accepts date releases and nothing else', () => {
  for (const version of ['0.1.20260808', '2.10.20261231']) assert.match(version, DATE_VERSION);
  for (const version of ['0.1.0', '1.2.3', '0.1.2026088', '0.1.202608080', 'v0.1.20260808', '0.1.20260808-rc.1', '0.1']) {
    assert.doesNotMatch(version, DATE_VERSION, version);
  }
  for (const date of ['20260230', '20261301', '20260000', '2026-08-08']) {
    assert.throws(() => validateReleaseDate(date), undefined, date);
  }
  validateReleaseDate('20240229');
});

test('date versions preserve bump semantics and reject invalid dates and downgrades', () => {
  assert.equal(nextVersion('1.4.7', 'patch', '20260910'), '1.4.20260910');
  assert.equal(nextVersion('1.4.20260930', 'patch', '20261001'), '1.4.20261001');
  assert.equal(nextVersion('1.4.20260910', 'minor', '20260911'), '1.5.20260911');
  assert.equal(nextVersion('1.4.20260910', 'major', '20260911'), '2.0.20260911');
  assert.throws(() => nextVersion('nope', 'patch', '20260911'), /Cannot derive/);
  assert.throws(() => nextVersion('1.4.20260910', 'patch', '20260909'), /downgrade/);
  for (const date of ['20260931', '20260229', '20261301', '2026011']) {
    assert.throws(() => validateReleaseDate(date), /date/i);
  }
  validateReleaseDate('20280229');
});

test('a malformed release date names the expected format', () => {
  for (const date of ['2026-08-08', '202608080', 'v20260808']) {
    assert.throws(() => validateReleaseDate(date), new RegExp(`^Error: Release date must be YYYYMMDD, got ${date}$`), date);
  }
  assert.throws(() => validateReleaseDate('20260230'), /^Error: Invalid release date: 20260230$/);
});

test('the release date is the UTC day', () => {
  assert.equal(releaseDate(new Date('2026-10-15T23:59:59-10:00')), '20261016');
  assert.equal(releaseDate(new Date('2026-10-16T00:30:00+10:00')), '20261015');
});

test('a bump keeps multi-digit series, refuses what it cannot date and allows a same-day patch', () => {
  assert.equal(nextVersion('12.34.20260910', 'minor', '20260911'), '12.35.20260911');
  assert.equal(nextVersion('12.34.20260910', 'patch', '20260911'), '12.34.20260911');
  // pnpm release --same-day updates the version it already published that day.
  assert.equal(nextVersion('1.4.20260910', 'patch', '20260910'), '1.4.20260910');
  // A minor or major bump raises the version whatever its date.
  assert.equal(nextVersion('1.4.20260910', 'minor', '20260901'), '1.5.20260901');
  assert.equal(nextVersion('1.4.20260910', 'major', '20260901'), '2.0.20260901');
  assert.throws(() => nextVersion('1.4.7', 'patch', '20261301'), /Invalid release date/);
  assert.throws(() => nextVersion('1.4.7', 'prerelease', '20260910'), /^Error: Unknown bump 'prerelease'$/);
  for (const current of ['v1.4.7', '1.4.7-rc.1', '01.4.7', '1.4']) {
    assert.throws(() => nextVersion(current, 'patch', '20260910'), new RegExp(`Cannot derive a date version from '${current.replaceAll('.', '\\.')}'`), current);
  }
});
