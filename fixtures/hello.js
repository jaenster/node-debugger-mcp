// Smoke fixture for the debugger MCP.
// The line marked BREAKPOINT MARKER below is intentionally targeted in tests.

function greet(name) {
  const greeting = `Hello, ${name}!`; // BREAKPOINT MARKER
  console.log(greeting);
  return greeting;
}

const result = greet("world");
console.log("done:", result);
