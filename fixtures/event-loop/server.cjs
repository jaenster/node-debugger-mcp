// Fixture that holds the event loop open with several different kinds of
// resources, so debug_event_loop_status has interesting things to report.

const net = require("node:net");
const fs = require("node:fs");

// A setInterval (Timeout handle).
const intervalId = setInterval(() => {}, 5000);

// A TCP server listening on a random port (Server handle).
const server = net.createServer().listen(0);

// An idle TCP socket connecting to ourselves (Socket handle).
server.on("listening", () => {
  const port = server.address().port;
  const client = net.connect(port);
  client.on("connect", () => {
    /* keep alive */
  });
});

// A file watcher (StatWatcher or FSEvent handle).
const watcher = fs.watch(__filename, () => {});

// A setTimeout that won't fire for a long time (Timeout handle).
const timer = setTimeout(() => {}, 60_000);

// BP TARGET — line 27 (0-indexed)
console.log("event-loop fixture: running, pid:", process.pid);

// Stop after 5 seconds so the smoke can run cleanly.
setTimeout(() => {
  clearInterval(intervalId);
  clearTimeout(timer);
  watcher.close();
  server.close();
  process.exit(0);
}, 5000);
