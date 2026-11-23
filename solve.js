// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build()
// returns for the same input, byte for byte: every page's index.html, the
// index and tag pages, build-report.txt and each static file.
//
// The reference is make.fun's own makefun-site (MIT), whose rules are stated
// in its README and whose code is the authority where the two differ. This
// file re-implements those rules from scratch for speed; every error string,
// every report line and every byte of HTML it emits matches the reference.
//
// Speed notes (where it differs from the reference's shape, never its answers):
//  - Templates are compiled to plain JavaScript functions (new Function) once
//    per build, with variable lookups resolved lexically at compile time and
//    includes inlined as calls; a small tree-walking interpreter below is the
//    fallback if code generation is ever unavailable in the sandbox.
//  - Markdown is lexed and rendered in one pass, and inline markup is scanned
//    with one regex for the next interesting character, so plain runs of text
//    are copied verbatim and never pass through an escaper at all.
//  - Slugs are cached per build (titles, tags and headings repeat a lot),
//    ASCII slugs skip Unicode normalisation, and word counting is a table
//    lookup instead of a regex match.
//
// No dependencies, no I/O, no clock, no randomness: the output is a function
// of the input alone, and nothing is kept from one case to the next.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESCAPES[text[i]];
    if (e !== undefined) {
      out += text.slice(last, i);
      out += e;
      last = i + 1;
    }
  }
  return out + text.slice(last);
}

export const SLUG_MAX = 64;

/** The slug of `text`, per the reference (NFKD, marks dropped, A-Z lowered, runs of other characters one `-`). */
export function slugify(text) {
  // Pure ASCII has no NFKD decomposition and no combining marks, so the
  // manual scan below is exact for it; anything else takes the slow path.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) return slugifyUnicode(text);
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Whitespace per JavaScript's \s, as a table over UTF-16 code units.
const IS_WS = new Uint8Array(65536);
for (const c of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) IS_WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) IS_WS[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (IS_WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Spaces/tabs at either end dropped (the reference's trimLine). */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigits(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45 && isDigits(raw, 0, 4) && isDigits(raw, 5, 7) && isDigits(raw, 8, 10)) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false; // may not close on '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are read
 * with indexOf, so the body is one slice of the text, not a split and rejoin.
 */
export function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  // The closing '---' line, and where the body starts after it.
  let pos = nl === -1 ? text.length : nl + 1;
  let bodyStart = -1;
  let closeLine = -1; // 0-based line index of the closing line
  let lineNo = 1; // 0-based index of the line starting at pos
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
    lineNo++;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl === -1 ? text.length : nl + 1;
  for (let i = 1; i < closeLine; i++) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    const line = text.slice(pos, end);
    pos = e === -1 ? text.length : e + 1;
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // LINE: ^([a-z_]+):(?: (.*))?$ — a key, a colon, then nothing or one space and the value.
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < colon; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let r = raw.length;
    while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
    if (r !== raw.length) raw = raw.slice(0, r);
    if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The next interesting character when rendering inline: a structural mark or one the escape table names. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * Whether the character at `j` is escaped by a backslash, counting the run
 * of backslashes before it from `from` (the reference scans escapes from
 * `from`, so a run reaching down from above `from` counts only from `from`).
 */
function isEscaped(s, j, from) {
  let n = 0;
  for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. Bounded by `hi`. */
function findUnescaped(s, what, from, hi) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1 || k + what.length > hi) return -1;
    if (!isEscaped(s, k, from)) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. Bounded by `hi`. */
function findSingleStar(s, from, hi) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1 || k >= hi) return -1;
    if (isEscaped(s, k, from)) { j = k + 1; continue; }
    if (s[k + 1] === '*') { j = k + 2; continue; }
    return k;
  }
}

/**
 * `s[lo..hi)` rendered inline into `out`; `env.link(target)` is a link's href.
 * Plain runs hold no escapable character by construction, so they are copied
 * verbatim; only code spans and link hrefs go through escapeHtml.
 */
function inlineRange(s, lo, hi, env) {
  let out = '';
  let i = lo;
  let plain = lo;
  for (;;) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= hi) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        if (plain < j) out += s.slice(plain, j);
        const n = s[j + 1];
        out += ESCAPES[n] !== undefined ? ESCAPES[n] : n;
        i = j + 2;
        plain = i;
      } else {
        // The backslash is itself, and the next character is read normally.
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (plain < j) out += s.slice(plain, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        plain = i;
      } else {
        // No closer: the backtick is itself.
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k !== -1 && k > j + 2) {
          if (plain < j) out += s.slice(plain, j);
          out += `<strong>${inlineRange(s, j + 2, k, env)}</strong>`;
          i = k + 2;
          plain = i;
        } else {
          if (plain < j) out += s.slice(plain, j);
          out += '**';
          i = j + 2;
          plain = i;
        }
      } else {
        const k = findSingleStar(s, j + 1, hi);
        if (k !== -1 && k > j + 1) {
          if (plain < j) out += s.slice(plain, j);
          out += `<em>${inlineRange(s, j + 1, k, env)}</em>`;
          i = k + 1;
          plain = i;
        } else {
          if (plain < j) out += s.slice(plain, j);
          out += '*';
          i = j + 1;
          plain = i;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, hi);
      let m2 = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        m2 = s.indexOf(')', k + 2);
        if (m2 >= hi) m2 = -1;
      }
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        if (plain < j) out += s.slice(plain, j);
        out += `<a href="${escapeHtml(env.link(target))}">${inlineRange(s, j + 1, k, env)}</a>`;
        i = m2 + 1;
        plain = i;
      } else {
        // No link: the '[' is itself.
        i = j + 1;
      }
      continue;
    }
    // One of & < > " ': the entity, and the plain run ends here.
    if (plain < j) out += s.slice(plain, j);
    out += ESCAPES[c];
    i = j + 1;
    plain = i;
  }
  if (plain < hi) out += s.slice(plain, hi);
  return out;
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  return s === '' ? '' : inlineRange(s, 0, s.length, env);
}

/** A fence's language, or null: ``` then [A-Za-z0-9_+-]* then spaces/tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ``` then spaces/tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === h) return null; // no space or tab after the #'s
  let k = line.length;
  while (k > j && (line.charCodeAt(k - 1) === 32 || line.charCodeAt(k - 1) === 9)) k--;
  if (k === j) return null;
  return { depth: h, text: line.slice(j, k) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces/tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* " then anything. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered item's number and text, or null: 1-9 digits, ". ", then anything. */
function orderedOf(line) {
  let i = 0;
  let num = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    num = num * 10 + (c - 48);
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num, text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return IS_WS[line.charCodeAt(i)] !== 1;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `slug` is the build's cached slugify; `env.link(target)` is a link's href.
 */
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (const l of body) code += escapeHtml(l) + '\n';
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${code}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slug(hd.text), ids);
      const html = inlineStr(hd.text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      const start = isOrdered ? ordered.num : 1;
      while (i < n) {
        const l = lines[i];
        const m = isOrdered ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          items.push([trimST(m.text)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ------------------------------------------------------------------ template values

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) — the tree-walking
 * interpreter, used only when compiling a template is unavailable.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t.nodes, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ template compilation

const ROOT_NAMES = ['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag'];
const ROOT_SET = new Set(ROOT_NAMES);

/**
 * A template's direct free names (first path segments neither a root name
 * nor bound by an enclosing for) and its include sites with the names bound
 * at each site. An include renders in the same scope, so a name an included
 * template needs is free in the includer unless a loop at the site binds it.
 */
function analyzeTemplate(nodes) {
  const direct = new Set();
  const includes = [];
  (function walk(ns, bound) {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        const f = n.path[0];
        if (!bound.has(f) && !ROOT_SET.has(f)) direct.add(f);
      } else if (n.kind === 'for') {
        const f = n.path[0];
        if (!bound.has(f) && !ROOT_SET.has(f)) direct.add(f);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'if') {
        const f = n.path[0];
        if (!bound.has(f) && !ROOT_SET.has(f)) direct.add(f);
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 'include') {
        includes.push({ name: n.name, bound: new Set(bound) });
      }
    }
  })(nodes, new Set());
  return { direct, includes };
}

/**
 * Compile one template's nodes to a function
 *   (site, tags, recent, page, posts, pager, tag, H, T, depth, F) -> string
 * where F holds the template's free names' values, in the order of `free`.
 * `H` is { escape, textOf, truthy } and `T` maps template names to their
 * compiled functions. All dynamic strings enter the generated code through
 * JSON.stringify, so no template text can break out of its literal.
 */
function compileTemplate(nodes, free) {
  const freeIndex = new Map(free.map((name, i) => [name, i]));
  let uid = 0;
  const parts = ['let __o="";\n'];

  // A path's value as a JS expression; multi-segment paths emit guarded
  // reads into a fresh temporary first (each next name an own property of an
  // object, else undefined, as the reference's lookup does).
  function genPath(path, env) {
    const first = env.get(path[0]);
    if (path.length === 1) return { pre: '', expr: first === undefined ? 'void 0' : first };
    const t = `__t${uid++}`;
    let pre = `let ${t}=${first === undefined ? 'void 0' : first};\n`;
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      pre += `if(${t}!==null&&typeof ${t}==='object'&&Object.hasOwn(${t},${seg}))${t}=${t}[${seg}];else ${t}=void 0;\n`;
    }
    return { pre, expr: t };
  }

  function genNodes(ns, env) {
    for (const n of ns) {
      if (n.kind === 'text') {
        parts.push(`__o+=${JSON.stringify(n.text)};\n`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const p = genPath(n.path, env);
        parts.push(p.pre);
        parts.push(n.kind === 'var' ? `__o+=H.var(${p.expr});\n` : `__o+=H.textOf(${p.expr});\n`);
      } else if (n.kind === 'if') {
        const p = genPath(n.path, env);
        parts.push(p.pre);
        parts.push(`if(${n.not ? '!' : ''}H.truthy(${p.expr})){`);
        genNodes(n.then, env);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else{');
          genNodes(n.else, env);
          parts.push('}');
        }
        parts.push('\n');
      } else if (n.kind === 'for') {
        const p = genPath(n.path, env);
        const xs = `__x${uid++}`;
        const lp = `__l${uid++}`;
        const el = `__e${uid++}`;
        const kk = `__k${uid++}`;
        parts.push(p.pre);
        parts.push(`{const ${xs}=${p.expr};if(Array.isArray(${xs})){const ${lp}={index:0,first:false,last:false,length:${xs}.length};for(let ${kk}=0;${kk}<${xs}.length;${kk}++){const ${el}=${xs}[${kk}];${lp}.index=${kk}+1;${lp}.first=${kk}===0;${lp}.last=${kk}===${xs}.length-1;`);
        const env2 = new Map(env);
        if (n.name !== 'loop') env2.set(n.name, el);
        env2.set('loop', lp);
        genNodes(n.body, env2);
        parts.push('}}}\n');
      } else if (n.kind === 'include') {
        // The callee's free names come from this scope; root names likewise.
        // (Its free list was fixed up over the include graph before compiling.)
        // A callee with no free names shares one empty array, never allocated.
        const callee = COMPILE_STATE.templates.get(n.name);
        const f = `__f${uid++}`;
        const args = ROOT_NAMES.map((r) => env.get(r) ?? 'void 0').join(',');
        const fargs = callee === undefined || callee.free.length === 0 ? 'H.empty' : `[${callee.free.map((name) => env.get(name) ?? 'void 0').join(',')}]`;
        parts.push(`if(depth<${INCLUDE_DEPTH}){const ${f}=T.get(${JSON.stringify(n.name)});if(${f}!==void 0)__o+=${f}(${args},H,T,depth+1,${fargs});}\n`);
      }
    }
  }

  const env = new Map(ROOT_NAMES.map((r) => [r, r]));
  for (const name of free) env.set(name, `F[${freeIndex.get(name)}]`);
  genNodes(nodes, env);
  parts.push('return __o;');
  const params = [...ROOT_NAMES, 'H', 'T', 'depth', 'F'];
  return new Function(...params, parts.join(''));
}

// Set while compiling a build's templates, so include sites can read the
// callee's free list. Only read during compilation, never at render time.
const COMPILE_STATE = { templates: new Map() };

/**
 * Parse and compile a build's templates. Returns { map, useCompiled } where
 * map holds name -> { nodes, fn, free } and useCompiled is false when code
 * generation is unavailable, in which case callers use the interpreter.
 */
function prepareTemplates(input, report) {
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Free names, fixed up over the include graph (an include renders in the
  // same scope, so what it needs is free in its includer unless bound there).
  const info = new Map();
  for (const [name, nodes] of parsed) info.set(name, { nodes, ...analyzeTemplate(nodes), free: new Set() });
  for (const [name, t] of info) for (const f of t.direct) t.free.add(f);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, t] of info) {
      for (const inc of t.includes) {
        const target = info.get(inc.name);
        if (target === undefined) continue;
        for (const name of target.free) {
          if (!inc.bound.has(name) && !t.free.has(name)) {
            t.free.add(name);
            changed = true;
          }
        }
      }
    }
  }
  const map = new Map();
  for (const [name, t] of info) map.set(name, { nodes: t.nodes, free: [...t.free].sort(byCodeUnits), fn: null });
  COMPILE_STATE.templates = map;
  let useCompiled = true;
  try {
    for (const [, t] of map) t.fn = compileTemplate(t.nodes, t.free);
  } catch {
    useCompiled = false;
    for (const [, t] of map) t.fn = null;
  }
  COMPILE_STATE.templates = new Map();
  return { map, useCompiled };
}

// ------------------------------------------------------------------ the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const H = { esc: escapeHtml, textOf, truthy, var: (v) => escapeHtml(textOf(v)), empty: [] };
const EMPTY_FREE = H.empty;

/** One site's output tree: path -> text. */
export function build(input) {
  const report = [];
  const { map: templates, useCompiled } = prepareTemplates(input, report);
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const slug = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content });
    } else statics.push(f);
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  // One link environment for the whole build: rendering is synchronous per
  // source, so its directory and source path are just reset for each source.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  const mdEnv = {
    dir: '',
    src: '',
    link(target) {
      if (schemeRe.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(this.dir, rel);
      const hit = path === null ? undefined : bySource.get(path);
      if (hit !== undefined) return `${hit.url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${this.src} -> ${target}`);
      return target;
    },
  };
  for (const s of kept) {
    mdEnv.dir = dirOf(s.path);
    mdEnv.src = s.path;
    const md = renderMarkdown(s.body, mdEnv, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sg = slug(name);
      if (!seen.has(sg)) {
        seen.add(sg);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sg = slug(name);
      let tag = bySlug.get(sg);
      if (tag === undefined) {
        tag = { name, slug: sg, url: `${base}/tags/${sg}/`, posts: [] };
        bySlug.set(sg, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sg = slug(name);
      return bySlug.get(sg) ?? { name, slug: sg, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    // The tag records themselves: templates only read name, slug and url
    // from a card's tags, which these carry (a page's tag records are the
    // { name, slug, url } fallbacks built above; a post's are its tags).
    tags: s.tagRefs,
  });
  for (const p of posts) p.card = cardOf(p);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};

  // Compiled templates call each other through this name -> function map.
  const fnMap = new Map();
  if (useCompiled) for (const [name, t] of templates) fnMap.set(name, t.fn);

  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    if (useCompiled) {
      return t.fn(site, allTags, recent, vars.page, vars.posts, vars.pager, vars.tag, H, fnMap, 0, EMPTY_FREE);
    }
    const interpTemplates = { get: (n) => templates.get(n) };
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    return renderNodes(t.nodes, scope, { templates: interpTemplates }, 0);
  };

  for (const s of kept) {
    // A post's page reuses its card (same title, url, dates, summary,
    // excerpt, reading time and tags); a page builds its card once, here.
    const card = s.post ? s.card : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
