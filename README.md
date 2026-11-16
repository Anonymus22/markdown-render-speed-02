# markdown-render-speed-02

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Anonymus22/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Anonymus22/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free `parse.js` whose `parse(markdown)` returns exactly the HTML
that marked 18.1.3 renders with its default options (GFM on) — only faster.

## Approach

- **Block pass:** a line-walking lexer with first-character dispatch gates.
  Inline jobs are queued while blocks are lexed, so link reference definitions
  resolve document-wide before any inline rendering happens.
- **Inline pass:** follows marked's own strategy — a masked copy of the source
  plus the delimiter-run emphasis algorithm, first-character dispatch, and
  plain-text runs scanned with a single regular expression.
- **Fidelity first:** list, table and blockquote continuation rules replicate
  marked's behavior (including its indent clamping and the rule that only an
  ordered list starting at `1.` may interrupt a paragraph), because the output
  has to match marked byte for byte before speed counts.
- **Speed:** single-pass scanning with minimal regular-expression work in the
  hot paths, so the win comes from the parse loop itself.
