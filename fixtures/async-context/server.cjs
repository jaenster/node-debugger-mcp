// CommonJS variant — `require` is in global scope, which makes the
// AsyncLocalStorage discovery in debug_get_async_context easy.

const { AsyncLocalStorage } = require("node:async_hooks");

const requestContext = new AsyncLocalStorage();
const traceContext = new AsyncLocalStorage();

function tick(n) {
  const r = requestContext.getStore();
  const t = traceContext.getStore();
  console.log("tick", n, r, t); // BP TARGET — V8 line 10 (0-indexed)
}

function handleRequest(id) {
  requestContext.run({ requestId: id, user: "alice" }, () => {
    traceContext.run({ traceId: `trace-${id}`, span: 0 }, () => {
      tick(id);
    });
  });
}

let n = 0;
setInterval(() => handleRequest(n++), 200);
