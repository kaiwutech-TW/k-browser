// @ts-check
// src/redact.js: credentials by value, URLs, header values, secret-named fields, numbers that identify a person.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeToken, redactor } from '../src/redact.js';

const TOKEN = 'kbFakeClientToken_0123456789abcdefXYZ';
const PAIR = 'fakePairKey-ABCDEFGHIJ0123456789';
const r = redactor({ secrets: [TOKEN, PAIR, null, undefined, 'short'] });

test('loaded credentials are removed wherever they appear, by value, whatever surrounds them', () => {
  const s = r.text(`endpoint http://127.0.0.1:9444/c/${TOKEN} key=${PAIR}; glued${TOKEN}glued`);
  assert.ok(!s.includes(TOKEN) && !s.includes(PAIR), s);
  assert.match(s, /\[redacted:credential\]/);
  assert.equal(r.text('short and sweet'), 'short and sweet', 'strings under 8 characters are not treated as credentials');
});

test('URLs lose userinfo, query values, fragment and token-like path segments; the rest stays readable', () => {
  assert.equal(r.url('https://user:pw@example.com/a/b?q=shoes&session=s3cr3t#access_token=zzz'),
    'https://[redacted]@example.com/a/b?q=[redacted]&session=[redacted]#[redacted]');
  assert.equal(r.url('https://example.com/reset/aB3dE5fG7hJ9kL1mN3pQ5/confirm'), 'https://example.com/reset/[redacted]/confirm');
  assert.equal(r.url('https://example.com/2026-10-24-my-blog-post-title'), 'https://example.com/2026-10-24-my-blog-post-title');
  assert.equal(r.url('https://example.com/page#'), 'https://example.com/page#');
  assert.equal(r.text('see https://a.example/x?id=4242 now'), 'see https://a.example/x?id=[redacted] now');
  assert.equal(r.text('{"url":"/api/echo?q=1&session=abc&x=2"}'), '{"url":"/api/echo?q=1&session=[redacted]&x=2"}', 'a relative URL: secret-named parameters');
  assert.equal(looksLikeToken('eyJhbGciOiJIUzI1NiJ9'), true);
  assert.equal(looksLikeToken('550e8400-e29b-41d4-a716-446655440000'), false, 'a UUID has no 16-character run');
});

test('header values, Bearer tokens and secret-named JSON fields are removed (escaped quotes too)', () => {
  assert.equal(r.text('Authorization: Bearer abc.def.ghi'), 'Authorization: [redacted]');
  assert.equal(r.text('Cookie: sid=1; theme=dark\nAccept: */*'), 'Cookie: [redacted]\nAccept: */*');
  assert.equal(r.text('sent Bearer fakeAuthValue123 to it'), 'sent Bearer [redacted] to it');
  assert.equal(r.text('<input type="password" name="p" value="hunter22"><input name=q value="shoes">'),
    '<input type="password" name="p" value="[redacted]"><input name=q value="shoes">', 'HTML: password fields only');
  assert.equal(r.text("<input type=hidden name='csrf_token' value='abc123'>"), "<input type=hidden name='csrf_token' value=\"[redacted]\">");
  assert.equal(r.text('<input aria-label="Password (>8 chars)" type="password" value="hunter22">'),
    '<input aria-label="Password (>8 chars)" type="password" value="[redacted]">', 'a quoted ">" does not end the tag');
  assert.equal(r.text('{"user":"amy","password":"hunter22","sessionId":"x1"}'), '{"user":"amy","password":"[redacted]","sessionId":"[redacted]"}');
  assert.equal(r.text(JSON.stringify(JSON.stringify({ api_key: 'k-123456' }))), JSON.stringify(JSON.stringify({ api_key: '[redacted]' })));
  assert.deepEqual(r.headers({ Authorization: 'Bearer x', 'Set-Cookie': 'a=b', Accept: 'text/html' }), { Authorization: '[redacted]', 'Set-Cookie': '[redacted]', Accept: 'text/html' });
  assert.deepEqual(r.value({ url: 'https://x.example/?a=1x', nested: [{ token: 'abc' }], n: 3 }), { url: 'https://x.example/?a=[redacted]', nested: [{ token: '[redacted]' }], n: 3 });
});

test('over-redaction: a 1-3 digit query value of an ordinary name stays; short secret words count only as whole words', () => {
  assert.equal(r.url('https://www.cwa.gov.tw/V8/C/W/County/County.html?CID=63&page=2'), 'https://www.cwa.gov.tw/V8/C/W/County/County.html?CID=63&page=2');
  // a shop's product number (Kav's compare candidates must stay openable); only that shop, that name, digits, not card-length
  assert.equal(r.url('https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541&Area=search&mdiv=403&kw=airpods'),
    'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541&Area=[redacted]&mdiv=403&kw=[redacted]');
  assert.equal(r.url('https://www.tw.coupang.com/products/1?itemId=12345678901&vendorItemId=98765432109&q=x'),
    'https://www.tw.coupang.com/products/1?itemId=12345678901&vendorItemId=98765432109&q=[redacted]');
  // and it stays through the text rules (an MCP result is text): i_code reads like a secret "code" there
  assert.equal(r.text('see https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541&kw=airpods now'),
    'see https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541&kw=[redacted] now');
  assert.equal(/** @type {any} */ (r.value({ url: 'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541' })).url, 'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=14104541');
  assert.equal(r.text('i_code=14104541 https://evil.test/?i_code=14104541'), 'i_code=[redacted] https://evil.test/?i_code=[redacted]');
  for (const u of ['https://evil.test/?i_code=14104541', 'https://momoshop.com.tw.evil.test/?i_code=14104541', 'https://www.momoshop.com.tw/?i_code=4111111111111111',
    'https://www.momoshop.com.tw/?i_code=abc12345', 'https://www.momoshop.com.tw/?token=14104541', 'https://u@www.momoshop.com.tw/?i_code=14104541']) {
    assert.ok(r.url(u).includes('=[redacted]'), u);
  }
  assert.equal(r.url('https://x.example/?id=1234&pin=12&code=7&q=12&x=1a'), 'https://x.example/?id=[redacted]&pin=[redacted]&code=[redacted]&q=12&x=[redacted]',
    '4 digits may be a one-time code; secret-named parameters lose even short numbers');
  assert.equal(r.url('https://x.example/?%E0%A4%A=1'), 'https://x.example/?%E0%A4%A=[redacted]', 'a name that does not decode counts as secret');
  assert.equal(r.text('Disallow: /*?author=*\nDisallow: /*?design=x&side=y'), 'Disallow: /*?author=*\nDisallow: /*?design=x&side=y');
  assert.deepEqual(r.value({ author: 'amy', shipping: 'fast', footprint: 'none', authorization: 'x', userPin: '1', otp_code: '2' }),
    { author: 'amy', shipping: 'fast', footprint: 'none', authorization: '[redacted]', userPin: '[redacted]', otp_code: '[redacted]' });
  assert.equal(r.text('{"author":"amy","passenger":"bo","user_pass":"x","PHPSESSID":"abc","code":"OK"}'), '{"author":"amy","passenger":"bo","user_pass":"[redacted]","PHPSESSID":"[redacted]","code":"OK"}',
    'JSON-like text: long words, or pass / pwd as a word; short words such as code stay (as before)');
  assert.equal(r.text('a=1 sig=zz connect.sid=abc csrf_token=t'), 'a=1 sig=[redacted] connect.sid=[redacted] csrf_token=[redacted]');
  assert.equal(r.text('"password": "never closed\n" ok'), '"password": "never closed\n" ok', 'a value runs to the closing quote on the same line only');
});

test('numbers that identify a person: national ID, mobile, card (Luhn); other numbers stay', () => {
  assert.equal(r.text('ID A123456789, ARC F800000000'), 'ID [redacted:id], ARC [redacted:id]');
  assert.equal(r.text('call 0912-345-678 or +886 912 345 678'), 'call [redacted:phone] or [redacted:phone]');
  assert.equal(r.text('card 4111 1111 1111 1111 ok'), 'card [redacted:card] ok');
  assert.equal(r.text('order 4111 1111 1111 1112'), 'order 4111 1111 1111 1112', 'fails Luhn: not a card');
  assert.equal(r.text('card 4111111111111111, amex 3782 822463 10005'), 'card [redacted:card], amex [redacted:card]');
  // passes Luhn but is not written as a card: an ID with a letter prefix, or digits grouped unlike any card
  assert.equal(r.text('食品業者登錄字號 A-116057345-00000-5'), '食品業者登錄字號 A-116057345-00000-5');
  assert.equal(r.text('reg 116057345-00000-5'), 'reg 116057345-00000-5');
  assert.equal(r.text('lot A-4111111111111111'), 'lot A-4111111111111111');
  assert.equal(r.text('total 1,234 items, train 123, 2026-10-24'), 'total 1,234 items, train 123, 2026-10-24');
});

test('hostile input stays fast (no catastrophic backtracking)', () => {
  const t0 = Date.now();
  r.text(`${'a1'.repeat(50_000)} ${'password'.repeat(5_000)}: "${'x'.repeat(50_000)} ${'9 '.repeat(50_000)}`);
  r.text(`${'token:"x '.repeat(20_000)} ${'a="'.repeat(20_000)}`); // many quoted values never closed
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
