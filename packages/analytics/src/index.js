// @neurodesk/analytics
// Shared, page-view-only GA4 bootstrap for the hosted webapps. There is
// deliberately no custom-event API: filenames, image metadata, processing
// settings, measurements, results, and interaction details cannot be sent.

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

export function isTrackingAllowed(navigatorObject = globalThis.navigator) {
  if (!navigatorObject) return true;
  const dnt = navigatorObject.doNotTrack || globalThis.doNotTrack || navigatorObject.msDoNotTrack;
  return dnt !== '1'
    && String(dnt).toLowerCase() !== 'yes'
    && navigatorObject.globalPrivacyControl !== true;
}

export function initAnalytics(measurementId, environment = {}) {
  if (!MEASUREMENT_ID_PATTERN.test(measurementId ?? '')) {
    throw new Error(`Invalid GA4 measurement id: ${measurementId}`);
  }

  const navigatorObject = environment.navigator ?? globalThis.navigator;
  if (!isTrackingAllowed(navigatorObject)) {
    return Object.freeze({ enabled: false, reason: 'privacy-signal' });
  }
  if (navigatorObject?.webdriver === true) {
    return Object.freeze({ enabled: false, reason: 'automation' });
  }

  const documentObject = environment.document ?? globalThis.document;
  const windowObject = environment.window ?? globalThis.window;
  if (!documentObject || !windowObject) {
    return Object.freeze({ enabled: false, reason: 'no-browser' });
  }

  const selector = `script[data-neurodesk-ga4="${measurementId}"]`;
  if (documentObject.querySelector(selector)) {
    return Object.freeze({ enabled: true, reason: 'already-loaded' });
  }

  windowObject.dataLayer = windowObject.dataLayer || [];
  function gtag() {
    windowObject.dataLayer.push(arguments);
  }
  gtag('js', new Date());
  gtag('config', measurementId, {
    send_page_view: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = documentObject.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  script.dataset.neurodeskGa4 = measurementId;
  documentObject.head.append(script);
  return Object.freeze({ enabled: true, reason: 'loaded' });
}
