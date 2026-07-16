// ── mr-fusion.js ──────────────────────────────────────────────────────────
// DeLorean easter egg — a 1-in-50 chance animation on a successful generate.
// (Named for the DeLorean's fuel source — this is the module that powers the
// easter egg.) The car drives across the face of the Generate Timeline
// button, riding its bottom line, laying a tire track that emerges from
// behind the rear wheel and cools left-to-right.
//
// Fully self-contained: this file touches no app state and no other module
// touches this one back. main.js calls maybeTriggerDelorean() once, from
// generateTimeline(), and that's the only coupling point. To remove the
// feature entirely: delete this file, css/mr-fusion.css and its <link> in
// index.html, the .de-stage markup block in index.html, and the one import
// line + one call site in main.js.
// ─────────────────────────────────────────────────────────────────────────

const TRIGGER_CHANCE = 1 / 50;

// Drive geometry — these must match the de-drive-across keyframe in the CSS:
//   #deloreanCar starts at left:-160px and drives to calc(100% + 20px).
const DRIVE_MS    = 1050;   // must match .de-driving animation duration
const CAR_START   = -160;   // must match #deloreanCar left / keyframe 0%
const CAR_END_PAD = 20;     // must match keyframe 100% (calc(100% + 20px))

// Each dot fades over its own lifetime; one drive-length keeps the tail
// visible for a beat after the car has passed.
const DOT_LIFE_MS = DRIVE_MS;

// Guards against a rapid double-generate re-triggering mid-animation —
// same pattern as ui.js's isAnimating-style flags elsewhere in the app.
let isAnimating = false;

export function maybeTriggerDelorean() {
  if (isAnimating) return;
  if (Math.random() >= TRIGGER_CHANCE) return;
  triggerDelorean();
}

function triggerDelorean() {
  const stage = document.getElementById('deStage');
  const car   = document.getElementById('deloreanCar');
  const track = document.getElementById('deTrackContainer');
  const flux  = document.getElementById('deFlux');
  // If the markup isn't present (e.g. someone strips it later without
  // removing this import), fail silently rather than throwing.
  if (!stage || !car || !track || !flux) return;

  isAnimating = true;

  // Removing + re-adding a class doesn't restart a CSS animation on repeat
  // triggers within the same session — forcing a reflow via offsetWidth
  // does. Same trick used for the flux message and the dot track below.
  car.classList.remove('de-driving');
  void car.offsetWidth;
  car.classList.add('de-driving');

  flux.classList.remove('de-flashing');
  void flux.offsetWidth;
  flux.classList.add('de-flashing');

  // Rebuild the tire track. Each dot is positioned by its x-fraction across
  // the button and delayed so it appears exactly as the car's rear edge
  // reaches it, then fades over its own life — giving a trail that emerges
  // behind the car and cools left-to-right, with no per-frame loop.
  track.classList.remove('de-firing');
  track.innerHTML = '';
  void track.offsetWidth;

  const W = stage.offsetWidth || 300;
  // Total px the car's left edge travels (off-screen start included). A dot at
  // x reaches the rear edge when CAR_START + p*totalTravel = x, so the delay
  // fraction p accounts for the car's off-screen lead-in — without this the
  // leftmost dots fire early and the trail appears to lead the car.
  const totalTravel = W + CAR_END_PAD - CAR_START;
  const dotCount = Math.max(1, Math.floor(W / 8));
  const colors   = ['#f70', '#ff4400', '#ff6600', '#ff2200', '#ffaa00', '#ff8800'];

  for (let i = 0; i < dotCount; i++) {
    const frac  = i / dotCount;             // 0 (left) .. 1 (right)
    const dotX  = frac * W;                  // dot position in px
    const p     = (dotX - CAR_START) / totalTravel;  // 0..1 of the drive
    const delay = Math.max(0, Math.round(p * DRIVE_MS));

    const dot   = document.createElement('span');
    dot.className = 'de-dot';
    const size  = Math.random() > 0.4 ? 3 : 2;
    const color = colors[Math.floor(Math.random() * colors.length)];
    dot.style.left           = (frac * 100).toFixed(2) + '%';
    dot.style.width          = size + 'px';
    dot.style.height         = size + 'px';
    dot.style.background     = color;
    dot.style.setProperty('--life', DOT_LIFE_MS + 'ms');
    dot.style.animationDelay = delay + 'ms';
    track.appendChild(dot);
  }
  void track.offsetWidth;
  track.classList.add('de-firing');

  // Reset the guard once the drive animation actually finishes, rather than
  // on a hardcoded timeout, so it can't drift out of sync with the CSS
  // duration if that's ever tuned.
  car.addEventListener('animationend', () => { isAnimating = false; }, { once: true });
}
