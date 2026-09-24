#!/usr/bin/env node
// Summarize a `mimo run --format json` event stream: event types, session ids, assistant text.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: inspect-events.mjs <ndjson-file>");
  process.exit(2);
}
const raw = fs.readFileSync(file, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim());

const types = {};
const texts = [];
const sessions = new Set();
let ok = 0;
let bad = 0;

for (const line of lines) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    bad++;
    continue;
  }
  ok++;
  const kind = ev.type ?? `keys:${Object.keys(ev).join("|")}`;
  types[kind] = (types[kind] ?? 0) + 1;

  const flat = JSON.stringify(ev);
  for (const m of flat.matchAll(/"(ses_[A-Za-z0-9]+)"/g)) sessions.add(m[1]);

  if (typeof ev.text === "string" && ev.text.trim()) texts.push(`text: ${ev.text.trim()}`);
  if (typeof ev.content === "string" && ev.content.trim()) texts.push(`content: ${ev.content.trim()}`);
  if (typeof ev.result === "string" && ev.result.trim()) texts.push(`result: ${ev.result.trim()}`);
  if (ev.part && typeof ev.part.text === "string" && ev.part.text.trim()) {
    texts.push(`part.text: ${ev.part.text.trim()}`);
  }
  if (typeof ev.error === "string" && ev.error.trim()) texts.push(`ERROR: ${ev.error.trim()}`);
}

console.log(`bytes=${raw.length} lines=${lines.length} json=${ok} non-json=${bad}`);
console.log(`types=${JSON.stringify(types)}`);
console.log(`sessions=${[...sessions].join(", ") || "(none)"}`);
console.log("--- text payloads ---");
for (const t of texts.slice(0, 20)) console.log(t.slice(0, 300));
if (bad > 0) {
  console.log("--- first non-JSON lines ---");
  for (const l of lines.filter((l) => !l.trim().startsWith("{")).slice(0, 5)) {
    console.log(l.slice(0, 200));
  }
}
