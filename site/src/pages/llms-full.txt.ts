import type { APIRoute } from 'astro';
import { full } from '../llms';

export const GET: APIRoute = () => full('en', '# K-Browser documentation\n\nhttps://k-browser.kaiwu.com.tw · https://github.com/kaiwutech-TW/k-browser');
