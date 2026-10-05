// Read the packed DSH app.asar (header-walk + on-demand entry reads).
// usage: node asar.mjs list <substring> [<substring> ...]
//        node asar.mjs cat <entryPath> [outFile]
import fs from 'node:fs';

const ASAR = process.env.DSH_ASAR
  || 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

export function openAsar(asarPath = ASAR) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const pickleSize = sizeBuf.readUInt32LE(4);
  const headerBuf = Buffer.alloc(pickleSize);
  fs.readSync(fd, headerBuf, 0, pickleSize, 8);
  const jsonLen = headerBuf.readUInt32LE(4);
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'));
  const dataStart = 8 + pickleSize;
  const files = new Map();
  (function walk(node, prefix) {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) walk(child, p);
      else files.set(p, { size: child.size, offset: Number(child.offset), unpacked: !!child.unpacked });
    }
  })(header, '');
  const read = (path) => {
    const e = files.get(path);
    if (!e) return undefined;
    if (e.unpacked) return fs.readFileSync(asarPath + '.unpacked/' + path);
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, dataStart + e.offset);
    return buf;
  };
  return { files, read, close: () => fs.closeSync(fd) };
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'list') {
  const { files, close } = openAsar();
  const needles = rest;
  for (const p of [...files.keys()].sort()) {
    if (needles.every((n) => p.includes(n))) console.log(p);
  }
  close();
} else if (cmd === 'cat') {
  const [entry, out] = rest;
  const { read, close } = openAsar();
  const buf = read(entry);
  if (!buf) { console.error('MISSING ' + entry); process.exit(1); }
  if (out) fs.writeFileSync(out, buf);
  else process.stdout.write(buf);
  close();
}
