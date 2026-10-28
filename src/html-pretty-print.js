#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const beautify = require('js-beautify').html;

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  })
);

if (args.length < 1) {
  console.error('Usage: html-pretty-print <input.html> [output.html]');
  process.exit(1);
}

const inputFile = path.resolve(args[0]);
const outputFile = args[1]
  ? path.resolve(args[1])
  : inputFile.replace(/(\.[^.]+)$/, '-formatted$1');

if (!fs.existsSync(inputFile)) {
  console.error(`Error: Cannot find file at "${inputFile}"`);
  process.exit(1);
}

const rawHtml = fs.readFileSync(inputFile, 'utf8');

const options = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 0,
  preserve_newlines: true,
  end_with_newline: true,
  ...(flags['wrap-attrs'] ? { wrap_attributes: 'force-expand-multiline', wrap_attributes_min_attrs: 1 } : {})
};

const formattedHtml = beautify(rawHtml, options);
fs.writeFileSync(outputFile, formattedHtml, 'utf8');
console.log(`Formatted: ${outputFile}`);
