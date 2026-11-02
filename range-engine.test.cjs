'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRangeEngine } = require('./range-engine.js');

const URLS = ['https://a.bilivideo.com/media?sign=a', 'https://b.bilivideo.com/media?sign=b'];
const bytes = length => Uint8Array.from({ length }, (_, i) => (i * 47 + Math.floor(i / 251)) % 256);
function fake(data, mutate) {
  const calls = [];
  let active = 0, peak = 0;
  async function request(args) {
    const index = calls.length;
    calls.push({ ...args });
    active++; peak = Math.max(peak, active);
    try {
      if (args.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const end = Math.min(args.endExclusive, data.length);
      let response = {
        status: 206,
        headers: { 'content-range': `bytes ${args.start}-${end - 1}/${data.length}`, 'content-length': String(end - args.start) },
        body: data.slice(args.start, end)
      };
      const change = mutate?.(args, response, index);
      if (change instanceof Error) throw change;
      if (change?.response) response = change.response;
      const delay = change?.delay ?? 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { args.signal.removeEventListener('abort', abort); resolve(); }, delay);
        const abort = () => { clearTimeout(timer); args.signal.removeEventListener('abort', abort); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        args.signal.addEventListener('abort', abort, { once: true });
      });
      return response;
    } finally { active--; }
  }
  return { request, calls, get active() { return active; }, get peak() { return peak; } };
}
const opts = { urls: URLS, chunkSize: 1024, sampleBytes: 128, concurrency: 4, maxCacheBytes: 4096 };

test('out-of-order requests produce exact bytes, with bounded LRU cache and aggregate concurrency', async () => {
  const data = bytes(21119);
  const network = fake(data, (args) => ({ delay: args.start % 2048 === 0 ? 12 : 1 }));
  const engine = createRangeEngine(network);
  const limiter = engine.createLimiter(4);
  const [v, a] = await Promise.all([
    engine.buildSource({ ...opts, limiter }),
    engine.buildSource({ ...opts, limiter })
  ]);
  try {
    assert.equal(v.size, data.length);
    const [video, audio] = await Promise.all([v.read(0, data.length), a.read(27, data.length - 21)]);
    assert.deepEqual(video, data);
    assert.deepEqual(audio, data.slice(27, -21));
    assert.ok(network.peak <= 4, `peak was ${network.peak}`);
    assert.ok(v.stats.peakCacheBytes <= 4096);
    assert.ok(a.stats.peakCacheBytes <= 4096);
    assert.deepEqual(await v.read(66, 2049), data.slice(66, 2049), 'evicted chunks can be fetched again');
    assert.ok(v.stats.downloadedBytes >= data.length);
  } finally { v.dispose(); a.dispose(); }
});

test('HTTP 200 is never accepted as a Range response; valid backup remains usable', async () => {
  const data = bytes(3000);
  const network = fake(data, (args, response) => args.url === URLS[0] ? ({ response: { ...response, status: 200, body: data } }) : null);
  const src = await createRangeEngine(network).buildSource(opts);
  try {
    assert.equal(src.routes[0].quarantined, true);
    assert.deepEqual(await src.read(0, data.length), data);
  } finally { src.dispose(); }
});

test('wrong offset, truncated data, changed totals are quarantined before output; backup supplies valid bytes', async t => {
  for (const kind of ['offset', 'truncated', 'total']) {
    await t.test(kind, async () => {
      const data = bytes(8000);
      const network = fake(data, (args, response) => {
        if (args.start !== 0 && args.url === URLS[0]) {
          if (kind === 'offset') response.headers['content-range'] = `bytes ${args.start + 1}-${Math.min(args.endExclusive, data.length)}/${data.length}`;
          if (kind === 'truncated') response.body = response.body.slice(1);
          if (kind === 'total') response.headers['content-range'] = response.headers['content-range'].replace('/8000', '/8001');
        }
        return { delay: args.url === URLS[0] ? 1 : 8 };
      });
      const src = await createRangeEngine(network).buildSource({ ...opts, prefetch: false });
      try {
        assert.deepEqual(await src.read(0, 4096), data.slice(0, 4096));
        assert.equal(src.routes[0].quarantined, true);
      } finally { src.dispose(); }
    });
  }
});

test('fallback with same size but different initial bytes is rejected', async () => {
  const data = bytes(4096);
  const network = fake(data, (args, response) => {
    if (args.url === URLS[1]) response.body[20] ^= 0xff;
  });
  const src = await createRangeEngine(network).buildSource(opts);
  try {
    assert.equal(src.routes[1].quarantined, true);
    assert.deepEqual(await src.read(0, data.length), data);
  } finally { src.dispose(); }
});

test('transient failure changes CDN without losing bytes', async () => {
  const data = bytes(10000), routes = [];
  const network = fake(data, (args, response) => ({
    delay: args.url === URLS[0] ? 1 : 10,
    response: args.url === URLS[0] && args.start > 0 ? { ...response, status: 503 } : response
  }));
  const src = await createRangeEngine(network).buildSource({ ...opts, onRoute: route => routes.push(route), prefetch: false });
  try {
    assert.deepEqual(await src.read(0, 5000), data.slice(0, 5000));
    assert.ok(routes.some(route => route.hostname === 'b.bilivideo.com' && route.reason === 'failover'));
  } finally { src.dispose(); }
});

test('all URLs failing after a successful probe produce a bounded terminal error', async () => {
  const data = bytes(4096);
  const network = fake(data, (args, response) => args.start > 0 ? { response: { ...response, status: 503 } } : null);
  const src = await createRangeEngine(network).buildSource({ ...opts, prefetch: false });
  try {
    await assert.rejects(src.read(0, 1000), /均未完成分片/);
    assert.equal(network.calls.length, 6, 'two probes plus two attempts per URL');
  } finally { src.dispose(); }
});

test('source cancellation aborts active and queued requests and rejects pending readers', async () => {
  const data = bytes(50000), controller = new AbortController();
  const network = fake(data, args => ({ delay: args.start > 0 ? 10000 : 1 }));
  const engine = createRangeEngine(network);
  const limiter = engine.createLimiter(2);
  const src = await engine.buildSource({ ...opts, signal: controller.signal, limiter });
  const reading = src.read(0, data.length);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(reading, { name: 'AbortError' });
  src.dispose();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(network.active, 0);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
  assert.equal(src.stats.cacheBytes, 0);
});

test('canceling one read does not destroy a shared source', async () => {
  const data = bytes(8192), controller = new AbortController();
  const network = fake(data, args => ({ delay: args.start > 0 ? 15 : 1 }));
  const src = await createRangeEngine(network).buildSource(opts);
  try {
    const canceled = src.read(3000, 5000, controller.signal);
    controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    assert.deepEqual(await src.read(3000, 5000), data.slice(3000, 5000));
  } finally { src.dispose(); }
});

test('file shorter than probe uses exact total and no extra request', async () => {
  const data = bytes(37), network = fake(data);
  const src = await createRangeEngine(network).buildSource(opts);
  try {
    assert.equal(src.size, 37);
    assert.deepEqual(await src.read(0, 37), data);
    assert.equal(network.calls.length, 2);
    assert.deepEqual(await src.read(0, 0), new Uint8Array());
    await assert.rejects(src.read(0, 38), RangeError);
  } finally { src.dispose(); }
});

test('timeouts abort an adapter even when its native timeout is absent', async () => {
  const data = bytes(2000);
  const network = fake(data, () => ({ delay: 10000 }));
  await assert.rejects(createRangeEngine(network).buildSource({ ...opts, timeoutMs: 100 }), /超时/);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(network.active, 0);
});

test('UI callback errors cannot affect valid downloaded bytes', async () => {
  const data = bytes(4000), network = fake(data);
  const src = await createRangeEngine(network).buildSource({ ...opts, onProgress() { throw new Error('UI error'); }, onRoute() { throw new Error('UI error'); } });
  try { assert.deepEqual(await src.read(0, 4000), data); }
  finally { src.dispose(); }
});
