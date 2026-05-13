// Fixture for CPU profiling — burns some user-code time so the profile
// has something meaningful in it.

function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

function doWork() {
  for (let i = 0; i < 30; i++) fib(28);
}

// Also allocate some objects so heap snapshot has interesting contents.
const cache = [];
function allocate() {
  for (let i = 0; i < 5000; i++) {
    cache.push({ id: i, payload: "x".repeat(100) });
  }
}

allocate();
const start = Date.now();
while (Date.now() - start < 3000) {
  doWork();
}
console.log("done");
