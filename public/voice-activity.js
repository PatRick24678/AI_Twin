// End-of-speech detection for hands-free voice mode. Pure logic (no DOM or audio APIs), so it is testable in Node.
// Levels are RMS values from 0 to 1. These are prototype defaults to tune with real use, not validated thresholds.
export const VOICE_ACTIVITY = Object.freeze({
  silenceMs: 2000,   // quiet after speech that ends a turn
  noSpeechMs: 8000,  // give up when nothing is said
  speechMs: 400,     // voiced time before it counts as speech (ignores coughs and clicks)
  resetMs: 500,      // quiet that forgets a short noise before speech started
  maxMs: 60000,      // hard recording limit
  calibrateMs: 300,  // first samples estimate the room's noise floor
  margin: 2,         // speech must be this many times louder than the floor
  minLevel: 0.02     // never treat anything quieter than this as speech
});

export function createSilenceDetector(options = {}) {
  const o = { ...VOICE_ACTIVITY, ...options };
  let start = null, last = null, floor = 0, samples = 0, voiced = 0, quiet = 0, spoke = false;
  return function update(level, now) {
    if (start === null) start = now;
    const elapsed = now - start, step = last === null ? 0 : now - last;
    last = now;
    if (elapsed < o.calibrateMs) { floor = (floor * samples + level) / ++samples; return 'waiting'; }
    if (elapsed >= o.maxMs) return 'max';
    if (level > Math.max(floor * o.margin, o.minLevel)) {
      voiced += step; quiet = 0;
      if (voiced >= o.speechMs) spoke = true;
    } else {
      quiet += step;
      if (spoke && quiet >= o.silenceMs) return 'done';
      if (!spoke && quiet >= o.resetMs) voiced = 0;
    }
    if (!spoke && elapsed >= o.noSpeechMs) return 'no_speech';
    return spoke ? 'speaking' : 'waiting';
  };
}
