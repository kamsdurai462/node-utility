#!/usr/bin/env node
/**
 * compare-html.js
 *
 * 1. Pretty-prints both input files → <name>-formatted.html
 * 2. Extracts --selector (default: .nwt-contentfragment) from each
 * 3. Diffs the fragments' HTML STRUCTURE (default) and shows exactly what changed:
 *      • compared: elements, nesting, class names, and which attributes are present
 *      • ignored:  text content, comments, attribute values other than class, class order
 *        (use --attr-values to also compare every attribute value, --text to include text content)
 *      • every change numbered, with line numbers and DOM location (e.g. div.nwt-contentfragment > ul > li)
 *      • the exact words/characters that changed are highlighted inside each line
 *        (red = only in A / preprod, green = only in B / prod)
 *      • side-by-side view with next/prev change navigation
 *      • visible-text changes and attribute changes as separate views
 * 4. Prints a coloured list of every change in the terminal and writes a self-contained HTML report
 *
 * Usage:
 *   node src/compare-html.js preprod.html prod.html [report.html]
 *       [--selector=.nwt-contentfragment]
 *       [--ignore-attrs=data-aue-resource,id]
 *       [--wrap-attrs]
 *       [--attr-values]     also compare attribute values (href, src, alt, data-*, …), not just presence
 *       [--text]            also compare text content (full diff: text + all attribute values)
 *       [--context=3]       lines of unchanged context in the side-by-side view
 *       [--no-color]        plain terminal output ([-removed-] {+added+})
 *
 * Exit code: 0 = identical, 1 = differences found.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const cheerio  = require('cheerio');
const Diff     = require('diff');
const beautify = require('js-beautify').html;

// ─── CLI args ────────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  })
);
const positional = argv.filter(a => !a.startsWith('--'));

if (positional.length < 2) {
  console.error(
    'Usage: compare-html <a.html> <b.html> [report.html]\n' +
    '       [--selector=.nwt-contentfragment] [--ignore-attrs=a,b] [--wrap-attrs]\n' +
    '       [--attr-values] [--text] [--context=3] [--no-color]'
  );
  process.exit(1);
}

const [fileA, fileB, reportPath = 'html-diff-report.html'] = positional;
const selector    = flags['selector'] || '.nwt-contentfragment';
const ignoreAttrs = new Set((flags['ignore-attrs'] || '').split(',').map(s => s.trim()).filter(Boolean));
const CONTEXT     = Number(flags['context'] ?? 3);
const COLOR       = !flags['no-color'] && process.stdout.isTTY;
const WITH_TEXT   = !!flags['text'];                        // include text content
const ATTR_VALUES = WITH_TEXT || !!flags['attr-values'];    // compare every attribute value
const MODE_LABEL  = WITH_TEXT ? 'Full comparison (structure + text)'
  : ATTR_VALUES ? 'Structure only (attribute values compared, text ignored)'
  : 'Structure only (text and attribute values ignored — class compared)';

// Attributes as they take part in the comparison:
//   class → sorted, de-duplicated tokens (order is not structural)
//   other → presence only ('' value) unless --attr-values / --text
function normAttrs(attribs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attribs)) {
    if (ignoreAttrs.has(k)) continue;
    if (k === 'class') out[k] = [...new Set(v.trim().split(/\s+/).filter(Boolean))].sort().join(' ');
    else out[k] = ATTR_VALUES ? v : '';
  }
  return out;
}

for (const f of [fileA, fileB]) {
  if (!fs.existsSync(f)) { console.error(`Error: Cannot find file at "${path.resolve(f)}"`); process.exit(1); }
}

// ─── Step 1: pretty-print both files ─────────────────────────────────────────
const beautifyOpts = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 0,
  preserve_newlines: true,
  end_with_newline: true,
  ...(flags['wrap-attrs'] ? { wrap_attributes: 'force-expand-multiline', wrap_attributes_min_attrs: 1 } : {}),
};

function formattedPath(filePath) {
  const dir  = path.dirname(filePath);
  const ext  = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // an already-formatted input keeps its own name (avoids x-formatted-formatted.html)
  return base.endsWith('-formatted') ? filePath : path.join(dir, `${base}-formatted${ext}`);
}

function prettyPrintAndSave(filePath) {
  const raw       = fs.readFileSync(filePath, 'utf8');
  const formatted = beautify(raw, beautifyOpts);
  const out       = formattedPath(filePath);
  if (out === filePath) {
    console.log(`Already formatted → ${out}`);
  } else {
    fs.writeFileSync(out, formatted, 'utf8');
    console.log(`Formatted → ${out}`);
  }
  return formatted;
}

const fmtA = prettyPrintAndSave(fileA);
const fmtB = prettyPrintAndSave(fileB);

// ─── Step 2: extract selector fragment ───────────────────────────────────────
function extractFragment(formattedSrc, filePath) {
  const $ = cheerio.load(formattedSrc);
  const el = $(selector);
  if (!el.length) {
    console.warn(`Warning: "${selector}" not found in ${filePath} — comparing the whole page`);
    return formattedSrc;
  }
  if (el.length > 1) console.warn(`Note: "${selector}" matched ${el.length} elements in ${filePath} — using the first`);
  // Outer HTML of the matched element so structure diffs include the root tag
  return $.html(el.first());
}

const fragSrcA = extractFragment(fmtA, fileA);
const fragSrcB = extractFragment(fmtB, fileB);

// ─── Step 3a: normalise fragments into lines (indent + DOM location per line) ─
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);

function normaliseLines(src) {
  const $   = cheerio.load(src);
  const out = [];
  const label = n => n.name + (n.attribs?.id ? `#${n.attribs.id}`
    : n.attribs?.class ? '.' + n.attribs.class.trim().split(/\s+/)[0] : '');
  const push = (depth, text, where) => out.push({ text, indent: '  '.repeat(depth), where });

  const walk = (node, depth, trail) => {
    const where = trail.join(' > ') || '(root)';
    if (node.type === 'text') {
      if (!WITH_TEXT) return;
      const t = node.data.replace(/\s+/g, ' ').trim();
      if (t) push(depth, t, where);
    } else if (node.type === 'comment') {
      if (WITH_TEXT) push(depth, `<!--${node.data.trim()}-->`, where);
    } else if (node.type === 'directive') {
      push(depth, `<${node.data}>`, where);
    } else if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      const attrs = Object.entries(normAttrs(node.attribs))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`)).join('');
      const me = node.name === 'html' || node.name === 'body' ? trail : [...trail, label(node)];
      push(depth, `<${node.name}${attrs}>`, me.join(' > '));
      (node.children || []).forEach(c => walk(c, depth + 1, me));
      if (!VOID.has(node.name)) push(depth, `</${node.name}>`, me.join(' > '));
    } else if (node.children) {
      node.children.forEach(c => walk(c, depth, trail));
    }
  };
  $.root().contents().each((_, n) => walk(n, 0, []));
  return out;
}

function visibleTextLines(src) {
  const $ = cheerio.load(src);
  $('script, style, noscript, template').remove();
  const out = [];
  $.root().find('*').contents().each((_, n) => {
    if (n.type !== 'text') return;
    const t = n.data.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const trail = $(n).parents().toArray().reverse().map(p => p.name).filter(x => x !== 'html' && x !== 'body');
    out.push({ text: t, indent: '', where: trail.join(' > ') });
  });
  return out;
}

// ─── Step 3b: diff engine with in-line highlighting ──────────────────────────
// Only lines of the same kind are paired as "modified" (same opening tag, same closing tag, or text)
const kind = t => t.startsWith('<!--') ? 'comment'
  : t.startsWith('</') ? 'close:' + t.slice(2).split(/[\s>]/)[0]
  : t.startsWith('<')  ? 'open:'  + t.slice(1).split(/[\s>]/)[0]
  : 'text';

function similarity(x, y) {
  if (kind(x) !== kind(y)) return 0;
  if (kind(x).startsWith('close:')) return 1;
  if (kind(x).startsWith('open:'))  return 0.9;         // same tag, different attributes
  const d    = Diff.diffChars(x, y);
  const same = d.filter(p => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  const dice = (2 * same) / (x.length + y.length || 1);
  const contain = same >= 3 ? same / Math.min(x.length, y.length) : 0;
  return Math.max(dice, contain >= 0.9 ? 0.6 : 0);
}

// Word-level diff; single-token edits drop to char-level when the tokens are similar ("2015" → "2014")
function inlineDiff(a, b) {
  const words = Diff.diffWordsWithSpace(a, b);
  return words.flatMap((p, i) => {
    if (p._done) return [];
    const next = words[i + 1];
    if (p.removed && next && next.added && !/\s/.test(p.value + next.value)) {
      const chars = Diff.diffChars(p.value, next.value);
      const same  = chars.filter(c => !c.added && !c.removed).reduce((n, c) => n + c.value.length, 0);
      const minLen = Math.min(p.value.length, next.value.length);
      if (minLen >= 3 && same / Math.max(p.value.length, next.value.length) >= 0.6) { next._done = true; return chars; }
    }
    return [p];
  });
}

// rows: { type: 'same'|'del'|'add'|'mod', a, b, aInd, bInd, aNo, bNo, aWhere, bWhere, parts? }
function diffRows(A, B) {
  const parts = Diff.diffArrays(A.map(l => l.text), B.map(l => l.text));   // indentation-insensitive
  const rows  = [];
  let ai = 0, bi = 0;
  const take = (arr, from, n) => arr.slice(from, from + n).map((l, k) => ({ ...l, no: from + k + 1 }));

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (let k = 0; k < p.value.length; k++, ai++, bi++) {
        rows.push({ type: 'same', a: A[ai].text, b: B[bi].text, aInd: A[ai].indent, bInd: B[bi].indent,
          aNo: ai + 1, bNo: bi + 1, aWhere: A[ai].where });
      }
      continue;
    }
    let dels = [], adds = [];
    if (p.removed) {
      dels = take(A, ai, p.value.length); ai += p.value.length;
      if (parts[i + 1]?.added) { i++; adds = take(B, bi, parts[i].value.length); bi += parts[i].value.length; }
    } else {
      adds = take(B, bi, p.value.length); bi += p.value.length;
    }
    // pair each removed line with the most similar added line (in order) → shown as modified
    let j = 0;
    for (const d of dels) {
      let best = -1, bestScore = 0.35;
      for (let k = j; k < Math.min(adds.length, j + 8); k++) {
        const s = similarity(d.text, adds[k].text);
        if (s > bestScore) { bestScore = s; best = k; }
      }
      if (best === -1) { rows.push({ type: 'del', a: d.text, aInd: d.indent, aNo: d.no, aWhere: d.where }); continue; }
      for (; j < best; j++) rows.push({ type: 'add', b: adds[j].text, bInd: adds[j].indent, bNo: adds[j].no, bWhere: adds[j].where });
      const m = adds[best];
      rows.push({ type: 'mod', a: d.text, b: m.text, aInd: d.indent, bInd: m.indent, aNo: d.no, bNo: m.no,
        aWhere: d.where, bWhere: m.where, parts: inlineDiff(d.text, m.text) });
      j = best + 1;
    }
    for (; j < adds.length; j++) rows.push({ type: 'add', b: adds[j].text, bInd: adds[j].indent, bNo: adds[j].no, bWhere: adds[j].where });
  }
  return rows;
}

// long DOM paths → last 5 segments for display (full path kept in the report tooltip)
const shortWhere = w => { const s = (w || '').split(' > '); return s.length > 5 ? '… > ' + s.slice(-5).join(' > ') : (w || ''); };

// consecutive changed rows → one numbered change
function hunks(rows) {
  const out = [];
  let cur = null;
  rows.forEach((r, idx) => {
    if (r.type === 'same') { cur = null; return; }
    if (!cur) { cur = { rows: [], start: idx }; out.push(cur); }
    cur.rows.push(r);
  });
  return out;
}

const srcRows  = diffRows(normaliseLines(fragSrcA), normaliseLines(fragSrcB));
const txtRows  = WITH_TEXT ? diffRows(visibleTextLines(fragSrcA), visibleTextLines(fragSrcB)) : [];
const srcHunks = hunks(srcRows);
const txtHunks = hunks(txtRows);

// ─── Step 3c: attribute changes per element (matched by DOM position) ────────
function elementMap(src) {
  const $   = cheerio.load(src);
  const map = new Map();
  const walk = (el, p) => {
    const counts = {};
    $(el).children().each((_, c) => {
      counts[c.name] = (counts[c.name] || 0) + 1;
      const key   = `${p ? p + ' > ' : ''}${c.name}${c.attribs.id ? '#' + c.attribs.id : ''}[${counts[c.name]}]`;
      map.set(key, normAttrs(c.attribs));
      walk(c, key);
    });
  };
  walk($.root(), '');
  return map;
}
const elA = elementMap(fragSrcA), elB = elementMap(fragSrcB);
const elAdded   = [...elB.keys()].filter(k => !elA.has(k));
const elRemoved = [...elA.keys()].filter(k => !elB.has(k));
const attrChanges = [];
for (const [k, a] of elA) {
  const b = elB.get(k);
  if (!b) continue;
  for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[n] !== b[n]) attrChanges.push({ el: k, attr: n, from: a[n], to: b[n] });
  }
}

// ─── Step 4: stats + console summary ─────────────────────────────────────────
const stats = {
  changes:       srcHunks.length,
  linesModified: srcRows.filter(r => r.type === 'mod').length,
  linesAdded:    srcRows.filter(r => r.type === 'add').length,
  linesRemoved:  srcRows.filter(r => r.type === 'del').length,
  ...(WITH_TEXT ? { textChanges: txtHunks.length } : {}),
  attrChanges:   attrChanges.length,
};
const identical = srcHunks.length === 0;

const C = COLOR
  ? { del: s => `\x1b[41m\x1b[97m${s}\x1b[0m`, add: s => `\x1b[42m\x1b[30m${s}\x1b[0m`,
      red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` }
  : { del: s => `[-${s}-]`, add: s => `{+${s}+}`, red: s => s, green: s => s, dim: s => s, bold: s => s };
const termSide = (parts, side) => parts.map(p =>
  p.added ? (side === 'b' ? C.add(p.value) : '') : p.removed ? (side === 'a' ? C.del(p.value) : '') : p.value).join('');

console.log(`\n${MODE_LABEL}`);
console.log(`Comparing "${selector}" in:`);
console.log(`  A: ${fileA}`);
console.log(`  B: ${fileB}`);
if (ignoreAttrs.size) console.log(C.dim(`Ignoring attributes: ${[...ignoreAttrs].join(', ')}`));

if (identical) {
  console.log(C.green('\n✔ No differences found.'));
} else {
  console.table(stats);
  srcHunks.forEach((h, i) => {
    const r0   = h.rows[0];
    const aNo  = h.rows.find(r => r.type !== 'add')?.aNo ?? '-';
    const bNo  = h.rows.find(r => r.type !== 'del')?.bNo ?? '-';
    console.log(C.bold(`#${i + 1}`) + C.dim(`  A:${aNo}  B:${bNo}  ${shortWhere(r0.aWhere || r0.bWhere)}`));
    h.rows.forEach(r => {
      if (r.type === 'mod') {
        console.log('  ' + C.red('- ') + termSide(r.parts, 'a'));
        console.log('  ' + C.green('+ ') + termSide(r.parts, 'b'));
      } else if (r.type === 'del') console.log('  ' + C.red('- ' + r.a));
      else console.log('  ' + C.green('+ ' + r.b));
    });
    console.log();
  });
}

// ─── Step 5: HTML report ──────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
);
const hl = (parts, side) => parts.map(p =>
  p.added   ? (side === 'b' ? `<ins>${esc(p.value)}</ins>` : '') :
  p.removed ? (side === 'a' ? `<del>${esc(p.value)}</del>` : '') : esc(p.value)).join('');

function changeCards(hs, idPrefix) {
  if (!hs.length) return '<p class="ok">No differences.</p>';
  return hs.map((h, i) => {
    const aNo   = h.rows.find(r => r.type !== 'add')?.aNo;
    const bNo   = h.rows.find(r => r.type !== 'del')?.bNo;
    const where = h.rows[0].aWhere || h.rows[0].bWhere || '';
    const kinds = new Set(h.rows.map(r => r.type));
    const label = kinds.size === 1 && kinds.has('add') ? 'Added' : kinds.size === 1 && kinds.has('del') ? 'Removed' : 'Changed';
    const body  = h.rows.map(r => r.type === 'mod'
      ? `<div class="ln a"><span class="tag">A ${r.aNo}</span><code>${hl(r.parts, 'a')}</code></div>` +
        `<div class="ln b"><span class="tag">B ${r.bNo}</span><code>${hl(r.parts, 'b')}</code></div>`
      : r.type === 'del'
        ? `<div class="ln a whole"><span class="tag">A ${r.aNo}</span><code>${esc(r.aInd)}<del>${esc(r.a)}</del></code></div>`
        : `<div class="ln b whole"><span class="tag">B ${r.bNo}</span><code>${esc(r.bInd)}<ins>${esc(r.b)}</ins></code></div>`).join('');
    const jump = idPrefix === 'src' ? `<a href="#row-${h.start}" class="jump">view in context ↓</a>` : '';
    return `<div class="change" id="${idPrefix}-chg-${i + 1}">
      <div class="chead"><b>#${i + 1}</b> <span class="kind ${label.toLowerCase()}">${label}</span>
        <span class="loc">${aNo ? 'A line ' + aNo : ''}${aNo && bNo ? ' · ' : ''}${bNo ? 'B line ' + bNo : ''}</span>
        <span class="where" title="${esc(where)}">${esc(shortWhere(where))}</span>${jump}</div>${body}</div>`;
  }).join('');
}

function sideBySide(rows) {
  if (!rows.some(r => r.type !== 'same')) return '<p class="ok">No differences.</p>';
  const near = rows.map((r, i) =>
    rows.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(x => x.type !== 'same'));
  const out = [];
  let gap = 0, chg = 0;
  rows.forEach((r, i) => {
    const hidden = !near[i];
    if (hidden) gap++;
    else if (gap) { out.push(`<tr class="gap"><td colspan="4">⋯ ${gap} unchanged line(s) ⋯</td></tr>`); gap = 0; }
    const isStart = r.type !== 'same' && (i === 0 || rows[i - 1].type === 'same');
    const id   = isStart ? ` id="row-${i}" data-chg="${++chg}"` : '';
    const aInd = esc(r.aInd || ''), bInd = esc(r.bInd || '');
    const aCell = r.type === 'add' ? '' : aInd + (r.type === 'mod' ? hl(r.parts, 'a') : r.type === 'del' ? `<del>${esc(r.a)}</del>` : esc(r.a));
    const bCell = r.type === 'del' ? '' : bInd + (r.type === 'mod' ? hl(r.parts, 'b') : r.type === 'add' ? `<ins>${esc(r.b)}</ins>` : esc(r.b));
    out.push(`<tr class="${r.type}${hidden ? ' hid' : ''}"${id}><td class="n">${r.type === 'add' ? '' : r.aNo}</td>` +
      `<td class="c ca">${aCell}</td><td class="n">${r.type === 'del' ? '' : r.bNo}</td><td class="c cb">${bCell}</td></tr>`);
  });
  if (gap) out.push(`<tr class="gap"><td colspan="4">⋯ ${gap} unchanged line(s) ⋯</td></tr>`);
  return `<table class="sbs"><colgroup><col class="nc"><col><col class="nc"><col></colgroup>
    <thead><tr><th></th><th>A (preprod) · ${esc(path.basename(fileA))}</th><th></th><th>B (prod) · ${esc(path.basename(fileB))}</th></tr></thead>
    <tbody>${out.join('')}</tbody></table>`;
}

const attrTable = attrChanges.length
  ? `<table class="attrs"><tr><th>Element</th><th>Attribute</th><th>A (preprod)</th><th>B (prod)</th></tr>${attrChanges.map(c => {
      const p = c.from != null && c.to != null ? inlineDiff(c.from, c.to) : null;
      const shown = (v, tag) => v === '' && c.attr !== 'class' && !ATTR_VALUES ? `<${tag}>present</${tag}>` : `<${tag}>${esc(v)}</${tag}>`;
      const a = c.from == null ? '<i>(not present)</i>' : p ? hl(p, 'a') : shown(c.from, 'del');
      const b = c.to   == null ? '<i>(not present)</i>' : p ? hl(p, 'b') : shown(c.to, 'ins');
      return `<tr><td><code>${esc(c.el)}</code></td><td><b>${esc(c.attr)}</b></td><td><code>${a}</code></td><td><code>${b}</code></td></tr>`;
    }).join('')}</table>`
  : '<p class="ok">None.</p>';
const elList = (arr, cls) => arr.length
  ? `<ul class="${cls}">${arr.map(k => `<li><code>${esc(k)}</code></li>`).join('')}</ul>`
  : '<p class="ok">None.</p>';
const fileLink = f => `<a href="${esc(path.resolve(formattedPath(f)))}">${esc(path.basename(formattedPath(f)))}</a>`;

const report = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTML diff — ${esc(selector)}</title>
<style>
:root{--bg:#f6f7f9;--fg:#1f2328;--card:#fff;--line:#d8dee4;--mut:#656d76;--delbg:#ffebe9;--delhl:#ff8182;--addbg:#e6ffec;--addhl:#4ac26b;--modbg:#fff8c5;--chip:#e8f0fe}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--card:#161b22;--line:#30363d;--mut:#8d96a0;--delbg:#3c1618;--delhl:#a0111f;--addbg:#12261e;--addhl:#1f6f37;--modbg:#2e2a12;--chip:#1f2d44}}
*{box-sizing:border-box}
body{margin:0;padding:20px 16px 80px;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:16px;margin:32px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}
a{color:#0969da}
.meta{font-size:12px;color:var(--mut);word-break:break-all}
.chip{display:inline-block;background:var(--chip);color:var(--fg);border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:12px}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
.card b{display:block;font-size:22px}
.legend{font-size:13px;color:var(--mut)}
del{background:var(--delhl);color:inherit;text-decoration:line-through;text-decoration-thickness:1px;border-radius:2px}
ins{background:var(--addhl);color:inherit;text-decoration:none;border-radius:2px}
.whole del,.whole ins{background:none;text-decoration:none}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.change{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0;overflow:hidden}
.chead{padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.kind{font-size:11px;font-weight:600;padding:1px 7px;border-radius:10px}
.kind.changed{background:var(--modbg)}.kind.added{background:var(--addbg)}.kind.removed{background:var(--delbg)}
.loc{color:var(--mut)}.where{color:var(--mut);font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
.jump{margin-left:auto;font-size:12px}
.ln{display:flex;gap:8px;padding:3px 10px}.ln.a{background:var(--delbg)}.ln.b{background:var(--addbg)}
.tag{flex:none;width:56px;font:11px ui-monospace,monospace;color:var(--mut);padding-top:2px}
.sbswrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table.sbs{border-collapse:collapse;width:100%;table-layout:fixed;min-width:760px}
.sbs th{position:sticky;top:0;background:var(--card);text-align:left;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
.sbs col.nc{width:50px}
.sbs td{vertical-align:top;padding:0 8px;font:12.5px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.sbs td.n{color:var(--mut);text-align:right;user-select:none;font-size:11px}
.sbs tr.del td.ca,.sbs tr.mod td.ca{background:var(--delbg)}
.sbs tr.add td.cb,.sbs tr.mod td.cb{background:var(--addbg)}
.sbs tr.del td.cb,.sbs tr.add td.ca{background:repeating-linear-gradient(45deg,transparent 0 5px,var(--line) 5px 6px)}
.sbs tr.del td.ca del,.sbs tr.add td.cb ins{background:none;text-decoration:none}
.sbs tr.gap td{text-align:center;color:var(--mut);background:var(--bg);font-size:12px;padding:3px}
.sbs tr.hid{display:none}
body.full .sbs tr.hid{display:table-row}body.full .sbs tr.gap{display:none}
.sbs tr.flash td{outline:2px solid #e3b341;outline-offset:-2px}
.ok{color:#1a7f37}ul.add li{color:#1a7f37}ul.del li{color:#cf222e}
table.attrs{border-collapse:collapse;background:var(--card);width:100%}
.attrs td,.attrs th{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
details>summary{cursor:pointer;font-weight:600;margin:8px 0}
.nav{position:fixed;right:16px;bottom:16px;display:flex;gap:6px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 8px;box-shadow:0 4px 14px rgba(0,0,0,.15);font-size:13px}
.nav button{font:inherit;padding:3px 10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;cursor:pointer}
</style></head>
<body>
<h1>HTML fragment comparison</h1>
<p class="meta">
  Mode: <b>${esc(MODE_LABEL)}</b><br>
  Selector: <span class="chip">${esc(selector)}</span><br>
  <b>A (preprod):</b> ${esc(path.resolve(fileA))} → ${fileLink(fileA)}<br>
  <b>B (prod):</b> ${esc(path.resolve(fileB))} → ${fileLink(fileB)}
  ${ignoreAttrs.size ? `<br>Ignored attributes: ${esc([...ignoreAttrs].join(', '))}` : ''}
</p>
${identical ? '<h2 class="ok">✔ No structure differences found.</h2>' : `
<div class="cards">
  <div class="card">Changes<b>${stats.changes}</b></div>
  <div class="card">Lines modified<b>${stats.linesModified}</b></div>
  <div class="card">Lines added<b>${stats.linesAdded}</b></div>
  <div class="card">Lines removed<b>${stats.linesRemoved}</b></div>
  ${WITH_TEXT ? `<div class="card">Visible-text changes<b>${stats.textChanges}</b></div>` : ''}
  <div class="card">Attribute changes<b>${stats.attrChanges}</b></div>
</div>
<div class="legend"><del>red</del> = only in A (preprod) &nbsp; <ins>green</ins> = only in B (prod) &nbsp;·&nbsp; keys: <b>n</b> next change, <b>p</b> previous</div>

<h2>1 · Every structure change</h2>
${changeCards(srcHunks, 'src')}

<h2>2 · Side by side</h2>
<p><label><input type="checkbox" id="full"> Show full fragment (not just changes + ${CONTEXT} lines of context)</label></p>
<div class="sbswrap">${sideBySide(srcRows)}</div>

${WITH_TEXT ? `<h2>3 · Visible text changes <span class="legend">(what a visitor reads — scripts/styles ignored)</span></h2>
${changeCards(txtHunks, 'txt')}` : ''}

<h2>${WITH_TEXT ? '4' : '3'} · Attribute changes</h2>
${attrTable}
<details><summary>Elements only in B (${elAdded.length})</summary>${elList(elAdded, 'add')}</details>
<details><summary>Elements only in A (${elRemoved.length})</summary>${elList(elRemoved, 'del')}</details>

<div class="nav"><button id="prev">▲ Prev</button><span id="pos">– / ${srcHunks.length}</span><button id="next">Next ▼</button></div>`}
<script>
(() => {
  const full = document.getElementById('full');
  if (full) full.onchange = () => document.body.classList.toggle('full', full.checked);
  const rows = [...document.querySelectorAll('tr[data-chg]')];
  let cur = -1;
  const go = d => {
    if (!rows.length) return;
    cur = (cur + d + rows.length) % rows.length;
    const r = rows[cur];
    r.scrollIntoView({ behavior: 'smooth', block: 'center' });
    r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 1200);
    document.getElementById('pos').textContent = (cur + 1) + ' / ' + rows.length;
  };
  const n = document.getElementById('next'), p = document.getElementById('prev');
  if (n) { n.onclick = () => go(1); p.onclick = () => go(-1); }
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'n') go(1);
    if (e.key === 'p') go(-1);
  });
})();
</script>
</body></html>`;

fs.writeFileSync(reportPath, report);
console.log(`Report → ${path.resolve(reportPath)}`);
process.exit(identical ? 0 : 1);
