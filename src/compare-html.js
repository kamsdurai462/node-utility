#!/usr/bin/env node
/**
 * compare-html.js — compare two HTML files three ways:
 *   1. Formatted source diff (pretty-printed, whitespace-normalised, line by line)
 *   2. Structural diff (elements, attributes, classes per DOM path)
 *   3. Visible text diff (what a reader actually sees)
 * Writes a self-contained HTML report and prints a summary to the console.
 *
 * Usage:
 *   npm install cheerio diff
 *   node compare-html.js old.html new.html [report.html] [--ignore-attrs=data-aue-resource,id]
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const Diff = require('diff');

// ---------- args ----------
const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  })
);
const files = args.filter(a => !a.startsWith('--'));
if (files.length < 2) {
  console.error('Usage: node compare-html.js <a.html> <b.html> [report.html] [--ignore-attrs=a,b]');
  process.exit(1);
}
const [fileA, fileB, reportPath = 'html-diff-report.html'] = files;
const ignoreAttrs = new Set((flags['ignore-attrs'] || '').split(',').filter(Boolean));

const srcA = fs.readFileSync(fileA, 'utf8');
const srcB = fs.readFileSync(fileB, 'utf8');
const $A = cheerio.load(srcA);
const $B = cheerio.load(srcB);

// ---------- 1. formatted source ----------
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
function pretty($) {
  const out = [];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    if (node.type === 'text') {
      const t = node.data.replace(/\s+/g, ' ').trim();
      if (t) out.push(pad + t);
    } else if (node.type === 'comment') {
      out.push(pad + `<!--${node.data.trim()}-->`);
    } else if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      const attrs = Object.entries(node.attribs || {})
        .filter(([k]) => !ignoreAttrs.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`)).join('');
      out.push(`${pad}<${node.name}${attrs}>`);
      (node.children || []).forEach(c => walk(c, depth + 1));
      if (!VOID.has(node.name)) out.push(`${pad}</${node.name}>`);
    } else if (node.children) {
      node.children.forEach(c => walk(c, depth));
    }
  };
  $.root().contents().each((_, n) => walk(n, 0));
  return out.join('\n') + '\n';
}
const sourceDiff = Diff.diffLines(pretty($A), pretty($B));

// ---------- 2. structure ----------
function structure($) {
  const map = new Map();
  const walk = (el, p) => {
    const counts = {};
    $(el).children().each((_, c) => {
      counts[c.name] = (counts[c.name] || 0) + 1;
      const id = c.attribs.id ? `#${c.attribs.id}` : '';
      const key = `${p} > ${c.name}${id}[${counts[c.name]}]`;
      const attrs = { ...c.attribs };
      for (const k of ignoreAttrs) delete attrs[k];
      map.set(key, attrs);
      walk(c, key);
    });
  };
  walk($.root(), '');
  return map;
}
const sA = structure($A), sB = structure($B);
const added = [...sB.keys()].filter(k => !sA.has(k));
const removed = [...sA.keys()].filter(k => !sB.has(k));
const changedAttrs = [];
for (const [k, a] of sA) {
  if (!sB.has(k)) continue;
  const b = sB.get(k);
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[name] !== b[name]) changedAttrs.push({ path: k, attr: name, from: a[name], to: b[name] });
  }
}

// ---------- 3. visible text ----------
function visibleText($) {
  $('script, style, noscript, template').remove();
  const lines = [];
  $('body').find('*').addBack().contents().each((_, n) => {
    if (n.type === 'text') {
      const t = n.data.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
  });
  return lines.join('\n') + '\n';
}
const textDiff = Diff.diffLines(visibleText(cheerio.load(srcA)), visibleText(cheerio.load(srcB)));

// ---------- stats ----------
const count = (d, f) => d.filter(p => p[f]).reduce((n, p) => n + p.count, 0);
const stats = {
  sourceAdded: count(sourceDiff, 'added'), sourceRemoved: count(sourceDiff, 'removed'),
  textAdded: count(textDiff, 'added'), textRemoved: count(textDiff, 'removed'),
  elementsAdded: added.length, elementsRemoved: removed.length, attrChanges: changedAttrs.length,
};
const identical = Object.values(stats).every(v => v === 0);

console.log(`\nComparing ${fileA}  →  ${fileB}`);
if (ignoreAttrs.size) console.log(`Ignoring attributes: ${[...ignoreAttrs].join(', ')}`);
console.log(identical ? '✔ No differences found.' : '');
console.table(stats);

// ---------- report ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderDiff(parts, context = 3) {
  const rows = [];
  let la = 1, lb = 1;
  parts.forEach((p, i) => {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.added) lines.forEach(l => rows.push(`<tr class="add"><td></td><td>${lb++}</td><td>+ ${esc(l)}</td></tr>`));
    else if (p.removed) lines.forEach(l => rows.push(`<tr class="del"><td>${la++}</td><td></td><td>- ${esc(l)}</td></tr>`));
    else {
      const first = i === 0, last = i === parts.length - 1;
      const keepHead = first ? 0 : context, keepTail = last ? 0 : context;
      lines.forEach((l, j) => {
        const show = j < keepHead || j >= lines.length - keepTail;
        if (show) rows.push(`<tr class="ctx"><td>${la}</td><td>${lb}</td><td>&nbsp; ${esc(l)}</td></tr>`);
        else if (j === keepHead) rows.push(`<tr class="gap"><td colspan="3">… ${lines.length - keepHead - keepTail} unchanged lines …</td></tr>`);
        la++; lb++;
      });
    }
  });
  return rows.length ? `<table class="diff">${rows.join('')}</table>` : '<p class="ok">No differences.</p>';
}
const list = (arr, cls) => arr.length
  ? `<ul class="${cls}">${arr.slice(0, 500).map(k => `<li><code>${esc(k)}</code></li>`).join('')}${arr.length > 500 ? `<li>…and ${arr.length - 500} more</li>` : ''}</ul>`
  : '<p class="ok">None.</p>';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>HTML diff</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
h1{font-size:20px}h2{font-size:16px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
.cards{display:flex;flex-wrap:wrap;gap:12px}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:130px}
.card b{display:block;font-size:22px}
table.diff{border-collapse:collapse;width:100%;font:12px/1.4 ui-monospace,monospace;background:#fff}
table.diff td{padding:0 6px;white-space:pre-wrap;word-break:break-all;vertical-align:top}
table.diff td:nth-child(-n+2){color:#999;text-align:right;width:40px;user-select:none}
.add{background:#e6ffec}.del{background:#ffebe9}.gap td{background:#f0f3f6;color:#666;text-align:center!important}
.ok{color:#1a7f37}ul.add li{color:#1a7f37}ul.del li{color:#cf222e}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}
table.attrs{border-collapse:collapse;background:#fff;font-size:12px}table.attrs td,table.attrs th{border:1px solid #ddd;padding:4px 8px;text-align:left}
</style></head><body>
<h1>HTML comparison</h1>
<p><b>A:</b> ${esc(path.resolve(fileA))}<br><b>B:</b> ${esc(path.resolve(fileB))}
${ignoreAttrs.size ? `<br><b>Ignored attributes:</b> ${esc([...ignoreAttrs].join(', '))}` : ''}</p>
<div class="cards">
${Object.entries({ 'Source lines +': stats.sourceAdded, 'Source lines −': stats.sourceRemoved, 'Text lines +': stats.textAdded, 'Text lines −': stats.textRemoved, 'Elements +': stats.elementsAdded, 'Elements −': stats.elementsRemoved, 'Attr changes': stats.attrChanges })
  .map(([k, v]) => `<div class="card">${k}<b>${v}</b></div>`).join('')}
</div>
<h2>Visible text</h2>${renderDiff(textDiff)}
<h2>Structure</h2>
<details ${added.length ? 'open' : ''}><summary>Elements only in B (${added.length})</summary>${list(added, 'add')}</details>
<details ${removed.length ? 'open' : ''}><summary>Elements only in A (${removed.length})</summary>${list(removed, 'del')}</details>
<details ${changedAttrs.length ? 'open' : ''}><summary>Attribute changes (${changedAttrs.length})</summary>
${changedAttrs.length ? `<table class="attrs"><tr><th>Element</th><th>Attribute</th><th>A</th><th>B</th></tr>${changedAttrs.slice(0, 1000).map(c => `<tr><td><code>${esc(c.path)}</code></td><td>${esc(c.attr)}</td><td>${esc(c.from ?? '—')}</td><td>${esc(c.to ?? '—')}</td></tr>`).join('')}</table>` : '<p class="ok">None.</p>'}</details>
<h2>Formatted source</h2>${renderDiff(sourceDiff)}
</body></html>`;

fs.writeFileSync(reportPath, html);
console.log(`Report written to ${path.resolve(reportPath)}`);
process.exit(identical ? 0 : 1);
