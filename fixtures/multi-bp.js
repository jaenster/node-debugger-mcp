// Fixture for exercising hit-count, exception, temporary, and function BPs.

function multiply(a, b) {
  return a * b; // BP target — V8 line 4 (0-indexed)
}

function processItems(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    out.push(multiply(items[i], 2));
  }
  return out;
}

function maybeThrows(x) {
  if (x > 10) {
    throw new TypeError(`too big: ${x}`);
  }
  return x;
}

const inputs = [1, 2, 3, 4, 5];
const doubled = processItems(inputs);
console.log("doubled:", doubled);

try {
  maybeThrows(20);
} catch (e) {
  console.log("caught:", e.message);
}

console.log("done");
