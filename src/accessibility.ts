/** Shared keyboard behavior for the desktop's dialogs and tab strips. */
export function installAccessibility(): void {
  const focusable = 'button, [href], input, select, textarea, [tabindex]';
  const visible = (element: HTMLElement) =>
    !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0;
  const controls = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter(
      (element) => visible(element) && element.tabIndex >= 0 && !element.matches(':disabled'),
    );

  // A tab strip is one stop in the Tab order. Arrows move within it; Tab
  // continues into the selected panel. Use the existing click handlers.
  for (const list of document.querySelectorAll<HTMLElement>('[role="tablist"]')) {
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const sync = () => {
      for (const tab of tabs) tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    };
    sync();
    new MutationObserver(sync).observe(list, {
      subtree: true, attributes: true, attributeFilter: ['aria-selected'],
    });
    list.addEventListener('keydown', (event) => {
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      const vertical = getComputedStyle(list).flexDirection === 'column';
      const next = vertical ? 'ArrowDown' : 'ArrowRight';
      const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
      let index = current;
      if (event.key === next) index = (current + 1) % tabs.length;
      else if (event.key === previous) index = (current + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[index].click();
      tabs[index].focus();
    });
  }

  const roots = Array.from(document.querySelectorAll<HTMLElement>('.overlay, #sheet-wrap'));
  for (const root of roots) {
    const dialog = root.querySelector<HTMLElement>('.sheet');
    const heading = dialog?.querySelector<HTMLElement>('h2');
    if (dialog && heading && root.id !== 'setup') {
      heading.id ||= `${root.id}-title`;
      dialog.setAttribute('aria-labelledby', heading.id);
    } else if (dialog) dialog.setAttribute('aria-label', 'Set up botcage');
    // Do not discard a draft when selecting text and releasing on the backdrop.
    let beganOnBackdrop = false;
    root.addEventListener('pointerdown', (event) => {
      beganOnBackdrop = event.target === root;
    });
    root.addEventListener('click', (event) => {
      if (!beganOnBackdrop || event.target !== root || root !== top) return;
      root.querySelector<HTMLButtonElement>('button[id$="-close"], #about-close')?.click();
    });
  }
  const opened: HTMLElement[] = [];
  const returnTo = new Map<HTMLElement, HTMLElement | null>();
  const concealed = new Map<HTMLElement, string | null>();
  let origin: HTMLElement | null = null;
  let menuOrigin: HTMLElement | null = null;
  let top: HTMLElement | undefined;

  const remember = (event: Event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const control = target?.closest<HTMLElement>(focusable) ?? null;
    if (target?.closest('#menu')) origin = menuOrigin;
    else {
      origin = control ?? (document.activeElement as HTMLElement | null);
      menuOrigin = origin;
    }
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', remember, true);

  const focusFirst = (root: HTMLElement) => {
    const first = controls(root)[0];
    (first ?? root).focus({ preventScroll: true });
  };
  const syncDialogs = () => {
    const previous = top;
    for (const root of roots) {
      const active = !root.hidden && (root.id !== 'sheet-wrap' || root.classList.contains('is-wizard'));
      const index = opened.indexOf(root);
      if (active && index < 0) {
        opened.push(root);
        returnTo.set(root, origin);
      } else if (!active && index >= 0) opened.splice(index, 1);
    }
    // The model chooser and restore dialog sit above the sheet that opened them.
    top = opened.reduce<HTMLElement | undefined>((highest, root) =>
      !highest || Number(getComputedStyle(root).zIndex) >= Number(getComputedStyle(highest).zIndex)
        ? root : highest, undefined);
    for (const [element, previousValue] of concealed) {
      if (previousValue === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', previousValue);
    }
    concealed.clear();
    for (const root of roots) {
      const dialog = root.querySelector<HTMLElement>('.sheet');
      if (!dialog) continue;
      if (opened.includes(root)) {
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', String(root === top));
        dialog.tabIndex = -1;
      } else {
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        dialog.removeAttribute('tabindex');
      }
    }
    if (top) {
      // Conceal the background from assistive technology. The overlay blocks
      // pointer input; the focus guard below keeps keyboard input in the dialog.
      // Walk ancestors because the hiring dialog lives inside .app.
      let branch: HTMLElement = top;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (!(sibling instanceof HTMLElement) || sibling === branch ||
              sibling.hidden || sibling.matches('script, style, #toast')) continue;
          concealed.set(sibling, sibling.getAttribute('aria-hidden'));
          sibling.setAttribute('aria-hidden', 'true');
        }
        if (branch.parentElement === document.body) break;
        branch = branch.parentElement;
      }
    }
    if (top !== previous) {
      const restore = previous && !opened.includes(previous) ? returnTo.get(previous) : null;
      if (restore?.isConnected && visible(restore)) restore.focus({ preventScroll: true });
      else if (top && !top.contains(document.activeElement)) focusFirst(top);
      else if (!top && previous) {
        const fallback = document.querySelector<HTMLElement>('#input');
        if (fallback && visible(fallback)) fallback.focus({ preventScroll: true });
      }
      if (previous && !opened.includes(previous)) returnTo.delete(previous);
    }
  };
  const observer = new MutationObserver(syncDialogs);
  for (const root of roots) observer.observe(root, { attributes: true, attributeFilter: ['hidden', 'class'] });

  document.addEventListener('focusin', (event) => {
    if (top && event.target instanceof Node && !top.contains(event.target)) focusFirst(top);
  });

  document.addEventListener('keydown', (event) => {
    if (!top) return;
    if ((event.metaKey || event.ctrlKey) && ['n', 'b', 'k', 'f'].includes(event.key.toLowerCase())) {
      // App-wide navigation must not open a second workflow behind a dialog.
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.key === 'Tab') {
      const items = controls(top);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
      }
    }
  }, true);
  syncDialogs();
}
