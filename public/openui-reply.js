// Generative UI in the final chat: a future-self reply is spoken words, optionally followed by one OpenUI Lang block
// (```openui … ```, see TWIN_VISUALS in lib/prompts.mjs). The words go in the bubble and to voice; the block is drawn
// with OpenUI's renderer (public/vendor/openui/, from @openuidev/browser-bundle), loaded only when first needed.

// The opening fence may arrive split across stream chunks; `streaming` hides a half-written one.
const OPEN = /(^|\n)[^\S\n]*```openui(?:-lang)?[^\S\n]*(?:\n|$)/i;
const CLOSE = /\n[^\S\n]*```[^\S\n]*(?:\n|$)/;
const PARTIAL_OPEN = /\n?[^\S\n]*`{1,3}(?:o(?:p(?:e(?:n(?:u(?:i)?)?)?)?)?)?[^\S\n]*$/i;

export function splitReply(text = '', { streaming = false } = {}) {
  const open = OPEN.exec(text);
  if (!open) return { words: (streaming ? text.replace(PARTIAL_OPEN, '') : text).trim(), ui: '', complete: true };
  const body = text.slice(open.index + open[0].length);
  const close = CLOSE.exec('\n' + body);
  const ui = (close ? body.slice(0, Math.max(0, close.index - 1)) : body).trim();
  // Anything after the block is dropped from the words; the prompt asks for nothing there.
  return { words: text.slice(0, open.index).trim(), ui, complete: Boolean(close) };
}

// Only the words are read aloud.
export const spokenPart = text => splitReply(text).words;

let loading = null;
export function loadOpenUI() {
  if (globalThis.__OpenUI) return Promise.resolve(globalThis.__OpenUI);
  return loading ||= new Promise((resolve, reject) => {
    // OpenUI falls back to its dark palette unless the page says otherwise; Future Self is a light page.
    document.documentElement.dataset.openuiTheme = 'light';
    const style = document.createElement('link');
    style.rel = 'stylesheet'; style.href = '/vendor/openui/openui-styles.css';
    // Our own stylesheet comes after OpenUI's so the TATOMA overrides in styles.css win.
    document.head.insertBefore(style, document.querySelector('link[href="/styles.css"]'));
    const script = document.createElement('script');
    script.src = '/vendor/openui/openui-bundle.min.js';
    script.onload = () => globalThis.__OpenUI ? resolve(globalThis.__OpenUI) : reject(new Error('OpenUI did not load.'));
    script.onerror = () => { loading = null; script.remove(); reject(new Error('OpenUI did not load.')); };
    document.head.append(script);
  });
}

// One drawn block. `update` re-renders it as more of the stream arrives; `unmount` frees React.
export function createVisual(element, { onMessage } = {}) {
  let root = null, latest = null, gone = false;
  const draw = () => {
    if (!root || !latest) return;
    const { React, Renderer, openuiChatLibrary } = globalThis.__OpenUI;
    root.render(React.createElement(Renderer, {
      response: latest.ui, library: openuiChatLibrary, isStreaming: latest.streaming, publishObservability: false,
      // Follow-ups and clickable items send their text as the participant's next message. Links are never opened.
      onAction: event => {
        const text = event?.humanFriendlyMessage;
        if (event?.type === 'continue_conversation' && typeof text === 'string' && text.trim()) onMessage?.(text.trim());
      }
    }));
  };
  loadOpenUI().then(api => {
    if (gone) return;
    root = api.createRoot(element); draw();
  }).catch(() => {
    element.textContent = 'This part of the reply could not be shown.';
    element.classList.add('genui-failed');
  });
  return {
    element,
    update(ui, streaming = false) { latest = { ui, streaming }; draw(); },
    unmount() { gone = true; root?.unmount(); root = null; }
  };
}
