import test from 'node:test';
import assert from 'node:assert/strict';
import { VISEMES, mouthSVG, textToVisemes, refineMouth, refineEye, analyseFace } from '../public/talking-portrait.js';

// A synthetic flat-colour "picture": skin everywhere, with dark shapes painted where a test wants them.
const SKIN = [242, 196, 160], INK = [40, 12, 36];
function picture(width = 400, height = 400) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...SKIN, 255], i);
  const paint = (x0, y0, x1, y1, colour = INK) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data.set([...colour, 255], (y * width + x) * 4);
  };
  return { img: { data, width, height }, paint };
}

test('reply text becomes timed mouth shapes that end closed', () => {
  const shapes = textToVisemes('Hello, nice to meet you.');
  assert.ok(shapes.length > 5);
  assert.ok(shapes.every(([shape, ms]) => VISEMES.includes(shape) && ms > 0));
  assert.equal(shapes.at(-1)[0], 'rest');
  assert.ok(textToVisemes('Hi.').reduce((n, [, ms]) => n + ms, 0) < textToVisemes('Hi, how was your week?').reduce((n, [, ms]) => n + ms, 0));
});

test('every mouth shape uses the picture\'s outline colour and no inline styles (the page CSP blocks them)', () => {
  for (const shape of VISEMES) {
    const svg = mouthSVG(shape, { id: 'x', ink: '#123456', line: 3 });
    assert.match(svg, /#123456/);
    assert.doesNotMatch(svg, /style=/);
  }
});

test('the mouth snaps to the drawn line near a rough estimate', () => {
  const { img, paint } = picture();
  paint(170, 250, 230, 254); // The drawn mouth: 61 px wide, 5 px thick, centred at 200,252.
  paint(196, 200, 199, 228); // A nose line above it, narrower: must not be chosen.
  const mouth = refineMouth(img, { x: 190, y: 245, w: 50, h: 10 });
  assert.equal(mouth.found, true);
  assert.equal(mouth.x, 200); assert.equal(mouth.y, 252); assert.equal(mouth.w, 61);
  assert.equal(mouth.ink, '#280c24');
  assert.equal(mouth.skin, '#f2c4a0');
  assert.ok(mouth.line >= 4 && mouth.line <= 5);
});

test('without a drawn line nearby the estimate is kept', () => {
  const { img } = picture();
  const mouth = refineMouth(img, { x: 200, y: 250, w: 40, h: 8 });
  assert.equal(mouth.found, false);
  assert.equal(mouth.x, 200); assert.equal(mouth.w, 40);
});

test('the eye snaps to the solid pupil, not to a glasses frame around it', () => {
  const { img, paint } = picture();
  // Glasses frame: a hollow rectangle around the eye.
  paint(140, 150, 200, 153); paint(140, 187, 200, 190); paint(140, 150, 143, 190); paint(197, 150, 200, 190);
  paint(165, 162, 175, 177); // The pupil: 11 x 16, centred at 170,169.5.
  const eye = refineEye(img, { x: 166, y: 166, w: 30, h: 30 });
  assert.equal(eye.found, true);
  assert.equal(eye.x, 170); assert.equal(eye.y, 169.5);
  assert.equal(eye.rx, 5.5); assert.equal(eye.ry, 8);
  assert.equal(eye.skin, '#f2c4a0');
});

test('blinking is switched off when an eye cannot be found', () => {
  const { img, paint } = picture();
  paint(165, 162, 175, 177);
  const face = analyseFace(img, { eyes: [{ x: 0.42, y: 0.42, w: 0.07, h: 0.07 }, { x: 0.6, y: 0.42, w: 0.07, h: 0.07 }],
    mouth: { x: 0.5, y: 0.62, w: 0.1, h: 0.02 } });
  assert.equal(face.eyes, null);
  assert.equal(face.mouth.found, false);
});

test('Tommy speaks with a light bar: quiet when resting, tallest in the middle, highest on wide vowels', async () => {
  const { barHeights, OPENNESS, tommySVG } = await import('../public/tommy.js');
  assert.ok(VISEMES.every(shape => shape in OPENNESS), 'every mouth shape has a light level');
  assert.deepEqual(barHeights('rest'), [4, 4, 4, 4, 4]);
  const wide = barHeights('ai'), small = barHeights('mbp');
  assert.equal(Math.max(...wide), wide[2]);
  assert.ok(wide[2] > barHeights('e')[2] && barHeights('e')[2] > small[2] && small[2] > 4);
  const svg = tommySVG('t');
  assert.match(svg, /class="tm-bars"/);
  assert.doesNotMatch(svg, /style=/, 'the page CSP blocks inline styles');
});

test('one timing engine drives every character and stops cleanly', async () => {
  const { createLipSync } = await import('../public/talking-portrait.js');
  const seen = [], talking = [];
  const lips = createLipSync({ setMouth: k => seen.push(k), setTalking: on => talking.push(on) });
  const u = new EventTarget(); u.text = 'Hello there.'; u.rate = 1;
  const done = lips.syncUtterance(u);
  u.dispatchEvent(new Event('start'));
  await new Promise(resolve => setTimeout(resolve, 900)); // no word events: the estimate runs
  u.dispatchEvent(new Event('end'));
  await done;
  assert.deepEqual(talking, [true, false]);
  assert.ok(seen.length > 2 && seen.every(k => VISEMES.includes(k)));
});
