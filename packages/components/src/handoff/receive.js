// Opens files another app sent here the way a page drop opens them: the shell claims the
// handoff and puts the files on the app's own inputs, so every app on the site can receive
// one without code of its own. An app that takes handoffs itself marks an element
// `data-neurodesk-handoff-receiver`, and the shell leaves its handoffs to it.
import { handoffId, takeHandoff } from './index.js';
import { classifiedInputs, deliverFiles, primaryInput, routeFiles } from '../ui/pageDrop.js';

// Apps that build their inputs after loading a model or a runtime get this long to show one.
const INPUT_WAIT_MS = 60 * 1000;

function loaded(window) {
  if (window.document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => { window.addEventListener('load', resolve, { once: true }); });
}

function inputAppears(document) {
  const window = document.defaultView;
  return new Promise((resolve, reject) => {
    let timer;
    const check = () => {
      const input = primaryInput(document);
      if (!input) return;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(input);
    };
    const observer = new window.MutationObserver(check);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert', 'open'] });
    timer = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error('this app shows no input to take it'));
    }, INPUT_WAIT_MS);
    check();
  });
}

// Resolves with what was received, or null when the page carries no handoff for the shell.
export async function receiveHandoff(document = globalThis.document) {
  if (!handoffId(document.location.hash)) return null;
  const window = document.defaultView;
  // Module scripts run in order; the app's own, and any handoff marker it renders, come after the shell's.
  await loaded(window);
  if (document.querySelector('[data-neurodesk-handoff-receiver]')) return null;
  const received = await takeHandoff({ document });
  if (!received) return null;
  const primary = await inputAppears(document);
  // A frame after load, so an app that binds its handlers once it has started does not miss the change.
  await new Promise((resolve) => { window.requestAnimationFrame(() => resolve()); });
  for (const [input, files] of routeFiles(received.files, classifiedInputs(document), primary)) {
    deliverFiles(input, files, { replace: true });
  }
  return received;
}
