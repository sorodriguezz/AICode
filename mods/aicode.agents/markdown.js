// Just enough Markdown for agent answers: fenced code (with actions), inline code (file paths in it
// become links), bold, italics, strikethrough, headings, lists, quotes, tables, rules and links.
// Everything is escaped first; no HTML from the model is ever rendered.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `src/a.ts`, `./x/y.py:12`, `README.md#L3`: looks like a file someone could open. */
const FILE_LIKE = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,11}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/;

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="ext-link" data-href="$2" title="$2">$1</a>')
    .replace(/\[([^\]]+)\]\(((?!https?:)[^)\s]+)\)/g, (m, label, target) => (FILE_LIKE.test(target.replace(/&amp;/g, "&")) ? `<a class="file-link" data-path="${target}" title="${target}">${label}</a>` : m))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a class="ext-link" data-href="$2" title="$2">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[Number(i)];
    const raw = c.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    return FILE_LIKE.test(raw) ? `<code class="file-link" data-path="${c}" title="Open ${c}">${c}</code>` : `<code>${c}</code>`;
  });
}

const tableRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Renders into `el`; `onCode(pre, lang, code)` decorates each code block. */
export function renderMarkdown(el, text, onCode) {
  el.innerHTML = "";
  const lines = text.split("\n");
  let html = "";
  const blocks = [];
  let i = 0;
  let list = null;
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([^\s`]*)/);
    if (fence) {
      closeList();
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ lang, code: body.join("\n") });
      html += `<div data-code="${blocks.length - 1}"></div>`;
      continue;
    }
    // | a | b |  then  |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      closeList();
      const head = tableRow(line);
      const align = tableRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      let body = "";
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        body += `<tr>${tableRow(lines[i]).map((c, n) => `<td${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(c)}</td>`).join("")}</tr>`;
        i++;
      }
      html += `<div class="md-table"><table><thead><tr>${head.map((c, n) => `<th${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    const bullet = line.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html += "<hr>";
    } else if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      const indent = (bullet ?? ordered)[1].length;
      if (list !== kind) {
        closeList();
        html += kind === "ol" && ordered[2] !== "1" ? `<ol start="${ordered[2]}">` : `<${kind}>`;
        list = kind;
      }
      const check = bullet?.[2] !== undefined ? `<input type="checkbox" disabled${bullet[2].trim() ? " checked" : ""}> ` : "";
      html += `<li${indent >= 2 ? ' class="nested"' : ""}>${check}${inline(bullet ? bullet[3] : ordered[3])}</li>`;
    } else if (/^>\s?/.test(line)) {
      closeList();
      const quote = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) quote.push(lines[++i].replace(/^>\s?/, ""));
      html += `<blockquote>${quote.map(inline).join("<br>")}</blockquote>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      // Consecutive text lines form one paragraph.
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(\s*```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|\s*\|.*\|\s*$)/.test(lines[i + 1])) para.push(lines[++i]);
      html += `<p>${para.map(inline).join("<br>")}</p>`;
    }
    i++;
  }
  closeList();
  el.innerHTML = html;
  for (const holder of el.querySelectorAll("[data-code]")) {
    const { lang, code } = blocks[Number(holder.dataset.code)];
    const pre = document.createElement("pre");
    const c = document.createElement("code");
    c.textContent = code;
    pre.append(c);
    holder.replaceWith(onCode ? onCode(pre, lang, code) : pre);
  }
}
