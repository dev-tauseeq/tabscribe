// A small Markdown to HTML converter for the summary PDF. It covers what the notes use:
// headings, paragraphs, nested and task lists, quotes, tables, code, rules and inline
// emphasis. Every piece of text is escaped, so the model's answer can never add markup.

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text: string): string {
  const codes: string[] = [];
  const html = escapeHtml(text)
    .replace(/`([^`]+)`/g, (_match, code: string) => `\u0000${codes.push(`<code>${code}</code>`) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
}

const indentOf = (spaces: string): number => spaces.replace(/\t/g, '    ').length;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => inline(cell.trim().replace(/\\\|/g, '|')));
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, '').split('\n');
  const out: string[] = [];
  const lists: { type: 'ul' | 'ol'; indent: number }[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeLists = (downTo = -1): void => {
    for (let top = lists.at(-1); top && top.indent > downTo; top = lists.at(-1)) {
      out.push(`</li></${top.type}>`);
      lists.pop();
    }
  };
  const openList = (type: 'ul' | 'ol', indent: number, marker: string): void => {
    const start = Number.parseInt(marker, 10);
    out.push(type === 'ol' && start > 1 ? `<ol start="${start}">` : `<${type}>`);
    lists.push({ type, indent });
  };
  const closeBlocks = (): void => {
    flushParagraph();
    closeLists();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (FENCE.test(line)) {
      closeBlocks();
      const code: string[] = [];
      for (index += 1; index < lines.length && !FENCE.test(lines[index]); index += 1) code.push(lines[index]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (RULE.test(line)) {
      closeBlocks();
      out.push('<hr>');
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const indent = indentOf(item[1]);
      const type = /\d/.test(item[2]) ? 'ol' : 'ul';
      const top = lists.at(-1);
      if (!top || indent > top.indent) {
        openList(type, indent, item[2]);
      } else {
        closeLists(indent);
        const current = lists.at(-1);
        if (current?.type === type) {
          out.push('</li>');
        } else {
          if (current) closeLists(current.indent - 1);
          openList(type, indent, item[2]);
        }
      }
      const task = TASK.exec(item[3]);
      out.push(
        task
          ? `<li class="task"><span class="box${task[1] === ' ' ? '' : ' done'}"></span>${inline(task[2])}`
          : `<li>${inline(item[3])}`,
      );
      continue;
    }
    if (lists.length > 0 && /^\s+\S/.test(line) && paragraph.length === 0) {
      out.push(` ${inline(line.trim())}`);
      continue;
    }
    if (QUOTE.test(line)) {
      closeBlocks();
      const quoted: string[] = [];
      let match = QUOTE.exec(line);
      while (match) {
        quoted.push(match[1]);
        match = QUOTE.exec(lines[index + 1] ?? '');
        if (match) index += 1;
      }
      out.push(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      closeBlocks();
      const head = tableCells(line);
      const rows: string[][] = [];
      for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim() !== ''; index += 1) {
        rows.push(tableCells(lines[index]));
      }
      index -= 1;
      const body = rows.map((row) => `<tr>${head.map((_cell, column) => `<td>${row[column] ?? ''}</td>`).join('')}</tr>`);
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    closeLists();
    paragraph.push(line.trim());
  }
  closeBlocks();
  return out.join('\n');
}
