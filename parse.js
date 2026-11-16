// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its default options (GFM on).
//
// Architecture: a block pass walks the source with anchored grammar rules and
// queues inline jobs as it goes, so link reference definitions resolve
// document-wide before any inline rendering happens. The inline pass follows
// marked's own strategy: a masked copy of the source (code spans, link
// destinations, tags and escapes blanked out) plus the delimiter-run emphasis
// algorithm, with first-character dispatch and single-regex text runs.
// All state lives in one per-call lexer object; nothing is shared between
// parse() calls.

// ---------------------------------------------------------------- helpers

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function getEscapeReplacement(ch) {
  return escapeReplacements[ch];
}

/** marked's escape: encode=true escapes every &<>"'; otherwise existing entities survive. */
function escapeHtml(text, encode) {
  if (encode) {
    if (escapeTest.test(text)) return text.replace(escapeReplace, getEscapeReplacement);
  } else if (escapeTestNoEncode.test(text)) {
    return text.replace(escapeReplaceNoEncode, getEscapeReplacement);
  }
  return text;
}

/** marked's cleanUrl: encodeURI with %25 folded back to %; null on failure. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Remove trailing copies of `c` (or, with invert, trailing chars that are not `c`). */
function rtrim(str, c, invert) {
  const len = str.length;
  if (len === 0) return '';
  let i = 0;
  while (i < len) {
    const ch = str.charAt(len - i - 1);
    if (ch === c && !invert) i++;
    else if (ch !== c && invert) i++;
    else break;
  }
  return str.slice(0, len - i);
}

/** Drop trailing blank lines when there are more than two of them. */
function trimBlankEnd(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

/** Normalize a link label the way marked does for definition lookup. */
function normalizeLabel(str) {
  return str.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** marked's findClosingBracket: index of the unmatched closer, -2 if unclosed, -1 if balanced/absent. */
function findClosingBracket(str, brackets) {
  if (str.indexOf(brackets[0]) === -1 && str.indexOf(brackets[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === brackets[0]) level++;
    else if (str[i] === brackets[1] && --level < 0) return i;
  }
  return level > 0 ? -2 : -1;
}

/** Expand tabs to the next multiple-of-4 column, counting from `offset`. */
function expandTabsPartial(text, offset = 0) {
  let col = offset;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const splitPipeRe = / \|/;
const slashPipeRe = /\\\|/g;

/** marked's splitCells: split a table row on unescaped pipes. */
function splitCells(str, limit) {
  const worked = str.replace(/\|/g, (match, offset, full) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && full[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = worked.split(splitPipeRe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (limit) {
    if (cells.length > limit) cells.splice(limit);
    else while (cells.length < limit) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(slashPipeRe, '|');
  return cells;
}

const numericRefTest = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const numericRefReplace = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Decode numeric character references in a text run (marked's unescape for inline text). */
function decodeNumericRefs(text) {
  if (!numericRefTest.test(text)) return text;
  return text.replace(numericRefReplace, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/**
 * marked's regex-edit helper: substitute named fragments into a pattern.
 * A fragment's leading ^ is stripped when it is embedded (unless after '[').
 */
const caretRe = /(^|[^\[])\^/g;
function edit(pattern, flags = '') {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const builder = {
    replace(name, fragment) {
      let frag = typeof fragment === 'string' ? fragment : fragment.source;
      frag = frag.replace(caretRe, '$1');
      src = src.replace(name, frag);
      return builder;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return builder;
}

/** Factory for the indent-clamped "begin" patterns used inside list items. */
function indentFactory(factory) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}

// ---------------------------------------------------------------- fragments

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
};

const listItemRegexCache = new Map();
const listItemRegex = (bull) => {
  let re = listItemRegexCache.get(bull);
  if (re === undefined) {
    re = new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
    listItemRegexCache.set(bull, re);
  }
  return re;
};

/** Manual equivalent of /\n[ \t]*\n[ \t]*$/ (blank line at the very end). */
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}
const nextBulletRegex = indentFactory((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrBeginRegex = indentFactory((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = indentFactory((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = indentFactory((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = indentFactory((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = indentFactory((n) => new RegExp(`^ {0,${n}}>`));

// ---------------------------------------------------------------- block grammar

const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const blockTable = edit('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG_NAMES)
  .getRegex();

const paragraphBase = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';

function paragraphWith(listFragment, tableFragment) {
  let builder = edit(paragraphBase)
    .replace('hr', blockHr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  builder = tableFragment === null
    ? builder.replace('|table', '')
    : builder.replace('table', tableFragment);
  return builder
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listFragment)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG_NAMES)
    .getRegex();
}

// Paragraph that may interrupt lazily inside blockquotes (any list may interrupt).
const paragraphForBlockquote = paragraphWith(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', null);
// Top-level GFM paragraph: only a "1." ordered list interrupts; a table may interrupt.
const paragraphGfm = paragraphWith(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', blockTable);

const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', paragraphForBlockquote)
  .getRegex();

const lheadingBase = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const blockLheading = edit(lheadingBase)
  .replace(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const defLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDef = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', defLabel)
  .replace('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const blockHtml = edit('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i')
  .replace('comment', htmlComment)
  .replace('tag', TAG_NAMES)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *\"[^\"\n]*\"| *= *'[^'\n]*'| *= *[^\s\"'=<>`]+)?/)
  .getRegex();

const block = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: blockHr,
  blockquote: blockquoteRe,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: blockHtml,
  def: blockDef,
  table: blockTable,
  lheading: blockLheading,
  paragraph: paragraphGfm,
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------- inline grammar

const punctClass = /[\p{P}\p{S}]/;
const punctSpaceClass = /[\s\p{P}\p{S}]/;
const notPunctSpaceClass = /[^\s\p{P}\p{S}]/;
const punctNoTilde = /(?!~)[\p{P}\p{S}]/;
const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/;
const notPunctSpaceOrTilde = /(?:[^\s\p{P}\p{S}]|~)/;

const inlinePunctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, punctSpaceClass)
  .getRegex();

const emStrongLDelimBase = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelim = edit(emStrongLDelimBase, 'u')
  .replace(/punct/g, punctNoTilde)
  .getRegex();

const rDelimAstTemplate = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const emStrongRDelimAst = edit(rDelimAstTemplate, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
  .replace(/punctSpace/g, punctSpaceNoTilde)
  .replace(/punct/g, punctNoTilde)
  .getRegex();

const rDelimUndTemplate = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const emStrongRDelimUnd = edit(rDelimUndTemplate, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
  .replace(/punctSpace/g, punctSpaceNoTilde)
  .replace(/punct/g, punctNoTilde)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, punctClass)
  .getRegex();

const delRDelimTemplate = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const delRDelim = edit(delRDelimTemplate, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceClass)
  .replace(/punctSpace/g, punctSpaceClass)
  .replace(/punct/g, punctClass)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, punctClass)
  .getRegex();

const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, punctClass)
  .getRegex();

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\()\\]|\((?:\\[\s\S]|[^\\()])*)*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const bracketGroup = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const linkLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', bracketGroup)
  .getRegex();

const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', linkLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^\\)\\])*\)/)
  .getRegex();

const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', linkLabel)
  .replace('ref', defLabel)
  .getRegex();

const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', defLabel)
  .getRegex();

const searchLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', bracketGroup)
  .getRegex();
const searchRef = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const reflinkSearch = edit(/reflink|nolink(?!\()/, 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/).replace('label', searchLabel).replace('ref', searchRef).getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', searchRef).getRegex())
  .getRegex();

const inlineTag = edit('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', edit(htmlComment).replace('(?:-->|$)', '-->').getRegex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*\"[^\"]*\"|\s*=\s*'[^']*'|\s*=\s*[^\s\"'=<>`]+)?/)
  .getRegex();

const inlineAutolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/) 
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const protocolClass = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const emailBare = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const emailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, emailBare)
  .getRegex();

const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', emailProtocol)
  .replace('protocol', protocolClass)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const inlineTextGfm = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@))))/)
  .replace('protocol', protocolClass)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

const inline = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: inlineTextGfm,
  autolink: inlineAutolink,
  tag: inlineTag,
  link: inlineLink,
  reflink: inlineReflink,
  nolink: inlineNolink,
  reflinkSearch,
  blockSkip,
  anyPunctuation,
  anyPunctuationOutsideCode,
  punctuation: inlinePunctuation,
  emStrongLDelim,
  emStrongRDelimAst,
  emStrongRDelimUnd,
  delLDelim,
  delRDelim,
  url: inlineUrl,
  _backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
};

// ---------------------------------------------------------------- block tokenizers
// Each takes the lexer state L and the remaining source; returns a token or undefined.

function queueInline(L, src) {
  const tokens = [];
  L.inlineQueue.push({ src, tokens });
  return tokens;
}

function tokSpace(L, src) {
  const cap = block.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokCode(L, src) {
  const cap = block.code.exec(src);
  if (cap) {
    const raw = trimBlankEnd(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

/** Fenced code: remove the fence-line indent from content lines when the fence is indented. */
function fencesText(raw, text) {
  const indentMatch = raw.match(other.indentCodeCompensation);
  if (indentMatch === null) return text;
  const indent = indentMatch[1];
  return text.split('\n').map((line) => {
    const leading = line.match(other.beginningSpace);
    if (leading === null) return line;
    return line.slice(Math.min(leading[0].length, indent.length));
  }).join('\n');
}

function tokFences(L, src) {
  const cap = block.fences.exec(src);
  if (cap) {
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(inline.anyPunctuation, '$1') : cap[2],
      text: fencesText(cap[0], cap[3] || ''),
    };
  }
}

function tokHeading(L, src) {
  const cap = block.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const stripped = rtrim(text, '#');
      if (!stripped || other.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(L, text) };
  }
}

function tokHr(L, src) {
  const cap = block.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(L, src) {
  const cap = block.blockquote.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const quoteLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
        quoteLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        quoteLines.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const curRaw = quoteLines.join('\n');
    const curText = curRaw
      .replace(other.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabsPartial(ws, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${curRaw}` : curRaw;
    text = text ? `${text}\n${curText}` : curText;
    const savedTop = L.top;
    L.top = true;
    blockTokens(L, curText, tokens, true);
    L.top = savedTop;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken && (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' || lastToken.type === 'html' || lastToken.type === 'table')) break;
    if (lastToken && lastToken.type === 'blockquote') {
      const oldToken = lastToken;
      const merged = oldToken.raw + '\n' + lines.join('\n').replace(other.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(L, merged);
      tokens[tokens.length - 1] = newToken;
      const leftover = merged.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const used = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (used.length > 0) raw = `${raw}\n${used.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(used.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.type === 'list') {
      const oldToken = lastToken;
      const mergedSrc = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(L, mergedSrc);
      tokens[tokens.length - 1] = newToken;
      const consumedLines = newToken.raw.length > oldToken.raw.length
        ? mergedSrc.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedLines > 0) {
        const usedText = lines.slice(0, consumedLines).join('\n');
        raw = `${raw}\n${usedText}`;
        text = `${text}\n${usedText}`;
      }
      lines = lines.slice(consumedLines);
      continue;
    }
  }
  return { type: 'blockquote', raw, text, tokens };
}

function tokList(L, src) {
  const firstCap = block.list.exec(src);
  if (!firstCap) return;
  const origSrc = src;
  const consumed = () => origSrc.length - src.length;
  let bull = firstCap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = listItemRegex(bull);
  let endWithBlank = false;
  while (src) {
    let itemBlankEnd = false;
    let itemText = '';
    const cap = itemRe.exec(src);
    if (!cap || block.hr.test(src)) break;
    const itemStart = consumed();
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bullLen = cap[1].length;
    let contentLine = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabsPartial(ws, bullLen));
    let nextLine = src.split('\n', 1)[0];
    const blankContent = !contentLine.trim();
    let indent = 0;
    if (blankContent) {
      indent = bullLen + 1;
    } else {
      indent = contentLine.search(other.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = contentLine.slice(indent);
      indent += bullLen;
    }
    if (blankContent && other.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      itemBlankEnd = true;
    }
    if (!itemBlankEnd) {
      const nextBullet = nextBulletRegex(indent);
      const hrPat = hrBeginRegex(indent);
      const fencesPat = fencesBeginRegex(indent);
      const headingPat = headingBeginRegex(indent);
      const htmlPat = htmlBeginRegex(indent);
      const quotePat = blockquoteBeginRegex(indent);
      let isBlank = blankContent;
      let prevContent = contentLine;
      while (src) {
        const rawLine = src.split('\n', 1)[0];
        nextLine = rawLine;
        const expanded = rawLine[0] === ' ' || rawLine[0] === '\t'
          ? rawLine.replace(other.leadingSpaceTab, (ws) => expandTabsPartial(ws))
          : rawLine;
        // Cheap gate: the six "begin" patterns can only match when the line's
        // first non-space character is one of their marker characters.
        let fc = '';
        for (let q = 0; q < rawLine.length; q++) {
          if (rawLine[q] !== ' ') { fc = rawLine[q]; break; }
        }
        if ((fc === '`' || fc === '~' || fc === '#' || fc === '<' || fc === '>' || fc === '*' || fc === '+' || fc === '-' || fc === '_' || (fc >= '0' && fc <= '9'))
          && (fencesPat.test(nextLine) || headingPat.test(nextLine) || htmlPat.test(nextLine) || quotePat.test(nextLine) || nextBullet.test(nextLine) || hrPat.test(nextLine))) break;
        if (expanded.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (isBlank
            || prevContent.replace(/\t/g, '    ').search(other.nonSpaceChar) >= 4
            || fencesPat.test(prevContent)
            || headingPat.test(prevContent)
            || htmlPat.test(prevContent)
            || hrPat.test(prevContent)) break;
          const setextLine = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && block.lheading.test(`${prevContent}\n${nextLine}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemText += '\n' + setextLine;
        }
        isBlank = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        prevContent = expanded.slice(indent);
      }
    }
    const itemRaw = origSrc.slice(itemStart, consumed());
    if (!list.loose) {
      if (endWithBlank) list.loose = true;
      else if (endsWithBlankLine(itemRaw)) endWithBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: other.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = origSrc.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    L.top = false;
    item.tokens = blockTokens(L, item.text, []);
    if (!list.loose) {
      const spaceTokens = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaceTokens.length > 0 && spaceTokens.some((t) => other.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const firstToken = item.tokens[0];
    if (item.task && firstToken && (firstToken.type === 'text' || firstToken.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      firstToken.raw = firstToken.raw.replace(other.listReplaceTask, '');
      firstToken.text = firstToken.text.replace(other.listReplaceTask, '');
      for (let g = L.inlineQueue.length - 1; g >= 0; g--) {
        if (other.listIsTask.test(L.inlineQueue[g].src)) {
          L.inlineQueue[g].src = L.inlineQueue[g].src.replace(other.listReplaceTask, '');
          break;
        }
      }
      const checkboxMatch = other.listTaskCheckbox.exec(item.raw);
      if (checkboxMatch) {
        const checkbox = { type: 'checkbox', raw: checkboxMatch[0] + ' ', checked: checkboxMatch[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return list;
}

function tokHtmlBlock(L, src) {
  const cap = block.html.exec(src);
  if (cap) {
    const raw = trimBlankEnd(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}

function tokDef(L, src) {
  const cap = block.def.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    return {
      type: 'def',
      tag: normalizeLabel(cap[1]),
      raw: rtrim(cap[0], '\n'),
      href: cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '',
      title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inline.anyPunctuation, '$1') : cap[3],
    };
  }
}

function tokTable(L, src) {
  const cap = block.table.exec(src);
  if (!cap || !other.tableDelimiter.test(cap[2])) return;
  const headerCells = splitCells(cap[1]);
  const alignCells = cap[2].replace(other.tableAlignChars, '').split('|');
  const rowLines = cap[3] && cap[3].trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  const table = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignCells.length) return;
  for (const cell of alignCells) {
    if (other.tableAlignRight.test(cell)) table.align.push('right');
    else if (other.tableAlignCenter.test(cell)) table.align.push('center');
    else if (other.tableAlignLeft.test(cell)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(L, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowLine of rowLines) {
    table.rows.push(splitCells(rowLine, table.header.length).map((cell, j) => ({
      text: cell,
      tokens: queueInline(L, cell),
      header: false,
      align: table.align[j],
    })));
  }
  return table;
}

function tokLheading(L, src) {
  const cap = block.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(L, text) };
  }
}

function tokParagraph(L, src) {
  const cap = block.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(L, text) };
  }
}

function tokText(L, src) {
  const cap = block.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(L, cap[0]) };
}

// ---------------------------------------------------------------- lexer core

const tableDelimLine = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

/** A table can only start when the second line is a delimiter row. */
function couldBeTable(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let end = src.indexOf('\n', nl + 1);
  if (end === -1) end = src.length;
  return tableDelimLine.test(src.slice(nl + 1, end));
}

const setextLineOnly = /^ {0,3}(=+|-+)[ \t]*$/;

/** A setext heading requires an underline line before the first blank line. */
function hasSetextAhead(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    let end = src.indexOf('\n', pos);
    if (end === -1) end = src.length;
    const line = src.slice(pos, end);
    if (line.trim() === '') return false;
    if (setextLineOnly.test(line)) return true;
    pos = end + 1;
  }
  return false;
}

function blockTokens(L, src, tokens, lastParagraphClipped = false) {
  let clipped = lastParagraphClipped;
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let token;
    if (token = tokSpace(L, src)) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (token.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(token);
      continue;
    }
    // First-significant-character gates: most block tokenizers can only match
    // one specific marker character within the first three spaces.
    let gi = 0;
    while (gi < 3 && src[gi] === ' ') gi++;
    const fc = src[gi];
    const c0 = src[0];
    if ((c0 === ' ' || c0 === '\t') && (token = tokCode(L, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      continue;
    }
    if ((fc === '`' || fc === '~') && (token = tokFences(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (fc === '#' && (token = tokHeading(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((fc === '*' || fc === '-' || fc === '_') && (token = tokHr(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (fc === '>' && (token = tokBlockquote(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) && (token = tokList(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (fc === '<' && (token = tokHtmlBlock(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (fc === '[' && (token = tokDef(L, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else {
        if (!Object.hasOwn(L.links, token.tag)) L.links[token.tag] = { href: token.href, title: token.title };
        tokens.push(token);
      }
      continue;
    }
    if (couldBeTable(src) && (token = tokTable(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (hasSetextAhead(src) && (token = tokLheading(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (L.top && (token = tokParagraph(L, src))) {
      const last = tokens[tokens.length - 1];
      if (clipped && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      clipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if (token = tokText(L, src)) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  L.top = true;
  return tokens;
}

// ---------------------------------------------------------------- masking

/** Scan a masked source for the last run of each delimiter that could close emphasis/del. */
function scanClosers(maskedSrc) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = maskedSrc.length;
  for (let i = 0; i < n; i++) {
    const ch = maskedSrc[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : maskedSrc[i - 1];
    let j = i + 1;
    while (j < n && maskedSrc[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { lastEm, lastDel };
}

function stackClosers(L, maskedSrc) {
  const top = L.maskStack[L.maskStack.length - 1];
  if (top && top.maskedSrc === maskedSrc) {
    if (top.closers === null) top.closers = scanClosers(maskedSrc);
    return top.closers;
  }
  return scanClosers(maskedSrc);
}

function lastEmCloser(L, maskedSrc, ch) {
  return stackClosers(L, maskedSrc).lastEm[ch];
}

function lastDelCloser(L, maskedSrc) {
  return stackClosers(L, maskedSrc).lastDel;
}

/** Does `text` contain a working link? (marked's linkInText, used by the masker.) */
function linkInText(L, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(inline.blockSkip)) {
    if (inline.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inline.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(L.links, normalizeLabel(s.slice(r + 1, -1))))
      && !(r > 1 && linkInText(L, s.slice(1, r - 1)))) return true;
  }
  return false;
}

/**
 * Build the masked copy of an inline source: link destinations, code spans,
 * tags and escaped punctuation are blanked so emphasis scanning ignores them.
 * The mask always has the same length as the source.
 */
function maskSrc(L, src) {
  let masked = src;
  if (masked.includes('[')) {
    masked = masked.replace(inline.reflinkSearch, (match) => {
      const r = match.lastIndexOf('[');
      if (!Object.hasOwn(L.links, normalizeLabel(match.slice(r + 1, -1)))) return match;
      if (r > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, r - 1);
        if (linkInText(L, inner)) {
          return '[' + inner.replace(inline.reflinkSearch, (nested) => maskReflink(L, nested)) + '][' + 'a'.repeat(match.length - r - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    });
  }
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(inline.anyPunctuationOutsideCode, (match, backticks, punct) =>
      punct
        ? '+'.repeat(match.length)
        : backticks
          ? backticks + match.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks
          : match);
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(inline.blockSkip, (match) => '[' + 'a'.repeat(match.length - 2) + ']');
  }
  return masked;
}

function maskReflink(L, match) {
  const r = match.lastIndexOf('[');
  if (!Object.hasOwn(L.links, normalizeLabel(match.slice(r + 1, -1)))) return match;
  if (r > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, r - 1);
    if (linkInText(L, inner)) {
      return '[' + inner.replace(inline.reflinkSearch, (nested) => maskReflink(L, nested)) + '][' + 'a'.repeat(match.length - r - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

// ---------------------------------------------------------------- inline tokenizers

function tokEscape(L, src) {
  const cap = inline.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokTag(L, src) {
  const cap = inline.tag.exec(src);
  if (cap) {
    if (!L.inLink && other.startATag.test(cap[0])) L.inLink = true;
    else if (L.inLink && other.endATag.test(cap[0])) L.inLink = false;
    if (!L.inRawBlock && other.startPreScriptTag.test(cap[0])) L.inRawBlock = true;
    else if (L.inRawBlock && other.endPreScriptTag.test(cap[0])) L.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: L.inLink, inRawBlock: L.inRawBlock, block: false, text: cap[0] };
  }
}

/** Reject a link whose label contains a tag/autolink spilling past the label's end. */
function labelHasSpillingTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const codeMatch = inline.code.exec(label.slice(i));
      if (codeMatch) {
        i += codeMatch[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tagMatch = inline.tag.exec(rest) || inline.autolink.exec(rest);
    if (tagMatch) {
      if (tagMatch[0].length > label.length - i) return true;
      i += tagMatch[0].length - 1;
    }
  }
  return false;
}

function outputLink(L, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = L.inLink;
  const savedEmitted = L.linkEmitted;
  const savedRawBlock = L.inRawBlock;
  L.inLink = true;
  L.linkEmitted = false;
  const tokens = inlineTokens(L, text, []);
  const emitted = L.linkEmitted;
  L.linkEmitted = savedEmitted;
  L.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      L.inRawBlock = savedRawBlock;
      return;
    }
    L.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(L, src) {
  if (L.linkParenPossible === false) return;
  const cap = inline.link.exec(src);
  if (!cap) return;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasSpillingTag(src, cap[1], offset)) return;
  let href = cap[2].trim();
  if (other.startAngleBracket.test(href)) {
    if (!other.endAngleBracket.test(href)) return;
    const trimmed = rtrim(href.slice(0, -1), '\\');
    if ((href.length - trimmed.length) % 2 === 0) return;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return;
    if (lastParen > -1) {
      const start = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, start).trim();
      cap[3] = '';
    }
  }
  const backslashTrimmed = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - backslashTrimmed.length) % 2 === 0) return;
  let hrefOut = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  hrefOut = hrefOut.trim();
  if (other.startAngleBracket.test(hrefOut)) hrefOut = hrefOut.slice(1, -1);
  return outputLink(L, cap, {
    href: hrefOut ? hrefOut.replace(inline.anyPunctuation, '$1') : hrefOut,
    title: title ? title.replace(inline.anyPunctuation, '$1') : title,
  }, cap[0]);
}

function tokReflink(L, src) {
  let cap = inline.reflink.exec(src);
  if (!cap) cap = inline.nolink.exec(src);
  if (!cap) return;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasSpillingTag(src, cap[1], offset)) return;
  const link = L.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const firstChar = cap[0].charAt(0);
    return { type: 'text', raw: firstChar, text: firstChar };
  }
  return outputLink(L, cap, link, cap[0]);
}

function tokEmStrong(L, src, maskedSrc, prevChar) {
  let match = inline.emStrongLDelim.exec(src);
  if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return;
  const delimChar = match[0][0];
  const prevIsDelim = prevChar === delimChar;
  const offset = maskedSrc.length - src.length;
  let runStart = offset;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const charBefore = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const charBeforeIsPunct = charBefore === '*' || charBefore === '_' || !!inline.punctuation.exec(charBefore);
  let effPrev = prevChar;
  if (runStart < offset) effPrev = charBefore;
  const effPrevIsPunct = runStart < offset ? charBeforeIsPunct : !!inline.punctuation.exec(prevChar);
  if (match[4] && effPrev.match(other.unicodeAlphaNumeric)) return;
  const punctAfter = match[1] || match[3] || '';
  if (!punctAfter || !effPrev || effPrevIsPunct) {
    const openerLen = [...match[0]].length - 1;
    let needed = openerLen;
    let leftover = 0;
    const span = offset - runStart + openerLen;
    const skipForThree = !!charBefore.trim() && (!!punctAfter || (delimChar === '*' && !charBeforeIsPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const rDelim = delimChar === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastCloser = lastEmCloser(L, maskedSrc, delimChar);
    const afterOpener = offset + openerLen;
    if (lastCloser < afterOpener) return;
    const masked = maskedSrc.slice(offset + openerLen);
    const maxCloserIndex = lastCloser - afterOpener;
    rDelim.lastIndex = 0;
    while ((match = rDelim.exec(masked)) !== null && !(match.index > maxCloserIndex)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (match[3] || match[4]) {
        needed += runLen;
        continue;
      }
      if (match[5] || match[6] || skipForThree) {
        if (prevIsDelim && (match[5] || match[6])) break;
        if (span % 3 && !((span + runLen) % 3)) {
          leftover += runLen;
          continue;
        }
      }
      needed -= runLen;
      if (needed > 0) continue;
      runLen = Math.min(runLen, runLen + needed + leftover);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + runLen);
      if (Math.min(openerLen, runLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(L, text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(L, text, []) };
    }
  }
}

function tokCodespan(L, src) {
  const cap = inline.code.exec(src);
  if (cap) {
    let text = cap[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const startsWithSpace = /^ /.test(text);
    const endsWithSpace = / $/.test(text);
    if (hasNonSpace && startsWithSpace && endsWithSpace) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(L, src) {
  const cap = inline.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokDel(L, src, maskedSrc, prevChar) {
  let match = inline.delLDelim.exec(src);
  if (!match) return;
  if (!match[1] || !prevChar || inline.punctuation.exec(prevChar)) {
    const openerLen = [...match[0]].length - 1;
    let needed = openerLen;
    const lastCloser = lastDelCloser(L, maskedSrc);
    const afterOpener = maskedSrc.length - src.length + openerLen;
    if (lastCloser < afterOpener) return;
    const masked = maskedSrc.slice(afterOpener);
    const maxCloserIndex = lastCloser - afterOpener;
    inline.delRDelim.lastIndex = 0;
    while ((match = inline.delRDelim.exec(masked)) !== null && !(match.index > maxCloserIndex)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (runLen !== openerLen) continue;
      if (match[3] || match[4]) {
        needed += runLen;
        continue;
      }
      needed -= runLen;
      if (needed > 0) continue;
      runLen = Math.min(runLen, runLen + needed);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + runLen);
      const text = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text, tokens: inlineTokens(L, text, []) };
    }
  }
}

function tokAutolink(L, src) {
  const cap = inline.autolink.exec(src);
  if (cap) {
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokUrl(L, src) {
  const cap = inline.url.exec(src);
  if (cap) {
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = cap[0];
        cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokInlineText(L, src) {
  const cap = inline.text.exec(src);
  if (cap) {
    const inRaw = L.inRawBlock;
    return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumericRefs(cap[0]), escaped: inRaw };
  }
}

function inlineTokens(L, src, tokens) {
  const saved = L.linkParenPossible;
  L.linkParenPossible = saved && src.includes(')');
  try {
    return inlineTokensImpl(L, src, tokens);
  } finally {
    L.linkParenPossible = saved;
  }
}

function inlineTokensImpl(L, src, tokens) {
  const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~') ? maskSrc(L, src) : src;
  L.maskStack.push({ maskedSrc, closers: null });
  try {
    let cur = src;
    let prevChar = '';
    let prevWasText = false;
    let lastLen = Infinity;
    while (cur) {
      if (cur.length < lastLen) lastLen = cur.length;
      else throw new Error('Infinite loop on byte: ' + cur.charCodeAt(0));
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      let token;
      // First-char dispatch: every inline tokenizer below is anchored to a
      // specific opening character (or, for url, an email/protocol start).
      const ch = cur[0];
      if (ch === '\\' && (token = tokEscape(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (ch === '<' && (token = tokTag(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((ch === '[' || ch === '!') && (token = tokLink(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((ch === '[' || ch === '!') && (token = tokReflink(L, cur))) {
        cur = cur.substring(token.raw.length);
        const last = tokens[tokens.length - 1];
        if (token.type === 'text' && last && last.type === 'text') {
          last.raw += token.raw;
          last.text += token.text;
        } else tokens.push(token);
        continue;
      }
      if ((ch === '*' || ch === '_') && (token = tokEmStrong(L, cur, maskedSrc, prevChar))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (ch === '`' && (token = tokCodespan(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((ch === ' ' || ch === '\\') && (token = tokBr(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (ch === '~' && (token = tokDel(L, cur, maskedSrc, prevChar))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (ch === '<' && (token = tokAutolink(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (!L.inLink && (ch === '_' || ch === '.' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) && (token = tokUrl(L, cur))) {
        cur = cur.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokInlineText(L, cur)) {
        cur = cur.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
        prevWasText = true;
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += token.raw;
          last.text += token.text;
        } else tokens.push(token);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + cur.charCodeAt(0));
    }
  } finally {
    L.maskStack.pop();
  }
  return tokens;
}

// ---------------------------------------------------------------- renderer

function renderTextToken(token) {
  if (token.tokens) return renderInline(token.tokens, false);
  if (token.escaped) return token.text;
  return escapeHtml(token.text);
}

function renderInline(tokens, asText) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += asText ? token.text : renderTextToken(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link': {
        if (asText) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        const content = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens, false);
        const href = cleanUrl(token.href);
        if (href === null) {
          out += content;
          break;
        }
        let html = '<a href="' + escapeHtml(href, token.autolink) + '"';
        if (token.title) html += ' title="' + escapeHtml(token.title) + '"';
        out += html + '>' + content + '</a>';
        break;
      }
      case 'image': {
        let text = token.text;
        if (token.tokens) text = renderInline(token.tokens, true);
        if (asText) {
          out += text;
          break;
        }
        const href = cleanUrl(token.href);
        if (href === null) {
          out += escapeHtml(text);
          break;
        }
        let html = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
        if (token.title) html += ` title="${escapeHtml(token.title)}"`;
        out += html + '>';
        break;
      }
      case 'checkbox':
        out += asText ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += asText
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<strong>${renderInline(token.tokens, false)}</strong>`;
        break;
      case 'em':
        out += asText
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<em>${renderInline(token.tokens, false)}</em>`;
        break;
      case 'codespan':
        out += asText ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += asText ? '' : '<br>';
        break;
      case 'del':
        out += asText
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<del>${renderInline(token.tokens, false)}</del>`;
        break;
      case 'text':
        out += asText ? token.text : renderTextToken(token);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const content = renderInline(cell.tokens, false);
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + content + `</${tag}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(token.tokens, false)}</h${token.depth}>\n`;
        break;
      case 'code': {
        const langString = (token.lang || '').match(/^\S*/)?.[0];
        const text = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
        const content = token.escaped ? text : escapeHtml(text, true);
        out += langString
          ? '<pre><code class="language-' + escapeHtml(langString) + '">' + content + '</code></pre>\n'
          : '<pre><code>' + content + '</code></pre>\n';
        break;
      }
      case 'table': {
        let headerHtml = '';
        for (const cell of token.header) headerHtml += renderTableCell(cell);
        let tableHtml = '<table>\n<thead>\n' + `<tr>\n${headerHtml}</tr>\n` + '</thead>\n';
        let body = '';
        for (const row of token.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) tableHtml += `<tbody>${body}</tbody>`;
        out += tableHtml + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(token.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of token.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(token.tokens, false)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(token);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * The HTML marked 18.1.3 renders for `markdown` with its default options
 * (GFM on, async off). All lexer state is created fresh for each call.
 */
export function parse(markdown) {
  const L = {
    links: Object.create(null),
    inlineQueue: [],
    maskStack: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    tokens: [],
  };
  const src = markdown.replace(/\r\n|\r/g, '\n');
  blockTokens(L, src, L.tokens, false);
  for (let i = 0; i < L.inlineQueue.length; i++) {
    const entry = L.inlineQueue[i];
    L.inRawBlock = false;
    inlineTokens(L, entry.src, entry.tokens);
  }
  L.inlineQueue = [];
  return renderBlocks(L.tokens);
}
