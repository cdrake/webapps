import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as analytics from '../src/index.js';

function fakeBrowser() {
  const scripts = [];
  const document = {
    createElement: () => ({ dataset: {} }),
    head: { append: (script) => scripts.push(script) },
    querySelector: (selector) => scripts.find((script) => selector.includes(script.dataset.neurodeskGa4)),
  };
  return { document, scripts, window: {} };
}

test('exports page-view initialization without a custom-event API', () => {
  assert.deepEqual(Object.keys(analytics).sort(), ['initAnalytics', 'isTrackingAllowed']);
});

test('does not load Google when Do Not Track or Global Privacy Control is enabled', () => {
  for (const navigator of [{ doNotTrack: '1' }, { doNotTrack: 'yes' }, { globalPrivacyControl: true }]) {
    const browser = fakeBrowser();
    const result = analytics.initAnalytics('G-4Z9774J59Y', { ...browser, navigator });
    assert.deepEqual(result, { enabled: false, reason: 'privacy-signal' });
    assert.equal(browser.scripts.length, 0);
    assert.equal(browser.window.dataLayer, undefined);
  }
});

test('loads GA4 exactly once and configures only an automatic page view', () => {
  const browser = fakeBrowser();
  const environment = { ...browser, navigator: { doNotTrack: '0' } };
  assert.deepEqual(analytics.initAnalytics('G-4Z9774J59Y', environment), { enabled: true, reason: 'loaded' });
  assert.deepEqual(analytics.initAnalytics('G-4Z9774J59Y', environment), { enabled: true, reason: 'already-loaded' });
  assert.equal(browser.scripts.length, 1);
  assert.equal(browser.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-4Z9774J59Y');
  assert.equal(browser.window.dataLayer.length, 2);
  for (const command of browser.window.dataLayer) {
    assert.equal(Object.prototype.toString.call(command), '[object Arguments]',
      'gtag commands must use arguments objects; Google ignores array commands');
  }
  assert.equal(browser.window.dataLayer[0][0], 'js');
  assert.deepEqual(Array.from(browser.window.dataLayer[1]), ['config', 'G-4Z9774J59Y', {
    send_page_view: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  }]);
});

test('does not load Google in automated browsers', () => {
  const browser = fakeBrowser();
  const result = analytics.initAnalytics('G-4Z9774J59Y', { ...browser, navigator: { webdriver: true } });
  assert.deepEqual(result, { enabled: false, reason: 'automation' });
  assert.equal(browser.scripts.length, 0);
  assert.equal(browser.window.dataLayer, undefined);
});

test('rejects malformed measurement ids', () => {
  assert.throws(() => analytics.initAnalytics('not-an-id'), /Invalid GA4 measurement id/);
});
