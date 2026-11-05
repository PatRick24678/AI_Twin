// Tommy, the stand-in future self: shown until (or instead of) a face drawn from the participant's description.
// The picture is assets/tommy.png (to change his look, replace that file; see TOMMY below for where his eyes,
// head light and speaking lights sit in it). A robot has no mouth, so Tommy speaks with lights laid over the
// picture: a row of light bars under his eyes rises and falls with the same timed mouth shapes as a drawn face
// (createLipSync), his eyes glow brighter and his head light pulses. The picture is served from this site and
// the overlay is inline SVG with styles set through the DOM, so the page's strict CSP stays unchanged.
import { createLipSync } from './talking-portrait.js';

// Positions in the picture's own pixels (assets/tommy.png is 800 x 787). Update these if you replace the picture.
export const TOMMY = Object.freeze({
  src: '/assets/tommy.png', width: 800, height: 787,
  view: '60 15 680 680',                         // The part of the picture the round corner shows (x y width height).
  eyes: [{ x: 330.5, y: 212.5, rx: 18, ry: 31 }, { x: 479.5, y: 212.5, rx: 18, ry: 31 }],
  light: { x: 508, y: 97, r: 13 },               // The yellow head light.
  bars: { x: 405, y: 290, scale: 1.6 },          // Centre of the speaking lights, and their size.
  pivot: { x: 400, y: 430 },                     // He sways around his neck.
  plate: '#260929'                               // Face plate colour, used to cover the eyes while blinking.
});
const C = { eye: '#F2FFF9', glow: '#8FF0E2', light: '#FFD84A', bars: '#A6F3E7' };
// How far each shape "opens" Tommy's light bar, from 0 (quiet) to 1 (widest vowel).
export const OPENNESS = Object.freeze({ rest: 0, mbp: 0.12, cons: 0.45, l: 0.5, fv: 0.4, e: 0.7, u: 0.55, o: 0.85, ai: 1 });
const BAR_X = [-28, -14, 0, 14, 28], BAR_SHAPE = [0.45, 0.75, 1, 0.75, 0.45], BAR_MIN = 4, BAR_MAX = 30;
// Bar heights for one shape: the middle bar is tallest; `jitter` (0 to 1 per bar) keeps repeated shapes lively.
export function barHeights(shape, jitter = [0.5, 0.5, 0.5, 0.5, 0.5]) {
  const open = OPENNESS[shape] ?? 0;
  return BAR_SHAPE.map((k, i) => open === 0 ? BAR_MIN : BAR_MIN + (BAR_MAX - BAR_MIN) * open * k * (0.8 + 0.4 * jitter[i]));
}

export function tommySVG(id = 'tommy') {
  const T = TOMMY;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${T.view}" role="img" aria-label="Tommy, your stand-in future self">
  <defs>
    <radialGradient id="${id}-glow"><stop offset="0" stop-color="${C.glow}" stop-opacity="0.9"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id}-shine"><stop offset="0" stop-color="${C.light}" stop-opacity="0.95"/><stop offset="1" stop-color="${C.light}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="-1000" y="-1000" width="3000" height="3000" fill="#F7F4EC"/>
  <g class="tm-head">
    <image href="${T.src}" width="${T.width}" height="${T.height}"/>
    ${T.eyes.map(e => `<ellipse class="tm-glow" cx="${e.x}" cy="${e.y}" rx="${e.rx * 2.8}" ry="${e.ry * 2.1}" fill="url(#${id}-glow)" opacity="0.2"/>`).join('')}
    <g class="tm-blink" visibility="hidden">${T.eyes.map(e => `<ellipse cx="${e.x}" cy="${e.y}" rx="${e.rx + 3}" ry="${e.ry + 3}" fill="${T.plate}"/>
      <rect x="${e.x - e.rx}" y="${e.y - 2.5}" width="${e.rx * 2}" height="5" rx="2.5" fill="${C.eye}"/>`).join('')}</g>
    <circle class="tm-light" cx="${T.light.x}" cy="${T.light.y}" r="${T.light.r * 2.2}" fill="url(#${id}-shine)" opacity="0.4"/>
    <g class="tm-bars" transform="translate(${T.bars.x},${T.bars.y}) scale(${T.bars.scale})">${BAR_X.map(x =>
      `<rect x="${x - 4}" y="${-BAR_MIN / 2}" width="8" height="${BAR_MIN}" rx="4" fill="${C.bars}" opacity="0.3"/>`).join('')}</g>
  </g>
</svg>`;
}

export function createTommy(root) {
  root.innerHTML = tommySVG(`tommy${Math.random().toString(36).slice(2, 8)}`);
  const q = selector => root.querySelector(selector), qa = selector => [...root.querySelectorAll(selector)];
  const head = q('.tm-head'), light = q('.tm-light'), blinkLayer = q('.tm-blink'), glows = qa('.tm-glow'), bars = qa('.tm-bars rect');
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let talking = false, raf = 0, blinkTimer = 0, alive = true;

  function setMouth(shape) {
    const heights = barHeights(shape, bars.map(() => Math.random()));
    bars.forEach((bar, i) => { bar.setAttribute('height', heights[i].toFixed(1)); bar.setAttribute('y', (-heights[i] / 2).toFixed(1)); });
  }
  function setTalking(on) {
    talking = on;
    bars.forEach(bar => bar.setAttribute('opacity', on ? '1' : '0.3'));
    glows.forEach(glow => glow.setAttribute('opacity', on ? '0.6' : '0.2'));
    if (!on) setMouth('rest');
  }
  function blink(closed) {
    blinkLayer.setAttribute('visibility', closed ? 'visible' : 'hidden');
    glows.forEach(glow => glow.setAttribute('visibility', closed ? 'hidden' : 'visible'));
  }
  function scheduleBlink() {
    blinkTimer = setTimeout(() => {
      if (!alive) return;
      blink(true);
      setTimeout(() => { blink(false); scheduleBlink(); }, 130);
    }, 2200 + Math.random() * 3800);
  }
  function frame(t) {
    if (!alive) return;
    const sway = 0;//reduceMotion ? 0 : Math.sin(t / 1600) * 1.4 + (talking ? Math.sin(t / 260) * 0.8 : 0)
    head.setAttribute('transform', `rotate(${sway.toFixed(2)} ${TOMMY.pivot.x} ${TOMMY.pivot.y})`);
    // The head light breathes slowly, and flickers while Tommy talks.
    light.setAttribute('opacity', (talking ? 0.6 + 0.4 * Math.abs(Math.sin(t / 120)) : 0.25 + 0.15 * Math.sin(t / 900)).toFixed(2));
    raf = requestAnimationFrame(frame);
  }
  const lips = createLipSync({ setMouth, setTalking });
  scheduleBlink(); raf = requestAnimationFrame(frame);
  return {
    get ready() { return alive; },
    syncUtterance: u => lips.syncUtterance(u),
    stop: () => lips.stop(),
    destroy() { alive = false; lips.stop(); cancelAnimationFrame(raf); clearTimeout(blinkTimer); root.innerHTML = ''; }
  };
}
