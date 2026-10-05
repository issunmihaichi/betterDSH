// Scan packed JS in app.asar for a literal needle; print path + line numbers.
// usage: node scan.mjs <needle> [<needle2> ...] [--max N]
import { openAsar } from './asar.mjs';

const args = process.argv.slice(2);
const maxIdx = args.indexOf('--max');
const max = maxIdx === -1 ? 40 : Number(args[maxIdx + 1]);
const needles = (maxIdx === -1 ? args : args.slice(0, maxIdx));

const { files, read, close } = openAsar();
let hits = 0;
for (const p of [...files.keys()].sort()) {
  if (!/\.js$/.test(p) || /\.map$/.test(p)) continue;
  let buf;
  try { buf = read(p); } catch { continue; }
  if (!buf || buf.length > 8_000_000) continue;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  for (const n of needles) {
    const at = text.indexOf(n);
    if (at === -1) continue;
    const lineNo = text.slice(0, at).split('\n').length;
    console.log(`${p}:${lineNo} [${n}] ${lines[lineNo - 1].trim().slice(0, 220)}`);
    if (++hits >= max) { close(); process.exit(0); }
  }
}
close();
console.log(`hits: ${hits}`);
