#!/usr/bin/env node
// Minimal Electron asar reader: list entries or extract one file.
// Usage:
//   node asar.mjs <archive> list [filter]
//   node asar.mjs <archive> extract <innerPath> <outFile>
import fs from "node:fs";
import path from "node:path";

const [, , archive, mode, arg1, arg2] = process.argv;
if (!archive || !mode) {
  console.error("usage: asar.mjs <archive> list [filter] | extract <innerPath> <outFile>");
  process.exit(2);
}

// asar layout: [u32 4][u32 headerSize][u32 payloadSize][u32 jsonLen][json @16][pad][file data]
const fd = fs.openSync(archive, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleA = head.readUInt32LE(0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const pad = headerSize - jsonLen;
if (pickleA !== 4 || pad < 0 || pad > 16) {
  console.error(`unexpected asar header: pickleA=${pickleA} headerSize=${headerSize} jsonLen=${jsonLen}`);
  process.exit(3);
}
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const tree = JSON.parse(jsonBuf.toString("utf8"));
const baseOffset = 8 + headerSize;

const entries = [];
(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (value.files) walk(value, p);
    else
      entries.push({
        path: p,
        size: value.size ?? 0,
        offset: value.offset === undefined ? null : Number(value.offset),
        unpacked: value.unpacked === true,
      });
  }
})(tree, "");

if (mode === "list") {
  const filter = arg1;
  const list = filter ? entries.filter((e) => e.path.includes(filter)) : entries;
  console.log(`total=${entries.length} shown=${list.length}`);
  for (const e of list) console.log(`${String(e.size).padStart(9)}  ${e.unpacked ? "U" : " "}  ${e.path}`);
} else if (mode === "extract") {
  const e = entries.find((x) => x.path === arg1);
  if (!e) {
    console.error(`not found: ${arg1}`);
    process.exit(4);
  }
  if (e.unpacked) {
    console.error("entry is unpacked; read it from app.asar.unpacked instead");
    process.exit(5);
  }
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, baseOffset + e.offset);
  fs.mkdirSync(path.dirname(arg2), { recursive: true });
  fs.writeFileSync(arg2, buf);
  console.log(`wrote ${e.size} bytes -> ${arg2}`);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
fs.closeSync(fd);
