import type { APIRoute } from 'astro';
import { full } from '../../llms';

export const GET: APIRoute = () => full('zh-tw', '# K-Browser 文件\n\nhttps://k-browser.kaiwu.com.tw/zh-tw/ · https://github.com/kaiwutech-TW/k-browser');
