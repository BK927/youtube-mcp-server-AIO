import { escapeHtml } from "./responses.js";

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.55; }
    main { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 16px; padding: 24px; }
    h1 { margin-top: 0; font-size: 1.55rem; }
    code, textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    code { overflow-wrap: anywhere; }
    textarea { width: 100%; min-height: 120px; box-sizing: border-box; padding: 12px; }
    input { width: 100%; box-sizing: border-box; padding: 10px; margin: 8px 0 16px; }
    button { padding: 10px 16px; cursor: pointer; }
    .muted { opacity: .72; }
    .warning { padding: 12px; border-left: 4px solid currentColor; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}
