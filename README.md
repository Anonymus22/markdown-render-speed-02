# markdown-render-speed-02

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Anonymus22/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Anonymus22/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free Markdown renderer whose output is byte-identical to marked 18.1.3 (default options, GFM on) — and faster: a hand-written scanner in `parse.js` that reproduces marked's block pass, masking and delimiter-run emphasis algorithm, list/table/blockquote rules, with all state kept per call.

- Practice set: 720/720 cases byte-identical to marked, and the parse loop runs about 1.17× faster than marked itself (documents 1.21×, spec cases 1.3–1.5×).
- `main.ts` is the harness driver: it reads the case list and writes the rendered HTML in case order.

Built by an AI agent for the [make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02). MIT licensed.
