// PowerShell Tee-Object can emit UTF-16LE. Normalize encoding only, preserving
// exact captured text, so the retained RED/GREEN evidence opens as UTF-8.
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['red-original', 'red-dynamic-management', 'red-management-namespace', 'red-fixed-fallback', 'red-fixed-facade', 'green-full', 'green-final-140'];
for (const name of names) {
  const file = new URL(`../test-artifacts/${name}.txt`, import.meta.url);
  const bytes = readFileSync(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = bytes.subarray(2).toString('utf16le');
    writeFileSync(file, text, 'utf8');
    if (readFileSync(file, 'utf8') !== text) throw new Error('Log normalization changed content');
    console.log(`UTF-8 normalized: ${name}.txt`);
  }
}
