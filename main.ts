// Entry point for the markdown-render-speed-02 harness.
//
// The grader runs `node /bot/main.ts` with the case set mounted at /input and
// a writable /output. Every case in /input/cases.json is an {id, markdown}
// pair; each one is rendered on its own by parse() from ./parse.js and the
// HTML strings are written to /output/html.json as one JSON array, in the
// same order as the cases. When run outside the sandbox, MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR may point at stand-in directories.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const out = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i]!.markdown);
}

// The sandbox mounts a writable /output; a stand-in directory used for a
// local run may not exist yet, so make sure it is there before writing.
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
