'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBiliCore } = require('../core.js');
const { createBiliNetwork } = require('../network.js');
const core = createBiliCore();
const mediaURL = 'https://test.bilivideo.com/test.m4s?deadline=123&sign=example';
const meta = { bvid: 'BV1xx411c7mD', cid: 12 };
const keys = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
const response = json => new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
const failGM = () => { throw new Error('Unexpected GM request'); };

test('native API reuses session, selects P2 CID, signs playurl, accepts public WBI keys in -101 nav', async () => {
  const calls = [];
  const net = createBiliNetwork({ core, gmRequest: failGM, nativeFetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/view?')) return response({ code: 0, data: { bvid: meta.bvid, aid: 99, title: 'test', pages: [{ page: 1, cid: 11 }, { page: 2, cid: 12, part: 'second' }] } });
    if (url.endsWith('/nav')) return response({ code: -101, data: { wbi_img: keys } });
    return response({ code: 0, data: { quality: 80, dash: { video: [] } } });
  } });
  const selected = await net.getMeta(`https://www.bilibili.com/video/${meta.bvid}/?p=2`);
  assert.equal(selected.cid, 12);
  assert.equal(selected.page, 2);
  const play = await net.getPlay(selected);
  assert.equal(play.quality, 80);
  const query = new URL(calls.at(-1).url).searchParams;
  assert.equal(query.get('cid'), '12');
  assert.equal(query.get('fnval'), '4048');
  assert.equal(query.get('fourk'), '1');
  assert.equal(query.get('qn'), '127');
  assert.match(query.get('w_rid'), /^[0-9a-f]{32}$/);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrer, 'https://www.bilibili.com/');
  }
  await net.getPlay(selected);
  assert.equal(calls.filter(c => c.url.endsWith('/nav')).length, 1, 'successful keys are memoized');
});

test('WBI -403 refreshes keys once; -412 business error never falls back to GM', async () => {
  let navs = 0, plays = 0, gms = 0;
  const net = createBiliNetwork({ core, gmRequest: () => { gms++; }, nativeFetch: async url => {
    if (url.endsWith('/nav')) { navs++; return response({ code: 0, data: { wbi_img: keys } }); }
    plays++;
    return response(plays === 1 ? { code: -403 } : { code: 0, data: { ok: true } });
  } });
  assert.equal((await net.getPlay(meta)).ok, true);
  assert.equal(navs, 2);
  assert.equal(plays, 2);
  assert.equal(gms, 0);
  const limited = createBiliNetwork({ core, gmRequest: () => { gms++; }, nativeFetch: async url => response(url.endsWith('/nav') ? { code: 0, data: { wbi_img: keys } } : { code: -412 }) });
  await assert.rejects(limited.getPlay(meta), error => error.code === -412);
  assert.equal(gms, 0);
});

test('API transport failure uses GM with normal cookies, no copied credential headers', async () => {
  const calls = [];
  const net = createBiliNetwork({ core, nativeFetch: async () => { throw new TypeError('CORS blocked'); }, gmRequest: details => {
    calls.push(details);
    queueMicrotask(() => details.onload({ status: 200, readyState: 4, finalUrl: details.url, responseHeaders: '', response: { code: 0, data: { bvid: meta.bvid, aid: 99, title: 'test', pages: [{ page: 1, cid: 12 }] } } }));
    return { abort() {} };
  } });
  assert.equal((await net.getMeta(`https://www.bilibili.com/video/${meta.bvid}/`)).cid, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].anonymous, false);
  assert.equal(calls[0].fetch, false);
  assert.deepEqual(calls[0].headers, { Referer: 'https://www.bilibili.com/' });
  assert.equal(new URL(calls[0].url).origin, 'https://api.bilibili.com');
});

test('an aborted key request does not poison the next request or trigger GM fallback', async () => {
  const controller = new AbortController();
  let navs = 0;
  const net = createBiliNetwork({ core, gmRequest: failGM, nativeFetch: (url, options) => {
    if (url.endsWith('/nav')) {
      navs++;
      if (navs === 1) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
        queueMicrotask(() => controller.abort());
      });
      return Promise.resolve(response({ code: 0, data: { wbi_img: keys } }));
    }
    return Promise.resolve(response({ code: 0, data: { ok: true } }));
  } });
  await assert.rejects(net.getPlay(meta, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await net.getPlay(meta)).ok, true);
  assert.equal(navs, 2);
});

test('Range uses exclusive end correctly and returns the exact binary response', async () => {
  let request;
  const net = createBiliNetwork({ core, gmRequest: details => {
    request = details;
    queueMicrotask(() => details.onload({ status: 206, readyState: 4, finalUrl: details.url, responseHeaders: 'Content-Range: bytes 10-19/100\r\nContent-Length: 10\r\n', response: new Uint8Array(10).fill(7).buffer }));
    return { abort() {} };
  } });
  const result = await net.requestRange({ url: mediaURL, start: 10, endExclusive: 20 });
  assert.equal(request.headers.Range, 'bytes=10-19');
  assert.equal(request.headers.Referer, 'https://www.bilibili.com/');
  assert.equal(request.anonymous, false);
  assert.equal(request.fetch, false);
  assert.equal(request.responseType, 'arraybuffer');
  assert.equal(result.status, 206);
  assert.equal(result.headers['content-range'], 'bytes 10-19/100');
  assert.deepEqual([...new Uint8Array(result.body)], Array(10).fill(7));
});

test('ignored Range status 200 is aborted at headers, before the full body', async () => {
  let aborts = 0;
  const net = createBiliNetwork({ core, gmRequest: details => {
    queueMicrotask(() => {
      details.onreadystatechange({ readyState: 2, status: 200, finalUrl: details.url, responseHeaders: 'Content-Length: 1000000000' });
      // A late success callback must not change the already rejected result.
      details.onload({ readyState: 4, status: 206, finalUrl: details.url, response: new ArrayBuffer(10) });
    });
    return { abort() { aborts++; details.onabort(); } };
  } });
  await assert.rejects(net.requestRange({ url: mediaURL, start: 0, endExclusive: 10 }), error => error.status === 200 && /Range/.test(error.message));
  assert.equal(aborts, 1);
});

test('oversized progress aborts, and media redirects outside the CDN allowlist fail', async () => {
  for (const mode of ['large', 'redirect']) {
    let aborts = 0;
    const net = createBiliNetwork({ core, gmRequest: details => {
      queueMicrotask(() => {
        if (mode === 'large') details.onprogress({ status: 206, loaded: 11, finalUrl: details.url });
        else details.onload({ status: 206, finalUrl: 'https://example.com/evil', response: new ArrayBuffer(10) });
      });
      return { abort() { aborts++; } };
    } });
    await assert.rejects(net.requestRange({ url: mediaURL, start: 0, endExclusive: 10 }), mode === 'large' ? /超量/ : /非 B站/);
    assert.equal(aborts, 1);
  }
});

test('invalid media URL is rejected before transport; timeout and abort settle exactly once', async () => {
  let requests = 0, aborts = 0;
  const net = createBiliNetwork({ core, gmRequest: details => {
    requests++;
    return { abort() { aborts++; details.onabort(); } };
  } });
  await assert.rejects(net.requestRange({ url: 'https://bilivideo.com.attacker.example/test', start: 0, endExclusive: 10 }), /允许/);
  assert.equal(requests, 0);
  await assert.rejects(net.requestRange({ url: mediaURL, start: 0, endExclusive: 10, timeoutMs: 5 }), { name: 'TimeoutError' });
  assert.equal(aborts, 1);
  const controller = new AbortController();
  const pending = net.requestRange({ url: mediaURL, start: 0, endExclusive: 10, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(aborts, 2);
});
