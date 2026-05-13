// Long-running fixture so we can attach to it externally and set a BP.
// Loops every 200ms forever; SIGTERM ends it cleanly.

let tick = 0;
function step() {
  tick++; // BREAKPOINT TARGET — V8 line 5
  if (tick > 1_000_000) process.exit(0);
}
setInterval(step, 200);

process.on("SIGTERM", () => process.exit(0));
console.log("long-runner started, pid:", process.pid);
