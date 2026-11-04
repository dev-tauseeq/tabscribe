import { escapeHtml, markdownToHtml } from './markdown';
import { recordedLine, type Timing } from './transcript-format';

const STYLE = `
@page { size: A4; margin: 18mm 16mm; }
:root { color-scheme: light; }
body {
  margin: 0;
  color: #1f2328;
  font: 10.5pt/1.5 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans',
    'Apple SD Gothic Neo', 'Geeza Pro', sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
header { margin-bottom: 18px; padding-bottom: 10px; border-bottom: 2px solid #1a73e8; }
header .label { color: #1a73e8; font-size: 8.5pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
header h1 { margin: 4px 0 6px; font-size: 19pt; line-height: 1.25; }
header p { margin: 0; color: #656d76; font-size: 9.5pt; }
h1, h2, h3, h4 { break-after: avoid; }
h1 { font-size: 16pt; margin: 20px 0 8px; }
h2 { margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d0d7de; font-size: 13pt; }
h3, h4, h5, h6 { margin: 14px 0 6px; font-size: 11pt; }
p { margin: 0 0 8px; }
ul, ol { margin: 0 0 8px; padding-left: 20px; }
li { margin: 2px 0; break-inside: avoid; }
li > ul, li > ol { margin: 2px 0 0; }
li.task { position: relative; margin-left: -20px; padding-left: 22px; list-style: none; }
.box { position: absolute; top: 0.3em; left: 2px; width: 10px; height: 10px; border: 1.3px solid #57606a; border-radius: 3px; }
.box.done { border-color: #1a73e8; background: #1a73e8; }
blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid #d0d7de; color: #57606a; }
table { width: 100%; margin: 4px 0 10px; border-collapse: collapse; font-size: 9.5pt; }
th, td { padding: 4px 6px; border: 1px solid #d0d7de; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
tr { break-inside: avoid; }
code { padding: 0 3px; border-radius: 3px; background: #f6f8fa; font: 9pt ui-monospace, Menlo, monospace; }
pre { padding: 8px; border-radius: 6px; background: #f6f8fa; white-space: pre-wrap; }
pre code { padding: 0; }
a { color: #1a73e8; text-decoration: none; }
hr { margin: 14px 0; border: 0; border-top: 1px solid #d0d7de; }
footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #d0d7de; color: #8c959f; font-size: 8.5pt; }
`;

export interface SummaryDetails {
  language?: string;
  model: string;
}

// The page has no scripts and allows none, and every piece of text is escaped.
export function buildSummaryHtml(meeting: Timing, summaryMarkdown: string, details: SummaryDetails): string {
  const facts = [recordedLine(meeting), details.language].filter(Boolean).map((fact) => escapeHtml(fact as string));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(meeting.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<div class="label">Meeting summary</div>
<h1>${escapeHtml(meeting.title)}</h1>
<p>${facts.join(' &middot; ')}</p>
</header>
<main>
${markdownToHtml(summaryMarkdown)}
</main>
<footer>Written by Claude (${escapeHtml(details.model)}) from the meeting transcript. Check important details against the recording.</footer>
</body>
</html>
`;
}
