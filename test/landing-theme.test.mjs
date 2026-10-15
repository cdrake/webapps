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
  assert.equal(token('muted'), '#8c8f8c');
  assert.equal(token('green'), '#6ba442');
  assert.equal(token('line'), '#262826');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--page\)/s);
});

function luminance(hex) {
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('small muted labels on the green panels meet AA contrast', () => {
  // Analytics labels and the search shortcut sit on --green-pale.
  for (const fg of ['muted', 'green-dark']) assert.ok(contrast(token(fg), token('green-pale')) >= 4.5, fg);
});

test('landing page exposes a neutral, readable light palette', () => {
  assert.match(css, /:root\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--page:\s*#fafafa[^}]*--green:\s*#467d25[^}]*--text:\s*#171817[^}]*--surface:\s*#f4f4f5/s);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
});
