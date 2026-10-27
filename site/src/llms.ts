// Plain-text views of the docs for language models (https://llmstxt.org): /llms.txt is the index,
// /llms-full.txt and /zh-tw/llms-full.txt hold every page in one file.
import { getCollection } from 'astro:content';

const SITE = 'https://k-browser.kaiwu.com.tw';
// Sidebar order (astro.config.mjs).
const ORDER = ['', 'install', 'safety', 'tools', 'commands', 'kav', 'data', 'troubleshooting', 'development'];

export async function docPages(locale: 'en' | 'zh-tw') {
	const prefix = locale === 'en' ? 'docs' : 'zh-tw/docs';
	const entries = await getCollection('docs', (e) => e.id === prefix || e.id.startsWith(`${prefix}/`));
	const page = (id: string) => id.slice(prefix.length).replace(/^\//, '');
	return entries
		.filter((e) => ORDER.includes(page(e.id)))
		.sort((a, b) => ORDER.indexOf(page(a.id)) - ORDER.indexOf(page(b.id)))
		.map((e) => ({ title: e.data.title, description: e.data.description ?? '', url: `${SITE}/${e.id}/`, body: plain(e.body ?? '') }));
}

/** MDX to Markdown: drop imports and Starlight components, keep their text. */
function plain(body: string) {
	return body
		.replace(/^import .*;\n/gm, '')
		.replace(/^<\/?Steps>\n/gm, '')
		.replace(/^<Aside[^>]*title="([^"]*)"[^>]*>$/gm, '**$1**')
		.replace(/^<\/?Aside[^>]*>\n?/gm, '')
		.trim();
}

export const text = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function full(locale: 'en' | 'zh-tw', heading: string) {
	const pages = await docPages(locale);
	return text([heading, ...pages.map((p) => `# ${p.title}\n\nSource: ${p.url}\n\n${p.body}`)].join('\n\n---\n\n') + '\n');
}
