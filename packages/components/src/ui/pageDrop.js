import { filesFromDataTransferItems } from '../file-io/detectFiles.js';

// Elements that already take drops for one slot keep them.
const LOCAL_TARGETS = '.nd-file, .file-upload-zone, .file-drop, .upload-zone, [data-drop-target]';
const KINDS = [
  ['gradients', /\.(bvals?|bvecs?)$/i],
  ['surface', /\.(gii|mz3|stl|obj|ply|vtk|off|pial|white|inflated|sphere)$/i],
];
const UNDO_MS = 8000;

function kindOf(file) {
  return KINDS.find(([, pattern]) => pattern.test(file.name))?.[0] ?? 'image';
}

/**
 * Put files on a file input and let the app's own change handler load them.
 * `replace` first fires `nd-replace` on the input, so an app whose input adds
 * to a file list can clear it.
 */
export function deliverFiles(input, files, { replace = false } = {}) {
  if (replace) input.dispatchEvent(new CustomEvent('nd-replace', { bubbles: true }));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Route files to the page's inputs: each file goes to an input of its kind
 * (`data-neurodesk-input`), or with the scans when no such input exists. Scans
 * fill empty single-file slots in order; a full page replaces from the first.
 */
export function routeFiles(files, inputs, filled = () => false) {
  const kinds = new Set(inputs.map(input => input.dataset.neurodeskInput));
  const groups = new Map();
  for (const file of files) {
    const kind = kinds.has(kindOf(file)) ? kindOf(file) : 'image';
    groups.set(kind, [...(groups.get(kind) ?? []), file]);
  }
  const plan = [];
  for (const [kind, group] of groups) {
    let slots = inputs.filter(input => input.dataset.neurodeskInput === kind);
    if (!slots.length) slots = inputs.slice(0, 1);
    if (!slots.length) continue;
    const empty = slots.findIndex(input => !filled(input));
    let index = empty < 0 ? 0 : empty;
    let rest = group;
    while (rest.length && index < slots.length) {
      const input = slots[index++];
      const take = input.multiple || index === slots.length ? rest.length : 1;
      plan.push([input, rest.slice(0, take)]);
      rest = rest.slice(take);
    }
  }
  return plan;
}

/**
 * Make the whole window a drop target, the NiiVue canvas included. Dropped
 * files replace the session through the app's normal inputs; the status bar
 * offers Undo, which reloads the previous inputs.
 */
export function bindPageDrop(doc = globalThis.document) {
  // The shell and the example selector both install it; their module copies differ, so mark the document.
  const root = doc.documentElement;
  if (root.hasAttribute('data-nd-page-drop')) return null;
  root.setAttribute('data-nd-page-drop', '');
  const view = doc.defaultView;
  const previous = new Map();
  const overlay = doc.createElement('div');
  overlay.className = 'nd-drop-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<p>Drop to open</p>';
  doc.body.append(overlay);
  let undoTimer;

  const inputs = () => [...doc.querySelectorAll('input[type="file"][data-neurodesk-input]')]
    .filter(input => !input.disabled && !input.webkitdirectory && !input.closest('[inert], dialog:not([open])'));
  const carriesFiles = event => event.dataTransfer?.types?.includes('Files');
  const local = event => event.target instanceof view.Element && event.target.closest(LOCAL_TARGETS);

  function show(event) {
    if (!carriesFiles(event) || !inputs().length) return;
    if (local(event)) {
      overlay.hidden = true;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    overlay.hidden = false;
  }

  function hide(event) {
    if (event.type === 'dragleave' && event.relatedTarget) return;
    overlay.hidden = true;
  }

  function offerUndo(snapshot) {
    const status = doc.querySelector('footer#status, #status');
    status?.querySelector('.nd-status-undo')?.remove();
    view.clearTimeout(undoTimer);
    if (!status || !snapshot.length) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'nd-status-undo';
    button.textContent = 'Undo';
    button.addEventListener('click', () => {
      button.remove();
      for (const [input, files] of snapshot) deliverFiles(input, files, { replace: true });
    });
    status.append(button);
    undoTimer = view.setTimeout(() => button.remove(), UNDO_MS);
  }

  async function drop(event) {
    if (!carriesFiles(event) || local(event)) return;
    const targets = inputs();
    if (!targets.length) return;
    event.preventDefault();
    event.stopPropagation();
    overlay.hidden = true;
    const files = await filesFromDataTransferItems(event.dataTransfer.items);
    if (!files.length) return;
    const plan = routeFiles(files, targets, input => previous.has(input));
    const snapshot = plan.filter(([input]) => previous.has(input)).map(([input]) => [input, previous.get(input)]);
    for (const [input, group] of plan) deliverFiles(input, group, { replace: true });
    offerUndo(snapshot);
  }

  // Remember each input's files so a later drop can be undone.
  function remember(event) {
    const input = event.target;
    if (input instanceof view.HTMLInputElement && input.type === 'file' && input.files?.length) previous.set(input, [...input.files]);
  }

  // Capture runs before NiiVue's own canvas handlers, which would load files behind the app's back.
  view.addEventListener('dragenter', show, true);
  view.addEventListener('dragover', show, true);
  view.addEventListener('dragleave', hide, true);
  view.addEventListener('drop', drop, true);
  doc.addEventListener('change', remember, true);
  return {
    destroy() {
      view.removeEventListener('dragenter', show, true);
      view.removeEventListener('dragover', show, true);
      view.removeEventListener('dragleave', hide, true);
      view.removeEventListener('drop', drop, true);
      doc.removeEventListener('change', remember, true);
      overlay.remove();
      root.removeAttribute('data-nd-page-drop');
    },
  };
}
