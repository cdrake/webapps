import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../site/landing.css', import.meta.url), 'utf8');

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing concrete --${name} token`);
  return match[1].toLowerCase();
}

test('landing page matches the app theme: neutral greys and the logo green', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  assert.equal(token('page'), '#0d0e0d');
  assert.equal(token('surface'), '#141514');
  assert.equal(token('white'), '#1c1d1c');
  assert.equal(token('text'), '#ededed');
  assert.equal(token('muted'), '#858885');
  assert.equal(token('green'), '#6ba442');
  assert.equal(token('line'), '#262826');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--page\)/s);
});

test('landing page exposes a neutral, readable light palette', () => {
  assert.match(css, /:root\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--page:\s*#fafafa[^}]*--green:\s*#467d25[^}]*--text:\s*#171817[^}]*--surface:\s*#f4f4f5/s);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
});
