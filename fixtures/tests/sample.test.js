// node:test fixture with a deliberate failing assertion.

import { test } from "node:test";
import assert from "node:assert/strict";

test("addition works", () => {
  assert.equal(1 + 1, 2);
});

test("intentional fail — for testing the debugger's pauseOnFailure", () => {
  const x = 42;
  assert.equal(x, 41); // FAILS — AssertionError thrown here
});

test("never reached when bail=true", () => {
  assert.equal("foo", "foo");
});
