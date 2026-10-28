#!/usr/bin/env node
/**
 * compare-html.js
 *
 * 1. Pretty-prints both input files → <name>-formatted.html
 * 2. Extracts the inner HTML of --selector (default: .nwt-contentfragment) from each
 * 3. Diffs the fragments: normalised/attribute-sorted formatted source diff
 * 4. Writes a self-contained HTML report
 *
 * Usage:
 *   node src/compare-html.js preprod.html prod.html [report.html]
 *       [--selector=.nwt-contentfragment]
 *       [--ignore-attrs=data-aue-resource,id]
 *       [--wrap-attrs]
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
    '       [--selector=.nwt-contentfragment] [--ignore-attrs=a,b] [--wrap-attrs]'
  );
  process.exit(1);
}

const [fileA, fileB, reportPath = 'html-diff-report.html'] = positional;
const selector   = flags['selector'] || '.nwt-contentfragment';
const ignoreAttrs = new Set((flags['ignore-attrs'] || '').split(',').filter(Boolean));

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
  const base = path.basename(filePath, path.extname(filePath));
  const ext  = path.extname(filePath);
  return path.join(dir, `${base}-formatted${ext}`);
}

function prettyPrintAndSave(filePath) {
  const raw       = fs.readFileSync(filePath, 'utf8');
  const formatted = beautify(raw, beautifyOpts);
  const out       = formattedPath(filePath);
  fs.writeFileSync(out, formatted, 'utf8');
  console.log(`Formatted → ${out}`);
  return formatted;
}

const fmtA = prettyPrintAndSave(fileA);
const fmtB = prettyPrintAndSave(fileB);

// ─── Step 2: extract selector fragment ───────────────────────────────────────
function extractFragment(formattedSrc, filePath) {
  const $ = cheerio.load(formattedSrc);
  const el = $(selector);
  if (!el.length) {
    console.warn(`Warning: "${selector}" not found in ${filePath}`);
    return formattedSrc;
  }
  // Return the outer HTML of the matched element so structure diffs include the root tag
  return $.html(el.first());
}

const fragSrcA = extractFragment(fmtA, fileA);
const fragSrcB = extractFragment(fmtB, fileB);

// ─── Step 3: diffs ───────────────────────────────────────────────────────────
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);

function normalise($root) {
  const out  = [];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    if (node.type === 'text') {
      const t = node.data.replace(/\s+/g, ' ').trim();
      if (t) out.push(pad + t);
    } else if (node.type === 'comment') {
      out.push(`${pad}<!--${node.data.trim()}-->`);
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
  $root.root().contents().each((_, n) => walk(n, 0));
  return out.join('\n') + '\n';
}


const $A = cheerio.load(fragSrcA);
const $B = cheerio.load(fragSrcB);

const sourceDiff = Diff.diffLines(normalise($A), normalise($B));

// ─── Step 4: stats + console summary ─────────────────────────────────────────
const countLines = (d, f) => d.filter(p => p[f]).reduce((n, p) => n + p.count, 0);
const stats = {
  linesAdded:   countLines(sourceDiff, 'added'),
  linesRemoved: countLines(sourceDiff, 'removed'),
};
const identical = Object.values(stats).every(v => v === 0);

console.log(`\nComparing "${selector}" in:`);
console.log(`  A: ${fileA}`);
console.log(`  B: ${fileB}`);
if (ignoreAttrs.size) console.log(`Ignoring attributes: ${[...ignoreAttrs].join(', ')}`);
console.log(identical ? '\n✔ No differences found.' : '');
console.table(stats);

// ─── Step 5: HTML report ──────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
);

function renderDiff(parts, context = 3) {
  const rows = [];
  let la = 1, lb = 1;
  parts.forEach((p, i) => {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.added)
      lines.forEach(l => rows.push(`<tr class="add"><td></td><td>${lb++}</td><td>+ ${esc(l)}</td></tr>`));
    else if (p.removed)
      lines.forEach(l => rows.push(`<tr class="del"><td>${la++}</td><td></td><td>- ${esc(l)}</td></tr>`));
    else {
      const first = i === 0, last = i === parts.length - 1;
      const keepHead = first ? 0 : context, keepTail = last ? 0 : context;
      lines.forEach((l, j) => {
        const show = j < keepHead || j >= lines.length - keepTail;
        if (show)
          rows.push(`<tr class="ctx"><td>${la}</td><td>${lb}</td><td>&nbsp; ${esc(l)}</td></tr>`);
        else if (j === keepHead)
          rows.push(`<tr class="gap"><td colspan="3">… ${lines.length - keepHead - keepTail} unchanged lines …</td></tr>`);
        la++; lb++;
      });
    }
  });
  return rows.length
    ? `<table class="diff">${rows.join('')}</table>`
    : '<p class="ok">No differences.</p>';
}


const report = `<!doctype html>
<html><head><meta charset="utf-8"><title>HTML diff — ${esc(selector)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
h1{font-size:20px}
h2{font-size:16px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
.meta{font-size:12px;color:#555;margin-bottom:16px}
.chip{display:inline-block;background:#e8f0fe;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:12px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:130px}
.card b{display:block;font-size:22px}
table.diff{border-collapse:collapse;width:100%;font:12px/1.4 ui-monospace,monospace;background:#fff}
table.diff td{padding:0 6px;white-space:pre-wrap;word-break:break-all;vertical-align:top}
table.diff td:nth-child(-n+2){color:#999;text-align:right;width:40px;user-select:none}
.add{background:#e6ffec}.del{background:#ffebe9}
.gap td{background:#f0f3f6;color:#666;text-align:center!important}
.ok{color:#1a7f37}ul.add li{color:#1a7f37}ul.del li{color:#cf222e}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}
</style></head>
<body>
<h1>HTML fragment comparison</h1>
<p class="meta">
  Selector: <span class="chip">${esc(selector)}</span><br>
  <b>A (preprod):</b> ${esc(path.resolve(fileA))}
    → <a href="${esc(formattedPath(fileA))}">${esc(path.basename(formattedPath(fileA)))}</a><br>
  <b>B (prod):</b> ${esc(path.resolve(fileB))}
    → <a href="${esc(formattedPath(fileB))}">${esc(path.basename(formattedPath(fileB)))}</a>
  ${ignoreAttrs.size ? `<br>Ignored attributes: ${esc([...ignoreAttrs].join(', '))}` : ''}
</p>
<div class="cards">
  <div class="card">Lines added<b>${stats.linesAdded}</b></div>
  <div class="card">Lines removed<b>${stats.linesRemoved}</b></div>
</div>

<h2>Formatted source diff</h2>
${renderDiff(sourceDiff)}
</body></html>`;

fs.writeFileSync(reportPath, report);
console.log(`Report → ${path.resolve(reportPath)}`);
process.exit(identical ? 0 : 1);
