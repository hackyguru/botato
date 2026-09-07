import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installAccessibility } from '../src/accessibility.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function page(markup) {
  const window = new Window();
  for (const name of ['document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'MutationObserver']) {
    globalThis[name] = window[name];
  }
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  // Happy DOM has no layout engine. Layout itself is checked in the desktop app.
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 32 }];
  window.document.body.innerHTML = markup;
  const get = id => window.document.getElementById(id);
  const click = id => {
    const element = get(id);
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    element.click();
  };
  const key = (value, options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    window.document.activeElement.dispatchEvent(event);
    return event;
  };
  return { window, get, click, key };
}

const dialogs = `
  <main id="background"><button id="open">Settings</button><input id="input"></main>
  <div class="overlay" id="settings" style="z-index:50" hidden>
    <div class="sheet"><h2>Settings</h2><button id="settings-close">Close</button>
      <button id="choose">Choose a model</button><button id="last">Done</button></div>
  </div>
  <div class="overlay" id="models-wrap" style="z-index:60" hidden>
    <div class="sheet"><h2>Models</h2><button id="models-close">Close</button><input id="search"></div>
  </div>`;
function setupDialogs() {
  const p = page(dialogs);
  p.get('open').onclick = () => { p.get('settings').hidden = false; };
  p.get('settings-close').onclick = () => { p.get('settings').hidden = true; };
  p.get('choose').onclick = () => { p.get('models-wrap').hidden = false; };
  p.get('models-close').onclick = () => { p.get('models-wrap').hidden = true; };
  installAccessibility();
  return p;
}

test('tabs use one Tab stop, arrows wrap, and Home/End select a panel', async () => {
  const p = page(`<div role="tablist" style="display:flex;flex-direction:column">
    <button id="general" role="tab" aria-selected="true">General</button>
    <button id="phone" role="tab" aria-selected="false">Phone</button>
    <button id="backup" role="tab" aria-selected="false">Backup</button></div>`);
  const tabs = [...document.querySelectorAll('[role=tab]')];
  for (const tab of tabs) tab.onclick = () => tabs.forEach(item => item.setAttribute('aria-selected', String(item === tab)));
  installAccessibility();
  p.get('general').focus();
  assert.equal(p.key('ArrowUp').defaultPrevented, true);
  await settle();
  assert.equal(document.activeElement, p.get('backup'));
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, -1, 0]);
  p.key('Home');
  await settle();
  assert.equal(document.activeElement, p.get('general'));
  p.key('End');
  await settle();
  assert.equal(document.activeElement, p.get('backup'));
  assert.equal(p.key('ArrowRight').defaultPrevented, false);
});

test('dialogs contain focus, block background shortcuts, and return to their opener', async () => {
  const p = setupDialogs();
  p.click('open');
  await settle();
  assert.equal(document.activeElement, p.get('settings-close'));
  assert.equal(p.get('background').getAttribute('aria-hidden'), 'true');
  assert.equal(p.get('settings').firstElementChild.getAttribute('aria-modal'), 'true');
  p.get('last').focus();
  assert.equal(p.key('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, p.get('settings-close'));
  p.key('Tab', { shiftKey: true });
  assert.equal(document.activeElement, p.get('last'));
  assert.equal(p.key('n', { metaKey: true }).defaultPrevented, true);
  p.get('input').focus();
  assert.equal(document.activeElement, p.get('settings-close'));
  p.click('settings-close');
  await settle();
  assert.equal(document.activeElement, p.get('open'));
  assert.equal(p.get('background').hasAttribute('aria-hidden'), false);
});

test('closing a nested picker restores its parent dialog and the picker opener', async () => {
  const p = setupDialogs();
  p.click('open');
  await settle();
  p.click('choose');
  await settle();
  assert.equal(document.activeElement, p.get('models-close'));
  assert.equal(p.get('settings').getAttribute('aria-hidden'), 'true');
  p.click('models-close');
  await settle();
  assert.equal(document.activeElement, p.get('choose'));
  assert.equal(p.get('settings').hasAttribute('aria-hidden'), false);
  assert.equal(p.get('background').getAttribute('aria-hidden'), 'true');
});

test('dragging from a field onto the backdrop preserves the draft', async () => {
  const p = setupDialogs();
  p.click('open');
  await settle();
  p.get('choose').dispatchEvent(new p.window.PointerEvent('pointerdown', { bubbles: true }));
  p.get('settings').click();
  await settle();
  assert.equal(p.get('settings').hidden, false);
  p.click('settings');
  await settle();
  assert.equal(p.get('settings').hidden, true);
});

test('a docked bot-settings pane does not trap focus or conceal the conversation', async () => {
  const p = page(`<main id="background"><input id="input"></main>
    <aside id="sheet-wrap" class="pane"><form class="sheet"><h2>Bot settings</h2><input id="name"></form></aside>`);
  installAccessibility();
  p.get('input').focus();
  assert.equal(document.activeElement, p.get('input'));
  assert.equal(p.get('background').hasAttribute('aria-hidden'), false);
  assert.equal(p.get('name').closest('form').hasAttribute('aria-modal'), false);
});
