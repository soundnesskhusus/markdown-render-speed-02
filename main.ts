// Driver for the markdown-render-speed-02 bounty.
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json), renders
// every case with the dependency-free parse() in parse.js, and writes
// /output/html.json (or $MAKEFUN_OUTPUT_DIR/html.json) as a JSON array
// of HTML strings, one per case, in input order.
// Run by the harness as: node /bot/main.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const out = [];
for (const c of cases) {
  out.push(parse(c.markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
