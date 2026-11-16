// parse.js — a fast Markdown-to-HTML renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off), byte for byte, but
// the implementation is a hand-written scanner rather than a stack of large
// composed regular expressions:
//
//   1. A block pass walks the source line by line, dispatching on the first
//      characters of each line to the block constructs (blank lines, indented
//      and fenced code, ATX and setext headings, thematic breaks, block
//      quotes, lists, HTML blocks, link reference definitions, tables and
//      paragraphs). Inline text is not rendered yet; every block that needs
//      it queues an inline job, so link reference definitions are all known
//      before any inline text is processed — the same two-phase shape the
//      reference uses, which forward references rely on.
//   2. The queued inline jobs then run in order against the shared link
//      table, and the block tree is rendered to HTML.
//
// Emphasis and strikethrough follow the reference's delimiter-run algorithm:
// the inline source is first masked (code spans, links and escaped
// punctuation are blanked to inert letters) and the last possible closer of
// each delimiter kind is precomputed, so failed openers cost almost nothing.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every HTML-special character (the reference's encode mode). */
function escAll(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const ESC_PLAIN_RE = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML-special characters, leaving entity-like &...; runs alone. */
function escPlain(s) {
  return s.replace(ESC_PLAIN_RE, (c) => ESCAPES[c]);
}

const NUMREF_RE = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMREF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Decode numeric character references in a text run; escape stray &. */
function decodeRefs(s) {
  if (!NUMREF_RE.test(s)) return s;
  return s.replace(NUMREF_OR_AMP_RE, (_m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '�';
    if (v === 38) return '&amp;';
    return String.fromCodePoint(v);
  });
}

/** The reference's URL cleaning: encodeURI with %25 folded back to %. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Remove trailing occurrences of a single character. */
function trimEndChar(a, ch) {
  let n = a.length;
  let s = 0;
  while (s < n && a.charAt(n - s - 1) === ch) s++;
  return a.slice(0, n - s);
}

/** Link-label lookup key: collapse whitespace, fold case (twice, as the reference does). */
function normLabel(a) {
  return a.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

const UNESCAPE_PUNCT_RE = /\\([\p{P}\p{S}])/gu;

/** Remove backslashes before punctuation (the reference's anyPunctuation rule). */
function unescapePunct(s) {
  return s.replace(UNESCAPE_PUNCT_RE, '$1');
}

/**
 * Scan for the bracket matching the one at the start of `a`'s depth count:
 * -1 when the string is balanced or bracket-free, -2 when an opener is left
 * unclosed, otherwise the index of the first closer with no opener.
 */
function findClosingBracket(a, open, close) {
  if (a.indexOf(open) === -1 && a.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') {
      n++;
      continue;
    }
    if (a[n] === open) depth++;
    else if (a[n] === close) {
      depth--;
      if (depth < 0) return n;
    }
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs to spaces, a tab advancing to the next multiple of 4 columns. */
function expandTabs(a, startCol) {
  let col = startCol;
  let out = '';
  for (const ch of a) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const BLANK_LINE_RE = /^[ \t]*$/;

/** Drop trailing blank lines of a raw block when there are more than two. */
function trimBlankTail(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE_RE.test(lines[t])) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}

/** Split a table row into cells on unescaped pipes (the reference's splitCells). */
function splitCells(row, maxCols) {
  const t = row.replace(/\|/g, (_m, off, str) => {
    let esc = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (maxCols !== undefined) {
    if (cells.length > maxCols) cells.splice(maxCols);
    else while (cells.length < maxCols) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/** Index of the end of the line starting at `pos` (the \n index, or length). */
function lineEnd(src, pos) {
  const i = src.indexOf('\n', pos);
  return i === -1 ? src.length : i;
}

/** Count leading spaces at `pos`, at most `max`. Returns [count, indexAfter]. */
function leadSpaces(src, pos, max) {
  let i = pos;
  let c = 0;
  while (c < max && src[i] === ' ') {
    i++;
    c++;
  }
  return [c, i];
}

// The block-level tag names that can open an HTML block (CommonMark's list).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block construct matchers. Each takes the source and a start index and
// either fails (null / -1) or describes the construct it found.
// ---------------------------------------------------------------------------

const HR_CORE = '(?:-[\\t ]*){3,}|(?:_[\\t ]*){3,}|(?:\\*[\\t ]*){3,}';
const HR_RE = new RegExp(`^ {0,3}(?:${HR_CORE})(?:\\n+|$)`);

/** Blank-line run: consecutive lines of only spaces/tabs. End index or -1. */
function matchSpace(src, pos) {
  const n = src.length;
  let p = pos;
  let end = -1;
  while (p < n) {
    let i = p;
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i < n && src[i] === '\n') {
      end = i + 1;
      p = i + 1;
      continue;
    }
    if (i >= n) end = i;
    break;
  }
  return end;
}

/** Indented code block: the end index of the whole match, or -1. */
function matchIndentedCode(src, pos) {
  const n = src.length;
  let p = pos;
  let end = -1;
  while (p < n) {
    // indent: exactly 4 spaces, or 0-3 spaces then a tab
    let indentEnd = -1;
    if (src.startsWith('    ', p)) {
      indentEnd = p + 4;
    } else {
      let s = 0;
      while (s < 3 && src[p + s] === ' ') s++;
      if (src[p + s] === '\t') indentEnd = p + s + 1;
    }
    if (indentEnd < 0) break;
    const le = lineEnd(src, indentEnd);
    if (le === indentEnd) break; // a content character is required
    p = le < n ? le + 1 : le;
    end = p;
    // following blank lines belong to the match
    while (p < n) {
      let i = p;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      if (i < n && src[i] === '\n') {
        p = i + 1;
        end = p;
        continue;
      }
      if (i >= n) {
        p = i;
        end = p;
      }
      break;
    }
  }
  return end;
}

const FENCES_RE =
  / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;

/** ATX heading: {depth, text, end} or null. `end` is the end of the text line. */
function matchHeading(src, pos) {
  const n = src.length;
  const [, i0] = leadSpaces(src, pos, 3);
  let i = i0;
  if (src[i] !== '#') return null;
  let depth = 0;
  while (src[i] === '#') {
    i++;
    depth++;
  }
  if (depth > 6) return null;
  if (i < n && src[i] !== '\n' && !/\s/.test(src[i])) return null;
  const le = lineEnd(src, i);
  let text = src.slice(i, le).trim();
  if (text.endsWith('#')) {
    const stripped = trimEndChar(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth, text, end: le };
}

/** Thematic break: the end of the line, or -1. */
function matchHr(src, pos) {
  const n = src.length;
  const [, i0] = leadSpaces(src, pos, 3);
  let i = i0;
  const c = src[i];
  if (c !== '-' && c !== '_' && c !== '*') return -1;
  let count = 0;
  while (i < n) {
    if (src[i] === c) {
      count++;
      i++;
    } else if (src[i] === ' ' || src[i] === '\t') {
      i++;
    } else break;
  }
  if (count < 3) return -1;
  if (i < n && src[i] !== '\n') return -1;
  return i;
}

const HTML_BLOCK_RE = new RegExp(
  ` {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *'[^'\\n]*'| *= *[^\\s"'=<>\\\`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))`,
  'iy',
);

const DEF_RE =
  / {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/y;

/** Does the line at [ls, le) look like a table delimiter row? */
const DELIM_ROW_RE = /^((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function isDelimLine(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  if (i >= le) return false;
  return DELIM_ROW_RE.test(src.slice(i, le));
}

/**
 * The header + delimiter pair of a table starting at `pos`:
 * {headerText, delimText, delimEnd} or null. Does not scan the body.
 */
function matchTableHead(src, pos) {
  const n = src.length;
  let i = pos;
  while (src[i] === ' ') i++;
  if (i >= n || src[i] === '\n') return null;
  const hEnd = lineEnd(src, pos);
  if (hEnd >= n) return null;
  const dStart = hEnd + 1;
  const dEnd = lineEnd(src, dStart);
  if (!isDelimLine(src, dStart, dEnd)) return null;
  const [, di] = leadSpaces(src, dStart, 3);
  return { headerText: src.slice(i, hEnd), delimText: src.slice(di, dEnd), delimEnd: dEnd };
}

const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;

/** Full table construct starting at `pos`: a table node (jobs queued), or null. */
function matchTable(ctx, src, pos) {
  const head = matchTableHead(src, pos);
  if (!head) return null;
  if (!/[:|]/.test(head.delimText)) return null;
  const headerCells = splitCells(head.headerText);
  const alignParts = head.delimText.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = alignParts.map((cell) =>
    TABLE_ALIGN_RIGHT.test(cell) ? 'right' : TABLE_ALIGN_CENTER.test(cell) ? 'center' : TABLE_ALIGN_LEFT.test(cell) ? 'left' : null,
  );
  const n = src.length;
  // body: lines until a blank line or another construct's first line
  let bodyRaw = '';
  let matchEnd = head.delimEnd;
  if (head.delimEnd < n) {
    let p = head.delimEnd + 1;
    const bodyStart = p;
    let bodyEnd = p;
    while (p < n) {
      const ls = p;
      const le = lineEnd(src, ls);
      if (isTableBodyBreak(src, ls, le)) break;
      bodyEnd = le;
      p = le < n ? le + 1 : le;
      if (le >= n) break;
    }
    bodyRaw = src.slice(bodyStart, p);
    matchEnd = p;
    // trailing blank \n run belongs to the match (trimmed from raw below)
    let q = matchEnd;
    while (q < n && src[q] === '\n') q++;
    matchEnd = q;
  }
  const raw = trimEndChar(src.slice(pos, matchEnd), '\n');
  const node = { type: 'table', raw, header: [], align, rows: [] };
  headerCells.forEach((text, i) => {
    node.header.push({ text, tokens: queueInline(ctx, text), header: true, align: align[i] });
  });
  if (bodyRaw.trim()) {
    const rowTexts = bodyRaw.replace(/\n[ \t]*$/, '').split('\n');
    for (const rowText of rowTexts) {
      const cells = splitCells(rowText, headerCells.length);
      node.rows.push(
        cells.map((text, i) => ({ text, tokens: queueInline(ctx, text), header: false, align: align[i] })),
      );
    }
  }
  return node;
}

/** Lines that end a table body (the reference's table continuation guard). */
function isTableBodyBreak(src, ls, le) {
  // the reference's guard is ` *\n`: only a space-only line ends the body
  // (a line holding a tab is a body row, not a blank)
  let allSpace = true;
  for (let i = ls; i < le; i++) {
    if (src[i] !== ' ') {
      allSpace = false;
      break;
    }
  }
  if (allSpace) return true;
  if (matchHr(src, ls) >= 0) return true;
  if (isHeadingStart(src, ls, le)) return true;
  if (isQuoteStart(src, ls)) return true;
  if (isIndentedStart(src, ls, le)) return true;
  if (isFenceStart(src, ls, le)) return true;
  if (isListStart(src, ls, le, true)) return true;
  if (isHtmlBegin(src, ls, le)) return true;
  return false;
}

/** ` {0,3}#{1,6}(\s|$)` at the line start. */
function isHeadingStart(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  if (src[i] !== '#') return false;
  let d = 0;
  let j = i;
  while (src[j] === '#') {
    j++;
    d++;
  }
  if (d > 6) return false;
  return j >= le || src[j] === ' ' || src[j] === '\t' || src[j] === '\n';
}

/** ` {0,3}>` at the line start. */
function isQuoteStart(src, ls) {
  const [, i] = leadSpaces(src, ls, 3);
  return src[i] === '>';
}

/** `(?: {4}| {0,3}\t)` plus a content character at the line start. */
function isIndentedStart(src, ls, le) {
  if (src.startsWith('    ', ls)) return le > ls + 4;
  let s = 0;
  while (s < 3 && src[ls + s] === ' ') s++;
  if (src[ls + s] === '\t') return le > ls + s + 1;
  return false;
}

/** ` {0,3}(?:`{3,}|~{3,})` fence start at the line start. */
function isFenceStart(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  const c = src[i];
  if (c !== '`' && c !== '~') return false;
  return src[i + 1] === c && src[i + 2] === c;
}

/**
 * List-item start at the line start. With `interrupt` the paragraph rules
 * apply (only `1.`/`1)` ordered items, and content must follow the spaces).
 */
function isListStart(src, ls, le, interrupt) {
  const [, i] = leadSpaces(src, ls, 3);
  let j = i;
  const c = src[j];
  if (c === '*' || c === '+' || c === '-') {
    j++;
  } else if (c >= '0' && c <= '9') {
    let digits = 0;
    while (j < le && src[j] >= '0' && src[j] <= '9' && digits < 9) {
      j++;
      digits++;
    }
    if (digits === 0) return false;
    if (src[j] !== '.' && src[j] !== ')') return false;
    if (interrupt && !(digits === 1 && src[i] === '1')) return false;
    j++;
  } else return false;
  if (interrupt) {
    // [ \t]+ then a non-space, non-tab character on the line
    let k = j;
    let spaces = 0;
    while (k < le && (src[k] === ' ' || src[k] === '\t')) {
      k++;
      spaces++;
    }
    return spaces > 0 && k < le;
  }
  return j >= le || src[j] === ' ' || src[j] === '\t';
}

const HTML_BEGIN_RE = new RegExp(
  ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  'y',
);

/** The HTML-block opening pattern at the line start (paragraph-style guard). */
function isHtmlBegin(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  if (src[i] !== '<') return false;
  HTML_BEGIN_RE.lastIndex = ls;
  return HTML_BEGIN_RE.test(src);
}

/** Lines that interrupt a paragraph (the reference's continuation guard). */
function isParaBreakLine(src, ls, le) {
  if (le === ls) return true; // blank line ends the paragraph
  let allSpace = true;
  for (let i = ls; i < le; i++) {
    if (src[i] !== ' ' && src[i] !== '\t') {
      allSpace = false;
      break;
    }
  }
  if (allSpace) return le < src.length; // a spaces-only line ends it only when a \n follows
  if (matchHr(src, ls) >= 0) return true;
  if (isHeadingStart(src, ls, le)) return true;
  if (isQuoteStart(src, ls)) return true;
  if (isFenceLine(src, ls, le)) return true;
  if (isListStart(src, ls, le, true)) return true;
  if (isHtmlBegin(src, ls, le)) return true;
  if (matchTableHead(src, ls) !== null) return true;
  return false;
}

/** A fence opening line: backtick fences need a backtick-free info string. */
function isFenceLine(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  const c = src[i];
  if (c !== '`' && c !== '~') return false;
  let run = 0;
  while (src[i + run] === c) run++;
  if (run < 3) return false;
  if (c === '~') return true;
  for (let j = i + run; j < le; j++) if (src[j] === '`') return false;
  return true;
}

// ---------------------------------------------------------------------------
// The block parser. Blocks that carry inline text queue a job instead of
// rendering immediately; jobs run after the whole document's blocks (and so
// all of its link definitions) are known.
// ---------------------------------------------------------------------------

/** Queue an inline job for `text`; returns the token array it will fill. */
function queueInline(ctx, text) {
  const job = { text, tokens: [] };
  ctx.jobs.push(job);
  return job.tokens;
}

/** Attach a fresh inline job to a block node. */
function nodeJob(ctx, node, text) {
  const job = { text, tokens: [] };
  ctx.jobs.push(job);
  node.job = job;
  node.tokens = job.tokens;
  return node;
}

/**
 * Parse blocks from `src` into `tokens`. `inQuote` is set while parsing a
 * block quote segment, where a paragraph may merge with the previous one.
 * Mirrors the reference's block loop, including its token merges.
 */
function blockParse(ctx, src, tokens, inQuote) {
  const n = src.length;
  let pos = 0;
  let lastRemaining = Infinity;
  while (pos < n) {
    const remaining = n - pos;
    if (remaining < lastRemaining) lastRemaining = remaining;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    const prev = tokens[tokens.length - 1];

    // blank lines
    const spaceEnd = matchSpace(src, pos);
    if (spaceEnd > pos) {
      const raw = src.slice(pos, spaceEnd);
      if (raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw });
      pos = spaceEnd;
      continue;
    }

    // indented code
    const codeEnd = matchIndentedCode(src, pos);
    if (codeEnd > pos) {
      const raw = trimBlankTail(src.slice(pos, codeEnd));
      const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
        prev.job.text = prev.text;
      } else {
        tokens.push({ type: 'code', raw, text, lang: undefined });
      }
      pos += raw.length;
      continue;
    }

    // fenced code
    const fenceCh = fenceLeadChar(src, pos);
    if (fenceCh) {
      FENCES_RE.lastIndex = pos;
      const m = FENCES_RE.exec(src);
      if (m) {
        const raw = m[0];
        const info = m[2];
        const lang = info ? info.trim().replace(UNESCAPE_PUNCT_RE, '$1') : info;
        tokens.push({ type: 'code', raw, text: fenceText(raw, m[3] || ''), lang });
        pos += raw.length;
        continue;
      }
    }

    // ATX heading
    const heading = matchHeading(src, pos);
    if (heading) {
      const raw = src.slice(pos, heading.end);
      tokens.push(nodeJob(ctx, { type: 'heading', raw, depth: heading.depth, text: heading.text }, heading.text));
      pos += raw.length;
      continue;
    }

    // thematic break
    const hrEnd = matchHr(src, pos);
    if (hrEnd > pos) {
      tokens.push({ type: 'hr', raw: src.slice(pos, hrEnd) });
      pos = hrEnd;
      continue;
    }

    // block quote
    if (isQuoteStart(src, pos)) {
      const node = tokenizeBlockquote(ctx, src, pos);
      if (node) {
        tokens.push(node);
        pos += node.raw.length;
        continue;
      }
    }

    // list
    if (isListLine(src, pos)) {
      const node = tokenizeList(ctx, src.slice(pos));
      if (node) {
        tokens.push(node);
        pos += node.raw.length;
        continue;
      }
    }

    // HTML block
    if (htmlLead(src, pos)) {
      HTML_BLOCK_RE.lastIndex = pos;
      const m = HTML_BLOCK_RE.exec(src);
      if (m) {
        const raw = trimBlankTail(m[0]);
        const tag = m[1];
        tokens.push({ type: 'html', raw, text: raw, pre: tag === 'pre' || tag === 'script' || tag === 'style' });
        pos += raw.length;
        continue;
      }
    }

    // link reference definition
    if (defLead(src, pos)) {
      DEF_RE.lastIndex = pos;
      const m = DEF_RE.exec(src);
      if (m) {
        const def = buildDef(m);
        if (def) {
          const raw = trimEndChar(m[0], '\n');
          if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            prev.text += '\n' + raw;
            prev.job.text = prev.text;
          } else {
            if (!Object.hasOwn(ctx.links, def.tag)) {
              ctx.links[def.tag] = { href: def.href, title: def.title };
              ctx.hasLinks = true;
            }
            tokens.push({ type: 'def', raw });
          }
          pos += raw.length;
          continue;
        }
      }
    }

    // table
    {
      const le = lineEnd(src, pos);
      if (le < n && isDelimLine(src, le + 1, lineEnd(src, le + 1))) {
        const node = matchTable(ctx, src, pos);
        if (node) {
          tokens.push(node);
          pos += node.raw.length;
          continue;
        }
      }
    }

    // setext heading
    const lheading = matchLheading(src, pos);
    if (lheading) {
      const raw = src.slice(pos, lheading.end);
      tokens.push(nodeJob(ctx, { type: 'heading', raw, depth: lheading.depth, text: lheading.text }, lheading.text));
      pos += raw.length;
      continue;
    }

    // paragraph (top level only)
    if (ctx.top) {
      const para = matchParagraph(src, pos);
      if (para) {
        const node = nodeJob(ctx, { type: 'paragraph', raw: para.raw, text: para.text }, para.text);
        if (inQuote && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
          prev.text += '\n' + node.text;
          ctx.jobs.pop();
          prev.job.text = prev.text;
        } else {
          tokens.push(node);
        }
        pos += node.raw.length;
        continue;
      }
    }

    // plain text line
    {
      const le = lineEnd(src, pos);
      if (le > pos) {
        const text = src.slice(pos, le);
        const node = nodeJob(ctx, { type: 'text', raw: text, text }, text);
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
          prev.text += '\n' + node.text;
          ctx.jobs.pop();
          prev.job.text = prev.text;
        } else {
          tokens.push(node);
        }
        pos += node.raw.length;
        continue;
      }
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ctx.top = true;
  return tokens;
}

/** The character opening a fence at `pos` (after ≤3 spaces), or ''. */
function fenceLeadChar(src, pos) {
  const [, i] = leadSpaces(src, pos, 3);
  const c = src[i];
  return c === '`' || c === '~' ? c : '';
}

/** Fenced code body with the opening fence's indentation removed. */
function fenceText(raw, text) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = /^\s+/.exec(line);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

/** Could a list start at `pos`? (First-line shape only.) */
function isListLine(src, pos) {
  const le = lineEnd(src, pos);
  return isListStart(src, pos, le, false);
}

/** Could an HTML block start at `pos`? */
function htmlLead(src, pos) {
  const [, i] = leadSpaces(src, pos, 3);
  return src[i] === '<';
}

/** Could a link reference definition start at `pos`? */
function defLead(src, pos) {
  const [, i] = leadSpaces(src, pos, 3);
  return src[i] === '[';
}

/** Validate and unpack a definition match; null when the href is unusable. */
function buildDef(m) {
  const hrefRaw = m[2];
  if (hrefRaw[0] !== '<' && findClosingBracket(hrefRaw, '(', ')') !== -1) return null;
  const href = hrefRaw ? unescapePunct(hrefRaw.replace(/^<(.*)>$/, '$1')) : '';
  const title = m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : m[3];
  return { tag: normLabel(m[1]), href, title };
}

/** Paragraph: consecutive lines until a line that starts another construct. */
function matchParagraph(src, pos) {
  const n = src.length;
  const firstEnd = lineEnd(src, pos);
  if (firstEnd === pos) return null;
  let end = firstEnd;
  let p = firstEnd < n ? firstEnd + 1 : firstEnd;
  while (p < n) {
    const le = lineEnd(src, p);
    if (isParaBreakLine(src, p, le)) break;
    end = le;
    p = le < n ? le + 1 : le;
    if (le >= n) break;
  }
  const raw = src.slice(pos, end);
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return { raw, text };
}

// ---------------------------------------------------------------------------
// Setext headings
// ---------------------------------------------------------------------------

const UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;

/** Lines the setext text may not start with / continue onto. */
function lheadingGuarded(src, ls, le, first) {
  const line = src.slice(ls, le);
  if (!first && BLANK_LINE_RE.test(line)) return true;
  // bullet followed by a space
  if (bulletSpaceStart(src, ls, le)) return true;
  if (first && isIndentedStartRaw(src, ls, le)) return true;
  if (isFenceStart(src, ls, le)) return true;
  if (isQuoteStart(src, ls)) return true;
  if (isHeadingStart(src, ls, le)) return true;
  if (!first && matchHr(src, ls) >= 0) return true;
  if (htmlLineGuard(src, ls, le)) return true;
  if (tableDelimGuard(src, ls, le)) return true;
  return false;
}

function bulletSpaceStart(src, ls, le) {
  const [, i] = leadSpaces(src, ls, 3);
  let j = i;
  const c = src[j];
  if (c === '*' || c === '+' || c === '-') {
    j++;
  } else if (c >= '0' && c <= '9') {
    let digits = 0;
    while (j < le && src[j] >= '0' && src[j] <= '9' && digits < 9) {
      j++;
      digits++;
    }
    if (digits === 0 || (src[j] !== '.' && src[j] !== ')')) return false;
    j++;
  } else return false;
  return src[j] === ' ';
}

/** `(?: {4}| {0,3}\t)` at the line start (no content requirement). */
function isIndentedStartRaw(src, ls, le) {
  if (src.startsWith('    ', ls)) return true;
  let s = 0;
  while (s < 3 && src[ls + s] === ' ') s++;
  return src[ls + s] === '\t';
}

/** ` {0,3}<[^\n>]+\>\n`: an angle-bracket line, requiring the newline. */
function htmlLineGuard(src, ls, le) {
  if (le >= src.length) return false; // the pattern needs the \n
  const [, i] = leadSpaces(src, ls, 3);
  if (src[i] !== '<') return false;
  const gt = src.indexOf('>', i);
  return gt !== -1 && gt < le;
}

/** ` {0,3}\|?(?:[:\- ]*\||)+[\:\- ]*\n`: a table-delimiter-looking line. */
function tableDelimGuard(src, ls, le) {
  if (le >= src.length) return false;
  const [, i] = leadSpaces(src, ls, 3);
  const line = src.slice(i, le);
  return /^\|?(?:[:\- ]*\||)+[\:\- ]*$/.test(line);
}

/** Setext heading at `pos`: {depth, text, end} or null. */
function matchLheading(src, pos) {
  const n = src.length;
  const firstLe = lineEnd(src, pos);
  if (firstLe >= n) return null; // need at least one more line
  let prevLe = firstLe;
  let p = firstLe + 1;
  while (p < n) {
    const le = lineEnd(src, p);
    const um = UNDERLINE_RE.exec(src.slice(p, le));
    if (um) {
      if (lheadingGuarded(src, pos, firstLe, true)) return null;
      const text = src.slice(pos, prevLe).trim();
      if (text) return { depth: um[1][0] === '=' ? 1 : 2, text, end: le };
      // empty text: this underline becomes a continuation line instead
    }
    // a guarded continuation line ends the search for every longer heading
    if (lheadingGuarded(src, p, le, false)) return null;
    prevLe = le;
    if (le >= n) break;
    p = le + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block quotes
// ---------------------------------------------------------------------------

const BQ_START_RE = /^ {0,3}>/;
const BQ_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_STRIP_RE = /^ {0,3}>[ \t]?/gm;

/** The raw extent of the block quote starting at `pos`, or -1. */
function matchBlockquoteRaw(src, pos) {
  const n = src.length;
  let p = pos;
  let matched = false;
  while (p < n) {
    const [, i0] = leadSpaces(src, p, 3);
    if (src[i0] !== '>') break;
    let i = i0 + 1;
    if (src[i] === ' ') i++;
    matched = true;
    // blank rest of line?
    let j = i;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j >= n || src[j] === '\n') {
      p = j < n ? j + 1 : j;
      continue;
    }
    // a lazy paragraph: first line, then continuation lines
    let le = lineEnd(src, i);
    p = le < n ? le + 1 : le;
    while (p < n) {
      const ls = p;
      const cle = lineEnd(src, ls);
      if (isQuoteParaBreakLine(src, ls, cle)) break;
      p = cle < n ? cle + 1 : cle;
      if (cle >= n) break;
    }
  }
  return matched ? p : -1;
}

/** Lines that end a lazy paragraph inside a block quote. */
function isQuoteParaBreakLine(src, ls, le) {
  if (le === ls) return true;
  let allSpace = true;
  for (let i = ls; i < le; i++) {
    if (src[i] !== ' ' && src[i] !== '\t') {
      allSpace = false;
      break;
    }
  }
  if (allSpace) return true;
  if (matchHr(src, ls) >= 0) return true;
  if (isHeadingStart(src, ls, le)) return true;
  if (isQuoteStart(src, ls)) return true;
  if (isFenceLine(src, ls, le)) return true;
  if (isListStart(src, ls, le, false)) return true;
  if (isHtmlBegin(src, ls, le)) return true;
  return false;
}

/**
 * Tokenize the block quote starting at `pos` in `src`. Returns the node;
 * its raw says how much of `src` it consumed.
 */
function tokenizeBlockquote(ctx, src, pos) {
  const end = matchBlockquoteRaw(src, pos);
  if (end < 0) return null;
  const rawText = trimEndChar(src.slice(pos, end), '\n');
  let lines = rawText.split('\n');
  let rawOut = '';
  let textOut = '';
  const tokens = [];
  while (lines.length > 0) {
    let seen = false;
    const seg = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BQ_START_RE.test(lines[p])) {
        seg.push(lines[p]);
        seen = true;
      } else if (!seen) seg.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const segRaw = seg.join('\n');
    const inner = segRaw
      .replace(BQ_MARKER_WS_RE, (_m, b, ws) => b + expandTabs(ws, b.length))
      .replace(BQ_SETEXT_RE, '\n    $1')
      .replace(BQ_STRIP_RE, '');
    rawOut = rawOut ? rawOut + '\n' + segRaw : segRaw;
    textOut = textOut ? textOut + '\n' + inner : inner;
    const savedTop = ctx.top;
    ctx.top = true;
    blockParse(ctx, inner, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const b = lines.join('\n');
      const merged = last.raw + '\n' + b.replace(BQ_STRIP_RE, '');
      const f = tokenizeBlockquote(ctx, merged, 0);
      if (!f) break;
      tokens[tokens.length - 1] = f;
      const y = merged.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) rawOut = rawOut + '\n' + A.join('\n');
      textOut = textOut.substring(0, textOut.length - last.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && BQ_START_RE.test(lines[0])) continue;
      break;
    }
    if (last.type === 'list') {
      const b = last.raw + '\n' + lines.join('\n');
      const m2 = tokenizeList(ctx, b);
      if (!m2) break;
      tokens[tokens.length - 1] = m2;
      const f = m2.raw.length > last.raw.length ? b.slice(last.raw.length + 1, m2.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        rawOut += '\n' + y;
        textOut += '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawOut, text: textOut, tokens };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const LIST_FIRST_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;

const LIST_ITEM_RES = new Map();

/** Index of the first non-space character, or -1 (String.search(/[^ ]/)). */
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}

/** firstNonSpace of `s` with each tab counted as four columns. */
function firstNonSpaceExpanded(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') col += 4;
    else if (c === ' ') col += 1;
    else return col;
  }
  return -1;
}

/** Expand tabs in the leading whitespace run of a line (column 0 based). */
function expandLeadingTabs(line) {
  return expandLeadingTabsAt(line, 0);
}

/** Expand tabs in the leading whitespace run, tabs advancing from `col`. */
function expandLeadingTabsAt(line, col) {
  let li = 0;
  while (li < line.length && (line[li] === ' ' || line[li] === '\t')) li++;
  if (li === 0) return line;
  const lead = line.slice(0, li);
  if (!lead.includes('\t')) return line;
  return expandTabs(lead, col) + line.slice(li);
}

/**
 * Do any of the list-continuation guard patterns match line `f`? Dispatched
 * on the first significant character; each pattern's is fixed. `full` selects
 * the main-loop set (with bullets and quotes) versus the lazy-line set.
 */
function listBeginBreak(f, begins, sp, full) {
  let sc = 0;
  while (f[sc] === ' ') sc++;
  if (sc > sp) return false;
  const fc = f[sc];
  if (fc === '`' || fc === '~') return begins.fences.test(f);
  if (fc === '#') return begins.heading.test(f);
  if (fc === '<') return begins.html.test(f);
  if (fc === '>') return full ? begins.quote.test(f) : false;
  if (fc === '*' || fc === '-' || fc === '_') return (full && begins.nextBullet.test(f)) || begins.hr.test(f);
  if (fc === '+') return full ? begins.nextBullet.test(f) : false;
  if (fc >= '0' && fc <= '9') return full ? begins.nextBullet.test(f) : false;
  return false;
}

/** The continuation guard patterns depend only on the indent allowance. */
const LIST_BEGINS = [0, 1, 2, 3].map((sp) => ({
  nextBullet: new RegExp(`^ {0,${sp}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
  hr: new RegExp(`^ {0,${sp}}(?:${HR_CORE})(?:\\n+|$)`),
  fences: new RegExp(`^ {0,${sp}}(?:\`\`\`|~~~)`),
  heading: new RegExp(`^ {0,${sp}}#{1,6}(?:\\s|$)`),
  html: new RegExp(
    `^ {0,${sp}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
    'i',
  ),
  quote: new RegExp(`^ {0,${sp}}>`),
}));
const LIST_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const LIST_TASK_STRIP_RE = /^\[[ xX]\][ \t]+/;
const LIST_CHECKBOX_RE = /\[[ xX]\]/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;

/**
 * Tokenize the list at the start of `str` (the remaining source). Returns
 * the list node, or null when the opening line does not begin a list.
 * Follows the reference's item-extraction walk line by line.
 */
function tokenizeList(ctx, str) {
  const first = LIST_FIRST_RE.exec(str);
  if (!first) return null;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  let itemRe = LIST_ITEM_RES.get(bulletPat);
  if (!itemRe) {
    itemRe = new RegExp(`^( {0,3}${bulletPat})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
    LIST_ITEM_RES.set(bulletPat, itemRe);
  }
  let e = str;
  let pendingLoose = false;
  const consumed = () => str.length - e.length;

  while (e) {
    let swallowedBlank = false;
    let itemText = '';
    const m = itemRe.exec(e);
    if (!m || HR_RE.test(e)) break;
    const itemStart = consumed();
    e = e.substring(m[0].length);
    const g0 = m[2].split('\n', 1)[0];
    const b = m[1].length;
    const g = expandLeadingTabsAt(g0, b);
    const fnl = e.indexOf('\n');
    let f = fnl === -1 ? e : e.slice(0, fnl);
    let isBlank = !g.trim();
    let R = 0;
    if (isBlank) {
      R = b + 1;
    } else {
      R = g.search(/[^ ]/);
      if (R > 4) R = 1;
      itemText = g.slice(R);
      R += b;
    }
    if (isBlank && BLANK_LINE_RE.test(f)) {
      e = e.substring(f.length + 1);
      swallowedBlank = true;
    }
    if (!swallowedBlank) {
      const sp = Math.max(0, Math.min(3, R - 1));
      const begins = LIST_BEGINS[sp];
      let cur = g;
      while (e) {
        const nl = e.indexOf('\n');
        const U = nl === -1 ? e : e.slice(0, nl);
        f = U;
        const Z = expandLeadingTabs(f);
        if (listBeginBreak(f, begins, sp, true)) break;
        if (firstNonSpace(Z) >= R || !f.trim()) {
          itemText += '\n' + Z.slice(R);
        } else {
          if (
            isBlank ||
            firstNonSpaceExpanded(cur) >= 4 ||
            listBeginBreak(cur, begins, sp, false)
          )
            break;
          const q =
            /^ {0,3}(?:=+|-+) *$/.test(f) && matchLheading(cur + '\n' + f, 0) !== null
              ? '    ' + Z.replace(/^ {0,3}/, '')
              : f;
          itemText += '\n' + q;
        }
        isBlank = !f.trim();
        e = e.substring(U.length + 1);
        cur = Z.slice(R);
      }
    }
    const itemRaw = str.slice(itemStart, consumed());
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (DOUBLE_BLANK_RE.test(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: LIST_TASK_RE.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = str.slice(0, consumed()).trimEnd();

  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockParse(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((sp) => /\n.*\n/.test(sp.raw));
    }
  }

  // task-list fixup: strip the checkbox marker from the item's first text
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(LIST_TASK_STRIP_RE, '');
      firstTok.raw = firstTok.raw.replace(LIST_TASK_STRIP_RE, '');
      firstTok.text = firstTok.text.replace(LIST_TASK_STRIP_RE, '');
      for (let gi = ctx.jobs.length - 1; gi >= 0; gi--) {
        if (LIST_TASK_RE.test(ctx.jobs[gi].text)) {
          ctx.jobs[gi].text = ctx.jobs[gi].text.replace(LIST_TASK_STRIP_RE, '');
          break;
        }
      }
      const cbm = LIST_CHECKBOX_RE.exec(item.raw);
      if (cbm) {
        const cb = { type: 'checkbox', raw: cbm[0] + ' ', checked: cbm[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (firstTok.job) {
            firstTok.raw = cb.raw + firstTok.raw;
            firstTok.text = cb.raw + firstTok.text;
            firstTok.job.tokens.unshift(cb);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, tokens: [cb], job: null });
          }
        } else {
          item.tokens.unshift(cb);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Inline parsing. One pass over the source; at each position the constructs
// are attempted in the reference's order (escape, tag, link, reference link,
// emphasis, code span, hard break, strikethrough, autolink, GFM url, text).
// ---------------------------------------------------------------------------

const TAG_SRC =
  `<!--(?:-?>|[\\s\\S]*?-->)|</[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s"'=<>\\\`]+)?)*?\\s*/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`;
const TAG_RE = new RegExp(TAG_SRC, 'y');
const TAG_TEST_RE = new RegExp('^(?:' + TAG_SRC + ')');

const LINK_LABEL_SRC =
  '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LINK_RE = new RegExp(
  `!?\\[(${LINK_LABEL_SRC})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`,
  'y',
);
const LINK_TEST_RE = new RegExp(
  `^!?\\[(${LINK_LABEL_SRC})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`,
);
const REFLINK_RE = new RegExp(
  `!?\\[(${LINK_LABEL_SRC})\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]`,
  'y',
);
const NOLINK_RE = new RegExp(
  `!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?`,
  'y',
);

const AUTOLINK_SRC =
  `<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_\`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>`;
const AUTOLINK_RE = new RegExp(AUTOLINK_SRC, 'y');
const AUTOLINK_TEST_RE = new RegExp('^(?:' + AUTOLINK_SRC + ')');

const URL_RE = new RegExp(
  `(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])`,
  'y',
);
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const INLINE_CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;

const EM_LDELIM_RE =
  /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/yu;
const EM_RDELIM_AST_RE =
  /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND_RE =
  /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_LDELIM_RE = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/yu;
const DEL_RDELIM_RE =
  /[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

const PUNCT_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP_RE =
  /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_SEARCH_RE =
  /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

/** Tokenize `src` inline, appending to `out`. Wraps the paren-lookahead state. */
function inlineTokenize(ctx, src, out) {
  const saved = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = saved && src.includes(')');
  try {
    return inlineRun(ctx, src, out);
  } finally {
    ctx.state.linkParenPossible = saved;
  }
}

function inlineRun(ctx, src, out) {
  const state = ctx.state;
  let masked = src;
  let closers = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = computeMask(ctx, src);
    closers = lastCloserIndexes(masked);
  }
  const n = src.length;
  let pos = 0;
  let prevChar = '';
  let lastWasText = false;
  let lastRemaining = Infinity;
  while (pos < n) {
    const remaining = n - pos;
    if (remaining < lastRemaining) lastRemaining = remaining;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    if (!lastWasText) prevChar = '';
    lastWasText = false;
    const ch = src[pos];
    let tok = null;

    if (ch === '\\') tok = matchEscape(src, pos);
    if (!tok && ch === '<') tok = matchTag(ctx, src, pos);
    if (!tok && (ch === '[' || (ch === '!' && src[pos + 1] === '['))) {
      tok = matchLink(ctx, src, pos);
      if (!tok) {
        tok = matchReflink(ctx, src, pos);
        if (tok && tok.mergeText) {
          const prev = out[out.length - 1];
          if (prev && prev.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else out.push(tok);
          pos += tok.raw.length;
          continue;
        }
      }
    }
    if (!tok && (ch === '*' || ch === '_')) tok = matchEmStrong(ctx, src, pos, masked, closers, prevChar);
    if (!tok && ch === '`') tok = matchCodespan(src, pos);
    if (!tok && (ch === ' ' || ch === '\\')) tok = matchBr(src, pos);
    if (!tok && ch === '~') tok = matchDel(ctx, src, pos, masked, closers, prevChar);
    if (!tok && ch === '<') tok = matchAutolink(src, pos);
    if (!tok && !state.inLink) tok = matchUrl(src, pos);
    if (tok) {
      out.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // plain text up to the next construct
    const end = textEnd(src, pos);
    const rawText = src.slice(pos, end);
    // decodeRefs is the identity unless a numeric reference occurs
    const text = state.inRawBlock || !rawText.includes('&#') ? rawText : decodeRefs(rawText);
    if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
    lastWasText = true;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') {
      prev.raw += rawText;
      prev.text += text;
    } else {
      out.push({ type: 'text', raw: rawText, text, escaped: state.inRawBlock });
    }
    pos = end;
  }
  return out;
}

const ESCAPE_CHARS = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

function matchEscape(src, pos) {
  const c = src[pos + 1];
  if (c !== undefined && ESCAPE_CHARS.has(c)) return { type: 'escape', raw: src.slice(pos, pos + 2), text: c };
  return null;
}

const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;
const START_PRE_TAG_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

function matchTag(ctx, src, pos) {
  TAG_RE.lastIndex = pos;
  const m = TAG_RE.exec(src);
  if (!m) return null;
  const state = ctx.state;
  const raw = m[0];
  if (!state.inLink && START_A_TAG_RE.test(raw)) state.inLink = true;
  else if (state.inLink && END_A_TAG_RE.test(raw)) state.inLink = false;
  if (!state.inRawBlock && START_PRE_TAG_RE.test(raw)) state.inRawBlock = true;
  else if (state.inRawBlock && END_PRE_TAG_RE.test(raw)) state.inRawBlock = false;
  return { type: 'html', raw, text: raw };
}

function matchCodespan(src, pos) {
  let run = 0;
  while (src[pos + run] === '`') run++;
  const n = src.length;
  let j = pos + run;
  while (j < n) {
    const idx = src.indexOf('`', j);
    if (idx === -1) return null;
    let r = 0;
    while (src[idx + r] === '`') r++;
    if (r === run && idx > pos + run) {
      const content = src.slice(pos + run, idx);
      let text = content.replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) text = text.slice(1, -1);
      return { type: 'codespan', raw: src.slice(pos, idx + run), text };
    }
    j = idx + r;
  }
  return null;
}

function matchBr(src, pos) {
  const n = src.length;
  let i = pos;
  if (src[pos] === ' ') {
    let k = 0;
    while (src[pos + k] === ' ') k++;
    if (k < 2 || src[pos + k] !== '\n') return null;
    i = pos + k;
  } else if (src[pos] === '\\' && src[pos + 1] === '\n') {
    i = pos + 1;
  } else return null;
  // after the newline, the rest must not be all whitespace
  let j = i + 1;
  let onlyWs = true;
  for (let q = j; q < n; q++) {
    if (!/\s/.test(src[q])) {
      onlyWs = false;
      break;
    }
  }
  if (onlyWs) return null;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  return { type: 'br', raw: src.slice(pos, j) };
}

function matchAutolink(src, pos) {
  AUTOLINK_RE.lastIndex = pos;
  const m = AUTOLINK_RE.exec(src);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, title: null, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function matchUrl(src, pos) {
  const code = src.charCodeAt(pos);
  if (!(isAlnumCode(code) || code === 43 || code === 46 || code === 95 || code === 45)) return null;
  // Cheap pre-gate: a URL here must open with mailto:/xmpp:, a protocol or
  // www. prefix, or an email-class run closed by '@'.
  const ch = src[pos];
  if (ch === 'm' || ch === 'x') {
    if (!src.startsWith('mailto:', pos) && !src.startsWith('xmpp:', pos) && emailRunEnd(src, pos) === -1) return null;
  } else if (ch === 'h' || ch === 'H') {
    if (!httpPrefixAt(src, pos) && emailRunEnd(src, pos) === -1) return null;
  } else if (ch === 'f' || ch === 'F') {
    if (!ftpPrefixAt(src, pos) && emailRunEnd(src, pos) === -1) return null;
  } else if (ch === 'w' || ch === 'W') {
    if (!src.startsWith('www.', pos) && emailRunEnd(src, pos) === -1) return null;
  } else if (emailRunEnd(src, pos) === -1) {
    return null;
  }
  URL_RE.lastIndex = pos;
  const m = URL_RE.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let t0 = m[0];
    let prev;
    do {
      prev = t0;
      t0 = BACKPEDAL_RE.exec(t0)?.[0] ?? '';
    } while (prev !== t0);
    if (!t0) return null;
    text = t0;
    href = m[1] === 'www.' ? 'http://' + t0 : t0;
  }
  return { type: 'link', raw: text, text, href, title: null, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

/** Build a link/image token, or null when the label itself holds a link. */
function buildLink(ctx, match, def, raw) {
  const href = def.href;
  const title = def.title || null;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const state = ctx.state;
  const prevInLink = state.inLink;
  const prevEmitted = state.linkEmitted;
  const prevRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const tokens = inlineTokenize(ctx, text, []);
  const emitted = state.linkEmitted;
  state.linkEmitted = prevEmitted;
  state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      state.inRawBlock = prevRawBlock;
      return null;
    }
    state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function matchLink(ctx, src, pos) {
  if (ctx.state.linkParenPossible === false) return null;
  LINK_RE.lastIndex = pos;
  const m = LINK_RE.exec(src);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  if (containsTagBeyond(src, m[1], pos + (isImage ? 2 : 1))) return null;
  const s = m[2].trim();
  if (s.startsWith('<')) {
    if (!s.endsWith('>')) return null;
    const inner = trimEndChar(s.slice(0, -1), '\\');
    if ((s.length - inner.length) % 2 === 0) return null;
  } else {
    const l = findClosingBracket(m[2], '(', ')');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const tail = trimEndChar(m[0].slice(0, -1), '\\');
  if ((m[0].length - tail.length) % 2 === 0) return null;
  let dest = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (dest.startsWith('<')) dest = dest.slice(1, -1);
  return buildLink(ctx, m, { href: dest ? unescapePunct(dest) : dest, title: title ? unescapePunct(title) : title }, m[0]);
}

function matchReflink(ctx, src, pos) {
  REFLINK_RE.lastIndex = pos;
  let m = REFLINK_RE.exec(src);
  if (!m) {
    NOLINK_RE.lastIndex = pos;
    m = NOLINK_RE.exec(src);
  }
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  if (containsTagBeyond(src, m[1], pos + (isImage ? 2 : 1))) return null;
  const def = ctx.links[normLabel(m[2] || m[1])];
  if (!def) {
    const c = m[0].charAt(0);
    return { type: 'text', raw: c, text: c, mergeText: true };
  }
  return buildLink(ctx, m, def, m[0]);
}

/**
 * The reference's link-label sanity check: a label holding an HTML tag or
 * autolink that reaches past the label's end rejects the link.
 */
function containsTagBeyond(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const cm = INLINE_CODE_RE.exec(label.slice(s));
      if (cm) {
        s += cm[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = TAG_TEST_RE.exec(r) || AUTOLINK_TEST_RE.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Emphasis masking: the reference rewrites parts of the source before
// matching emphasis so code spans, escapes and resolved references cannot
// fake delimiters. The masked text has the same length as the source.
// ---------------------------------------------------------------------------

/**
 * Does `text` contain a working link? Used while masking: a reference whose
 * label itself holds a link keeps its label visible to the emphasis pass.
 */
function linkInText(ctx, text) {
  BLOCK_SKIP_RE.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_TEST_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))
    )
      return true;
  }
  return false;
}

/** Mask one reference-style construct found by the search pattern. */
function maskReflink(ctx, r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const label = r.slice(1, o - 1);
    if (linkInText(ctx, label)) {
      return '[' + label.replace(REFLINK_SEARCH_RE, (m) => maskReflink(ctx, m)) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

/**
 * The masked twin of an inline source: resolved references, inline links,
 * code spans and HTML tags are blanked to inert letters, escaped punctuation
 * becomes '+', so delimiter runs in the mask are the only ones emphasis may
 * use. Same length as the source.
 */
function computeMask(ctx, src) {
  let t = src;
  // each pass is skipped when none of its trigger characters can occur
  if (src.includes('[') && src.includes(']') && ctx.hasLinks) {
    t = t.replace(REFLINK_SEARCH_RE, (r) => maskReflink(ctx, r));
  }
  if (src.includes('\\') || src.includes('`')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (match, g1, g2) => {
      if (g2 !== undefined) return '+'.repeat(match.length);
      if (g1 !== undefined) return g1 + match.slice(g1.length, match.length - g1.length).replace(/`/g, '+') + g1;
      return match;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (match) => '[' + 'a'.repeat(match.length - 2) + ']');
  }
  return t;
}

/**
 * The last index of each delimiter kind that could close an emphasis span:
 * the start of the last run whose preceding character is not blank. Runs
 * starting after whitespace can never be closers in the reference's model.
 */
function lastCloserIndexes(masked) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') last[r] = s;
    s = i - 1;
  }
  return last;
}

/**
 * Emphasis/strong matching at `pos`, following the reference's delimiter
 * algorithm: the opener run is characterized by what follows it, the walk
 * back over identical delimiters in the mask fixes the effective preceding
 * character, and candidate closers are scanned with the rule of three.
 * `closers` holds the last possible closer index per delimiter (or null).
 */
function matchEmStrong(ctx, src, pos, masked, closers, prevChar) {
  EM_LDELIM_RE.lastIndex = pos;
  const cap = EM_LDELIM_RE.exec(src);
  if (!cap || cap.index !== pos) return null;
  if (!cap[1] && !cap[2] && !cap[3] && !cap[4]) return null;
  const delim = cap[0][0];
  const sameChar = prevChar === delim;
  // walk back over identical delimiters in the mask
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  let before = '';
  if (runStart > 0) {
    const seg = masked.slice(Math.max(0, runStart - 2), runStart);
    before = [...seg].at(-1) ?? '';
  }
  const beforeIsPunct = before === '*' || before === '_' || PUNCT_RE.test(before);
  let prev = prevChar;
  if (runStart < pos) prev = before;
  const prevIsPunct = runStart < pos ? beforeIsPunct : PUNCT_RE.test(prev);
  if (cap[4] && ALNUM_RE.test(prev)) return null;
  const punctAfter = cap[1] || cap[3] || '';
  if (punctAfter && prev && !prevIsPunct) return null;
  const k = [...cap[0]].length - 1; // opener count
  let m = k; // unmatched opener balance
  let f = 0; // delimiters skipped by the rule of three
  const y = pos - runStart + k; // delimiters in the whole run through the opener
  const canCloseExtra = before.trim() !== '' && (!!punctAfter || (delim === '*' && !beforeIsPunct));
  if (delim !== '*' && delim !== '_') return null;
  const re = delim === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
  const lastCloser = closers ? closers[delim] : -1;
  const afterOpener = pos + k;
  if (lastCloser < afterOpener) return null;
  const suffix = masked.slice(afterOpener);
  const lastRel = lastCloser - afterOpener;
  re.lastIndex = 0;
  let match = null;
  while ((match = re.exec(suffix)) !== null && !(match.index > lastRel)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    let b = [...g].length;
    if (match[3] || match[4]) {
      m += b; // a nested opener: it consumes would-be closers
      continue;
    }
    if (match[5] || match[6] || canCloseExtra) {
      if (sameChar && (match[5] || match[6])) break;
      if (y % 3 && !((y + b) % 3)) {
        f += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) continue;
    b = Math.min(b, b + m + f);
    const leadLen = [...match[0]][0].length;
    const raw = src.slice(pos, pos + k + match.index + leadLen + b);
    if (Math.min(k, b) % 2) {
      const text = raw.slice(1, -1);
      return { type: 'em', raw, text, tokens: inlineTokenize(ctx, text, []) };
    }
    const text = raw.slice(2, -2);
    return { type: 'strong', raw, text, tokens: inlineTokenize(ctx, text, []) };
  }
  return null;
}

function matchDel(ctx, src, pos, masked, closers, prevChar) {
  DEL_LDELIM_RE.lastIndex = pos;
  const cap = DEL_LDELIM_RE.exec(src);
  if (!cap || cap.index !== pos) return null;
  if ((cap[1] || '') !== '' && prevChar && !PUNCT_RE.test(prevChar)) return null;
  const o = [...cap[0]].length - 1; // opener count (1 or 2)
  let p = o; // unmatched opener balance
  const lastCloser = closers ? closers['~'] : -1;
  const afterOpener = pos + o;
  if (lastCloser < afterOpener) return null;
  const suffix = masked.slice(afterOpener);
  const lastRel = lastCloser - afterOpener;
  DEL_RDELIM_RE.lastIndex = 0;
  let match = null;
  while ((match = DEL_RDELIM_RE.exec(suffix)) !== null && !(match.index > lastRel)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (match[3] || match[4]) {
      p += l; // a nested opener
      continue;
    }
    p -= l;
    if (p > 0) continue;
    const used = Math.min(l, l + p);
    const leadLen = [...match[0]][0].length;
    const raw = src.slice(pos, pos + o + match.index + leadLen + used);
    const text = raw.slice(o, raw.length - o);
    return { type: 'del', raw, text, tokens: inlineTokenize(ctx, text, []) };
  }
  return null;
}


// ---------------------------------------------------------------------------
// Plain-text scanning: how far a run of ordinary text extends before the
// next inline construct can start (mirrors the reference's GFM text rule).
// ---------------------------------------------------------------------------

const EMAIL_START_CLASS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-");
const EMAIL_CLASS_TABLE = new Uint8Array(128);
for (const ch of EMAIL_START_CLASS) EMAIL_CLASS_TABLE[ch.charCodeAt(0)] = 1;

/** Is `code` (a char code) in the email-run character class? */
function isEmailClass(code) {
  return code < 128 && EMAIL_CLASS_TABLE[code] === 1;
}

/** Is `code` an ASCII letter or digit? */
function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** End of the email-like run starting at `i`, when directly followed by '@'. */
function emailRunEnd(src, i) {
  let j = i;
  while (j < src.length && isEmailClass(src.charCodeAt(j))) j++;
  return j > i && src[j] === '@' ? j : -1;
}

/** ` {2,}\n` at `i`: two or more spaces then a newline. */
function twoSpaceNewline(src, i) {
  let j = i;
  while (src[j] === ' ') j++;
  return j - i >= 2 && src[j] === '\n';
}

/** The `http`/`https` prefix (letter classes only) at `i`. */
function httpPrefixAt(src, i) {
  const a = src[i + 1];
  const b = src[i + 2];
  const c = src[i + 3];
  return (a === 't' || a === 'T') && (b === 't' || b === 'T') && (c === 'p' || c === 'P');
}

/** The `ftp://` prefix at `i`. */
function ftpPrefixAt(src, i) {
  const a = src[i + 1];
  const b = src[i + 2];
  return (a === 't' || a === 'T') && (b === 'p' || b === 'P') && src[i + 3] === ':' && src[i + 4] === '/' && src[i + 5] === '/';
}

// Per-character scan flags for the text scanner:
//   1 hard stop, 2 http trigger, 4 ftp trigger, 8 www trigger, 16 email class
const TEXT_FLAGS = new Uint8Array(128);
for (const code of [92, 60, 33, 91, 96, 42, 126, 95]) TEXT_FLAGS[code] |= 1; // \ < ! [ ` * ~ _
for (const ch of 'hH') TEXT_FLAGS[ch.charCodeAt(0)] |= 2;
for (const ch of 'fF') TEXT_FLAGS[ch.charCodeAt(0)] |= 4;
for (const ch of 'wW') TEXT_FLAGS[ch.charCodeAt(0)] |= 8;
for (let code = 0; code < 128; code++) if (EMAIL_CLASS_TABLE[code]) TEXT_FLAGS[code] |= 16;

function textEnd(src, pos) {
  const n = src.length;
  const c0 = src[pos];
  // a lone non-alphanumeric char directly before mailto:/xmpp: is a whole token
  if (!isAlnumCode(src.charCodeAt(pos)) && (src.startsWith('mailto:', pos + 1) || src.startsWith('xmpp:', pos + 1))) {
    return pos + 1;
  }
  let i;
  if (c0 === '`') {
    i = pos;
    while (i < n && src[i] === '`') i++;
  } else if (c0 === '~') {
    i = pos;
    while (i < n && src[i] === '~') i++;
  } else {
    i = pos + 1;
  }
  // The current email-class run's end and whether '@' follows it; a run
  // starting anywhere inside it ends at the same place.
  let runEnd = -1;
  let runAt = false;
  // stops immediately after the first unit
  if (i >= n) return i;
  {
    const c = src[i];
    if (c === '`' || c === '~') return i;
    if (c === ' ' && twoSpaceNewline(src, i)) return i;
    if (isEmailClass(src.charCodeAt(i))) {
      runEnd = i;
      while (runEnd < n && isEmailClass(src.charCodeAt(runEnd))) runEnd++;
      runAt = src[runEnd] === '@';
      if (runAt) return i;
    }
  }
  let end = i;
  while (end < n) {
    const code = src.charCodeAt(end);
    const flags = code < 128 ? TEXT_FLAGS[code] : 0;
    // lookahead stops: the token ends before this char
    if (flags & 1) break;
    if (flags & 2) {
      if (httpPrefixAt(src, end)) break;
    } else if (flags & 4) {
      if (ftpPrefixAt(src, end)) break;
    } else if (flags & 8) {
      if (src.startsWith('www.', end) && /[\s*_~(]/.test(src[end - 1])) break;
    }
    if (flags & 16) {
      // email-class char: a stop when its run is followed by '@'
      if (end < runEnd) {
        if (runAt) break;
      } else {
        runEnd = end;
        while (runEnd < n && isEmailClass(src.charCodeAt(runEnd))) runEnd++;
        runAt = src[runEnd] === '@';
        if (runAt) break;
      }
    }
    // char-consuming stops: this char joins the token, then it ends
    if (code !== 32 && src[end + 1] === ' ' && twoSpaceNewline(src, end + 1)) {
      end++;
      break;
    }
    if (!isAlnumCode(code) && (src[end + 1] === 'm' || src[end + 1] === 'x') && (src.startsWith('mailto:', end + 1) || src.startsWith('xmpp:', end + 1))) {
      end++;
      break;
    }
    if (!(flags & 16)) {
      // a non-email-class char followed by an email run + '@'
      const p = end + 1;
      if (p < runEnd) {
        if (runAt) {
          end++;
          break;
        }
      } else if (p < n && isEmailClass(src.charCodeAt(p))) {
        runEnd = p;
        while (runEnd < n && isEmailClass(src.charCodeAt(runEnd))) runEnd++;
        runAt = src[runEnd] === '@';
        if (runAt) {
          end++;
          break;
        }
      }
    }
    end++;
  }
  return end;
}

// ---------------------------------------------------------------------------
// Rendering: the block tree and inline token trees become HTML strings.
// ---------------------------------------------------------------------------

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok);
  return out;
}

function renderBlock(tok) {
  switch (tok.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
    case 'code': {
      const lang = tok.lang ? /^\S*/.exec(tok.lang)[0] : '';
      const cls = lang ? ` class="language-${escPlain(lang)}"` : '';
      const text = tok.text === '' ? '' : tok.text.endsWith('\n') ? tok.text : tok.text + '\n';
      return `<pre><code${cls}>${escAll(text)}</code></pre>\n`;
    }
    case 'html':
      return tok.text;
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 && tok.start !== '' ? ` start="${tok.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const item of tok.items) out += renderBlock(item);
      return out + `</${tag}>\n`;
    }
    case 'list_item':
      return `<li>${renderBlocks(tok.tokens)}</li>\n`;
    case 'checkbox':
      return tok.checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
    case 'paragraph':
      return `<p>${renderInline(tok.tokens)}</p>\n`;
    case 'text':
      return renderInline(tok.tokens);
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < tok.header.length; c++) out += renderCell(tok.header[c], tok.align[c], true);
      out += '</tr>\n</thead>\n';
      if (tok.rows.length > 0) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) out += renderCell(row[c], tok.align[c], false);
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderCell(cell, align, header) {
  const tag = header ? 'th' : 'td';
  const attr = align ? ` align="${align}"` : '';
  return `<${tag}${attr}>${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) out += renderInlineTok(tok);
  return out;
}

function renderInlineTok(tok) {
  switch (tok.type) {
    case 'text':
      return tok.escaped ? tok.text : escPlain(tok.text);
    case 'escape':
      return escPlain(tok.text);
    case 'html':
      return tok.text;
    case 'strong':
      return `<strong>${renderInline(tok.tokens)}</strong>`;
    case 'em':
      return `<em>${renderInline(tok.tokens)}</em>`;
    case 'del':
      return `<del>${renderInline(tok.tokens)}</del>`;
    case 'codespan':
      return `<code>${escAll(tok.text)}</code>`;
    case 'br':
      return '<br>';
    case 'checkbox':
      return tok.checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
    case 'link': {
      const text = tok.autolink ? escAll(tok.text) : renderInline(tok.tokens);
      const cleaned = cleanUrl(tok.href);
      if (cleaned === null) return text;
      const hrefAttr = tok.autolink ? escAll(cleaned) : escPlain(cleaned);
      const title = tok.title ? ` title="${escPlain(tok.title)}"` : '';
      return `<a href="${hrefAttr}"${title}>${text}</a>`;
    }
    case 'image': {
      const alt = renderAltText(tok.tokens);
      const cleaned = cleanUrl(tok.href);
      if (cleaned === null) return escPlain(alt);
      const title = tok.title ? ` title="${escPlain(tok.title)}"` : '';
      return `<img src="${escPlain(cleaned)}" alt="${escPlain(alt)}"${title}>`;
    }
    default:
      return '';
  }
}

/** Alt text: inline tokens rendered with formatting stripped. */
function renderAltText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'escape':
      case 'html':
        out += tok.text;
        break;
      case 'codespan':
        out += tok.text;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += renderAltText(tok.tokens);
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        break; // br contributes nothing
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render a Markdown document to HTML, byte-identical to the reference
 * renderer with default (GFM) options. All state is per call: nothing is
 * cached or shared between documents.
 */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    jobs: [],
    top: true,
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true },
  };
  const tokens = blockParse(ctx, src, [], false);
  for (const job of ctx.jobs) {
    ctx.state.inRawBlock = false;
    inlineTokenize(ctx, job.text, job.tokens);
  }
  return renderBlocks(tokens);
}
