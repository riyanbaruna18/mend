// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection (section 4),
// line matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- a file's lines (SPEC.md section 3) ----

interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Occurrences of O in lines, at the first tier (0, 1, 2; strict: 0 only) with at least one (SPEC.md section 5). */
function findOccurrences(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NSeg {
  ctx: boolean;
  text: string;
  oIndex: number;
}

/** The lines N writes in place of O at position pos (SPEC.md section 5). */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NSeg[], tier: number): string[] {
  const out: string[] = [];
  const f = leadWS(fileLines[pos]!);
  const p = leadWS(o[0]!);
  for (const seg of n) {
    if (seg.ctx) out.push(fileLines[pos + seg.oIndex]!);
    else if (tier === 2 && seg.text !== '' && seg.text.trim() !== '' && seg.text.startsWith(p)) out.push(f + seg.text.slice(p.length));
    else out.push(seg.text);
  }
  return out;
}

/** One body element of a unified hunk or a V4A chunk. rawEmpty: the patch line was literally empty. */
interface BodyEl {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
  rawEmpty: boolean;
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function chunkON(elements: BodyEl[]): { o: string[]; n: NSeg[] } {
  const o: string[] = [];
  const n: NSeg[] = [];
  for (const e of elements) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ ctx: true, text: e.text, oIndex: o.length - 1 });
    } else if (e.kind === 'old') o.push(e.text);
    else if (e.kind === 'new') n.push({ ctx: false, text: e.text, oIndex: -1 });
  }
  return { o, n };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- format detection (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  elements: BodyEl[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` / `+++ ` line names, or null for no file (`/dev/null`, or `a/dev/null` / `b/dev/null`). */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  const p = stripPrefix(raw);
  return p === 'dev/null' ? null : p;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.elements.length; k++) {
    if (h.elements[k]!.kind === 'ctx' || h.elements[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  const after = h.elements[last + 1];
  return after !== undefined && after.kind === 'backslash';
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = chunkON(h.elements);
    const beforeLen = f.lines.length;
    if (o.length > 0) {
      const found = findOccurrences(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const seg = buildReplacement(f.lines, best, o, n, found.tier);
      const runsToEnd = best + o.length === beforeLen;
      f.lines.splice(best, o.length, ...seg);
      if (runsToEnd) f.final = !hunkNoEol(h);
      d += n.length - o.length;
    } else {
      const insertAt = Math.max(0, Math.min(h.a + d, beforeLen));
      f.lines.splice(insertAt, 0, ...n.map((s) => s.text));
      if (insertAt === beforeLen) f.final = !hunkNoEol(h);
      d += n.length;
    }
  }
}

function buildUniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  let kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
  if (sec.newFile && newP !== null) kind = 'create';
  else if (sec.deletedFile && oldP !== null) kind = 'delete';
  else if (oldP === null && newP === null) kind = 'noop';
  else if (oldP === null) kind = 'create';
  else if (newP === null) kind = 'delete';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';
  if (kind === 'noop') return () => {};
  if (kind === 'create') {
    const p = newP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const newLines: string[] = [];
      let final = true;
      let lastPlus: { hunk: Hunk; index: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.elements.length; k++) {
          if (h.elements[k]!.kind === 'new') {
            newLines.push(h.elements[k]!.text);
            lastPlus = { hunk: h, index: k };
          }
        }
      }
      if (lastPlus !== null) {
        const after = lastPlus.hunk.elements[lastPlus.index + 1];
        if (after !== undefined && after.kind === 'backslash') final = false;
      }
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + (final ? '\n' : ''));
    };
  }
  if (kind === 'delete') {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (kind === 'move') {
    const o = oldP!;
    const n = newP!;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const f = splitFile(cur);
      applyHunks(f, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, joinFile(f));
      tree.moves.push([o, n]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    applyHunks(f, sec.hunks, strict, p);
    tree.now.set(p, joinFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: UniSection | null = null;
  let inHeader = false;
  const flush = (): void => {
    if (section !== null) {
      edits.push(buildUniEdit(section, strict));
      section = null;
    }
  };
  const parseHunk = (i: number): number => {
    if (section === null) throw new Exit2(`error: parse ${i + 1}`);
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const hunk: Hunk = { a: parseInt(m[1]!, 10), elements: [] };
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l === '') {
        hunk.elements.push({ kind: 'ctx', text: '', rawEmpty: true });
        j++;
        continue;
      }
      const c = l[0]!;
      if (c === ' ') {
        hunk.elements.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
        j++;
        continue;
      }
      if (c === '-') {
        hunk.elements.push({ kind: 'old', text: l.slice(1), rawEmpty: false });
        j++;
        continue;
      }
      if (c === '+') {
        hunk.elements.push({ kind: 'new', text: l.slice(1), rawEmpty: false });
        j++;
        continue;
      }
      if (c === '\\') {
        hunk.elements.push({ kind: 'backslash', text: l.slice(1), rawEmpty: false });
        j++;
        continue;
      }
      break;
    }
    while (hunk.elements.length > 0) {
      const e = hunk.elements[hunk.elements.length - 1]!;
      if (e.kind === 'ctx' && e.text === '') hunk.elements.pop();
      else break;
    }
    section.hunks.push(hunk);
    inHeader = false;
    return j;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      section = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, newFile: false, deletedFile: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (section !== null && inHeader) {
        section.oldPath = oldP;
        section.newPath = newP;
        section.hasPair = true;
      } else {
        flush();
        section = {
          oldPath: oldP,
          newPath: newP,
          hasPair: true,
          newFile: false,
          deletedFile: false,
          hunks: [],
        };
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (section !== null && inHeader) {
      if (l.startsWith('@@')) {
        i = parseHunk(i);
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && !section.hasPair) section.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !section.hasPair) section.newPath = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) section.newFile = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) section.deletedFile = true;
      i++;
      continue;
    }
    if (section !== null) {
      if (l.startsWith('@@')) {
        i = parseHunk(i);
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  flush();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function buildSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findOccurrences(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const seg = buildReplacement(f.lines, pos, oldLines, newLines.map((t) => ({ ctx: false, text: t, oIndex: -1 })), found.tier);
    f.lines.splice(pos, oldLines.length, ...seg);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(buildSrEdit(path, oldLines, newLines, strict));
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  elements: BodyEl[];
  closed: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

function findOccAtOrAfter(lines: string[], o: string[], cursor: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = cursor; i + o.length <= lines.length; i++) {
      if (eof && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) return { pos: i, tier };
    }
  }
  return null;
}

function buildV4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const p = sec.path;
    const fileLines = sec.lines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = chunkON(ch.elements);
      if (o.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        f.lines.splice(ins, 0, ...n.map((s) => s.text));
        cursor = ins + n.length;
      } else {
        const found = findOccAtOrAfter(f.lines, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const seg = buildReplacement(f.lines, found.pos, o, n, found.tier);
        f.lines.splice(found.pos, o.length, ...seg);
        cursor = found.pos + seg.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let sec: V4aSection | null = null;
  const flush = (): void => {
    if (sec === null) return;
    if (sec.kind === 'add') {
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (sec.kind === 'update') {
      const ch = sec.chunks[sec.chunks.length - 1];
      if (ch !== undefined) {
        while (ch.elements.length > 0) {
          const e = ch.elements[ch.elements.length - 1]!;
          if (e.kind === 'ctx' && e.text === '') ch.elements.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    edits.push(buildV4aEdit(sec, strict));
    sec = null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File:')) {
      flush();
      sec = { kind: 'add', path: l.slice('*** Add File:'.length).trim(), line: i + 1, lines: [], moveTo: null, chunks: [] };
      i++;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      flush();
      sec = { kind: 'delete', path: l.slice('*** Delete File:'.length).trim(), line: i + 1, lines: [], moveTo: null, chunks: [] };
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      flush();
      sec = { kind: 'update', path: l.slice('*** Update File:'.length).trim(), line: i + 1, lines: [], moveTo: null, chunks: [] };
      i++;
      continue;
    }
    if (sec === null) {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (l.startsWith('+')) {
        sec.lines.push(l.slice(1));
        i++;
        continue;
      }
      if (l === '') {
        sec.lines.push('');
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'delete') {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.startsWith('*** Move to:')) {
      if (sec.moveTo === null && sec.chunks.length === 0) {
        sec.moveTo = l.slice('*** Move to:'.length).trim();
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.startsWith('*** End of File')) {
      const ch = sec.chunks[sec.chunks.length - 1];
      if (ch === undefined || ch.closed) throw new Exit2(`error: parse ${i + 1}`);
      ch.eof = true;
      ch.closed = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      sec.chunks.push({ anchor: l.slice(2).trim(), eof: false, elements: [], closed: false });
      i++;
      continue;
    }
    if (l === '') {
      const ch = sec.chunks[sec.chunks.length - 1];
      if (ch === undefined) {
        i++;
        continue;
      }
      if (ch.closed) {
        i++;
        continue;
      }
      ch.elements.push({ kind: 'ctx', text: '', rawEmpty: true });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      const ch = sec.chunks[sec.chunks.length - 1];
      if (ch === undefined) {
        sec.chunks.push({ anchor: null, eof: false, elements: [], closed: false });
      } else if (ch.closed) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const cur = sec.chunks[sec.chunks.length - 1]!;
      if (c === ' ') cur.elements.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
      else if (c === '-') cur.elements.push({ kind: 'old', text: l.slice(1), rawEmpty: false });
      else cur.elements.push({ kind: 'new', text: l.slice(1), rawEmpty: false });
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  flush();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- the run (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveByNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moveByNew.set(newP, oldP);
    }
  }
  const movedOlds = new Set<string>(moveByNew.values());
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveByNew.has(p)) {
      rows.push(`R ${moveByNew.get(p)} -> ${p}`);
      continue;
    }
    if (movedOlds.has(p)) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
