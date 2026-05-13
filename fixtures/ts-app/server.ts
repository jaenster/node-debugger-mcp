// TS fixture. Run via `tsx fixtures/ts-app/server.ts`.
// V8 will load this file and report an inline sourceMapURL on Debugger.scriptParsed.

interface Item {
  id: number;
  name: string;
}

function describe(item: Item): string {
  const out = `#${item.id}: ${item.name}`; // BP MARKER — V8 line 10 (0-indexed)
  return out;
}

const items: Item[] = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
  { id: 3, name: "gamma" },
];

for (const item of items) {
  console.log(describe(item));
}

console.log("done");
