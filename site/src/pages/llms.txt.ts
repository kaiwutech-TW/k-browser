import type { APIRoute } from 'astro';
import { docPages, text } from '../llms';

export const GET: APIRoute = async () => {
	const list = (pages: Awaited<ReturnType<typeof docPages>>) => pages.map((p) => `- [${p.title}](${p.url}): ${p.description}`).join('\n');
	return text(`# K-Browser

> K-Browser is an open-source (MIT) MCP server and Chrome extension that lets local AI agents — Claude Code, Codex, Antigravity, Gemini CLI, or any
> MCP client — use the user's real, signed-in Chrome on macOS. Each agent works only in the tabs it opened, in a window
> that never takes focus; input is real mouse and keyboard, re-checked before each press; page text is returned as
> untrusted data with secrets masked; logins and captchas are handed to the user. Requires macOS, Chrome 125+, Node.js 22+.

K-Browser is not a web browser of its own, and not the K Browser apps for Windows, Android or iOS.

Source code: https://github.com/kaiwutech-TW/k-browser
All documentation in one file: https://k-browser.kaiwu.com.tw/llms-full.txt (English), https://k-browser.kaiwu.com.tw/zh-tw/llms-full.txt (繁體中文)

## Docs

${list(await docPages('en'))}

## 文件(繁體中文)

${list(await docPages('zh-tw'))}
`);
};
