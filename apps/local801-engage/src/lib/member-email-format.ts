const LINK_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2048})\)/gi;

function normalize(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeWebUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function renderEmphasis(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function renderInline(value: string) {
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    html += renderEmphasis(value.slice(cursor, index));
    const url = safeWebUrl(match[2]);
    if (url) {
      html += `<a href="${escapeHtml(url)}" style="color:#134d8c;text-decoration:underline;">${renderEmphasis(match[1])}</a>`;
    } else {
      html += renderEmphasis(match[0]);
    }
    cursor = index + match[0].length;
  }
  return html + renderEmphasis(value.slice(cursor));
}

export function renderMemberEmailHtml(source: string) {
  const lines = normalize(source).split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  function flushParagraph() {
    if (paragraph.length === 0) return;
    output.push(`<p style="margin:0 0 16px;line-height:1.6;">${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType || listItems.length === 0) return;
    const items = listItems.map((item) => `<li style="margin:0 0 6px;">${renderInline(item)}</li>`).join("");
    output.push(`<${listType} style="margin:0 0 16px;padding-left:24px;line-height:1.5;">${items}</${listType}>`);
    listType = null;
    listItems = [];
  }

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      output.push(`<h${level} style="color:#082438;margin:20px 0 10px;line-height:1.3;">${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered ?? ordered)?.[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return output.join("") || '<p style="margin:0;color:#526171;">Nothing written yet.</p>';
}

export function renderMemberEmailText(source: string) {
  return normalize(source)
    .replace(LINK_PATTERN, (_match, label: string, url: string) => `${label} (${url})`)
    .replace(/^(#{1,3})\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .trim();
}
