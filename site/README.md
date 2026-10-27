# K-Browser site

The showcase and documentation site (English and Traditional Chinese), built with Astro and Starlight. Static output.

| Path | What |
|---|---|
| `src/pages/index.astro`, `src/pages/zh-tw/index.astro` | Showcase pages; layout in `src/components/Landing.astro`, text in `src/i18n/landing.ts` |
| `src/content/docs/docs/`, `src/content/docs/zh-tw/docs/` | Documentation, one file per page in each language |
| `public/img/panel-dark.png` | Side panel screenshot (sample data) |

```sh
npm install
npm run dev       # http://localhost:4321
npm run build     # into dist/
npm run preview
```

Live at https://k-browser.kaiwu.com.tw. Deploy with `npm run build` then `npx wrangler deploy` (Cloudflare static assets; settings in
`wrangler.jsonc`, including the custom domain).
