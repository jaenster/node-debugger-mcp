// Fixture exercising exception data, frame defaults, source patching, and
// per-line coverage in one place.

function add(a, b) {
  return a + b + 1; // BUG: should be `a + b` — patched live by the smoke.
}

function thrower(x) {
  if (x > 10) {
    throw new TypeError(`too big: ${x}`); // PAUSE TARGET via exception BP
  }
  return x;
}

console.log("results before patch:", add(1, 2), add(3, 4));

let n = 0;
const t = setInterval(() => {
  n++;
  try {
    thrower(n > 3 ? 20 : 5);
  } catch (_e) {
    /* swallow */
  }
  add(n, n);
  if (n >= 20) {
    clearInterval(t);
    console.log("done, last add result:", add(n, n));
    process.exit(0);
  }
}, 100);
console.log("running, pid:", process.pid);
