// Fails when the version is not the same everywhere it is written, so a release can't ship stale pins.
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const errors = [];
const expect = (where, actual) => { if (actual !== version) errors.push(`${where}: ${actual ?? 'missing'} (package.json: ${version})`); };

expect('package-lock.json', JSON.parse(read('package-lock.json')).version);
expect('package-lock.json packages[""]', JSON.parse(read('package-lock.json')).packages[''].version);
expect('plugin/.claude-plugin/plugin.json', JSON.parse(read('plugin/.claude-plugin/plugin.json')).version);
for (const skill of ['jev', 'jev-route']) {
  const pins = [...read(`plugin/skills/${skill}/SKILL.md`).matchAll(/github:abby-inc\/jev-opus#v([^\s'"]+)/g)].map((m) => m[1]);
  if (!pins.length) errors.push(`plugin/skills/${skill}/SKILL.md: no pinned github:abby-inc/jev-opus#v<version>`);
  for (const pin of pins) expect(`plugin/skills/${skill}/SKILL.md pin`, pin);
}
if (!new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?( |$)`, 'm').test(read('CHANGELOG.md'))) errors.push(`CHANGELOG.md: no "## ${version}" entry`);

if (errors.length) {
  console.error(`version mismatch:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`version ${version} is consistent`);
