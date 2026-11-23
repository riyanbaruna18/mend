#!/usr/bin/env node
// Hand-written edge tests for mend. Run: node tests/edge-tests.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
let pass = 0;
let fail = 0;
const results = [];

function run(files, patch, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-t-'));
  for (const [p, c] of Object.entries(files)) {
    const fp = join(dir, p);
    writeFileSync(fp, c, { flag: 'w' });
  }
  const pf = join(dir, 'p.patch');
  writeFileSync(pf, patch);
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [MAIN, ...args, pf], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout || '';
  }
  const after = {};
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'p.patch') continue;
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else after[p] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  walk(dir);
  for (const p of Object.keys(files)) {
    if (!(p in after)) after[p] = null;
  }
  return { code, out, after };
}

function t(name, cond) {
  results.push((cond ? 'PASS ' : 'FAIL ') + name);
  if (cond) pass++;
  else fail++;
}

// 1. strict: tier-1 match must fail with --strict
let r = run(
  { 'a.txt': 'x  \ny\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+z\n y\n',
  []
);
t('tier1 match works without --strict', r.code === 0 && r.after['a.txt'] === 'z\ny\n');
r = run(
  { 'a.txt': 'x  \ny\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+z\n y\n',
  ['--strict']
);
t('tier1 match fails with --strict', r.code === 1 && r.out.includes('error: no-match a.txt'));

// 2. --check does not write
r = run({ 'a.txt': 'x\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n', ['--check']);
t('--check ok and no write', r.code === 0 && r.after['a.txt'] === 'x\n' && r.out.includes('M a.txt'));

// 3. usage error
r = run({}, '', ['--bogus']);
t('usage error exit 2', r.code === 2 && r.out === 'error: usage\n');
r = run({}, '', ['a', 'b']);
t('two patch args usage', r.code === 2);

// 4. no-patch
{
  const dir = mkdtempSync(join(tmpdir(), 'mend-t-'));
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [MAIN, 'nope.patch'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout || '';
  }
  t('no-patch exit 2', code === 2 && out === 'error: no-patch\n');
}

// 5. format error (no recognizable format)
r = run({}, 'hello world\n');
t('format error exit 2', r.code === 2 && r.out === 'error: format\n');

// 6. ambiguous (SR, same old block twice)
r = run(
  { 'a.txt': 'foo\nfoo\n' },
  'a.txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n'
);
t('SR ambiguous exit 1', r.code === 1 && r.out.includes('error: ambiguous a.txt'));

// 7. missing file
r = run({}, '--- a/missing.txt\n+++ b/missing.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
t('missing exit 1', r.code === 1 && r.out.includes('error: missing missing.txt'));

// 8. exists (create over existing)
r = run(
  { 'a.txt': 'x\n' },
  '--- a/dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+new\n'
);
t('exists exit 1', r.code === 1 && r.out.includes('error: exists a.txt'));

// 9. unsafe path
r = run({}, '--- a/dev/null\n+++ b/../evil.txt\n@@ -0,0 +1,1 @@\n+new\n');
t('unsafe exit 1', r.code === 1 && r.out.includes('error: unsafe ../evil.txt'));

// 10. CRLF preserved
r = run(
  { 'a.txt': 'x\r\ny\r\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+z\n y\n'
);
t('CRLF preserved', r.code === 0 && r.after['a.txt'] === 'z\r\ny\r\n');

// 11. no final newline preserved
r = run(
  { 'a.txt': 'x\ny' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+z\n y\n'
);
// SPEC.md section 6: when matched lines run to end of file, result ends with a break
// unless a `\` follows the hunk's last context or `+` line.
t('no final newline: hunk to end gains final break', r.code === 0 && r.after['a.txt'] === 'z\ny\n');

// 12. no-newline-at-end marker removes final break
r = run(
  { 'a.txt': 'x\ny\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+z\n y\n\\ No newline at end of file\n'
);
t('\\ marker removes final break', r.code === 0 && r.after['a.txt'] === 'z\ny');

// 13. move (unified rename)
r = run(
  { 'old.txt': 'x\n' },
  'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n'
);
t('unified move', r.code === 0 && r.after['old.txt'] === null && r.out.includes('R old.txt -> new.txt') && r.out.includes('ok: 1 file'));

// 14. V4A add + delete + move
r = run(
  { 'b.txt': 'keep\n', 'c.txt': 'old\n' },
  '*** Begin Patch\n*** Add File: a.txt\n+hello\n\n*** Delete File: b.txt\n*** Update File: c.txt\n*** Move to: d.txt\n@@\n-old\n+new\n*** End Patch\n'
);
t('V4A add/delete/move', r.code === 0 && r.after['c.txt'] === null && r.out.includes('R c.txt -> d.txt'));

// 15. JSON create + str_replace + insert (array form)
r = run(
  { 'a.txt': 'hello world\n' },
  '[{"command":"create","path":"n.txt","file_text":"hi\\n"},{"command":"str_replace","path":"a.txt","old_str":"world","new_str":"there"},{"command":"insert","path":"a.txt","insert_line":1,"new_str":"end"}]\n',
  ['--format=json']
);
t('JSON array edits', r.code === 0 && r.after['a.txt'] === 'hello there\nend\n' && r.after['n.txt'] === 'hi\n');

// 16. JSONL
r = run(
  { 'a.txt': 'hello\n' },
  '{"command":"str_replace","path":"a.txt","old_str":"hello","new_str":"bye"}\n',
  ['--format=json']
);
t('JSONL edit', r.code === 0 && r.after['a.txt'] === 'bye\n');

// 17. JSON parse error line
r = run({}, '{"command":"bogus"}\n', ['--format=json']);
t('JSON bad command parse 1', r.code === 2 && r.out === 'error: parse 1\n');

// 19. hunk before section: format is unified (a ---/+++ pair follows), so parse error at the hunk line
r = run({}, '@@ -1,1 +1,1 @@\n-x\n+y\n--- a/a.txt\n+++ b/a.txt\n');
t('hunk before section parse 1', r.code === 2 && r.out === 'error: parse 1\n');

// 19. SR path inheritance (second block reuses first path)
r = run(
  { 'a.txt': 'x\ny\n' },
  'a.txt\n<<<<<<< SEARCH\nx\n=======\nX\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny\n=======\nY\n>>>>>>> REPLACE\n'
);
t('SR path inheritance', r.code === 0 && r.after['a.txt'] === 'X\nY\n');

// 20. tier 2 re-indent
r = run(
  { 'a.txt': '  alpha\n  beta\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n alpha\n beta\n+gamma\n'
);
t('tier2 re-indent new line', r.code === 0 && r.after['a.txt'] === '  alpha\n  beta\n  gamma\n');

// 21. failed edit changes nothing, later edits still run, no file written
r = run(
  { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nope\n+z\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-y\n+w\n'
);
t('one fail blocks all writes', r.code === 1 && r.after['a.txt'] === 'x\n' && r.after['b.txt'] === 'y\n' && r.out.includes('failed: 1 of 2 edits'));

// 22. create via SR empty old
r = run({}, 'n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n');
t('SR create', r.code === 0 && r.after['n.txt'] === 'hello\n');

// 23. V4A EOF chunk
r = run(
  { 'a.txt': 'x\ny\n' },
  '*** Begin Patch\n*** Update File: a.txt\n@@\n x\n y\n+tail\n*** End of File\n*** End Patch\n'
);
t('V4A EOF chunk', r.code === 0 && r.after['a.txt'] === 'x\ny\ntail\n');

// 24. unified delete file
r = run(
  { 'a.txt': 'x\n' },
  '--- a/a.txt\n+++ b/dev/null\n@@ -1,1 +0,0 @@\n-x\n'
);
t('unified delete', r.code === 0 && r.after['a.txt'] === null && r.out.includes('D a.txt'));

// 25. empty patch -> format error
r = run({}, '');
t('empty patch format error', r.code === 2 && r.out === 'error: format\n');

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
