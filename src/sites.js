// @ts-check
// High-risk site categories the installer offers to block. A starting point, not a
// complete list: the result lands in ~/.k-browser/clients/<name>.json as blockedOrigins, where the user can edit it.
// Patterns follow src/mcp/sites.js: a bare host covers its subdomains.

/** @type {Record<string, { label: string, hosts: string[] }>} */
export const CATEGORIES = {
  banking: { label: '網路銀行', hosts: ['ctbcbank.com', 'cathaybk.com.tw', 'esunbank.com', 'esunbank.com.tw', 'fubon.com', 'taishinbank.com.tw',
    'megabank.com.tw', 'firstbank.com.tw', 'bot.com.tw', 'landbank.com.tw', 'tcb-bank.com.tw', 'hncb.com.tw', 'scsb.com.tw', 'sinopac.com',
    'feib.com.tw', 'post.gov.tw', 'richart.tw', 'linebank.com.tw', 'nextbank.com.tw', 'rakuten-bank.com.tw'] },
  payments: { label: '支付', hosts: ['paypal.com', 'pay.line.me', 'jkopay.com', 'stripe.com'] },
  email: { label: '電子郵件', hosts: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com', 'proton.me'] },
  government: { label: '政府服務(gov.tw)', hosts: ['gov.tw'] },
  crypto: { label: '加密貨幣交易所', hosts: ['binance.com', 'coinbase.com', 'maicoin.com', 'bitopro.com'] },
  passwords: { label: '密碼管理器', hosts: ['1password.com', 'bitwarden.com', 'lastpass.com'] },
};

/** The patterns of the chosen categories. @param {string[]} names */
export function patternsFor(names) {
  const unknown = names.filter((n) => !CATEGORIES[n]);
  if (unknown.length) throw new Error(`unknown site categories: ${unknown.join(', ')} (known: ${Object.keys(CATEGORIES).join(', ')})`);
  return [...new Set(names.flatMap((n) => CATEGORIES[n].hosts))];
}

/** Which categories a blockedOrigins list holds in full or in part, and how many of its entries are in none (the
 * user's own). Entries are compared as written, the way the installer writes them. @param {unknown[]} list */
export function categoriesIn(list) {
  const have = new Set(list.filter((x) => typeof x === 'string'));
  /** @type {string[]} */ const on = [];
  /** @type {string[]} */ const part = [];
  for (const [name, { hosts }] of Object.entries(CATEGORIES)) {
    const n = hosts.filter((h) => have.has(h)).length;
    if (n === hosts.length) on.push(name);
    else if (n) part.push(name);
  }
  const known = new Set(Object.values(CATEGORIES).flatMap((c) => c.hosts));
  return { on, part, other: list.filter((x) => typeof x !== 'string' || !known.has(x)).length };
}

/** list with one category turned on (its patterns added) or off (its patterns removed, except those another category
 * that stays fully on also holds). Every other entry stays as it is; one the user added by hand that is exactly a
 * category's pattern cannot be told apart from it. @param {unknown[]} list @param {string} name @param {boolean} on */
export function withCategory(list, name, on) {
  const hosts = patternsFor([name]);
  if (on) return [...list, ...hosts.filter((h) => !list.includes(h))];
  const keep = new Set(patternsFor(categoriesIn(list).on.filter((n) => n !== name)));
  return list.filter((x) => typeof x !== 'string' || !hosts.includes(x) || keep.has(x));
}
