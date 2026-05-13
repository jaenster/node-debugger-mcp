// Child process spawned by parent.js. Loops a bit so the MCP can observe it
// and set a BP that hits inside this process.

let n = 0;
function step() {
  n++; // BP TARGET — V8 line 4 (0-indexed)
  if (n >= 5) {
    clearInterval(timer);
    console.log("child: done at n=", n);
    process.exit(0);
  }
}
const timer = setInterval(step, 200);
console.log("child running, pid:", process.pid);
