'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { JSDOM } = require('jsdom');
const { createBiliCore } = require('../core.js');
const { startBiliDownloader } = require('../main.js');

const core = createBiliCore();
const href = 'https://www.bilibili.com/video/BV1TestVideo/?p=2';
const sourceURL = id => `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${id}/track.m4s?deadline=2000000000`;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const abortError = () => new DOMException('Canceled', 'AbortError');

function playData() {
  return {
    support_formats: [{ quality: 80, new_description: '1080P 高清' }, { quality: 64, new_description: '720P 高清' }, { quality: 120, new_description: '4K 超清' }],
    dash: {
      duration: 60,
      video: [
        { id: 80, codecid: 7, codecs: 'avc1.640028', width: 1920, height: 1080, frameRate: '30000/1001', bandwidth: 8000000, baseUrl: sourceURL(80) },
        { id: 64, codecid: 7, codecs: 'avc1.64001f', width: 1280, height: 720, frameRate: '30', bandwidth: 4000000, baseUrl: sourceURL(64) },
      ],
      audio: [{ id: 30280, codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: sourceURL(30280) }],
    },
  };
}

function resolveMeta(url, title = '测试视频') {
  const identity = core.pageIdentity(url);
  return { bvid: identity.id, aid: 1, cid: 100 + identity.p, page: identity.p, pageCount: 3, title, part: `片段${identity.p}`, identity: identity.key };
}

async function until(predicate, message = 'condition', attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="video-toolbar-container"><div class="video-toolbar-left-main"><button class="video-share">分享</button></div></div></body></html>', { url: href });
  const win = dom.window, doc = win.document;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const events = [], sources = [], requests = [], urls = [], revoked = [];
  win.URL.createObjectURL = blob => { const url = `blob:https://www.bilibili.com/test-${urls.length}`; urls.push({ url, blob }); return url; };
  win.URL.revokeObjectURL = url => revoked.push(url);
  const target = {
    writes: [], closes: 0, aborts: 0,
    async write(chunk) { this.writes.push(chunk); },
    async close() { this.closes++; },
    async abort() { this.aborts++; },
  };
  let writableCalls = 0;
  const handle = { async createWritable() { writableCalls++; if (options.createWritable) return options.createWritable(); return target; } };
  if (options.picker !== false) win.showSaveFilePicker = args => { events.push({ type: 'picker', args }); return options.picker ? options.picker(args) : Promise.resolve(handle); };
  function makeSource(args) {
    const id = Number(new URL(args.urls[0]).pathname.split('/')[2]);
    const source = {
      id, size: id === 30280 ? 3000 : id * 1000,
      signal: args.signal, disposed: 0,
      stats: { downloadedBytes: 256 },
      routes: [{ hostname: 'upos-sz-mirrorali.bilivideo.com', speed: 1500000, quarantined: false }],
      dispose() { this.disposed++; },
      async read() { return new Uint8Array(); },
    };
    sources.push(source); return source;
  }
  const network = {
    async getMeta(url, signal) { requests.push({ type: 'meta', url, signal }); return options.getMeta ? options.getMeta(url, signal) : resolveMeta(url, options.title); },
    async getPlay(meta, args) { requests.push({ type: 'play', meta, args }); return options.getPlay ? options.getPlay(meta, args) : playData(); },
  };
  const range = {
    createLimiter(n) { return { concurrency: n }; },
    async buildSource(args) {
      if (args.signal.aborted) throw abortError();
      return options.buildSource ? options.buildSource(args, makeSource) : makeSource(args);
    },
  };
  const media = {
    async muxToTarget(args) {
      events.push({ type: 'mux', args });
      if (options.mux) return options.mux(args);
      await args.target.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3, 4]) });
      await args.target.close();
      args.onProgress({ stage: 'done', outputBytes: 4, seconds: 60, duration: 60 });
      return { outputBytes: 4 };
    },
  };
  const saved = [];
  const app = startBiliDownloader({ win, doc, network, media, core, range, getValue: () => 4, setValue: (k, v) => saved.push([k, v]) });
  const el = id => app.shadow.querySelector(`[data-id="${id}"]`);
  const ready = async () => { app.open(); await until(() => app.getState().prepared, 'prepared selection'); };
  t.after(() => { app.dispose(); dom.window.close(); });
  return { dom, win, doc, app, el, ready, events, sources, requests, urls, revoked, target, handle, saved, get writableCalls() { return writableCalls; } };
}

test('mounts download entry in the existing share toolbar and parses available qualities', async t => {
  const h = setup(t);
  assert.equal(h.app.entry.parentElement.className, 'video-toolbar-left-main');
  assert.equal(h.doc.querySelector('.video-share').nextElementSibling, h.app.entry);
  assert.equal(h.doc.querySelectorAll('#bnd-download-entry').length, 1);
  await h.ready();
  assert.equal(h.el('rows').children.length, 2);
  assert.match(h.el('quality-hint').textContent, /接口未提供：4K/);
  assert.match(h.el('total').textContent, /已校验/);
  assert.equal(h.el('download').disabled, false);
  assert.equal(h.app.getState().meta.cid, 102);
  const alternate = h.app.shadow.querySelectorAll('input[type=radio]')[1];
  alternate.click();
  await until(() => h.app.getState().prepared?.video.id === 64, '720p selection');
  assert.equal(h.app.getState().prepared.audio.id, 30280);
  assert.ok(h.sources.filter(s => s.id === 80).every(s => s.disposed === 1));
});

test('untrusted video title is rendered as text, never inserted as executable HTML', async t => {
  const title = '<img src=x onerror="globalThis.compromised=1"><script>bad()</script>';
  const h = setup(t, { title });
  await h.ready();
  assert.equal(h.el('title').textContent, `${title} · P2 片段2`);
  assert.equal(h.el('title').children.length, 0);
  assert.equal(h.app.shadow.querySelectorAll('script,img').length, 0);
});

test('late analysis from a prior page cannot replace a newer page result', async t => {
  const old = deferred();
  const h = setup(t, { getMeta: url => url.includes('p=2') ? old.promise : resolveMeta(url, '新页面') });
  h.app.open();
  assert.equal(h.requests.length, 1);
  h.win.history.pushState({}, '', '/video/BV1TestVideo/?p=3');
  h.app.open();
  await until(() => h.app.getState().prepared, 'new page ready');
  assert.equal(h.requests[0].signal.aborted, true);
  const newest = h.app.getState().prepared;
  old.resolve(resolveMeta(href, '旧页面'));
  await until(() => h.requests.filter(r => r.type === 'play').length === 2, 'late response consumed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.app.getState().meta.page, 3);
  assert.equal(h.app.getState().prepared, newest);
  assert.match(h.el('title').textContent, /^新页面/);
});

test('a superseded CDN preparation disposes its source and cannot publish a stale selection', async t => {
  const slow = deferred(); let first = true, staleSource;
  const h = setup(t, { buildSource: (args, make) => {
    const source = make(args);
    if (first) { first = false; staleSource = source; return slow.promise; }
    return source;
  } });
  h.app.open();
  await until(() => staleSource, 'old source preparation');
  h.app.shadow.querySelectorAll('input[type=radio]')[1].click();
  await until(() => h.app.getState().prepared?.video.id === 64, 'new source preparation');
  const current = h.app.getState().prepared;
  assert.equal(staleSource.signal.aborted, true);
  slow.resolve(staleSource);
  await until(() => staleSource.disposed === 1, 'old source disposed');
  assert.equal(h.app.getState().prepared, current);
  assert.equal(current.video.disposed, 0);
  assert.equal(h.el('download').disabled, false);
});

test('save picker is invoked synchronously in the click before any awaited work', async t => {
  const pick = deferred(), mux = deferred();
  const h = setup(t, { picker: () => pick.promise, mux: args => mux.promise });
  await h.ready();
  const pack = h.app.getState().prepared;
  h.el('download').click();
  assert.equal(h.events[0].type, 'picker', 'must happen before click() returns');
  assert.equal(h.writableCalls, 0);
  assert.equal(h.el('download').disabled, true);
  assert.equal(h.app.getState().activeJob !== null, true);
  assert.match(h.events[0].args.suggestedName, /_P2_/);
  pick.resolve(h.handle);
  await until(() => h.events.some(e => e.type === 'mux'), 'mux invocation');
  const call = h.events.find(e => e.type === 'mux').args;
  assert.equal(call.videoSource, pack.video);
  assert.equal(call.audioSource, pack.audio);
  // Disabled radio rows must not visually change the active download selection.
  const rows = h.el('rows').children;
  rows[1].querySelector('.resolution').click();
  assert.equal(rows[0].querySelector('input').checked, true);
  assert.equal(rows[1].querySelector('input').checked, false);
  await h.target.close();
  mux.resolve({ outputBytes: 4 });
  await until(() => h.app.getState().activeJob === null, 'download completion');
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(pack.controller.signal.aborted, true);
  assert.equal(getEventListeners(call.signal, 'abort').length, 0);
  assert.match(h.el('status').textContent, /已保存/);
});

test('cancel while save picker is pending never opens a writable and releases prepared sources', async t => {
  const pick = deferred();
  const h = setup(t, { picker: () => pick.promise });
  await h.ready();
  const pack = h.app.getState().prepared;
  h.el('download').click();
  h.el('cancel').click();
  pick.resolve(h.handle);
  await until(() => h.app.getState().activeJob === null, 'picker cancellation');
  assert.equal(h.writableCalls, 0);
  assert.equal(h.events.some(e => e.type === 'mux'), false);
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(h.app.getState().prepared, null);
  assert.match(h.el('status').textContent, /已取消/);
  assert.equal(h.el('refresh').disabled, false);
});

test('cancel active mux relays cancellation to CDN sources and supports a fresh retry', async t => {
  let muxArgs;
  const h = setup(t, { mux: args => {
    muxArgs = args;
    return new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', async () => { await args.target.abort(); reject(abortError()); }, { once: true });
    });
  } });
  await h.ready(); const pack = h.app.getState().prepared;
  h.el('download').click();
  await until(() => muxArgs, 'active mux');
  h.el('cancel').click();
  assert.equal(pack.controller.signal.aborted, true);
  await until(() => h.app.getState().activeJob === null, 'mux canceled');
  assert.equal(h.target.aborts, 1);
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(h.el('cancel').hidden, true);
  assert.equal(h.el('error').hidden, true);
  h.el('reprobe').click();
  await until(() => h.app.getState().prepared, 'retry prepared');
  assert.notEqual(h.app.getState().prepared.video, pack.video);
  assert.equal(h.el('download').disabled, false);
});

test('failed mux cleans up sources and abort listener, surfaces a redacted error, and reenables analysis', async t => {
  let failedSignal;
  const h = setup(t, { mux: async args => {
    failedSignal = args.signal;
    await args.target.abort(); // The real media engine owns target failure cleanup.
    throw new Error(`Download failed ${sourceURL(80)}&secret=abc`);
  } });
  await h.ready(); const pack = h.app.getState().prepared;
  h.el('download').click();
  await until(() => h.app.getState().activeJob === null, 'error cleanup');
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(h.target.aborts, 1);
  assert.equal(getEventListeners(failedSignal, 'abort').length, 0);
  assert.match(h.el('error').textContent, /upos-sz-mirrorali.bilivideo.com/);
  assert.doesNotMatch(h.el('error').textContent, /secret|deadline/);
  assert.equal(h.el('refresh').disabled, false);
  assert.equal(h.el('reprobe').disabled, false);
  h.el('refresh').click();
  await until(() => h.app.getState().prepared, 'analysis after failure');
  assert.equal(h.el('error').hidden, true);
});

test('memory fallback creates a completed blob and changing quality revokes its URL', async t => {
  const h = setup(t, { picker: false });
  await h.ready();
  assert.equal(h.el('save-mode').value, 'memory');
  assert.equal(h.el('save-mode').options[0].disabled, true);
  h.el('download').click();
  await until(() => h.app.getState().activeJob === null, 'memory completion');
  assert.equal(h.urls.length, 1);
  assert.deepEqual([...new Uint8Array(await h.urls[0].blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(h.el('save-blob').hidden, false);
  assert.equal(h.el('download').hidden, true);
  h.app.shadow.querySelectorAll('input[type=radio]')[1].click();
  await until(() => h.app.getState().prepared?.video.id === 64, 'new quality after memory download');
  assert.deepEqual(h.revoked, [h.urls[0].url]);
  assert.equal(h.el('save-blob').hidden, true);
  assert.equal(h.el('download').hidden, false);
});

test('disposing while mux is pending prevents a late success from allocating a new blob URL', async t => {
  const finish = deferred(); let started = false;
  const h = setup(t, { picker: false, mux: async args => {
    started = true;
    await args.target.write({ type: 'write', position: 0, data: new Uint8Array([1]) });
    await args.target.close();
    await finish.promise; // Deliberately ignores abort to exercise the caller guard.
    return { outputBytes: 1 };
  } });
  await h.ready();
  h.el('download').click();
  await until(() => started, 'pending mux');
  h.app.dispose();
  finish.resolve();
  await until(() => h.app.getState().activeJob === null, 'disposed mux settled');
  assert.equal(h.urls.length, 0);
  assert.equal(h.doc.querySelector('#bnd-panel-host'), null);
  h.app.open();
  assert.equal(h.doc.querySelector('#bnd-panel-host'), null);
});
