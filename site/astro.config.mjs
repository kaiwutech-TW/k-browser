// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The showcase pages (src/pages/index.astro, src/pages/zh-tw/index.astro) are plain Astro pages; Starlight serves the
// documentation under /docs/ and /zh-tw/docs/. Static output, for Cloudflare.
export default defineConfig({
	site: 'https://k-browser.pages.dev',
	integrations: [
		starlight({
			title: 'K-Browser',
			description: 'Let local agents use your real, signed-in Chrome — only the tabs they open, under rules you set.',
			logo: { src: './src/assets/logo.svg' },
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kaiwutech-TW/k-browser' }],
			defaultLocale: 'root',
			locales: {
				root: { label: 'English', lang: 'en' },
				'zh-tw': { label: '繁體中文', lang: 'zh-TW' },
			},
			customCss: ['./src/styles/fonts.css', './src/styles/docs.css'],
			sidebar: [
				{
					label: 'Start here',
					translations: { 'zh-TW': '開始使用' },
					items: [
						{ slug: 'docs', label: 'Overview', translations: { 'zh-TW': '總覽' } },
						{ slug: 'docs/install', label: 'Install', translations: { 'zh-TW': '安裝' } },
						{ slug: 'docs/safety', label: 'Safety model', translations: { 'zh-TW': '安全設計' } },
					],
				},
				{
					label: 'Using K-Browser',
					translations: { 'zh-TW': '使用' },
					items: [
						{ slug: 'docs/tools', label: 'Agent tools', translations: { 'zh-TW': 'agent 工具' } },
						{ slug: 'docs/commands', label: 'Commands & side panel', translations: { 'zh-TW': '指令與側邊面板' } },
						{ slug: 'docs/kav', label: 'Kav flows (optional)', translations: { 'zh-TW': 'Kav 流程(選用)' } },
						{ slug: 'docs/data', label: 'Where data is kept', translations: { 'zh-TW': '資料存在哪' } },
						{ slug: 'docs/troubleshooting', label: 'Troubleshooting', translations: { 'zh-TW': '常見問題' } },
					],
				},
				{
					label: 'Contributing',
					translations: { 'zh-TW': '參與開發' },
					items: [{ slug: 'docs/development', label: 'Development', translations: { 'zh-TW': '開發與測試' } }],
				},
			],
		}),
	],
});
