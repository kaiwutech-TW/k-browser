import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

// Documentation pages get the link-preview image of their language (Starlight sets the other og: / twitter: tags).
export const onRequest = defineRouteMiddleware((context) => {
	const { head, lang } = context.locals.starlightRoute;
	const image = new URL(lang === 'zh-TW' ? '/img/og-zh.png' : '/img/og-en.png', context.site).href;
	head.push(
		{ tag: 'meta', attrs: { property: 'og:image', content: image } },
		{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
		{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
		{ tag: 'meta', attrs: { name: 'twitter:image', content: image } },
	);
});
