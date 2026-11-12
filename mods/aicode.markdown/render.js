// Markdown to HTML for the preview: CommonMark's blocks (ATX and setext headings, paragraphs, nested
// lists, task lists, quotes, fenced and indented code, tables, rules) and inlines (code, emphasis,
// strikethrough, links, images, autolinks). Everything is escaped; raw HTML in the file shows as
// text. Each block carries `data-line` (its first source line, 0-based) for scroll sync.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");

function safeUrl(url) {
  const u = url.trim().replace(/^<|>$/g, "");
  return /^\s*(javascript|vbscript|data):/i.test(u) ? "" : u;
}

export function inline(src) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  // Code spans first: nothing inside them is markup.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code.trim() ? code.replace(/^ (.*) $/, "$1") : code)}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c) => keep(esc(c)));
  s = s.replace(/<((?:https?|mailto):[^\s<>]+)>/g, (_, u) => keep(`<a data-href="${esc(u)}" title="${esc(u)}">${esc(u)}</a>`));
  // Images, then links: [text](url "title").
  s = s.replace(/!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) => {
    const u = safeUrl(url);
    return keep(`<span class="md-image" title="${esc(title ?? u)}"><i class="codicon codicon-file-media"></i>${esc(unesc(alt) || u)}</span>`);
  });
  s = s.replace(/\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) => {
    const u = safeUrl(url);
    return keep(`<a data-href="${esc(u)}" title="${esc(title ?? u)}">${inlineText(text)}</a>`);
  });
  s = esc(s);
  s = s
    .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, "<strong><em>$2</em></strong>")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=[^\s_])([^_]*?[^\s_])_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?])/g, (_, pre, u) => `${pre}<a data-href="${u.startsWith("www.") ? "https://" + u : u}" title="${u}">${u}</a>`)
    // Two trailing spaces or a backslash end a line: a hard break.
    .replace(/(?: {2,}|\\)\n/g, "<br>")
    .replace(/\n/g, " ");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const inlineText = (t) => inline(t);

const isBlank = (l) => !l.trim();
const fenceOpen = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const hrRe = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const atxRe = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const bulletRe = /^( {0,3})([-*+])([ \t]+|$)(.*)$/;
const orderedRe = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const quoteRe = /^ {0,3}> ?(.*)$/;
const tableSep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const splitRow = (line) => {
  const cells = [];
  let cur = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
};

const startsBlock = (l) => fenceOpen.test(l) || hrRe.test(l) || atxRe.test(l) || quoteRe.test(l) || bulletRe.test(l) || /^ {0,3}1[.)][ \t]/.test(l);

/** `lines` with their source line numbers; returns HTML. */
function blocks(lines, base) {
  let out = "";
  let i = 0;
  const at = (n) => ` data-line="${base + n}"`;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let m;
    // Fenced code.
    if ((m = line.match(fenceOpen))) {
      const [, indent, fence, lang] = m;
      const start = i++;
      const body = [];
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${indent.length}}`), ""));
      i++;
      out += `<pre${at(start)}${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }
    // Indented code.
    if (/^( {4}|\t)/.test(line)) {
      const start = i;
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (isBlank(lines[i]) && i + 1 < lines.length && /^( {4}|\t)/.test(lines[i + 1])))) body.push(lines[i++].replace(/^( {4}|\t)/, ""));
      out += `<pre${at(start)}><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }
    if ((m = line.match(atxRe))) {
      const level = m[1].length;
      out += `<h${level}${at(i)} id="${slug(m[2] ?? "")}">${inline(m[2] ?? "")}</h${level}>`;
      i++;
      continue;
    }
    if (hrRe.test(line)) {
      out += `<hr${at(i)}>`;
      i++;
      continue;
    }
    if (quoteRe.test(line)) {
      const start = i;
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = lines[i].match(quoteRe);
        if (q) inner.push(q[1]);
        else if (startsBlock(lines[i])) break;
        else inner.push(lines[i]); // lazy continuation
        i++;
      }
      out += `<blockquote${at(start)}>${blocks(inner, base + start)}</blockquote>`;
      continue;
    }
    if (bulletRe.test(line) || orderedRe.test(line)) {
      const r = list(lines, i, base);
      out += r.html;
      i = r.next;
      continue;
    }
    // Table: a header row, then | --- | --- |.
    if (line.includes("|") && i + 1 < lines.length && tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const start = i;
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      const cell = (tag, c, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(c ?? "")}</${tag}>`;
      i += 2;
      let body = "";
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const row = splitRow(lines[i]);
        body += `<tr${at(i)}>${head.map((_, n) => cell("td", row[n], n)).join("")}</tr>`;
        i++;
      }
      out += `<table${at(start)}><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`;
      continue;
    }
    // Paragraph (or a setext heading when underlined with === or ---).
    const start = i;
    const para = [line.trim()];
    i++;
    let setext = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      if (/^ {0,3}=+\s*$/.test(lines[i])) {
        setext = 1;
        i++;
        break;
      }
      if (/^ {0,3}-+\s*$/.test(lines[i])) {
        setext = 2;
        i++;
        break;
      }
      if (startsBlock(lines[i]) || (lines[i].includes("|") && i + 1 < lines.length && tableSep.test(lines[i + 1]))) break;
      para.push(lines[i].replace(/^\s+/, ""));
      i++;
    }
    const text = para.join("\n");
    out += setext ? `<h${setext}${at(start)} id="${slug(text)}">${inline(text)}</h${setext}>` : `<p${at(start)}>${inline(text)}</p>`;
  }
  return out;
}

/** A list starting at `i`: items run until a line that is neither indented under it nor a sibling. */
function list(lines, i, base) {
  const first = lines[i].match(bulletRe) ?? lines[i].match(orderedRe);
  const ordered = !lines[i].match(bulletRe);
  const marker = ordered ? first[3] : first[2];
  const startNo = ordered ? Number(first[2]) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = ordered ? lines[i].match(orderedRe) : lines[i].match(bulletRe);
    if (!m || (ordered ? m[3] : m[2]) !== marker) break;
    const indent = m[1].length;
    const markerLen = ordered ? m[2].length + 1 : 1;
    const gap = ordered ? m[4] : m[3];
    const content = ordered ? m[5] : m[4];
    const width = indent + markerLen + Math.min(Math.max(gap.length, 1), 4);
    const start = i;
    const body = [content];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        sawBlank = true;
        body.push("");
        i++;
        continue;
      }
      const lead = l.match(/^ */)[0].length;
      if (lead >= width) {
        if (sawBlank && body.length > 1) loose = true;
        body.push(l.slice(width));
        sawBlank = false;
        i++;
        continue;
      }
      // Lazy continuation of the item's paragraph.
      if (!sawBlank && !startsBlock(l) && !orderedRe.test(l)) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    if (sawBlank && i < lines.length && (ordered ? orderedRe : bulletRe).test(lines[i])) loose = true;
    items.push({ start, body });
  }
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag}${ordered && startNo !== 1 ? ` start="${startNo}"` : ""} data-line="${base + items[0].start}">`;
  for (const it of items) {
    let body = it.body;
    let check = "";
    const task = body[0].match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task) {
      check = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}>`;
      body = [task[2], ...body.slice(1)];
    }
    let inner = blocks(body, base + it.start);
    // A tight list's items hold their text directly, not in paragraphs.
    if (!loose) inner = inner.replace(/^<p data-line="\d+">([\s\S]*?)<\/p>/, "$1");
    html += `<li${task ? ' class="task-list-item"' : ""} data-line="${base + it.start}">${check}${inner}</li>`;
  }
  return { html: html + `</${tag}>`, next: i };
}

function slug(text) {
  return esc(
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-"),
  );
}

export function renderMarkdown(text) {
  // Front matter (--- yaml ---) is not shown, like VS Code's preview.
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  let base = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      lines = lines.slice(end + 1);
      base = end + 1;
    }
  }
  return blocks(lines, base);
}
