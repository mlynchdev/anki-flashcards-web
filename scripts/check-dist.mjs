// Fails the build if anything that looks like private deck data ended up in dist/.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const banned = /\.(db|sqlite|apkg|colpkg|anki2|anki21b?)$/i;
const bad = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (banned.test(name) || /(^|\/)cards\//.test(p.slice('dist/'.length))) bad.push(p);
  }
})('dist');
if (bad.length) {
  console.error('Refusing to ship deck data in dist/:\n' + bad.join('\n'));
  process.exit(1);
}
console.log('dist check passed: no deck data files');
