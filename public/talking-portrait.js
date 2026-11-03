// The future self's talking face. The picture comes from the image model (lib/portrait-model.mjs); everything that
// moves is laid over it here: the same nine mouth shapes for every face, a blink, and a gentle sway. The mouth
// follows the browser's speechSynthesis (no audio data is available): shapes come from the reply text, word
// boundary events keep them in step, and the end event closes the mouth.
//
// Works under the page's strict CSP: the picture is drawn on a canvas from an ImageBitmap, the overlay is inline
// SVG, and styles are set through the DOM, never as inline style attributes.

/* ---------- mouth shapes (shared by every face) ---------- */
export const VISEMES = ['rest', 'mbp', 'ai', 'e', 'o', 'u', 'fv', 'l', 'cons'];
const INSIDE = '#5A1B2F', TONGUE = '#EF7F72', TEETH = '#FFFFFF';

// One mouth, drawn around 0,0 in units where the closed mouth is about 30 wide. `ink` and `line` follow the
// picture's own outline colour and thickness.
export function mouthSVG(k, { id = 'm', ink = '#1E001E', line = 4.5 } = {}) {
  const s = (w = 4.5) => `stroke="${ink}" stroke-width="${(w * line / 4.5).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"`;
  const open = (outer, inner) => `<clipPath id="${id}"><path d="${outer}"/></clipPath><path d="${outer}" fill="${INSIDE}"/>` +
    `<g clip-path="url(#${id})">${inner}</g><path d="${outer}" fill="none" ${s(4)}/>`;
  const teeth = (y, h, w = 30) => `<rect x="${-w}" y="${y}" width="${w * 2}" height="${h}" fill="${TEETH}"/>`;
  const tongue = (cy, rx, ry) => `<ellipse cy="${cy}" rx="${rx}" ry="${ry}" fill="${TONGUE}"/>`;
  switch (k) {
    case 'rest': return `<path d="M-15,1 Q0,6 15,1" fill="none" ${s()}/>`;
    case 'mbp': return `<path d="M-16,2 Q0,-1 16,2" fill="none" ${s(6)}/>`;
    case 'ai': return open('M-18,-6 Q0,-9 18,-6 C18,10 10,21 0,21 C-10,21 -18,10 -18,-6Z', teeth(-13, 11) + tongue(19, 10, 6));
    case 'e': return open('M-21,-4 Q0,-7 21,-4 Q13,10 0,11 Q-13,10 -21,-4Z', teeth(-12, 13));
    case 'o': return open('M0,-12 Q10,-12 10,0 Q10,13 0,13 Q-10,13 -10,0 Q-10,-12 0,-12Z', tongue(9, 6, 4));
    case 'u': return `<ellipse rx="6" ry="7" fill="${INSIDE}" ${s(4)}/><path d="M-12,-5 Q-9,0 -12,5 M12,-5 Q9,0 12,5" fill="none" ${s(2.5)}/>`;
    case 'fv': return open('M-16,-2 Q0,-6 16,-2 Q10,7 0,7 Q-10,7 -16,-2Z', teeth(-9, 10, 11));
    case 'l': return open('M-17,-4 Q0,-7 17,-4 Q11,10 0,11 Q-11,10 -17,-4Z', teeth(-11, 8) + tongue(1, 6, 4.5));
    default: return open('M-18,-3 Q0,-6 18,-3 Q10,5 0,5 Q-10,5 -18,-3Z', teeth(-9, 10) + teeth(1, 6) + `<path d="M-15,1 L15,1" ${s(1.4)}/>`);
  }
}

/* ---------- text to timed mouth shapes ---------- */
export function textToVisemes(text) {
  const t = String(text).toLowerCase(), out = [];
  const push = (k, d) => { const last = out[out.length - 1]; if (last && last[0] === k) last[1] += d; else out.push([k, d]); };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i], nx = t[i + 1];
    if (ch === 't' && nx === 'h') { push('l', 85); i++; continue; }
    if ((ch === 's' || ch === 'c') && nx === 'h') { push('cons', 95); i++; continue; }
    if (ch === 'o' && nx === 'o') { push('u', 130); i++; continue; }
    if (ch === 'e' && nx === 'e') { push('e', 125); i++; continue; }
    if (ch === 'a') push('ai', 110);
    else if ('eiyéèë'.includes(ch)) push('e', 90);
    else if ('oö'.includes(ch)) push('o', 115);
    else if ('uü'.includes(ch)) push('u', 100);
    else if ('mbp'.includes(ch)) push('mbp', 80);
    else if ('fv'.includes(ch)) push('fv', 80);
    else if ('ltdn'.includes(ch)) push('l', 65);
    else if (ch === 'w') push('u', 80);
    else if ('rszcgkjxhq0123456789'.includes(ch)) push('cons', 62);
    else if (ch === ' ' || ch === '\n') push('rest', 45);
    else if (',;:'.includes(ch)) push('rest', 180);
    else if ('.!?'.includes(ch)) push('rest', 320);
  }
  push('rest', 60);
  return out;
}
const BASE_MS_PER_CHAR = 75; // What textToVisemes averages at.

/* ---------- finding the drawn mouth and pupils ---------- */
// `img` is { data, width, height } as from getImageData. Estimates are in pixels. Claude's boxes are rough, so
// these snap them to the actual drawn lines: the darkest connected shape of the right size near each estimate.
const luminance = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

function area(img, cx, cy, hw, hh) {
  return { x0: Math.max(0, Math.floor(cx - hw)), y0: Math.max(0, Math.floor(cy - hh)),
    x1: Math.min(img.width - 1, Math.ceil(cx + hw)), y1: Math.min(img.height - 1, Math.ceil(cy + hh)) };
}
// The typical colour of the lighter half of an area: skin rather than lines, shadows or stubble.
function lightColour(img, a) {
  const px = [];
  for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) {
    const i = (y * img.width + x) * 4; px.push([luminance(img.data, i), img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (!px.length) return { rgb: [240, 200, 170], lum: 0.8 };
  px.sort((p, q) => p[0] - q[0]);
  const top = px.slice(Math.floor(px.length * 0.5));
  const mid = c => { const v = top.map(p => p[c]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
  return { rgb: [mid(1), mid(2), mid(3)], lum: top[Math.floor(top.length / 2)][0] };
}
// Connected dark shapes inside an area (4-neighbour flood fill).
function darkShapes(img, a, threshold) {
  const w = a.x1 - a.x0 + 1, h = a.y1 - a.y0 + 1, seen = new Uint8Array(w * h), shapes = [];
  const dark = (x, y) => luminance(img.data, ((a.y0 + y) * img.width + a.x0 + x) * 4) < threshold;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seen[y * w + x] || !dark(x, y)) continue;
    const shape = { count: 0, minX: x, maxX: x, minY: y, maxY: y, r: 0, g: 0, b: 0 }, stack = [[x, y]];
    seen[y * w + x] = 1;
    while (stack.length) {
      const [px, py] = stack.pop(), i = ((a.y0 + py) * img.width + a.x0 + px) * 4;
      shape.count++; shape.r += img.data[i]; shape.g += img.data[i + 1]; shape.b += img.data[i + 2];
      if (px < shape.minX) shape.minX = px; if (px > shape.maxX) shape.maxX = px;
      if (py < shape.minY) shape.minY = py; if (py > shape.maxY) shape.maxY = py;
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || !dark(nx, ny)) continue;
        seen[ny * w + nx] = 1; stack.push([nx, ny]);
      }
    }
    Object.assign(shape, { w: shape.maxX - shape.minX + 1, h: shape.maxY - shape.minY + 1,
      cx: a.x0 + (shape.minX + shape.maxX) / 2, cy: a.y0 + (shape.minY + shape.maxY) / 2,
      touches: shape.minX === 0 || shape.maxX === w - 1 || shape.maxY === h - 1, ink: [shape.r / shape.count, shape.g / shape.count, shape.b / shape.count] });
    shapes.push(shape);
  }
  return shapes;
}

export function refineMouth(img, est) {
  const a = area(img, est.x, est.y, Math.max(est.w * 0.9, img.width * 0.05), Math.max(est.h * 2.2, est.w * 0.45));
  const skin = lightColour(img, a);
  const shapes = darkShapes(img, a, Math.min(skin.lum * 0.55, 0.45))
    .filter(s => !s.touches && s.w >= Math.max(6, est.w * 0.3) && s.h <= s.w * 1.2);
  let best = null, bestScore = -Infinity;
  for (const s of shapes) {
    const score = s.w / est.w - 2.5 * Math.hypot(s.cx - est.x, s.cy - est.y) / est.w;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  if (!best) return { x: est.x, y: est.y, w: est.w, h: Math.max(est.h, 4), ink: '#2B1027', skin: hex(skin.rgb), line: Math.max(2, img.width * 0.006), found: false };
  // The cover colour comes from just around the drawn mouth (skin, or a beard), not from inside it (teeth).
  const around = ringColour(img, best.cx, best.cy, best.w, best.h, Math.min(skin.lum * 0.55, 0.45)) || skin.rgb;
  return { x: best.cx, y: best.cy, w: best.w, h: best.h, ink: hex(best.ink), skin: hex(around),
    line: Math.max(2, Math.min(best.h, best.count / best.w)), found: true };
}
// The typical colour of the non-dark pixels in a band just outside a box.
function ringColour(img, cx, cy, w, h, threshold) {
  const inner = area(img, cx, cy, w * 0.6, h * 0.6 + 2), outer = area(img, cx, cy, w * 0.8, h * 0.6 + w * 0.15);
  const px = [];
  for (let y = outer.y0; y <= outer.y1; y++) for (let x = outer.x0; x <= outer.x1; x++) {
    if (x >= inner.x0 && x <= inner.x1 && y >= inner.y0 && y <= inner.y1) continue;
    const i = (y * img.width + x) * 4;
    if (luminance(img.data, i) >= threshold) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (px.length < 10) return null;
  const mid = c => { const v = px.map(p => p[c]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
  return [mid(0), mid(1), mid(2)];
}

export function refineEye(img, est) {
  const r = Math.max(est.w, est.h, 8);
  const a = area(img, est.x, est.y, r * 0.9, r * 0.9);
  const shapes = darkShapes(img, a, 0.3).filter(s => s.w >= 3 && s.h >= 3 && s.w <= r * 1.3 && s.h <= r * 1.3 &&
    s.count / (s.w * s.h) > 0.4 && s.w / s.h > 0.35 && s.w / s.h < 2.8);
  let best = null;
  for (const s of shapes) if (!best || Math.hypot(s.cx - est.x, s.cy - est.y) < Math.hypot(best.cx - est.x, best.cy - est.y)) best = s;
  if (!best) return { found: false };
  const rx = best.w / 2, ry = best.h / 2;
  const below = lightColour(img, area(img, best.cx, best.cy + ry * 2.2, rx * 1.2, ry * 0.6));
  return { x: best.cx, y: best.cy, rx, ry, ink: hex(best.ink), skin: hex(below.rgb), found: true };
}

// From the stored fractions to pixel positions snapped to the picture.
export function analyseFace(img, points) {
  const px = b => ({ x: b.x * img.width, y: b.y * img.height, w: b.w * img.width, h: b.h * img.height });
  const mouth = refineMouth(img, px(points.mouth));
  const eyes = points.eyes.map(e => refineEye(img, px(e)));
  return { width: img.width, height: img.height, mouth, eyes: eyes.every(e => e.found) ? eyes : null };
}

/* ---------- the player ---------- */
const store = {
  get(k) { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* Optional convenience. */ } }
};
let uid = 0;

// `root` holds a .face-stage element with a <canvas> and an <svg> inside (see index.html).
export function createTalkingPortrait(root) {
  const stage = root.querySelector('.face-stage'), canvas = root.querySelector('canvas'), overlay = root.querySelector('svg');
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), id = `tp${++uid}`;
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let face = null, talking = false, mouth = 'rest', drawnKey = '', timers = [], tok = 0, raf = 0, blinkTimer = 0;
  const $ = selector => overlay.querySelector(selector);

  function build() {
    const { width: W, height: H, mouth: m, eyes } = face;
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cover = (gid, colour) => `<radialGradient id="${gid}"><stop offset="0" stop-color="${colour}"/>` +
      `<stop offset="0.7" stop-color="${colour}"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>`;
    const blink = eyes ? eyes.map((e, i) => `<g transform="translate(${e.x.toFixed(1)},${e.y.toFixed(1)})">
        <ellipse rx="${(e.rx * 1.8).toFixed(1)}" ry="${(e.ry * 1.7).toFixed(1)}" fill="url(#${id}e${i})"/>
        <path d="M${(-e.rx * 1.3).toFixed(1)},0 Q0,${(e.ry * 0.8).toFixed(1)} ${(e.rx * 1.3).toFixed(1)},0" fill="none"
          stroke="${e.ink}" stroke-width="${m.line.toFixed(1)}" stroke-linecap="round"/></g>`).join('') : '';
    overlay.innerHTML = `<defs>${cover(`${id}m`, m.skin)}${eyes ? eyes.map((e, i) => cover(`${id}e${i}`, e.skin)).join('') : ''}</defs>
      <g class="tp-talk"><ellipse cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" rx="${(m.w * 0.78).toFixed(1)}"
        ry="${Math.max(m.h * 1.8, m.w * 0.42).toFixed(1)}" fill="url(#${id}m)"/><g class="tp-mouth"></g></g>
      <g class="tp-blink">${blink}</g>`;
    $('.tp-talk').setAttribute('visibility', 'hidden');
    $('.tp-blink').setAttribute('visibility', 'hidden');
    drawnKey = '';
  }
  // While quiet, the picture's own mouth shows; while speaking, it is covered and the shared shapes take over.
  function drawMouth() {
    if (!face) return;
    $('.tp-talk').setAttribute('visibility', talking ? 'visible' : 'hidden');
    if (!talking || drawnKey === mouth) return;
    drawnKey = mouth;
    const m = face.mouth, scale = Math.max(0.5, m.w / 40); // The closed shared mouth is about 30 units wide. 33-> 40%20 smaller
    const g = $('.tp-mouth');
    g.setAttribute('transform', `translate(${m.x.toFixed(1)},${m.y.toFixed(1)}) scale(${scale.toFixed(3)})`);
    g.innerHTML = mouthSVG(mouth, { id: `${id}c`, ink: m.ink, line: m.line / scale });
  }
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  function setMouth(k) { mouth = VISEMES.includes(k) ? k : 'rest'; drawMouth(); }
  function setTalking(on) { talking = on; if (!on) mouth = 'rest'; drawnKey = ''; drawMouth(); }
  function play(seq, scale) {
    clearTimers(); let t = 0;
    for (const [k, d] of seq) { timers.push(setTimeout(() => setMouth(k), t)); t += d * scale; }
    return t;
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (!face?.eyes) return;
    blinkTimer = setTimeout(() => {
      const g = face && $('.tp-blink');
      if (!g) return;
      g.setAttribute('visibility', 'visible');
      setTimeout(() => { g.setAttribute('visibility', 'hidden'); scheduleBlink(); }, 130);
    }, 2200 + Math.random() * 3800);
  }
  function frame(t) {
    if (!face) return;
    const sway = reduceMotion ? 0 : Math.sin(t / 1600) * 0.9 + (talking ? Math.sin(t / 280) * 0.5 : 0);
    const breathe = reduceMotion ? 1 : 1 + Math.sin(t / 1900) * 0.004;
    stage.style.transform = `rotate(${sway.toFixed(3)}deg) scale(${(1.03 * breathe).toFixed(4)})`;
    raf = requestAnimationFrame(frame);
  }

  return {
    get ready() { return Boolean(face); },
    get face() { return face; },
    // Draws the picture, finds the mouth and eyes, and starts the idle motion.
    load(bitmap, points) {
      this.clear();
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      face = analyseFace(ctx.getImageData(0, 0, canvas.width, canvas.height), points);
      build(); scheduleBlink(); raf = requestAnimationFrame(frame);
      return face;
    },
    clear() {
      this.stop(); face = null; cancelAnimationFrame(raf); clearTimeout(blinkTimer);
      overlay.innerHTML = ''; ctx.clearRect(0, 0, canvas.width, canvas.height); stage.style.transform = '';
    },
    // Animates an utterance the app speaks. Call before speechSynthesis.speak(u); the app's own handlers keep working.
    syncUtterance(u) {
      const text = u.text || '', mine = ++tok;
      clearTimers();
      const key = `face:msPerChar:${u.voice?.name || 'default'}:${u.rate || 1}`;
      let msPerChar = store.get(key) || BASE_MS_PER_CHAR / (u.rate || 1), gotWord = false, startedAt = 0, done = false;
      return new Promise(resolve => {
        const finish = ok => {
          if (done) return; done = true;
          if (mine === tok) {
            clearTimers(); setTalking(false);
            if (ok && startedAt) {
              // Learn this voice's speed, so the estimate improves for voices without word events.
              const real = (performance.now() - startedAt) / Math.max(10, text.length);
              if (real > 20 && real < 400) store.set(key, (msPerChar * 0.6 + real * 0.4).toFixed(1));
            }
          }
          resolve();
        };
        u.addEventListener('start', () => {
          if (mine !== tok) return;
          startedAt = performance.now(); setTalking(true);
          // No word events within 250 ms: this voice does not send them, so run the whole line on the estimate.
          timers.push(setTimeout(() => { if (!gotWord && mine === tok) play(textToVisemes(text), msPerChar / BASE_MS_PER_CHAR); }, 250));
        });
        u.addEventListener('boundary', event => {
          if (mine !== tok || (event.name && event.name !== 'word')) return;
          gotWord = true;
          const word = text.slice(event.charIndex).match(/^\S+/);
          if (word) play(textToVisemes(word[0]), (msPerChar / BASE_MS_PER_CHAR) * 0.85);
        });
        u.addEventListener('end', () => finish(true));
        u.addEventListener('error', () => finish(false));
      });
    },
    stop() { tok++; clearTimers(); if (face) setTalking(false); }
  };
}
