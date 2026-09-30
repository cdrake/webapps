import { createElement } from '../core/dom.js';

/**
 * Small "i" help icons with a positioned tooltip, as used beside QSMbly's
 * parameter labels. Markup:
 *
 *   <span class="nd-info-icon" tabindex="0" aria-label="About X">i
 *     <span class="nd-info-tooltip" role="tooltip">…</span></span>
 *
 * `bindInfoTooltips(root)` shows the tooltip on hover and keyboard focus and
 * keeps it inside the viewport. Icons already bound are skipped.
 */
const bound = new WeakSet();

export function bindInfoTooltips(root = globalThis.document) {
  for (const icon of root.querySelectorAll('.nd-info-icon')) {
    if (bound.has(icon)) continue;
    const tooltip = icon.querySelector('.nd-info-tooltip');
    if (!tooltip) continue;
    bound.add(icon);
    keepControlName(icon);
    const win = icon.ownerDocument.defaultView;
    if (!icon.hasAttribute('tabindex')) icon.tabIndex = 0;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.id ||= `${icon.id || `ndInfo${Math.random().toString(36).slice(2, 8)}`}Tip`;
    icon.setAttribute('aria-describedby', tooltip.id);
    tooltip.hidden = true;
    const show = () => {
      tooltip.hidden = false;
      const iconRect = icon.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      let top = iconRect.top - tipRect.height - 6;
      if (top < 4) top = iconRect.bottom + 6;
      const left = Math.max(4, Math.min(iconRect.left + iconRect.width / 2 - tipRect.width / 2, win.innerWidth - tipRect.width - 4));
      Object.assign(tooltip.style, { top: `${top}px`, left: `${left}px` });
    };
    const hide = () => { tooltip.hidden = true; };
    icon.addEventListener('mouseenter', show);
    icon.addEventListener('mouseleave', hide);
    icon.addEventListener('focus', show);
    icon.addEventListener('blur', hide);
    icon.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  }
}

// An icon inside a <label> would otherwise join the control's accessible
// name ("Zoom level About zoom levels"). Name the control from the label's
// own text instead, unless the app already named it.
function keepControlName(icon) {
  const label = icon.closest('label');
  const control = label?.control;
  if (!control || control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
  const text = [...label.childNodes]
    .filter((node) => node !== icon && !(node.contains && node.contains(icon)) && node !== control)
    .map((node) => node.textContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) control.setAttribute('aria-label', text);
}

export function renderInfoIcon(text, config = {}, doc = globalThis.document) {
  return createElement('span', {
    className: 'nd-info-icon',
    tabindex: '0',
    'aria-label': config.label || 'More information',
    id: config.id,
    ownerDocument: doc,
  }, ['i', createElement('span', { className: 'nd-info-tooltip', text, ownerDocument: doc })]);
}
