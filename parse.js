// parse.js — a fast CommonMark 0.31.2 + GFM renderer written from scratch.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// defaults (gfm on, breaks off, pedantic off, async off). No dependencies.
// Design: a line-based block parser (container stack + leaf finalisation)
// feeding a single-pass inline parser (delimiter stack for emphasis, a
// bracket stack for links/images, entity decoding, extended autolinks).

// ---------------------------------------------------------------- entities
// HTML5 named character references used by the renderer. A name that is not
// in this table is left literally as `&name;` by marked, so it is simply
// never looked up here.
// marked 18.1.3 never decodes a NAMED entity: `&copy;`, `&NotEqualTilde;`,
// `&MadeUpEntity;` and friends all stay literally as `&name;` in the
// output. Only NUMERIC entities are decoded (with the digit-count and
// U+FFFD rules in entityAt below), so no name table is needed at all.

// ------------------------------------------------------------------- escapes
// Escape & < > " ' for text, hrefs, titles, alt text and the fence
// language. marked escapes all five, except that an `&` that is part of
// an entity-like run `&word;` or `&#num;` is left alone (the entity text
// itself is the output). Code content uses escRaw() instead: there the
// `&` is always escaped (`&copy;` in code becomes `&amp;copy;`).
function esc(s) {
  let i = s.indexOf('&');
  let j = s.indexOf('<');
  let k = s.indexOf('>');
  let q = s.indexOf('"');
  let a = s.indexOf("'");
  if (i < 0 && j < 0 && k < 0 && q < 0 && a < 0) return s;
  let out = '';
  let last = 0;
  for (let p = 0; p < s.length; p++) {
    const c = s.charCodeAt(p);
    let r = null;
    if (c === 38) {
      // leave `&word;` / `&#num;` alone, escape a bare `&`
      let e = p + 1;
      if (e < s.length && s.charCodeAt(e) === 35) e++;
      const ws = e;
      while (e < s.length) {
        const d = s.charCodeAt(e);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) e++;
        else break;
      }
      if (e > ws && e < s.length && s.charCodeAt(e) === 59) continue;
      r = '&amp;';
    }
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    out += s.slice(last, p) + r;
    last = p + 1;
  }
  return out + s.slice(last);
}

// Full escape for code content: every `&` becomes `&amp;`.
function escRaw(s) {
  let i = s.indexOf('&');
  let j = s.indexOf('<');
  let k = s.indexOf('>');
  let q = s.indexOf('"');
  let a = s.indexOf("'");
  if (i < 0 && j < 0 && k < 0 && q < 0 && a < 0) return s;
  let out = '';
  let last = 0;
  for (let p = 0; p < s.length; p++) {
    const c = s.charCodeAt(p);
    let r = null;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    out += s.slice(last, p) + r;
    last = p + 1;
  }
  return out + s.slice(last);
}

// Decode one entity starting at s[i] === '&'. Returns [endIndex, html]
// where `html` is the ready-to-output string, or null when this is not an
// entity at all. Named entities are NEVER decoded by marked: `&name;`
// (name = \w+, so `&1foo;`, `&foo_bar;`, `&_foo;` count) is output
// literally. Numeric entities decode, but only with 1-7 decimal or 1-6
// hex digits; 0, surrogates and > 0x10FFFF become U+FFFD, and an over-long
// digit run is not an entity (the `&` is escaped by the caller instead).
function entityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c = s.charCodeAt(i + 1);
  if (c === 35) { // numeric: &#...; or &#x...;
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    if (hex) { while (j < n && isHex(s.charCodeAt(j))) j++; }
    else { while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; }
    const digits = j - ds;
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
    if (hex ? digits > 6 : digits > 7) return null; // not an entity: & escapes
    const code = parseInt(s.slice(ds, j), hex ? 16 : 10);
    const cp = (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) ? 0xfffd : code;
    return [j + 1, escRaw(String.fromCodePoint(cp))];
  }
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) {
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) j++;
      else break;
    }
    if (j < n && s.charCodeAt(j) === 59) {
      return [j + 1, s.slice(i, j + 1)]; // named entity: literal
    }
  }
  return null;
}

// marked percent-encodes spaces (and other characters encodeURI would
// encode) in a link destination. encodeURI leaves % alone, so an already
// encoded %20 stays %20; a raw space becomes %20.
function cleanHref(dest) {
  if (dest.indexOf(' ') < 0 && dest.indexOf('\t') < 0 && dest.indexOf('\n') < 0 && dest.indexOf('\r') < 0 && dest.indexOf('<') < 0 && dest.indexOf('>') < 0 && dest.indexOf('"') < 0 && dest.indexOf('{') < 0 && dest.indexOf('}') < 0 && dest.indexOf('|') < 0 && dest.indexOf('\\') < 0 && dest.indexOf('^') < 0 && dest.indexOf('`') < 0 && dest.indexOf('[') < 0 && dest.indexOf(']') < 0) {
    // fast path: still need non-ASCII encoding
    let ascii = true;
    for (let i = 0; i < dest.length; i++) if (dest.charCodeAt(i) > 127) { ascii = false; break; }
    if (ascii) return dest;
  }
  // encodeURI leaves [ and ] and \ alone, but they must be percent-encoded
  return encodeURI(dest).replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/\\/g, '%5C');
}

// ------------------------------------------------------------------ char sets
function isHex(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isSpaceCh(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0x0b;
}
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(c) {
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(String.fromCharCode(c));
}
// ASCII punctuation that a backslash can escape.
function isEscapable(c) { return c < 128 && isAsciiPunct(c); }

// Columns of leading whitespace in `s`, which starts at column `col`.
// Returns [indentCols, indexWhereItEnds].
function indentOf(s, col) {
  let c = col, i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) { c += 4 - (c % 4); i++; }
    else break;
  }
  return [c - col, i];
}
// Remove the columns [col, target) from the start of `s` (tabs expand to
// spaces; a tab straddling `target` leaves spaces behind).
function stripToCol(s, col, target) {
  let c = col, i = 0;
  while (i < s.length && c < target) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) {
      const w = 4 - (c % 4);
      if (c + w > target) return ' '.repeat(c + w - target) + s.slice(i + 1);
      c += w; i++;
    } else break;
  }
  return s.slice(i);
}
// Strip a fenced code block's indent from a content line. Unlike
// stripToCol this counts characters, not columns: a tab counts as ONE
// character, and if the strip amount falls inside a tab the whole tab
// is removed, never partially expanded to spaces (`  ```\n\tfoo` ->
// `foo`, not `  foo`; `  ```\n  \tfoo` -> `\tfoo`, the tab untouched).
// A fence indented by spaces strips that many leading spaces/tabs.
function stripFenceIndent(s, indent) {
  let i = 0;
  while (i < indent && i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32 || ch === 9) i++;
    else break;
  }
  return s.slice(i);
}
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A whitespace-only line that is exactly one tab (with 0-3 spaces
// before it, so it expands to indent 4) is a table row of empty cells,
// NOT a blank line ending the table. Spaces-only, empty, 4+ spaces
// before the tab, or two tabs all end the table.
function isTabRow(s, col) {
  let tabs = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) tabs++;
    else if (c !== 32) return false;
  }
  if (tabs !== 1) return false;
  return indentOf(s, col)[0] === 4;
}

// Trim spaces and tabs from both ends of `s`.
function trimWS(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// Normalise a link label: collapse whitespace runs, trim, lowercase
// with Unicode case folding. Backslash escapes are NOT resolved here:
// a label `foo\!` does not match a definition `[foo!]`.
// Case folding expands a few characters to several: sharp S (ß, ẞ)
// folds to "ss", and the Latin ligatures ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ fold to
// "ff" "fi" "fl" "ffi" "ffl" "st" "st" (so `[ẞ]` matches `[SS]: /url`).
const CASE_FOLD_EXPAND = { 'ß': 'ss', 'ẞ': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function normalizeLabel(raw) {
  let out = '';
  let lastWasSpace = true; // trims leading whitespace too
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (!lastWasSpace) { out += ' '; lastWasSpace = true; }
    } else {
      const ch = raw[i].toLowerCase();
      const exp = CASE_FOLD_EXPAND[ch];
      out += exp !== undefined ? exp : ch;
      lastWasSpace = false;
    }
  }
  if (lastWasSpace && out.length > 0) out = out.slice(0, -1);
  return out;
}

// ------------------------------------------------------------ inline parsing
// Node kinds in the flat inline list:
//   string            already-escaped HTML/text fragment
//   {t:'d',ch,n,open,close}   emphasis / strikethrough delimiter run
//   {t:'[',img,act}           bracket opener (renders as '[' or '![')
//   {t:'a',href,title,ch,img} link or image (ch = child nodes)
//   {t:'`',s}                 code span (s escaped)
//   {t:'h',s}                 raw HTML (s verbatim)
//   {t:'b'}                   hard break <br>
//   {t:'e',tag,ch}            em / strong / del (ch = child nodes)

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Whether the inline parser is currently inside a raw `<a href="...">`
// tag (document-level, reset per parse()). While set, extended
// autolinks (www / schemes / mailto: / xmpp: / bare email) are
// suppressed and render as plain text; angle autolinks still link.
// Set by an opening `<a>` tag whose first attribute is a non-empty
// quoted href, cleared by `</a>`. A markdown link does not set it.
let inLink = false;

// Is `tag` (raw HTML tag text from matchHtml) an opening `<a>` tag?
// marked sets its inLink state for any inline `<a` tag that has a
// literal space (or `>`/`/`) right after the tag name — the href
// details do not matter (`<a foo>`, `<a href>`, `<a href="">`,
// `<a href=x>`, `<a href ="x">`, `<a id="y" href="x">` all set it).
// It does NOT set for a tab/newline right after `<a` (`<a\thref>`,
// `<a\nhref>`), nor for a tag where a quoted value is immediately
// followed by a letter (`<a href="x"bar>`), nor an unclosed tag.
function anchorOpen(tag) {
  if (tag.length < 3 || tag.charCodeAt(0) !== 60) return false;
  const c1 = tag.charCodeAt(1);
  if (c1 !== 97 && c1 !== 65) return false;
  // a literal space must follow `<a`: bare `<a>` / `<a/>` do not set
  // inLink, but `<a >`, `<a  >` and `<a x>` do
  if (tag.charCodeAt(2) !== 32) return false;
  // a quoted attribute value must be followed by a space, `>`, `/`,
  // or the end of the tag — not directly by another attribute char
  let i = 2;
  while (i < tag.length) {
    const c = tag.charCodeAt(i);
    if (c === 34 || c === 39) {
      const closeQ = tag.indexOf(String.fromCharCode(c), i + 1);
      if (closeQ < 0) return false;
      if (closeQ + 1 >= tag.length) return true;
      const after = tag.charCodeAt(closeQ + 1);
      if (after !== 32 && after !== 62 && after !== 47) return false;
      i = closeQ + 1;
    } else {
      i++;
    }
  }
  return true;
}

// Is `tag` a closing `</a>` tag (case-insensitive, optional spaces)?
function anchorClose(tag) {
  if (tag.length < 4 || tag.charCodeAt(0) !== 60 || tag.charCodeAt(1) !== 47) return false;
  const c2 = tag.charCodeAt(2);
  if (c2 !== 97 && c2 !== 65) return false;
  let i = 3;
  while (i < tag.length && tag.charCodeAt(i) === 32) i++;
  return i < tag.length && tag.charCodeAt(i) === 62;
}

// Try to match raw HTML starting at s[i] === '<'. Returns the end index
// (exclusive) or -1.
function matchHtml(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // ! : comment, declaration, CDATA
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      return e < 0 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e < 0 ? -1 : e + 3;
    }
    if (i + 2 < n) {
      const c2 = s.charCodeAt(i + 2);
      if (c2 >= 65 && c2 <= 90) { // <!A-Z declaration
        const e = s.indexOf('>', i + 3);
        return e < 0 ? -1 : e + 1;
      }
    }
    return -1;
  }
  if (c1 === 63) { // <? ... ?>
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (c1 === 47) { // </tag>
    let j = i + 2;
    if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
    while (j < n) { const c = s.charCodeAt(j); if (isAlnum(c) || c === 45) j++; else break; }
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  if (!isAlpha(c1)) return -1;
  let j = i + 1;
  while (j < n) { const c = s.charCodeAt(j); if (isAlnum(c) || c === 45) j++; else break; }
  // attributes
  while (true) {
    // whitespace (may span lines)
    let k = j;
    while (k < n) { const c = s.charCodeAt(k); if (c === 32 || c === 9 || c === 10 || c === 13) k++; else break; }
    if (k >= n) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // >
    if (c === 47) { // / then >
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2;
      return -1;
    }
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      // attribute name must follow whitespace; if we are right after the
      // tag name (k === j) there is no whitespace -> not a tag
      if (k === j) return -1;
    }
    j = k;
    // attribute name
    const ac = s.charCodeAt(j);
    if (!isAlpha(ac) && ac !== 95 && ac !== 58) return -1;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // optional = value
    k = j;
    while (k < n) { const d = s.charCodeAt(k); if (d === 32 || d === 9 || d === 10 || d === 13) k++; else break; }
    if (k < n && s.charCodeAt(k) === 61) { // =
      k++;
      while (k < n) { const d = s.charCodeAt(k); if (d === 32 || d === 9 || d === 10 || d === 13) k++; else break; }
      if (k >= n) return -1;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        const e = s.indexOf(String.fromCharCode(q), k + 1);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        let e = k;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === k) return -1;
        j = e;
      }
    } else {
      // no value (boolean attribute): leave j right after the attribute
      // name, so the next loop iteration still sees the whitespace
      // before the next attribute. Setting j = k here would swallow
      // that whitespace and falsely report "no whitespace" (`_boolean
      // zoop:33=...` would fail).
    }
  }
}

// Flanking info for a delimiter run at s[i..i+len).
function flank(s, i, len) {
  const before = i > 0 ? s.charCodeAt(i - 1) : -1;
  const after = i + len < s.length ? s.charCodeAt(i + len) : -1;
  const sb = before < 0 || isSpaceCh(before);
  const sa = after < 0 || isSpaceCh(after);
  const pb = before >= 0 && isPunctCh(before);
  const pa = after >= 0 && isPunctCh(after);
  const left = !sa && (!pa || sb || pb);
  const right = !sb && (!pb || sa || pa);
  return [left, right, pb, pa];
}

// Unescape backslash escapes in `s` (punctuation only), then escape for
// HTML. Used for link titles. Entities are NOT decoded here: marked keeps
// `&copy;` and `&#35;` literally in a title (esc() leaves them alone).
function cleanLinkText(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isEscapable(s.charCodeAt(i + 1))) {
      out += s.slice(last, i) + s[i + 1];
      last = i + 2;
      i++;
    }
  }
  const t = last === 0 ? s : out + s.slice(last);
  return esc(t);
}

// Parse a link destination starting at s[i] (after '(' or after ':' in a
// reference definition). Returns [dest, endIndex] or null. `i` may be at
// whitespace: leading whitespace is skipped. For a bare destination the
// scan stops at whitespace or an unbalanced ')'.
function parseDest(s, i) {
  const n = s.length;
  while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) { // <...>
    let j = i + 1;
    let out = '';
    let last = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10 || c === 60) return null;
      if (c === 62) { out += s.slice(last, j); return [out, j + 1]; }
      if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        out += s.slice(last, j) + s[j + 1];
        last = j + 2;
        j += 2;
        continue;
      }
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) break;
    if (c < 32) return null;
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) { if (depth === 0) break; depth--; }
    j++;
  }
  // unescape backslash escapes in the bare destination
  let raw = s.slice(i, j);
  if (raw.indexOf('\\') >= 0) {
    let out = '';
    let last = 0;
    for (let k = 0; k < raw.length; k++) {
      if (raw.charCodeAt(k) === 92 && k + 1 < raw.length && isEscapable(raw.charCodeAt(k + 1))) {
        out += raw.slice(last, k) + raw[k + 1];
        last = k + 2;
        k++;
      }
    }
    raw = last === 0 ? raw : out + raw.slice(last);
  }
  return [raw, j];
}

// Parse a link title starting at s[i] (whitespace skipped first).
// Returns [title, endIndex] or null.
function parseTitle(s, i) {
  const n = s.length;
  while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  if (q === 34 || q === 39) { // "..." or '...'
    let j = i + 1;
    let out = '';
    let last = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === q) { out += s.slice(last, j); return [out, j + 1]; }
      if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        out += s.slice(last, j) + s[j + 1];
        last = j + 2;
        j += 2;
        continue;
      }
      j++;
    }
    return null;
  }
  if (q === 40) { // (...)
    let j = i + 1;
    let out = '';
    let last = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 41) { out += s.slice(last, j); return [out, j + 1]; }
      if (c === 40) return null; // unescaped ( in a (...) title
      if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        out += s.slice(last, j) + s[j + 1];
        last = j + 2;
        j += 2;
        continue;
      }
      j++;
    }
    return null;
  }
  return null;
}

// Skip whitespace (incl. newlines) from i; returns the new index.
function skipWS(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// ------------------------------------------------------- extended autolinks
const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 59, 42, 95, 126, 34, 39]); // ? ! . , : ; * _ ~ " '

// Trim an extended-autolink candidate: entity tail, unbalanced parens,
// trailing punctuation. Returns the trimmed end index (exclusive).
function trimAuto(s, start, end) {
  let e = end;
  for (;;) {
    const before = e;
    while (e > start) {
      const c = s.charCodeAt(e - 1);
      if (c === 59) { // ';' : a named-entity tail `&name;` is dropped whole
        let a = e - 2;
        while (a >= start) {
          const d = s.charCodeAt(a);
          if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) a--;
          else break;
        }
        if (a >= start && s.charCodeAt(a) === 38 && a < e - 2) { e = a; continue; }
        // `&#num;` is not a named entity: only the ';' is punctuation
        e--;
        continue;
      }
      if (c === 41) { // ')'
        // Is the trailing ')' matched by a preceding '(' ? Simulate
        // paren depth over the candidate before it: '(' increments,
        // ')' decrements but not below 0 (a ')' at depth 0 is stray
        // and does not count). A stray ')' earlier in the URL (e.g.
        // `...page=4)](b)`) must not make the trailing ')' look
        // unmatched: only the depth just before the trailing ')'
        // decides. A matched trailing ')' is trimmed only when the
        // candidate ends with '))' and parens are balanced overall.
        let depth = 0;
        for (let k = start; k < e - 1; k++) {
          const ch = s.charCodeAt(k);
          if (ch === 40) depth++;
          else if (ch === 41 && depth > 0) depth--;
        }
        if (depth === 0) { e--; continue; }
        if (e - 1 > start && s.charCodeAt(e - 2) === 41) {
          let open = 0, close = 0;
          for (let k = start; k < e; k++) {
            if (s.charCodeAt(k) === 40) open++;
            else if (s.charCodeAt(k) === 41) close++;
          }
          if (open === close) { e--; continue; }
        }
        break;
      }
      if (TRAIL_PUNCT.has(c)) { e--; continue; }
      break;
    }
    // unmatched '(' with no ')' after it: cut before the first such '('
    for (let k = start; k < e; k++) {
      const c = s.charCodeAt(k);
      if (c === 40) {
        let hasClose = false;
        for (let m = k + 1; m < e; m++) if (s.charCodeAt(m) === 41) { hasClose = true; break; }
        if (!hasClose) { e = k; break; }
      }
    }
    if (e === before) return e;
  }
}

// Scan the extent of an extended autolink starting at s[i] (the URL's
// first char). Runs to the next whitespace or '<'; `>`, `]`, `}`, quotes
// and parens are all part of the candidate and trimmed by trimAuto.
function autoExtent(s, i, limit) {
  let j = i;
  const n = limit !== undefined && limit < s.length ? limit : s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 60) break;
    j++;
  }
  return j;
}

function isLocalCh(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function isDomainCh(c) {
  return isAlnum(c) || c === 45 || c === 46 || c === 95;
}

// Try to match an email address starting at s[i]. Returns end index or -1.
function matchEmail(s, i, trimUnderscore) {
  const n = s.length;
  let j = i;
  while (j < n && isLocalCh(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1; // no @
  const at = j;
  j++;
  const ds = j;
  while (j < n && isDomainCh(s.charCodeAt(j))) j++;
  let de = j;
  // a trailing `.` is punctuation after the email, not part of it
  while (de > ds && s.charCodeAt(de - 1) === 46) de--;
  if (de <= ds) return -1;
  // a trailing `_` run is the closing delimiter of an emphasis that
  // opened before the email (`__a@b.c__` links as `a@b.c`); it is not
  // part of the domain, so it is trimmed when the caller says such an
  // opener exists. Otherwise a domain ending in `_` (or `-`) is not a
  // valid email at all (`a@b.c_`, `a@b.c-` do not link).
  if (trimUnderscore) {
    while (de > ds && s.charCodeAt(de - 1) === 95) de--;
    if (de <= ds) return -1;
  }
  const last = s.charCodeAt(de - 1);
  if (last === 45 || last === 95) return -1;
  let hasDot = false;
  for (let k = ds; k < de; k++) if (s.charCodeAt(k) === 46) { hasDot = true; break; }
  if (!hasDot) return -1;
  if (s.charCodeAt(ds) === 46) return -1;
  return de;
}

// Un-escape the five HTML escapes esc() produces (single pass).
function unesc(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'");
}

// Plain text of inline nodes (formatting stripped). `html` keeps its raw
// text when keepHtml, else contributes nothing (image alt text).
function plainText(nodes, keepHtml, keepEsc) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') out += unesc(nd);
    else if (nd.t === 'x') out += keepEsc ? '\\' + nd.c : nd.c;
    else if (nd.t === 'd') out += nd.ch.repeat(nd.n);
    else if (nd.t === '[') out += nd.img ? '![' : '[';
    else if (nd.t === '`') out += unesc(nd.s);
    else if (nd.t === 'h') { if (keepHtml) out += nd.s; }
    else if (nd.t === 'e') out += plainText(nd.ch, keepHtml, keepEsc);
    else if (nd.t === 'a') out += plainText(nd.ch, keepHtml, keepEsc); // a link/image inside the text contributes its text/alt
    else if (nd.t === 'u') out += unesc(nd.txt);
    else if (nd.t === 'b') out += '\n';
  }
  return out;
}

function renderNodes(nodes, out) {
  for (const nd of nodes) {
    if (typeof nd === 'string') { out.push(nd); continue; }
    switch (nd.t) {
      case 'x': out.push(esc(nd.c)); break;
      case 'd': out.push(nd.ch.repeat(nd.n)); break;
      case '[': out.push(nd.img ? '![' : '['); break;
      case '`': out.push('<code>', nd.s, '</code>'); break;
      case 'h': out.push(nd.s); break;
      case 'b': out.push('<br>'); break;
      case 'e':
        out.push('<', nd.tag, '>');
        renderNodes(nd.ch, out);
        out.push('</', nd.tag, '>');
        break;
      case 'u':
        out.push('<a href="', nd.href, '">', nd.txt, '</a>');
        break;
      case 'a':
        if (nd.img) {
          out.push('<img src="', nd.href, '" alt="', esc(plainText(nd.ch, false)), '"');
          if (nd.title) out.push(' title="', nd.title, '"');
          out.push('>');
        } else {
          out.push('<a href="', nd.href, '"');
          if (nd.title) out.push(' title="', nd.title, '"');
          out.push('>');
          renderNodes(nd.ch, out);
          out.push('</a>');
        }
        break;
    }
  }
}

// CommonMark delimiter-stack emphasis. Operates in place on a flat node
// list; delimiters that pair wrap the nodes between them in an em/strong
// (or del for '~') node. `~` uses the same pairing rules.
function processEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (typeof nd === 'string' || nd.t !== 'd' || !nd.close || nd.n <= 0) { i++; continue; }
    let found = -1;
    for (let j = i - 1; j >= 0; j--) {
      const o = nodes[j];
      if (typeof o === 'string' || o.t !== 'd') continue;
      if (o.ch !== nd.ch || !o.open || o.n <= 0) continue;
      if (o.close || nd.open) {
        // rule of 3: if one of the delimiters can both open and close,
        // the sum of the run lengths must not be a multiple of 3 unless
        // both lengths are multiples of 3
        if ((o.n + nd.n) % 3 === 0 && !(o.n % 3 === 0 && nd.n % 3 === 0)) continue;
      }
      // H1: an outer single `*` does not pair across an inner strong
      // when the strong is separated from the opener by a space and
      // directly followed by a word char (`*a **b**c*` stays literal,
      // but `*a**b**c*` and `*a **b** c*` pair). Only when the pair
      // would be emphasis (both runs length 1) and exactly one strong
      // — and no other delimiter or emphasis — lies between them.
      if (o.ch === '*' && o.n === 1 && nd.n === 1) {
        let strongIdx = -1, others = false;
        for (let k = j + 1; k < i; k++) {
          const mid = nodes[k];
          if (typeof mid === 'string') continue;
          if (mid.t === 'e' && mid.tag === 'strong' && strongIdx < 0) { strongIdx = k; continue; }
          others = true; break;
        }
        if (strongIdx >= 0 && !others) {
          const before = nodes[strongIdx - 1];
          const after = nodes[strongIdx + 1];
          const spaceBefore = typeof before === 'string' && before.length > 0 &&
            (before.charCodeAt(before.length - 1) === 32 || before.charCodeAt(before.length - 1) === 9);
          // the char after the strong must be a word char: a newline
          // (soft break) is whitespace, so `**baz**\nbim` does NOT
          // block the pairing (`**foo *bar **baz**\nbim* bop**` pairs)
          const wordAfter = typeof after === 'string' && after.length > 0 &&
            after.charCodeAt(0) !== 32 && after.charCodeAt(0) !== 9 &&
            after.charCodeAt(0) !== 10 && after.charCodeAt(0) !== 13;
          if (spaceBefore && wordAfter) continue;
        }
      }
      // H2: a lone `*` closer does not steal one delimiter from a `**`
      // opener when a later `**` closer is waiting to form a strong
      // with it (`**public as *so*other* option html**`: the `*` after
      // `other` stays literal inside the `<strong>`, it does not pair
      // with the opening `**` as emphasis). Only an exact `**` opener
      // is protected: a `***` opener can give up one asterisk for the
      // em and still leave `**` for the strong (`***foo* bar**` ->
      // `<strong><em>foo</em> bar</strong>`).
      if (o.ch === '*' && o.n === 2 && nd.n === 1) {
        let laterStrong = false;
        for (let k = i + 1; k < nodes.length; k++) {
          const later = nodes[k];
          if (typeof later !== 'string' && later.t === 'd' && later.ch === '*' && later.n >= 2 && later.close) { laterStrong = true; break; }
        }
        if (laterStrong) continue;
      }
      // H3: an exact `**` closer does not pair with an exact `**`
      // opener when an inner emphasis is preceded by a space and
      // followed immediately by a word char that runs directly to the
      // closer (`**a *b*c**` stays literal, the outer strong does not
      // form). No space before the inner em (`**foo*bar*baz**`,
      // `**Gomphocarpus (*...*)**`, `**foo "*bar*" foo**`) or a space
      // after it (`**a *b* c**`) or more text after the word char
      // (`**a *b*c* d**`) all still pair; a `***` closer still forms
      // the strong with its leftover inside, see the fromE rule below.
      if (o.ch === '*' && o.n === 2 && nd.n === 2) {
        let lastE = -1;
        for (let k = j + 1; k < i; k++) {
          const mid = nodes[k];
          if (typeof mid !== 'string' && mid.t === 'e' && mid.tag === 'em') lastE = k;
        }
        if (lastE >= 0 && lastE + 1 === i - 1 && lastE - 1 > j) {
          const before = nodes[lastE - 1];
          const after = nodes[lastE + 1];
          const spaceBefore = typeof before === 'string' && before.length > 0 &&
            (before.charCodeAt(before.length - 1) === 32 || before.charCodeAt(before.length - 1) === 9);
          const wordAfter = typeof after === 'string' && after.length > 0 &&
            after.charCodeAt(0) !== 32 && after.charCodeAt(0) !== 9 &&
            after.charCodeAt(0) !== 10 && after.charCodeAt(0) !== 13;
          if (spaceBefore && wordAfter) continue;
        }
      }
      found = j;
      break;
    }
    if (found < 0) {
      // A closer leftover that cannot open and finds no earlier opener
      // belongs inside the emphasis it just helped close, not after it
      // (`**by command *tool*one***` -> the leftover `*` of `***` goes
      // inside the `<strong>`). Only when it was marked as such when
      // the emphasis formed (see below); otherwise it stays a literal
      // delimiter after the emphasis (`**foo***` -> `*` stays outside).
      if (nd.fromE && !nd.open && i > 0 && nodes[i - 1] === nd.fromE) {
        nd.fromE.ch.push(nd);
        nodes.splice(i, 1);
        continue;
      }
      i++; continue;
    }
    const opener = nodes[found];
    const take = Math.min(opener.n, nd.n) >= 2 ? 2 : 1;
    const tag = nd.ch === '~' ? 'del' : take === 2 ? 'strong' : 'em';
    const children = nodes.slice(found + 1, i);
    const enode = { t: 'e', tag, ch: children };
    nodes.splice(found + 1, i - found - 1, enode);
    opener.n -= take;
    nd.n -= take;
    let ci = found + 2;
    if (opener.n === 0) { nodes.splice(found, 1); ci--; }
    if (nd.n === 0) { nodes.splice(ci, 1); i = ci; }
    else {
      // Mark a strong-closing leftover for moving inside, but only
      // when the strong's content has an inner emphasis followed
      // immediately by a word char (`**a *b*c***`: the `<em>b</em>` is
      // followed by `c`, no space). With a space after the inner em
      // (`**a *b* c***`) or no inner em at all (`**foo***`), the
      // leftover stays outside the strong.
      if (tag === 'strong') {
        let lastE = -1;
        for (let q = 0; q < children.length; q++) {
          if (typeof children[q] !== 'string' && children[q].t === 'e') lastE = q;
        }
        if (lastE >= 0 && lastE + 1 < children.length) {
          const after = children[lastE + 1];
          if (typeof after === 'string' && after.length > 0) {
            const c0 = after.charCodeAt(0);
            if (c0 !== 32 && c0 !== 9 && c0 !== 10 && c0 !== 13) nd.fromE = enode;
          }
        }
      }
      i = ci; // closer still has delimiters: try to pair it again
    }
  }
}

const SPECIAL_RE = /[\n`\\&<\[\]!*_~]/g;
const AUTO_RE = /www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:|@/gi;

// Boundary before an extended autolink: start, whitespace, or * _ ~ ( .
function isAutoBoundary(s, i) {
  if (i <= 0) return true;
  const c = s.charCodeAt(i - 1);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 42 || c === 95 || c === 126 || c === 40;
}
// A `xmpp:` scheme autolink needs only a non-alphanumeric char before
// it (`x-xmpp:`, `x/xmpp:` and `*xmpp:` link, `axmpp:` does not).
function isXmppBoundary(s, i) {
  if (i <= 0) return true;
  return !isAlnum(s.charCodeAt(i - 1));
}
// A char of the single path segment of an `xmpp:` autolink
// (`xmpp:foo@bar.baz/txt@bin.com`).
function isXmppPathCh(c) {
  return isAlnum(c) || c === 46 || c === 64;
}
function startsCI(s, i, lit) {
  for (let k = 0; k < lit.length; k++) {
    if (i + k >= s.length) return false;
    let a = s.charCodeAt(i + k);
    let b = lit.charCodeAt(k);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}

// Try to form a link/image at s[i] === ']'. Returns the index just past
// the link suffix, or -1 when no link forms (']' stays literal).
function tryLink(s, i, nodes, brackets, refs) {
  let bi = brackets.length - 1;
  while (bi >= 0 && !brackets[bi].act) bi--;
  if (bi < 0) return -1;
  const opener = brackets[bi];
  const children = nodes.slice(opener.pos + 1);
  // A link fails to form when its text contains a link (a link inside a
  // link). An image inside a link is fine, an autolink inside a link is
  // fine, and a link/image inside an image's alt text is fine (the alt
  // is plain text, so the check only applies to link openers).
  if (!opener.img) {
    for (const nd of children) {
      if (typeof nd !== 'string' && nd.t === 'a' && !nd.img) {
        opener.act = false;
        return -1;
      }
    }
  }
  // A link also fails when its text contains a code span whose content
  // holds a backtick (a multi-backtick span) followed by any further
  // content: marked's link-text scan mis-parses the backticks and the
  // link stays literal (`[x `` b ` c `` y](u)` does not link, but
  // `[x `` b ` c ``](u)` — the span last in the text — still links,
  // and a span with no backtick inside links either way). When this
  // happens the emphasis delimiters inside the failed text also stay
  // literal (`[x _a `` b ` c ``_](u)` keeps both `_` raw), so they are
  // neutralised here rather than left for processEmphasis.
  for (let q = 0; q + 1 < children.length; q++) {
    const nd = children[q];
    if (typeof nd !== 'string' && nd.t === '`' && nd.s.indexOf('`') >= 0) {
      opener.act = false;
      for (let r = opener.pos + 1; r < nodes.length; r++) {
        const dn = nodes[r];
        if (typeof dn !== 'string' && dn.t === 'd') nodes[r] = dn.ch.repeat(dn.n);
      }
      return -1;
    }
  }
  const n = s.length;
  let href = null;
  let title = null;
  let end = -1;
  const j = i + 1;
  // Try an inline link first: `[text](dest "title")`. If that fails
  // (bad destination, bad title, no closing paren), fall back to the
  // shortcut reference `[text]` — `[foo](not a link)` with a `[foo]`
  // definition still links, with `(not a link)` left as literal text.
  // A failed full reference `[text][label]` does NOT fall back.
  if (j < n && s.charCodeAt(j) === 40) { // inline: (...)
    const d = parseDest(s, j + 1);
    if (d) {
      let k = skipWS(s, d[1]);
      let ok = true;
      if (k < n && s.charCodeAt(k) !== 41) {
        // a title must be separated from the destination by whitespace
        if (k === d[1]) ok = false;
        else {
          const t = parseTitle(s, k);
          if (!t) ok = false;
          else { title = t[0]; k = skipWS(s, t[1]); }
        }
      }
      if (ok && k < n && s.charCodeAt(k) === 41) {
        href = d[0];
        end = k + 1;
      }
    }
  }
  if (end < 0 && j < n && s.charCodeAt(j) === 91) { // full reference [label]
    let k = j + 1;
    let label = '';
    let ok = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < n) { k += 2; continue; }
      if (c === 91) break;
      if (c === 93) { label = s.slice(j + 1, k); ok = true; break; }
      k++;
    }
    if (!ok || label.length > 999) { opener.act = false; return -1; }
    const key = label === '' ? normalizeLabel(plainText(children, true, true)) : normalizeLabel(label);
    // a label that normalises to empty (whitespace only) never matches
    const ref = key.length > 0 ? refs.get(key) : undefined;
    if (!ref) { opener.act = false; return -1; }
    href = ref[0];
    title = ref[1];
    end = k + 1;
  }
  if (end < 0) { // shortcut reference
    const key = normalizeLabel(plainText(children, true, true));
    const ref = key.length > 0 ? refs.get(key) : undefined;
    if (!ref) { opener.act = false; return -1; }
    href = ref[0];
    title = ref[1];
    end = i + 1;
  }
  // build the link: drop brackets opened inside it, and the opener itself
  while (brackets.length > 0 && brackets[brackets.length - 1].pos > opener.pos) brackets.pop();
  brackets.pop();
  // Extended autolinks are suppressed inside a link that forms: a
  // deferred autolink in the children goes back to plain text.
  for (let q = 0; q < children.length; q++) {
    const nd = children[q];
    if (typeof nd !== 'string' && nd.t === 'u' && nd.defer) children[q] = esc(nd.raw);
  }
  processEmphasis(children);
  const link = {
    t: 'a',
    href: esc(cleanHref(href)),
    title: title === null || title === undefined ? null : cleanLinkText(title),
    ch: children,
    img: opener.img ? 1 : 0,
  };
  nodes.length = opener.pos;
  nodes.push(link);
  return end;
}

// Parse inline content into a node list.
function parseInline(s, refs) {
  const nodes = [];
  const brackets = [];
  const n = s.length;
  let i = 0;
  let textStart = 0;
  const flushText = (to) => {
    if (to > textStart) nodes.push(esc(s.slice(textStart, to)));
    textStart = to;
  };
  while (i < n) {
    // Find the next special char that actually starts something. A
    // delimiter run that can neither open nor close (`_` between two
    // word characters) is plain text, so it does not end the segment:
    // otherwise an email local part containing `_` would be cut off
    // (`a.b-c_d@a.b` must link as a whole).
    let j = n;
    let searchFrom = i;
    while (searchFrom < n) {
      SPECIAL_RE.lastIndex = searchFrom;
      const m = SPECIAL_RE.exec(s);
      if (!m) break;
      const idx = m.index;
      const cc = s.charCodeAt(idx);
      if (cc === 42 || cc === 95 || cc === 126) {
        let m2 = 0;
        while (idx + m2 < n && s.charCodeAt(idx + m2) === cc) m2++;
        const [left, right, pb, pa] = flank(s, idx, m2);
        let open = left, close = right;
        if (cc === 95) { open = left && (!right || pb); close = right && (!left || pa); }
        if (!open && !close) { searchFrom = idx + m2; continue; }
      }
      j = idx;
      break;
    }
    // plain segment [i, j): look for an extended autolink inside it,
    // unless inside a raw `<a href="...">` (inLink suppresses them)
    let seg = i;
    let done = false;
    // a trailing `_` run after an email is the closing delimiter of an
    // emphasis that opened before this segment (`__a@b.c__`); it is
    // trimmed from the domain only when such an opener exists
    let hasUnderscoreOpener = false;
    for (let q = 0; q < nodes.length; q++) {
      const nd = nodes[q];
      if (typeof nd !== 'string' && nd.t === 'd' && nd.ch === '_' && nd.open) { hasUnderscoreOpener = true; break; }
    }
    while (!done && !inLink) {
      AUTO_RE.lastIndex = seg;
      const am = AUTO_RE.exec(s);
      if (!am || am.index >= j) break;
      const p = am.index;
      const what = am[0].toLowerCase();
      // `www.`, `mailto:` and `xmpp:` are lowercase-only (`Www.`,
      // `MAILTO:` and `XMPP:` do not link); `http://`, `https://` and
      // `ftp://` are case-insensitive
      if ((what === 'www.' || what === 'mailto:' || what === 'xmpp:') && am[0] !== what) { seg = p + 1; continue; }
      if (what === '@') {
        // email: local part runs back from p to the segment start
        let ls = p - 1;
        while (ls >= i && isLocalCh(s.charCodeAt(ls))) ls--;
        ls++;
        if (ls >= p) { seg = p + 1; continue; }
        const e = matchEmail(s, ls, hasUnderscoreOpener);
        if (e < 0 || e <= p) { seg = p + 1; continue; }
        flushText(ls);
        const txt = s.slice(ls, e);
        // an extended autolink inside brackets is deferred: if the link
        // around it forms, it goes back to plain text (see tryLink)
        const defer = brackets.some(b => b.act);
        nodes.push({ t: 'u', href: esc('mailto:' + txt), txt: esc(txt), raw: txt, defer: defer ? 1 : 0 });
        i = e;
        textStart = e;
        done = true;
        break;
      }
      if (what === 'mailto:') {
        if (!isAutoBoundary(s, p)) { seg = p + 1; continue; }
        const e = matchEmail(s, p + 7, hasUnderscoreOpener);
        if (e < 0) { seg = p + 1; continue; }
        flushText(p);
        const txt = s.slice(p, e);
        const defer = brackets.some(b => b.act);
        nodes.push({ t: 'u', href: esc(txt), txt: esc(txt), raw: txt, defer: defer ? 1 : 0 });
        i = e;
        textStart = e;
        done = true;
        break;
      }
      if (what === 'xmpp:') {
        // `xmpp:` is the one bare scheme that autolinks, and only with
        // an email after it plus at most one path segment of
        // `[a-zA-Z0-9.@]` (`xmpp:foo@bar.baz/txt@bin.com` links whole;
        // `xmpp:foo@bar.baz/txt/bin` links only to `/txt`)
        if (!isXmppBoundary(s, p)) { seg = p + 1; continue; }
        const e = matchEmail(s, p + 5, hasUnderscoreOpener);
        if (e < 0) { seg = p + 1; continue; }
        let end = e;
        if (end < n && s.charCodeAt(end) === 47) {
          let pe = end + 1;
          while (pe < n && isXmppPathCh(s.charCodeAt(pe))) pe++;
          while (pe > end + 1 && s.charCodeAt(pe - 1) === 46) pe--;
          if (pe > end + 1) end = pe;
        }
        flushText(p);
        const txt = s.slice(p, end);
        const defer = brackets.some(b => b.act);
        nodes.push({ t: 'u', href: esc(txt), txt: esc(txt), raw: txt, defer: defer ? 1 : 0 });
        i = end;
        textStart = end;
        done = true;
        break;
      }
      // www. or a scheme
      if (what === 'www.' && !isAutoBoundary(s, p)) { seg = p + 1; continue; }
      // an extended autolink inside link text never runs past the
      // `]` that closes that link text: `](...)` after a `www.` inside
      // `[text]` is the link's own closing, not part of the autolink
      let limit;
      if (brackets.some(b => b.act)) {
        const closeIdx = s.indexOf(']', p);
        if (closeIdx >= 0) limit = closeIdx;
      }
      const ext = autoExtent(s, p, limit);
      const e = trimAuto(s, p, ext);
      const minLen = what === 'www.' ? 5 : what.length + 1;
      if (e - p < minLen) { seg = p + 1; continue; }
      flushText(p);
      const txt = s.slice(p, e);
      const defer = brackets.some(b => b.act);
      const node = { t: 'u', href: esc(cleanHref(what === 'www.' ? 'http://' + txt : txt)), txt: esc(txt), raw: txt, defer: defer ? 1 : 0 };
      // If the surrounding link does NOT form, this autolink is a real
      // link and takes its greedy extent (past the `]`, e.g.
      // `https://x.io)]`): remember it so the `]` handler can extend
      // the node when tryLink fails. The greedy end is computed without
      // the `]` limit; trimAuto cuts it back at an unmatched `(`.
      if (defer) {
        const extG = autoExtent(s, p, undefined);
        const eG = trimAuto(s, p, extG);
        if (eG > e) {
          const gTxt = s.slice(p, eG);
          node.gEnd = eG;
          node.gTxt = gTxt;
          node.gHref = esc(cleanHref(what === 'www.' ? 'http://' + gTxt : gTxt));
          node.p = p;
          node.e = e;
        }
      }
      nodes.push(node);
      i = e;
      textStart = e;
      done = true;
      break;
    }
    if (done) continue;
    if (j >= n) { flushText(n); break; }
    const c = s.charCodeAt(j);
    if (c === 10) { // newline: hard break if 2+ spaces precede it
      let sp = 0;
      let k = j - 1;
      while (k >= textStart && s.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flushText(j - sp);
        nodes.push({ t: 'b' });
        // a hard break strips the leading spaces of the next line
        let ni = j + 1;
        while (ni < n && (s.charCodeAt(ni) === 32 || s.charCodeAt(ni) === 9)) ni++;
        i = ni;
        textStart = i;
      } else {
        flushText(j);
        nodes.push('\n');
        i = j + 1;
        textStart = i;
      }
      continue;
    }
    if (c === 96) { // code span
      let m2 = 0;
      while (j + m2 < n && s.charCodeAt(j + m2) === 96) m2++;
      let k = j + m2;
      let close = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 96) {
          let r = 0;
          while (k + r < n && s.charCodeAt(k + r) === 96) r++;
          if (r === m2) { close = k; break; }
          k += r;
        } else k++;
      }
      if (close < 0) { i = j + m2; continue; }
      let content = s.slice(j + m2, close);
      if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
        let allSpace = true;
        for (let q = 1; q < content.length - 1; q++) if (content.charCodeAt(q) !== 32) { allSpace = false; break; }
        if (!allSpace) content = content.slice(1, -1);
      }
      flushText(j);
      nodes.push({ t: '`', s: escRaw(content) });
      i = close + m2;
      textStart = i;
      continue;
    }
    if (c === 92) { // backslash
      if (j + 1 < n && s.charCodeAt(j + 1) === 10) {
        flushText(j);
        nodes.push({ t: 'b' });
        // a hard break strips the leading spaces of the next line
        let ni = j + 2;
        while (ni < n && (s.charCodeAt(ni) === 32 || s.charCodeAt(ni) === 9)) ni++;
        i = ni;
        textStart = i;
        continue;
      }
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        flushText(j);
        // an escaped char is its own node: the backslash is part of
        // the raw text, so a label built from it keeps the backslash
        // (`[foo\!]` must not match a `[foo!]` definition), while
        // rendering drops the backslash
        nodes.push({ t: 'x', c: s[j + 1] });
        i = j + 2;
        textStart = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 38) { // & entity
      const e = entityAt(s, j);
      if (e) {
        flushText(j);
        nodes.push(e[1]); // ready-to-output: decoded char or literal &name;
        i = e[0];
        textStart = i;
        continue;
      }
      // not an entity at all: the `&` itself is escaped (`&#x;` -> `&amp;#x;`)
      flushText(j);
      nodes.push('&amp;');
      i = j + 1;
      textStart = i;
      continue;
    }
    if (c === 60) { // < : autolink or raw HTML
      let handled = false;
      const gt = s.indexOf('>', j + 1);
      if (gt > j + 1) {
        const inner = s.slice(j + 1, gt);
        if (inner.indexOf('\n') < 0 && inner.indexOf('<') < 0) {
          const colon = inner.indexOf(':');
          if (colon >= 2 && colon <= 32) {
            const sch = inner.slice(0, colon);
            let okSch = isAlpha(sch.charCodeAt(0));
            for (let q = 1; q < sch.length && okSch; q++) {
              const d = sch.charCodeAt(q);
              if (!isAlnum(d) && d !== 43 && d !== 45 && d !== 46) okSch = false;
            }
            if (okSch) {
              let okRest = true;
              for (let q = colon + 1; q < inner.length; q++) {
                const d = inner.charCodeAt(q);
                if (d <= 32 || d === 60 || d === 62) { okRest = false; break; }
              }
              if (okRest) {
                flushText(j);
                nodes.push({ t: 'u', href: esc(cleanHref(inner)), txt: esc(inner) });
                i = gt + 1;
                textStart = i;
                handled = true;
              }
            }
          }
          if (!handled) {
            const at = inner.indexOf('@');
            if (at > 0 && inner.indexOf('@', at + 1) < 0) {
              const local = inner.slice(0, at);
              const dom = inner.slice(at + 1);
              let okL = local.length > 0;
              for (let q = 0; q < local.length && okL; q++) if (!isLocalCh(local.charCodeAt(q))) okL = false;
              let okD = dom.length > 0 && dom.indexOf('.') >= 0 && dom.charCodeAt(0) !== 46 && dom.charCodeAt(dom.length - 1) !== 46;
              for (let q = 0; q < dom.length && okD; q++) if (!isDomainCh(dom.charCodeAt(q))) okD = false;
              if (okL && okD) {
                flushText(j);
                nodes.push({ t: 'u', href: esc('mailto:' + inner), txt: esc(inner) });
                i = gt + 1;
                textStart = i;
                handled = true;
              }
            }
          }
        }
      }
      if (!handled) {
        const he = matchHtml(s, j);
        if (he > 0) {
          flushText(j);
          const tag = s.slice(j, he);
          nodes.push({ t: 'h', s: tag });
          // a raw `<a href="...">` opens the inLink state (extended
          // autolinks suppressed until `</a>`); a raw `</a>` closes it
          if (anchorOpen(tag)) inLink = true;
          else if (anchorClose(tag)) inLink = false;
          i = he;
          textStart = i;
        } else {
          i = j + 1;
        }
      }
      continue;
    }
    if (c === 91) { // [
      flushText(j);
      const br = { t: '[', img: 0, act: 1, pos: nodes.length };
      nodes.push(br);
      brackets.push(br);
      i = j + 1;
      textStart = i;
      continue;
    }
    if (c === 33) { // !
      if (j + 1 < n && s.charCodeAt(j + 1) === 91) {
        flushText(j);
        const br = { t: '[', img: 1, act: 1, pos: nodes.length };
        nodes.push(br);
        brackets.push(br);
        i = j + 2;
        textStart = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 93) { // ] : the link text is the pending text run, so flush it first
      flushText(j);
      const e = tryLink(s, j, nodes, brackets, refs);
      if (e >= 0) {
        i = e;
        textStart = i;
      } else {
        // The link did not form: a deferred autolink inside it is a
        // real link and takes its greedy extent (past the `]`, e.g.
        // `https://x.io)]`). Extend the most recent deferred autolink
        // whose greedy end covers this `]`, absorbing the text nodes
        // between it and the `]` and skipping past the `]`.
        let extended = false;
        for (let k = nodes.length - 1; k >= 0; k--) {
          const nd = nodes[k];
          if (typeof nd !== 'string' && nd.t === '[') break;
          if (typeof nd === 'string' || nd.t !== 'u' || !nd.defer || nd.gEnd === undefined || nd.gEnd < j + 1) continue;
          // only extend when everything after the autolink is plain
          // text (no delimiters/links in between that must survive)
          let allText = true;
          for (let q = k + 1; q < nodes.length; q++) {
            if (typeof nodes[q] !== 'string') { allText = false; break; }
          }
          if (!allText) break;
          nd.txt = esc(nd.gTxt);
          nd.href = nd.gHref;
          nd.raw = nd.gTxt;
          nd.defer = 0;
          nodes.length = k + 1;
          i = nd.gEnd;
          textStart = nd.gEnd;
          extended = true;
          break;
        }
        if (!extended) i = j + 1;
      }
      continue;
    }
    // * _ ~ delimiter run
    let m2 = 0;
    while (j + m2 < n && s.charCodeAt(j + m2) === c) m2++;
    // A tilde run of 3+ is not a strikethrough delimiter at all
    // (`~~~not~~~` stays literal); it is plain text.
    if (c === 126 && m2 >= 3) { i = j + m2; continue; }
    const [left, right, pb, pa] = flank(s, j, m2);
    let open = left;
    let close = right;
    if (c === 95) { // _
      open = left && (!right || pb);
      close = right && (!left || pa);
    }
    flushText(j);
    nodes.push({ t: 'd', ch: String.fromCharCode(c), n: m2, open, close });
    i = j + m2;
    textStart = i;
  }
  // a branch above can advance `i` to the end without flushing the
  // pending text run (an unclosed backtick run, a trailing backslash);
  // flush it here so `two`` ` and a lone backtick survive
  flushText(n);
  processEmphasis(nodes);
  return nodes;
}

// ------------------------------------------------- link reference definitions
// Parse leading link reference definitions from paragraph text `s`, adding
// them to `refs` (first definition of a label wins). Returns the text that
// remains after the definitions.
function stripRefDefs(s, refs) {
  let i = 0;
  const n = s.length;
  while (true) {
    let k = i;
    let sp = 0;
    while (k < n && s.charCodeAt(k) === 32 && sp < 3) { sp++; k++; }
    if (k >= n || s.charCodeAt(k) !== 91) break;
    let l = k + 1;
    let label = null;
    while (l < n) {
      const c = s.charCodeAt(l);
      if (c === 92 && l + 1 < n) { l += 2; continue; }
      if (c === 91) break;
      if (c === 93) { label = s.slice(k + 1, l); break; }
      l++;
    }
    if (label === null || label.length === 0 || label.length > 999) break;
    let m = l + 1;
    if (m >= n || s.charCodeAt(m) !== 58) break;
    m++;
    const d = parseDest(s, m);
    if (!d) break;
    // The destination may be followed by a title on the same line or the
    // next line, but a title must be separated from the destination by
    // whitespace (`[foo]: <bar>(baz)` is not a definition). A title on
    // the same line must be alone on its line or the definition is
    // invalid; a title on the next line is only taken when it is alone
    // on its line, otherwise the definition simply ends at the
    // destination (`[foo]: /url\n"title" ok` -> def without a title).
    let p = d[1];
    while (p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
    let title = null;
    let defEnd = -1;
    if (p < n && s.charCodeAt(p) !== 10) {
      const q = s.charCodeAt(p);
      if (q === 34 || q === 39 || q === 40) {
        if (p === d[1]) break; // no whitespace before the title
        const t = parseTitle(s, p);
        if (!t) break;
        title = t[0];
        p = t[1];
      } else break; // junk after the destination on its own line
      let e = p;
      while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
      if (e < n && s.charCodeAt(e) !== 10) break;
      defEnd = e < n ? e + 1 : e;
    } else {
      let e = p;
      while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
      if (e < n && s.charCodeAt(e) !== 10) break;
      defEnd = e < n ? e + 1 : e;
      if (e < n && s.charCodeAt(e) === 10) {
        let p2 = e + 1;
        while (p2 < n && (s.charCodeAt(p2) === 32 || s.charCodeAt(p2) === 9)) p2++;
        if (p2 < n) {
          const q = s.charCodeAt(p2);
          if (q === 34 || q === 39 || q === 40) {
            const t = parseTitle(s, p2);
            if (t) {
              let e2 = t[1];
              while (e2 < n && (s.charCodeAt(e2) === 32 || s.charCodeAt(e2) === 9)) e2++;
              if (e2 >= n || s.charCodeAt(e2) === 10) {
                title = t[0];
                defEnd = e2 < n ? e2 + 1 : e2;
              }
            }
          }
        }
      }
    }
    const key = normalizeLabel(label);
    // a label that normalises to empty (whitespace only) is not a
    // definition at all
    if (key.length === 0) break;
    if (!refs.has(key)) refs.set(key, [d[0], title]);
    i = defEnd;
  }
  return s.slice(i);
}

// ------------------------------------------------------------- block parsing
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// ATX heading at the start of `cur` (indent already known < 4).
// Returns {level, text} or null.
function matchAtx(cur, idx) {
  let i = idx;
  let level = 0;
  while (i < cur.length && cur.charCodeAt(i) === 35) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < cur.length) {
    const c = cur.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  let t = cur.slice(i);
  let s2 = 0;
  while (s2 < t.length && (t.charCodeAt(s2) === 32 || t.charCodeAt(s2) === 9)) s2++;
  let e = t.length;
  while (e > s2 && (t.charCodeAt(e - 1) === 32 || t.charCodeAt(e - 1) === 9)) e--;
  t = t.slice(s2, e);
  let k = t.length;
  while (k > 0 && t.charCodeAt(k - 1) === 35) k--;
  // a closing sequence needs a space before it, except when the whole
  // heading text is `#`s (`# #`, `### ###` are empty headings)
  if (k < t.length && (k === 0 || t.charCodeAt(k - 1) === 32 || t.charCodeAt(k - 1) === 9)) {
    t = t.slice(0, k);
    e = t.length;
    while (e > 0 && (t.charCodeAt(e - 1) === 32 || t.charCodeAt(e - 1) === 9)) e--;
    t = t.slice(0, e);
  }
  return { level, text: t };
}

// Thematic break: 3+ of the same - _ * with spaces between, nothing else.
function matchThematic(cur, idx) {
  let i = idx;
  let ch = 0;
  let count = 0;
  while (i < cur.length) {
    const c = cur.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 45 || c === 95 || c === 42) {
      if (ch === 0) ch = c;
      else if (c !== ch) return false;
      count++;
      i++;
      continue;
    }
    return false;
  }
  return ch !== 0 && count >= 3;
}

// Fenced code start. Returns {ch, len, info, indent} or null.
function matchFence(cur, idx) {
  const c0 = cur.charCodeAt(idx);
  if (c0 !== 96 && c0 !== 126) return null;
  let i = idx;
  let len = 0;
  while (i < cur.length && cur.charCodeAt(i) === c0) { len++; i++; }
  if (len < 3) return null;
  const info = cur.slice(i);
  if (c0 === 96 && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(c0), len, info };
}

// HTML block start type (1-7) at the start of `cur`, or 0.
// Returns [type, tag]: the HTML block type (0 = none) and, for type 1,
// the tag name whose closing tag ends the block (lowercase).
function matchHtmlBlock(cur, idx) {
  const s = cur.slice(idx);
  const low = s.toLowerCase();
  if (low.startsWith('<!--')) return [2, null];
  if (low.startsWith('<?')) return [3, null];
  if (low.startsWith('<![cdata[')) return [5, null];
  if (s.length >= 3 && s.charCodeAt(0) === 60 && s.charCodeAt(1) === 33) {
    const c2 = s.charCodeAt(2);
    if (c2 >= 65 && c2 <= 90) return [4, null];
  }
  // type 1: script, pre, style, textarea
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (low.startsWith('<' + tag)) {
      const ai = 1 + tag.length;
      const after = ai >= low.length ? -1 : low.charCodeAt(ai);
      if (after === -1 || after === 32 || after === 9 || after === 62 || after === 47 || after === 10) return [1, tag];
    }
  }
  // type 6: block-level tag
  let m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = m[0].length >= s.length ? -1 : s.charCodeAt(m[0].length);
    if (after === -1 || after === 32 || after === 9 || after === 62 || after === 47 || after === 10) return [6, null];
  }
  // type 7: a complete tag alone on the line
  const he = matchHtml(cur, idx);
  if (he > 0) {
    let e = he;
    while (e < cur.length && (cur.charCodeAt(e) === 32 || cur.charCodeAt(e) === 9)) e++;
    if (e >= cur.length) return [7, null];
  }
  return [0, null];
}

// Does line `s` contain the closing tag `</tag` (case-insensitive)?
// The char after the tag name must not be a letter, digit or `-`, so
// `</stylefoo>` does not close a `style` block.
function hasCloseTag(s, tag) {
  const n = s.length;
  for (let i = 0; i + 2 + tag.length <= n; i++) {
    if (s.charCodeAt(i) === 60 && s.charCodeAt(i + 1) === 47) {
      let ok = true;
      for (let k = 0; k < tag.length; k++) {
        let a = s.charCodeAt(i + 2 + k);
        if (a >= 65 && a <= 90) a += 32;
        if (a !== tag.charCodeAt(k)) { ok = false; break; }
      }
      if (ok) {
        const j = i + 2 + tag.length;
        if (j >= n) return true;
        const c = s.charCodeAt(j);
        if (!(c >= 48 && c <= 57) && !(c >= 65 && c <= 90) && !(c >= 97 && c <= 122) && c !== 45) return true;
      }
    }
  }
  return false;
}

// Does line `s` contain the end marker for HTML block `b`?
function htmlBlockEnds(s, b) {
  if (b.endTag) return hasCloseTag(s, b.endTag);
  if (b.endSub !== null) return s.indexOf(b.endSub) >= 0;
  return false;
}

// Setext underline: returns 1 for ===, 2 for ---, else 0.
function matchSetext(cur, idx) {
  let i = idx;
  const c0 = cur.charCodeAt(i);
  if (c0 !== 61 && c0 !== 45) return 0;
  while (i < cur.length && cur.charCodeAt(i) === c0) i++;
  while (i < cur.length && (cur.charCodeAt(i) === 32 || cur.charCodeAt(i) === 9)) i++;
  if (i >= cur.length) return c0 === 61 ? 1 : 2;
  return 0;
}

// List item start. `idx` is the char index of the marker in `cur`, `col`
// the column at which `cur` starts, `ind` the indent in columns.
function matchListItem(cur, idx, col, ind) {
  const c0 = cur.charCodeAt(idx);
  let ordered = false;
  let bullet = 0;
  let delim = 0;
  let start = 0;
  let markerLen = 0;
  let i = idx;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    bullet = c0;
    markerLen = 1;
    i++;
  } else if (c0 >= 48 && c0 <= 57) {
    let num = 0;
    let digits = 0;
    while (i < cur.length && cur.charCodeAt(i) >= 48 && cur.charCodeAt(i) <= 57 && digits < 9) {
      num = num * 10 + (cur.charCodeAt(i) - 48);
      digits++;
      i++;
    }
    if (digits === 0) return null;
    if (i >= cur.length) return null;
    const d = cur.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    delim = d;
    start = num;
    ordered = true;
    markerLen = i - idx + 1;
    i++;
  } else return null;
  // the marker must be followed by a space/tab or the end of the line
  if (i < cur.length) {
    const c = cur.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  const markerOff = col + ind;
  // spaces after the marker, in columns
  let sp = 0;
  let j = i;
  let cc = markerOff + markerLen;
  while (j < cur.length) {
    const c = cur.charCodeAt(j);
    if (c === 32) { sp++; cc++; j++; }
    else if (c === 9) { const w = 4 - (cc % 4); sp += w; cc += w; j++; }
    else break;
  }
  const empty = j >= cur.length;
  let contentIndent;
  let rest;
  if (empty) {
    contentIndent = markerOff + markerLen + 1;
    rest = '';
  } else if (sp >= 5) {
    contentIndent = markerOff + markerLen + 1;
    // the content starts one column past the marker: strip that one
    // column from the text after the marker
    rest = stripToCol(cur.slice(i), markerOff + markerLen, markerOff + markerLen + 1);
  } else {
    contentIndent = markerOff + markerLen + sp;
    rest = cur.slice(j);
  }
  return { ordered, bullet, delim, start, markerLen, markerOff, contentIndent, rest, empty };
}

// Split a table row line into cells (unescaped pipes separate cells).
function splitRow(s) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) {
      // an escaped pipe is a literal pipe in the cell (it only escaped
      // the cell split); the backslash itself does not survive, so a
      // `\|` inside a code span renders as `|` too
      cur += '|';
      i++;
      continue;
    }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  // drop the empty cells implied by leading/trailing pipes
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// Parse a table delimiter row. Returns aligns array or null.
function parseDelimiterRow(s) {
  const cells = splitRow(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    let t = cell.trim();
    if (t.length === 0) return null;
    let left = false, right = false;
    if (t.charCodeAt(0) === 58) { left = true; t = t.slice(1); }
    if (t.length > 0 && t.charCodeAt(t.length - 1) === 58) { right = true; t = t.slice(0, -1); }
    if (t.length === 0) return null;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) !== 45) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Task marker at the start of an item's first line: `[ ]` or `[x]`/`[X]`
// followed by whitespace and then non-whitespace content on the same
// line. Returns [checked, endIndex] (endIndex is just past the whitespace
// run, so the whole `[ ]` + whitespace is the prefix) or null. A `[ ]`
// with nothing after it, or with its content on a later line, is not a
// task.
function taskPrefix(text) {
  if (text.length < 3) return null;
  if (text.charCodeAt(0) !== 91) return null;
  const c = text.charCodeAt(1);
  if (c !== 32 && c !== 120 && c !== 88) return null;
  if (text.charCodeAt(2) !== 93) return null;
  let k = 3;
  if (k >= text.length || (text.charCodeAt(k) !== 32 && text.charCodeAt(k) !== 9)) return null;
  while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k >= text.length) return null;
  return [c === 32 ? 0 : 1, k];
}

// Blockquote prefix at the start of `rem` (which starts at column `col`).
// Returns {rem, col, markerCol} or null. The space after `>` is a single
// column: a tab there counts as one column too, and the rest of the tab
// becomes spaces (`>\tfoo` -> content `  foo`).
function matchQuote(rem, col) {
  let cc = col, ii = 0;
  while (ii < rem.length) {
    const ch = rem.charCodeAt(ii);
    if (ch === 32) { if (cc - col >= 3) break; cc++; ii++; }
    else if (ch === 9) { const w = 4 - (cc % 4); if (cc - col + w > 3) break; cc += w; ii++; }
    else break;
  }
  if (cc - col > 3) return null;
  if (ii >= rem.length || rem.charCodeAt(ii) !== 62) return null;
  const markerCol = cc;
  cc++; ii++;
  if (ii < rem.length) {
    const c = rem.charCodeAt(ii);
    if (c === 32) { cc++; ii++; }
    // a tab after `>` is NOT consumed here: it stays in `rem` so the
    // caller expands it at the content column (consuming one column
    // of it here would under-expand it for nested quotes, e.g.
    // `>>\tfoo` should give two spaces, not one)
  }
  return { rem: rem.slice(ii), col: cc, markerCol };
}

// Expand the leading whitespace run of `s` (spaces and tabs) to spaces,
// assuming `s` starts at column `col`. Used when a container has consumed
// part of a line and the rest starts with a tab: the tab expands to the
// next multiple of 4 columns, so `> \tfoo` becomes content `  foo`.
function expandLead(s, col) {
  let i = 0, c = col, out = '';
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 9) { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
    else if (ch === 32) { out += ' '; c++; i++; }
    else break;
  }
  if (i === 0) return s;
  return out + s.slice(i);
}

function listMatches(list, it) {
  if (list.ordered !== it.ordered) return false;
  if (it.ordered) return list.delim === it.delim;
  return list.bullet === it.bullet;
}

function fenceInfoLang(info) {
  let i = 0;
  while (i < info.length && (info.charCodeAt(i) === 32 || info.charCodeAt(i) === 9)) i++;
  let j = i;
  while (j < info.length && info.charCodeAt(j) !== 32 && info.charCodeAt(j) !== 9) j++;
  const w = info.slice(i, j);
  if (w.indexOf('\\') < 0) return w;
  // backslash escapes in the info string are unescaped (`foo\+bar` -> `foo+bar`)
  let out = '';
  let last = 0;
  for (let k = 0; k < w.length; k++) {
    if (w.charCodeAt(k) === 92 && k + 1 < w.length && isEscapable(w.charCodeAt(k + 1))) {
      out += w.slice(last, k) + w[k + 1];
      last = k + 2;
      k++;
    }
  }
  return last === 0 ? w : out + w.slice(last);
}

function isClosingFence(rem, col, leaf) {
  const [ind, idx] = indentOf(rem, col);
  if (ind >= 4) return false;
  const c0 = rem.charCodeAt(idx);
  if (c0 !== leaf.ch.charCodeAt(0)) return false;
  let i = idx, len = 0;
  while (i < rem.length && rem.charCodeAt(i) === c0) { len++; i++; }
  if (len < leaf.len) return false;
  while (i < rem.length && (rem.charCodeAt(i) === 32 || rem.charCodeAt(i) === 9)) i++;
  return i >= rem.length;
}

// Parse the blocks of `src` (already newline-normalised). Returns the
// document node. Link reference definitions are collected into `refs`.
function parseBlocks(src, refs) {
  const lines = [];
  const lineNL = [];
  let start = 0;
  for (let p = 0; p < src.length; p++) {
    if (src.charCodeAt(p) === 10) { lines.push(src.slice(start, p)); lineNL.push(true); start = p + 1; }
  }
  if (start < src.length) { lines.push(src.slice(start)); lineNL.push(false); }
  else if (src.length === 0) { lines.push(''); lineNL.push(false); }
  const N = lines.length;

  const doc = { t: 'doc', ch: [] };
  const stack = [doc]; // open containers (doc first)
  let leaf = null;
  let li = 0;
  let lineQuoteCol = -1; // column of the outermost `>` matched on this line
  // A type 1-5 HTML block that just ended at its closing tag: whether
  // its trailing newline survives is decided by the next line (it is
  // kept only if that line is non-blank and still inside the block's
  // parent container), so it is recorded here until then.
  let pendingHtml = null;
  function noteHtmlEnd(node, endLine, parentDepth) {
    pendingHtml = { node, endLine, parentDepth };
  }

  // Pop the innermost open container. A blank line at the end of a
  // list item means its parent list ends with a blank line too, and a
  // blank line at the end of a nested list means the parent item ends
  // with one too (`* foo\n  * bar\n\n  baz` is loose); so the flag
  // propagates up from an item or a list. It does NOT propagate from
  // a block quote: a blank line inside a quote does not make the outer
  // list loose (`* a\n > b\n >\n* c` stays tight).
  function popContainer() {
    const c = stack.pop();
    if (c && (c.t === 'item' || c.t === 'list') && c.lastBlank && stack.length > 0) stack[stack.length - 1].lastBlank = true;
  }

  function addBlock(parent, child) {
    // A list can only contain list items: any other block ends the list
    // (and is added to the list's parent instead).
    if (parent.t === 'list' && child.t !== 'item') {
      if (stack[stack.length - 1] === parent) popContainer();
      addBlock(stack[stack.length - 1], child);
      return;
    }
    child.parent = parent;
    if (child.t === 'item' && parent.t === 'list') {
      if (parent.lastBlank && parent.ch.length > 0) parent.loose = true;
    } else if (parent.t === 'item') {
      if (parent.lastBlank && parent.ch.length > 0 && parent.list) parent.list.loose = true;
    }
    parent.ch.push(child);
    parent.lastBlank = false;
  }

  function finalizeLeaf(b) {
    if (b.t === 'para') {
      const text = b.lines.join('\n');
      const rest = stripRefDefs(text, refs);
      if (rest.length === 0) {
        const par = b.parent;
        if (par && par.ch[par.ch.length - 1] === b) par.ch.pop();
        b.text = '';
        b.dropped = true;
        return;
      }
      b.text = rest;
      // (task markers are only recognised on the item's first line, at
      // item creation in startBlocks; a `[ ]` on a continuation line is
      // literal text, so nothing is done here)
    } else if (b.t === 'code') {
      if (!b.fence) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
      b.content = b.lines.join('\n');
      // the content ends with a newline when the last line is not
      // blank (a trailing blank line already ends the join with one)
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] !== '') b.content += '\n';
    } else if (b.t === 'html') {
      // the trailing newline is decided at render time: it is kept only
      // when the block's last line had one and noTrailNL was not set
      // (a blank line or a container end after the block removes it)
      b.content = b.lines.join('\n');
    }
  }

  function closeLeaf() {
    if (leaf) { const b = leaf; leaf = null; finalizeLeaf(b); }
  }

  // Match the open containers against `line`. Returns {matched, rem, col}.
  // Also records lineQuoteCol (the outermost `>` matched on this line).
  function matchContainers(line) {
    let rem = line;
    let col = 0;
    let matched = 1;
    lineQuoteCol = -1;
    for (let k = 1; k < stack.length; k++) {
      const c = stack[k];
      if (c.t === 'list') { matched++; continue; }
      if (c.t === 'quote') {
        const q = matchQuote(rem, col);
        if (!q) break;
        if (lineQuoteCol < 0) lineQuoteCol = q.markerCol;
        rem = q.rem;
        col = q.col;
        matched++;
        continue;
      }
      if (c.t === 'item') {
        if (isBlank(rem)) { matched++; continue; }
        const [ind] = indentOf(rem, col);
        // The item's content indent is measured from the start of the
        // parent container's content (see relIndent): the outer
        // containers (quotes) can sit at different columns on
        // different lines, so only the indent left after them counts
        // (`   > > 1.  one` then `>>     two`).
        if (ind < c.relIndent) break;
        rem = stripToCol(rem, col, col + c.relIndent);
        col = col + c.relIndent;
        matched++;
        continue;
      }
      break;
    }
    return { matched, rem, col };
  }

  // Does `rem` start a block that can interrupt a paragraph?
  // Returns {kind:'setext',level} | {kind:'start'} | null. A setext
  // underline cannot be a lazy continuation line, so callers pass
  // allowSetext=false when the line did not match all open containers.
  // `inList` is true when the paragraph sits inside a list item: an
  // ordered item may then interrupt it whatever its start number is
  // (`1. foo\n2. bar` -> two items), while at the top level only an
  // ordered item starting at 1 can. An empty list item (`foo\n*`)
  // never interrupts a paragraph.
  function interruptingStart(rem, col, allowSetext, inList) {
    const [ind, idx] = indentOf(rem, col);
    if (ind >= 4) return null;
    if (allowSetext !== false) {
      const se = matchSetext(rem, idx);
      if (se) return { kind: 'setext', level: se };
    }
    if (matchFence(rem, idx)) return { kind: 'start' };
    const [hb] = matchHtmlBlock(rem, idx);
    if (hb >= 1 && hb <= 6) return { kind: 'start' };
    if (matchAtx(rem, idx)) return { kind: 'start' };
    if (matchThematic(rem, idx)) return { kind: 'start' };
    const li2 = matchListItem(rem, idx, col, ind);
    // inside a list any item interrupts (a new item, or a new list);
    // at the top level only a non-empty bullet item or a non-empty
    // ordered item starting at 1 does
    if (li2 && (inList || (!li2.empty && (!li2.ordered || li2.start === 1)))) return { kind: 'start' };
    if (matchQuote(rem, col)) return { kind: 'start' };
    return null;
  }

  // Does `rem` start a block-level structure (used to end a table)?
  // A setext underline or a link reference definition does NOT end a
  // table: those lines are table rows.
  function tableRowEnd(rem, col) {
    const [ind, idx] = indentOf(rem, col);
    if (ind >= 4) return true;
    if (matchFence(rem, idx)) return true;
    const [hb] = matchHtmlBlock(rem, idx);
    if (hb) return true;
    if (matchAtx(rem, idx)) return true;
    if (matchThematic(rem, idx)) return true;
    if (matchListItem(rem, idx, col, ind)) return true;
    if (matchQuote(rem, col)) return true;
    return false;
  }

  // Try to parse a table starting at the current line (header `cur`).
  // Returns the table node or null; on success advances `li` past the rows.
  function tryTable(cur) {
    if (li + 1 >= N) return null;
    const mc = matchContainers(lines[li + 1]);
    if (mc.matched !== stack.length) return null;
    const aligns = parseDelimiterRow(mc.rem);
    if (!aligns) return null;
    const header = splitRow(cur);
    // the delimiter row must have exactly as many cells as the header
    if (header.length !== aligns.length) return null;
    const table = { t: 'table', aligns, header, rows: [] };
    let k = li + 1;
    while (k + 1 < N) {
      const rl = lines[k + 1];
      const m2 = matchContainers(rl);
      if (m2.matched !== stack.length) break;
      // a lone-tab line is an empty row, not a table-ending blank line
      if (isTabRow(m2.rem, m2.col)) { table.rows.push(splitRow(m2.rem)); k++; continue; }
      if (isBlank(m2.rem)) break;
      // a row is any non-blank line that matches the containers and does
      // not start another block; it does not need a `|` in it
      if (tableRowEnd(m2.rem, m2.col)) break;
      table.rows.push(splitRow(m2.rem));
      k++;
    }
    li = k;
    return table;
  }

  // Start new blocks from the remainder `cur` (column `col`) of line `li`.
  function startBlocks(cur, col) {
    while (true) {
      if (isBlank(cur)) return;
      const [ind, idx] = indentOf(cur, col);
      if (ind >= 4) {
        const code = { t: 'code', fence: 0, lines: [stripToCol(cur, col, col + 4)], lastNL: lineNL[li] };
        addBlock(stack[stack.length - 1], code);
        leaf = code;
        return;
      }
      const bq = matchQuote(cur, col);
      if (bq) {
        const q = { t: 'quote', ch: [], lastBlank: false };
        addBlock(stack[stack.length - 1], q);
        stack.push(q);
        if (lineQuoteCol < 0) lineQuoteCol = bq.markerCol;
        cur = bq.rem;
        col = bq.col;
        if (cur.length > 0 && (cur.charCodeAt(0) === 32 || cur.charCodeAt(0) === 9)) {
          cur = expandLead(cur, lineQuoteCol + 2);
        }
        continue;
      }
      const atx = matchAtx(cur, idx);
      if (atx) {
        addBlock(stack[stack.length - 1], { t: 'head', level: atx.level, text: atx.text });
        return;
      }
      const fence = matchFence(cur, idx);
      if (fence) {
        const code = { t: 'code', fence: 1, ch: fence.ch, len: fence.len, indent: ind, lang: fenceInfoLang(fence.info), lines: [], lastNL: lineNL[li] };
        addBlock(stack[stack.length - 1], code);
        leaf = code;
        return;
      }
      const [hb, endTag] = matchHtmlBlock(cur, idx);
      if (hb) {
        const endSub = hb === 2 ? '-->' : hb === 3 ? '?>' : hb === 4 ? '>' : hb === 5 ? ']]>' : null;
        const html = { t: 'html', type: hb, endSub, endTag, lines: [cur], lastNL: lineNL[li] };
        addBlock(stack[stack.length - 1], html);
        if (htmlBlockEnds(cur, html)) { finalizeLeaf(html); noteHtmlEnd(html, li, stack.length); }
        else leaf = html;
        return;
      }
      if (matchThematic(cur, idx)) {
        addBlock(stack[stack.length - 1], { t: 'hr' });
        return;
      }
      const it = matchListItem(cur, idx, col, ind);
      if (it) {
        let rest = it.rest;
        let task = null;
        const tm = taskPrefix(rest);
        if (tm) { task = tm[0]; rest = rest.slice(tm[1]); }
        let parent = stack[stack.length - 1];
        let list = null;
        if (parent.t === 'list' && listMatches(parent, it)) list = parent;
        else {
          if (parent.t === 'list') { popContainer(); parent = stack[stack.length - 1]; }
          list = { t: 'list', ordered: it.ordered, start: it.start, delim: it.delim, bullet: it.bullet, ch: [], loose: false, lastBlank: false };
          addBlock(parent, list);
          stack.push(list);
        }
        // relIndent is the content indent measured from the start of
        // the parent container's content on this line (the `col` the
        // item was created at), not an absolute column: the outer
        // containers (quotes) can sit at different columns on
        // different lines, so only the indent left after them counts
        const item = { t: 'item', contentIndent: it.contentIndent, markerOff: it.markerOff, relIndent: it.contentIndent - col, ch: [], lastBlank: false, list, task };
        addBlock(list, item);
        stack.push(item);
        cur = rest;
        col = it.contentIndent;
        continue;
      }
      if (cur.indexOf('|') >= 0) {
        const tbl = tryTable(cur);
        if (tbl) { addBlock(stack[stack.length - 1], tbl); return; }
      }
      const para = { t: 'para', lines: [cur], lastLazy: false };
      addBlock(stack[stack.length - 1], para);
      leaf = para;
      return;
    }
  }

  for (li = 0; li < N; li++) {
    const line = lines[li];
    const mc = matchContainers(line);
    const matched = mc.matched;
    // A line is blank when it is whitespace, or when nothing is left
    // after the container markers (`>` on its own ends a paragraph
    // inside the quote, just like an empty line; `>  ` leaves a single
    // space, so it is not blank).
    const blank = isBlank(line) || mc.rem.length === 0;
    let rem = mc.rem;
    let col = mc.col;
    // A tab at the start of the content (after the containers) expands
    // to spaces up to the next multiple of 4 columns. For a fenced-code
    // content line the column depends on the containers: inside a list
    // item it is the true absolute column (`col`, so `>   \tindented`
    // in a list item wants 4 spaces), while directly in a quote it is
    // the outermost `>` marker's column + 2 (so `> > \tindented` wants
    // 2 spaces). For other lines the column is the outermost `>`
    // marker's column + 2 when a quote matched (nested quotes expand
    // as if the content started at column 2), else the content column
    // itself. A line with no matched container keeps its tab
    // (`a\n\tb` stays `a\n\tb`).
    if (matched > 1 && rem.length > 0 && (rem.charCodeAt(0) === 32 || rem.charCodeAt(0) === 9)) {
      const isFenceContent = leaf !== null && leaf.t === 'code' && leaf.fence && !blank;
      let expCol;
      if (isFenceContent) {
        const inList = stack.slice(0, matched).some(c => c.t === 'list' || c.t === 'item');
        // A quote nested inside a list item expands its tab from the
        // `>` marker's own column (`- a\n\n  > ```\n  > \tfoo` -> 2
        // spaces), not from the absolute content column (4 spaces)
        // and not from marker+2. Only when a list is actually an
        // ancestor of the quote in the matched containers; a list
        // that merely precedes the quote as a sibling does not count.
        // A list nested inside a quote still uses the absolute column
        // (`> \tindented` in a quote+list -> 4 spaces).
        // The column to expand from is whichever of the `>` marker
        // column and the content column is 2 mod 4: the tab then
        // expands to 2 spaces. A `>` at col 2 (content col 4) uses
        // the marker column; a `>` at col 4 (content col 6, as in
        // doc-12's `    > \tindented` inside a `+` item) uses the
        // content column — the marker column there would give 4.
        let quoteInList = false;
        if (lineQuoteCol >= 0) {
          let seenList = false;
          for (let q = 1; q < matched; q++) {
            const ct = stack[q].t;
            if (ct === 'list' || ct === 'item') seenList = true;
            else if (ct === 'quote' && seenList) { quoteInList = true; break; }
          }
        }
        if (quoteInList) expCol = (lineQuoteCol % 4 === 2) ? lineQuoteCol : col;
        else expCol = inList ? col : (lineQuoteCol >= 0 ? lineQuoteCol + 2 : col);
      } else {
        expCol = lineQuoteCol >= 0 ? lineQuoteCol + 2 : col;
      }
      rem = expandLead(rem, expCol);
    }
    const leafOpen = leaf !== null;
    // A type 1-5 HTML block ended at its closing tag on the previous
    // line: its trailing newline is kept only if this line is non-blank
    // and still inside the block's parent container. A whitespace-only
    // line (a lone tab or spaces) does NOT drop the newline — only a
    // truly empty line (or a line that leaves the container) does
    // (`<script>a</script>\n\t\nfoo` keeps the `\n` after `</script>`).
    if (pendingHtml && li === pendingHtml.endLine + 1) {
      if (line.length === 0 || mc.rem.length === 0 || matched < pendingHtml.parentDepth) pendingHtml.node.noTrailNL = true;
      pendingHtml = null;
    }
    // A fenced code block's content lines do not need to match a list
    // item's indent: once the block has content, it runs until its
    // closing fence, even if a content line is not indented enough to
    // be inside the list item that holds it (`function f...` at
    // column 0 stays code). But a line that does not match a
    // block-quote container DOES end the block: the `>` marker is
    // required (`> ```\nfoo` leaves `foo` as a top-level paragraph,
    // not code). And a fence with NO content yet also ends when its
    // first content line does not match the container (`- a\n  ```\nfoo`
    // -> empty code block, `foo` is a top-level paragraph).
    if (leafOpen && leaf.t === 'code' && leaf.fence && !blank) {
      const firstUnmatched = matched < stack.length ? stack[matched] : null;
      if (!firstUnmatched || firstUnmatched.t !== 'quote') {
        if (matched < stack.length && leaf.lines.length === 0) {
          // no content yet and a container did not match: fall
          // through to the container-pop handling below, which ends
          // the (empty) code block and its container
        } else {
          if (isClosingFence(rem, col, leaf)) {
            closeLeaf();
            while (stack.length > matched) popContainer();
            continue;
          }
          leaf.lines.push(stripFenceIndent(rem, leaf.indent));
          leaf.lastNL = lineNL[li];
          continue;
        }
      }
      // else: the line lacks a `>` for an open quote, so the block
      // ends here; fall through to the container-pop handling below
    }
    // The containers that did not match this line are closed, whether
    // or not a leaf is open: otherwise the next block would be added
    // inside a dead container (`- one\n\n two` -> ` two` is a top-level
    // paragraph, not a second paragraph of the item).
    if (matched < stack.length) {
      if (leafOpen && leaf.t === 'para' && !blank) {
        // a setext underline cannot be a lazy continuation line
        const inList = stack.some(c => c.t === 'list');
        const intr = interruptingStart(rem, col, false, inList);
        if (intr === null) {
          // lazy continuation: a leading run of 4+ columns of
          // whitespace loses 4 columns (`> a\n\tb` -> `a\nb`)
          const [lind] = indentOf(rem, col);
          if (lind >= 4) rem = stripToCol(rem, col, col + 4);
          // a setext underline line that follows another lazy line is
          // indented by 4 spaces, so it cannot be read as a setext
          // underline (`> foo\nbar\n===` -> `foo\nbar\n    ===`)
          const [lind2, lidx] = indentOf(rem, col);
          if (lind2 < 4 && matchSetext(rem, lidx) && leaf.lastLazy) rem = '    ' + rem;
          leaf.lines.push(rem); // lazy continuation
          leaf.lastLazy = true;
          continue;
        }
        if (intr.kind === 'setext') {
          const b = leaf;
          leaf = null;
          const text = b.lines.join('\n');
          const rest = stripRefDefs(text, refs);
          if (rest.length === 0) {
            const par = b.parent;
            if (par && par.ch[par.ch.length - 1] === b) par.ch.pop();
            startBlocks(rem, col);
            continue;
          }
          b.t = 'head';
          b.level = intr.level;
          b.text = rest;
          continue;
        }
      }
      // an HTML block whose container ends has no trailing newline
      if (leaf && leaf.t === 'html') leaf.noTrailNL = true;
      closeLeaf();
      while (stack.length > matched) popContainer();
      rem = mc.rem;
      col = mc.col;
    }
    if (blank) {
      if (leaf && leaf.t === 'code') {
        // a blank line inside a code block keeps its whitespace, with
        // the code indent stripped (`    chunk1\n      \n` -> `chunk1\n  \n`)
        leaf.lines.push(leaf.fence ? stripFenceIndent(rem, leaf.indent) : stripToCol(rem, col, col + 4));
        leaf.lastNL = lineNL[li];
      } else if (leaf && leaf.t === 'html' && (leaf.endSub !== null || leaf.endTag)) {
        // types 1-5 end at their closing tag, not at a blank line:
        // the blank line is content of the block
        leaf.lines.push(rem);
        leaf.lastNL = lineNL[li];
        if (htmlBlockEnds(rem, leaf)) { const h = leaf; closeLeaf(); noteHtmlEnd(h, li, stack.length); }
      } else {
        // an HTML block that ends at a blank line has no trailing newline
        if (leaf && leaf.t === 'html') leaf.noTrailNL = true;
        closeLeaf();
        // a blank line marks only the innermost container; the flag
        // propagates up when that container is closed (see
        // popContainer), so a blank line inside a sub-list does not
        // make the outer list loose
        if (stack.length > 0) stack[stack.length - 1].lastBlank = true;
        // an empty list item followed by a blank line ends the item:
        // `-\n\n  foo` leaves `foo` as a top-level paragraph, not a
        // paragraph inside the empty item
        while (stack.length > 1 && stack[stack.length - 1].t === 'item' && stack[stack.length - 1].ch.length === 0) popContainer();
      }
      continue;
    }
    if (leaf) {
      if (leaf.t === 'para') {
        const inList = stack.some(c => c.t === 'list');
        const intr = interruptingStart(rem, col, true, inList);
        if (intr !== null) {
          if (intr.kind === 'setext') {
            const b = leaf;
            leaf = null;
            const text = b.lines.join('\n');
            const rest = stripRefDefs(text, refs);
            if (rest.length === 0) {
              const par = b.parent;
              if (par && par.ch[par.ch.length - 1] === b) par.ch.pop();
              startBlocks(rem, col);
              continue;
            }
            b.t = 'head';
            b.level = intr.level;
            // a setext heading's text is stripped of leading and
            // trailing spaces/tabs (`  Foo\n---` -> `<h2>Foo</h2>`)
            b.text = trimWS(rest);
            continue;
          }
          closeLeaf();
          startBlocks(rem, col);
          continue;
        }
        leaf.lines.push(rem);
        leaf.lastLazy = false;
        continue;
      }
      if (leaf.t === 'code' && leaf.fence) {
        if (isClosingFence(rem, col, leaf)) { closeLeaf(); continue; }
        leaf.lines.push(stripFenceIndent(rem, leaf.indent));
        leaf.lastNL = lineNL[li];
        continue;
      }
      if (leaf.t === 'code' && !leaf.fence) {
        const [ind] = indentOf(rem, col);
        if (ind >= 4) {
          leaf.lines.push(stripToCol(rem, col, col + 4));
          leaf.lastNL = lineNL[li];
          continue;
        }
        closeLeaf();
        startBlocks(rem, col);
        continue;
      }
      if (leaf.t === 'html') {
        leaf.lines.push(rem);
        leaf.lastNL = lineNL[li];
        if (htmlBlockEnds(rem, leaf)) { const h = leaf; closeLeaf(); noteHtmlEnd(h, li, stack.length); }
        continue;
      }
    }
    startBlocks(rem, col);
  }
  closeLeaf();
  return doc;
}

// ------------------------------------------------------------------ rendering
const INLINE_SPECIAL_RE = /[`\\&<[\]!*_~]/;
const AUTO_CHECK_RE = /www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:|@/i;

function renderInlineText(text, refs, out) {
  if (!INLINE_SPECIAL_RE.test(text) && !AUTO_CHECK_RE.test(text) && text.indexOf('  \n') < 0) {
    out.push(esc(text));
    return;
  }
  renderNodes(parseInline(text, refs), out);
}

function renderBlocks(node, refs, out) {
  switch (node.t) {
    case 'doc':
      for (const c of node.ch) renderBlocks(c, refs, out);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of node.ch) renderBlocks(c, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<', tag);
      if (node.ordered && node.start !== 1) out.push(' start="', String(node.start), '"');
      out.push('>\n');
      for (const c of node.ch) renderBlocks(c, refs, out);
      out.push('</', tag, '>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const tight = !node.list.loose;
      let first = true;
      for (const c of node.ch) {
        if (c.t === 'para') {
          if (tight) {
            if (first && node.task !== null) out.push(node.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
            renderInlineText(c.text, refs, out);
          } else {
            out.push('<p>');
            if (first && node.task !== null) out.push(node.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
            renderInlineText(c.text, refs, out);
            out.push('</p>\n');
          }
        } else {
          if (first && node.task !== null) out.push(node.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
          renderBlocks(c, refs, out);
        }
        first = false;
      }
      out.push('</li>\n');
      break;
    }
    case 'para':
      out.push('<p>');
      renderInlineText(node.text, refs, out);
      out.push('</p>\n');
      break;
    case 'head':
      out.push('<h', String(node.level), '>');
      renderInlineText(node.text, refs, out);
      out.push('</h', String(node.level), '>\n');
      break;
    case 'code': {
      out.push('<pre><code');
      if (node.fence && node.lang) out.push(' class="language-', esc(node.lang), '"');
      out.push('>', escRaw(node.content), '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(node.content);
      if (node.lastNL && !node.noTrailNL) out.push('\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'table': {
      const cols = node.aligns.length;
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < cols; i++) {
        const cell = i < node.header.length ? node.header[i].trim() : '';
        const a = node.aligns[i];
        out.push('<th');
        if (a) out.push(' align="', a, '"');
        out.push('>');
        renderInlineText(cell, refs, out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let i = 0; i < cols; i++) {
            const cell = i < row.length ? row[i].trim() : '';
            const a = node.aligns[i];
            out.push('<td');
            if (a) out.push(' align="', a, '"');
            out.push('>');
            renderInlineText(cell, refs, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// ---------------------------------------------------------------------- entry
export function parse(markdown) {
  let src = markdown;
  if (src.indexOf('\r') >= 0) src = src.replace(/\r\n?/g, '\n');
  const refs = new Map();
  inLink = false;
  const doc = parseBlocks(src, refs);
  const out = [];
  renderBlocks(doc, refs, out);
  return out.join('');
}
