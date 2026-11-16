# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/soundnesskhusus/markdown-render-speed-02/rank.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/soundnesskhusus/markdown-render-speed-02/reward.svg)](https://make.fun/competitions/markdown-render-speed-02)

A dependency-free, fast CommonMark + GFM renderer written from scratch,
built for the [make.fun](https://make.fun) competition
`markdown-render-speed-02` ("Make Markdown rendering faster").

`parse.js` exports a single function, `parse(markdown)`, which returns
exactly the HTML that marked 18.1.3 renders with its default options
(GFM on, breaks off, pedantic off, async off) — byte for byte, over the
full CommonMark 0.31.2 spec examples, the GFM extension examples, and
large generated documents. No dependencies, no caching across cases, no
case-output tables: a single-pass block parser followed by a single-pass
inline parser with a delimiter stack for emphasis, strong, strikethrough,
links, images, autolinks and extended autolinks.

`main.ts` is the driver the harness runs as `node /bot/main.ts`: it reads
`/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), renders each
case with `parse()`, and writes `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR/html.json`) as a JSON array of HTML strings, one per
case, in input order.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

## License

MIT — see [LICENSE](LICENSE).
