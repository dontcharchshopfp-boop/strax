// Syntax-checks the inline <script> of every public/*.html page.
// Run: node scripts/check-html-js.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'public');
let failed = 0;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) {
    console.log(`${file}: no inline scripts`);
    continue;
  }
  const tmp = path.join(require('os').tmpdir(), 'strax-html-check.mjs');
  scripts.forEach((m, i) => {
    fs.writeFileSync(tmp, m[1]);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log(`${file} [script ${i + 1}]: OK`);
    } catch (e) {
      failed++;
      console.error(`${file} [script ${i + 1}]: SYNTAX ERROR\n${e.stderr.toString().slice(0, 500)}`);
    }
  });
}

if (failed) process.exit(1);
