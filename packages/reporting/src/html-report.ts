/**
 * Self-contained HTML report rendering: inline CSS, no scripts, no external
 * requests, works from file://. Used by drift reports (Phase H) and any
 * command that wants a shareable artifact.
 */

export interface HtmlReportItem {
  status: 'ok' | 'warn' | 'fail' | 'info';
  text: string;
  detail?: string;
}

export interface HtmlReportSection {
  heading: string;
  items: HtmlReportItem[];
}

export interface HtmlReportInput {
  title: string;
  subtitle?: string;
  sections: HtmlReportSection[];
  footer?: string;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STATUS_GLYPH: Record<HtmlReportItem['status'], string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '·',
};

export function renderHtmlReport(input: HtmlReportInput): string {
  const sections = input.sections
    .map((section) => {
      const items = section.items
        .map(
          (item) =>
            `<li class="item ${item.status}"><span class="glyph">${STATUS_GLYPH[item.status]}</span>` +
            `<span>${escapeHtml(item.text)}${
              item.detail !== undefined ? `<span class="detail"> — ${escapeHtml(item.detail)}</span>` : ''
            }</span></li>`,
        )
        .join('\n');
      return `<section>\n<h2>${escapeHtml(section.heading)}</h2>\n<ul>\n${items}\n</ul>\n</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .subtitle { color: #777; margin-top: 0; }
  h2 { font-size: 1.05rem; border-bottom: 1px solid #8884; padding-bottom: 0.25rem; margin-top: 1.5rem; }
  ul { list-style: none; padding-left: 0; }
  .item { display: flex; gap: 0.5rem; padding: 0.15rem 0; }
  .glyph { width: 1.2em; text-align: center; font-weight: 700; }
  .ok .glyph { color: #1a7f37; }
  .warn .glyph { color: #b08800; }
  .fail .glyph { color: #cf222e; }
  .info .glyph { color: #777; }
  .detail { color: #777; }
  footer { margin-top: 2rem; color: #777; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
${input.subtitle !== undefined ? `<p class="subtitle">${escapeHtml(input.subtitle)}</p>` : ''}
${sections}
${input.footer !== undefined ? `<footer>${escapeHtml(input.footer)}</footer>` : ''}
</body>
</html>
`;
}
