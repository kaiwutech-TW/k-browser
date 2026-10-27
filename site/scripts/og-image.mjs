// Renders the link-preview images (public/img/og-en.png, og-zh.png, 1200×630). Run after changing the text:
//   node scripts/og-image.mjs
import sharp from 'sharp';

const pages = {
	en: { lines: ['Your agents.', 'Your Chrome.', 'Your rules.'], sub: 'Let local AI agents use your real, signed-in Chrome — safely.', font: 'Helvetica Neue' },
	zh: { lines: ['你的 agent，', '你的 Chrome，', '你的規則。'], sub: '讓本機 AI agent 安全地使用你已登入的 Chrome', font: 'PingFang TC' },
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

for (const [lang, p] of Object.entries(pages)) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	<defs><radialGradient id="g" cx="0.9" cy="0" r="0.9"><stop offset="0" stop-color="#B00D23" stop-opacity=".35"/><stop offset="1" stop-color="#B00D23" stop-opacity="0"/></radialGradient></defs>
	<rect width="1200" height="630" fill="#0A0A0B"/><rect width="1200" height="630" fill="url(#g)"/>
	<g transform="translate(80,72)">
		<rect width="72" height="72" rx="16" fill="#18181B" stroke="#27272A"/>
		<g transform="translate(-4.8,-4) scale(.8)"><polygon points="28,14 42,14 45,50 70,14 70,34 34,86" fill="#B00D23"/><polygon points="48,72 56,61 74,86 58,86" fill="#71717A"/></g>
		<text x="96" y="48" font-family="Helvetica Neue" font-size="38" font-weight="600" fill="#F4F4F5">K-Browser</text>
	</g>
	${p.lines.map((l, i) => `<text x="80" y="${280 + i * 88}" font-family="${p.font}" font-size="78" font-weight="700" fill="${i === 2 ? '#F0546A' : '#F4F4F5'}">${esc(l)}</text>`).join('')}
	<text x="80" y="560" font-family="${p.font}" font-size="30" fill="#A1A1AA">${esc(p.sub)}</text>
</svg>`;
	await sharp(Buffer.from(svg)).png().toFile(new URL(`../public/img/og-${lang}.png`, import.meta.url).pathname);
}
