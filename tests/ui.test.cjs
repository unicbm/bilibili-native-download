'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { JSDOM } = require('jsdom');
const { createBiliCore } = require('../core.js');
const { startBiliDownloader } = require('../main.js');
const { createDirectoryPicker } = require('../picker.js');

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

async function until(predicate, message = 'condition', attempts = 100, interval = 0) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => interval ? setTimeout(resolve, interval) : setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="video-column"><div class="video-toolbar-container"><div class="video-toolbar-left-main"><button class="video-share">分享</button></div></div><div id="video-description">视频简介</div></main></body></html>', { url: href });
  const win = dom.window, doc = win.document;
  const events = [], sources = [], requests = [], urls = [], revoked = [];
  win.URL.createObjectURL = blob => { const url = `blob:https://www.bilibili.com/test-${urls.length}`; urls.push({ url, blob }); return url; };
  win.URL.revokeObjectURL = url => revoked.push(url);
  const target = {
    writes: [], closes: 0, aborts: 0,
    async write(chunk) { assert.equal(this, target); this.writes.push(chunk); },
    async close() { assert.equal(this, target); this.closes++; },
    async abort() { assert.equal(this, target); this.aborts++; },
  };
  let writableCalls = 0;
  const handle = {
    name: '',
    async getFile() { assert.equal(this, handle); return options.getFile ? options.getFile() : { name: handle.name, size: 0, lastModified: 1 }; },
    async createWritable(args) {
      assert.equal(this, handle); writableCalls++;
      assert.deepEqual(args, { keepExistingData: false, mode: 'exclusive' });
      if (options.createWritable) return options.createWritable(args);
      return target;
    },
  };
  const fileLookups = [];
  const directory = { async getFileHandle(name, args = {}) {
    assert.equal(this, directory); fileLookups.push({ name, args });
    if (options.getFileHandle) return options.getFileHandle(name, args, handle);
    if (!args.create) throw new DOMException('No such file', 'NotFoundError');
    handle.name = name; return handle;
  } };
  const pickerWindow = options.pickerWindow || win;
  if (options.picker !== false) pickerWindow.showDirectoryPicker = function (args) {
    // Native Window methods reject a userscript's window wrapper as `this`.
    if (this !== pickerWindow) throw new TypeError("Failed to execute 'showDirectoryPicker' on 'Window': Illegal invocation");
    events.push({ type: 'picker', args });
    return options.picker ? options.picker(args) : Promise.resolve(directory);
  };
  if (pickerWindow !== win) {
    const sandboxWindow = new Proxy(pickerWindow, {});
    // Keep a callable on the sandbox even when the native API is unavailable.
    // Neither capability detection nor saving should consult this wrapper.
    win.showDirectoryPicker = function (args) {
      if (typeof sandboxWindow.showDirectoryPicker !== 'function') throw new Error('Sandbox-only picker must not be called');
      return sandboxWindow.showDirectoryPicker(args);
    };
  }
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
  const app = startBiliDownloader({ win, doc, network, media, core, range, pickDirectory: createDirectoryPicker(pickerWindow), getValue: () => 4, setValue: (k, v) => saved.push([k, v]) });
  const el = id => app.shadow.querySelector(`[data-id="${id}"]`);
  const ready = async () => { app.open(); await until(() => app.getState().prepared, 'prepared selection'); };
  t.after(() => { app.dispose(); dom.window.close(); });
  return { dom, win, doc, app, el, ready, events, sources, requests, urls, revoked, target, handle, directory, fileLookups, saved, get writableCalls() { return writableCalls; } };
}

test('download toggles an inline region after the toolbar and preserves the prepared selection', async t => {
  const h = setup(t);
  const outer = h.doc.querySelector('.video-toolbar-container');
  const host = h.doc.querySelector('#bnd-panel-host');
  assert.equal(h.app.entry.parentElement.className, 'video-toolbar-left-main');
  assert.equal(h.doc.querySelector('.video-share').nextElementSibling, h.app.entry);
  assert.equal(h.doc.querySelectorAll('#bnd-download-entry').length, 1);
  assert.equal(outer.nextElementSibling, host, 'panel belongs to the video column, after the whole toolbar');
  assert.equal(host.nextElementSibling.id, 'video-description');
  assert.equal(host.hidden, true);
  assert.equal(h.app.entry.getAttribute('aria-expanded'), 'false');
  assert.equal(h.app.entry.getAttribute('aria-controls'), host.id);
  assert.equal(h.app.entry.hasAttribute('aria-haspopup'), false);
  assert.equal(h.app.shadow.querySelector('dialog'), null);
  assert.ok(h.app.shadow.querySelector('section[role="region"][aria-labelledby="bnd-heading"]'));
  h.app.entry.click();
  await until(() => h.app.getState().prepared, 'inline panel prepared');
  assert.equal(host.hidden, false);
  assert.equal(h.app.entry.getAttribute('aria-expanded'), 'true');
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
  const pack = h.app.getState().prepared, requestCount = h.requests.length;
  h.app.entry.click();
  assert.equal(host.hidden, true);
  assert.equal(h.app.entry.getAttribute('aria-expanded'), 'false');
  h.app.entry.click();
  assert.equal(host.hidden, false);
  assert.equal(h.app.getState().prepared, pack);
  assert.equal(pack.controller.signal.aborted, false);
  assert.equal(h.requests.length, requestCount, 'folding does not reparse or restart prepared downloads');
  h.el('close').click();
  assert.equal(host.hidden, true);
  assert.equal(h.app.entry.getAttribute('aria-expanded'), 'false');
});

test('folding and reopening during parsing or CDN preparation keeps the same work in flight', async t => {
  const metadata = deferred(), videoReady = deferred();
  let firstSource;
  const h = setup(t, {
    getMeta: () => metadata.promise,
    buildSource(args, make) {
      const source = make(args);
      if (!firstSource) { firstSource = source; return videoReady.promise; }
      return source;
    },
  });
  h.app.entry.click();
  assert.equal(h.requests.length, 1);
  const signal = h.requests[0].signal;
  h.app.close(); h.app.open(); h.app.open();
  assert.equal(h.requests.length, 1);
  assert.equal(signal.aborted, false);
  metadata.resolve(resolveMeta(href));
  await until(() => firstSource, 'pending CDN preparation');
  const preparation = h.app.getState().preparation;
  h.app.close(); h.app.open(); h.app.open();
  assert.equal(h.app.getState().preparation, preparation);
  assert.equal(preparation.signal.aborted, false);
  assert.equal(h.sources.length, 1);
  videoReady.resolve(firstSource);
  await until(() => h.app.getState().prepared, 'resumed preparation');
  assert.equal(h.sources.length, 2, 'video and audio are prepared once each');
  assert.equal(h.app.getState().prepared.video, firstSource);
});

test('replacing the video column remounts both inline panel and entry without losing its state', async t => {
  const h = setup(t);
  await h.ready();
  const host = h.doc.querySelector('#bnd-panel-host');
  const pack = h.app.getState().prepared;
  const column = h.doc.querySelector('#video-column');
  const replacement = h.doc.createElement('div');
  replacement.className = 'video-toolbar-container';
  replacement.innerHTML = '<div class="video-toolbar-left-main"><button class="video-share">分享</button></div>';
  const description = h.doc.createElement('div');
  description.textContent = '新的视频简介';
  column.replaceChildren(replacement, description);
  assert.equal(host.isConnected, false);
  await until(() => host.isConnected && h.app.entry.isConnected, 'toolbar and panel remount', 100, 5);
  assert.equal(replacement.nextElementSibling, host);
  assert.equal(host.nextElementSibling, description);
  assert.equal(h.app.entry.parentElement, replacement.firstElementChild);
  assert.equal(host.hidden, false);
  assert.equal(h.app.entry.getAttribute('aria-expanded'), 'true');
  assert.equal(h.app.getState().prepared, pack);
  assert.equal(pack.controller.signal.aborted, false);
  assert.equal(h.doc.querySelectorAll('#bnd-panel-host').length, 1);
  assert.equal(h.doc.querySelectorAll('#bnd-download-entry').length, 1);
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

test('directory picker uses the native Window receiver synchronously, despite a userscript window Proxy', async t => {
  const pick = deferred(), mux = deferred();
  const h = setup(t, { pickerWindow: {}, picker: () => pick.promise, mux: args => mux.promise });
  assert.throws(() => h.win.showDirectoryPicker({}), /Illegal invocation/, 'the old sandbox call must fail in this regression fixture');
  await h.ready();
  const pack = h.app.getState().prepared;
  h.el('download').click();
  assert.equal(h.events[0].type, 'picker', 'must happen before click() returns');
  assert.equal(h.writableCalls, 0);
  assert.equal(h.el('download').disabled, true);
  assert.equal(h.app.getState().activeJob !== null, true);
  assert.deepEqual(h.events[0].args, { id: 'bnd-downloads', mode: 'readwrite' });
  pick.resolve(h.directory);
  await until(() => h.events.some(e => e.type === 'mux'), 'mux invocation');
  const call = h.events.find(e => e.type === 'mux').args;
  assert.equal(call.videoSource, pack.video);
  assert.equal(call.audioSource, pack.audio);
  const job = h.app.getState().activeJob;
  h.app.entry.click();
  assert.equal(h.doc.querySelector('#bnd-panel-host').hidden, true);
  assert.equal(job.controller.signal.aborted, false);
  assert.equal(pack.controller.signal.aborted, false);
  h.app.entry.click();
  assert.equal(h.doc.querySelector('#bnd-panel-host').hidden, false);
  assert.equal(h.app.getState().activeJob, job);
  assert.equal(h.events.filter(e => e.type === 'mux').length, 1);
  // Disabled radio rows must not visually change the active download selection.
  const rows = h.el('rows').children;
  rows[1].querySelector('.resolution').click();
  assert.equal(rows[0].querySelector('input').checked, true);
  assert.equal(rows[1].querySelector('input').checked, false);
  h.app.close();
  const requestsBeforeCompletion = h.requests.length, sourcesBeforeCompletion = h.sources.length;
  await h.target.close();
  mux.resolve({ outputBytes: 4 });
  await until(() => h.app.getState().activeJob === null, 'download completion');
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(pack.controller.signal.aborted, true);
  assert.equal(getEventListeners(call.signal, 'abort').length, 0);
  const savedStatus = `已保存：${h.handle.name}`;
  assert.match(h.handle.name, /_P2_/);
  assert.equal(h.el('status').textContent, savedStatus);
  assert.equal(h.doc.querySelector('#bnd-panel-host').hidden, true);
  h.app.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.doc.querySelector('#bnd-panel-host').hidden, false);
  assert.equal(h.el('status').textContent, savedStatus, 'reopening keeps the completed filename visible');
  assert.equal(h.requests.length, requestsBeforeCompletion, 'reopening a completed download does not refresh its URLs');
  assert.equal(h.sources.length, sourcesBeforeCompletion, 'reopening a completed download does not start new CDN probes');
});

test('dismissing the native directory picker cancels without retrying, opening a writable, or starting mux', async t => {
  const h = setup(t, { pickerWindow: {}, picker: () => Promise.reject(abortError()) });
  await h.ready();
  const requestsBefore = h.requests.length;
  const sourcesBefore = h.sources.length;
  const pack = h.app.getState().prepared;
  h.el('download').click();
  await until(() => h.app.getState().activeJob === null, 'dismissed picker cleanup');
  assert.equal(h.events.filter(e => e.type === 'picker').length, 1);
  assert.equal(h.events.some(e => e.type === 'mux'), false);
  assert.equal(h.writableCalls, 0);
  assert.equal(h.requests.length, requestsBefore);
  assert.equal(h.sources.length, sourcesBefore);
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(h.el('error').hidden, true);
  assert.match(h.el('status').textContent, /已取消/);
});

test('cancel while directory picker is pending never opens a writable and releases prepared sources', async t => {
  const pick = deferred();
  const h = setup(t, { picker: () => pick.promise });
  await h.ready();
  const pack = h.app.getState().prepared;
  h.el('download').click();
  h.el('cancel').click();
  pick.resolve(h.directory);
  await until(() => h.app.getState().activeJob === null, 'picker cancellation');
  assert.equal(h.writableCalls, 0);
  assert.equal(h.events.some(e => e.type === 'mux'), false);
  assert.equal(pack.video.disposed, 1);
  assert.equal(pack.audio.disposed, 1);
  assert.equal(h.app.getState().prepared, null);
  assert.match(h.el('status').textContent, /已取消/);
  assert.equal(h.el('refresh').disabled, false);
});

test('folder permission refusal preserves preparation and a second explicit click can save to a new file', async t => {
  let attempts = 0, h;
  h = setup(t, { picker() {
    if (++attempts === 1) return Promise.reject(new DOMException('Folder permission refused', 'NotAllowedError'));
    return Promise.resolve(h.directory);
  } });
  await h.ready();
  const pack = h.app.getState().prepared, requestCount = h.requests.length, sourceCount = h.sources.length;
  h.el('download').click();
  await until(() => h.app.getState().activeJob === null, 'folder refusal handled');
  assert.equal(h.app.getState().prepared, pack);
  assert.equal(pack.controller.signal.aborted, false);
  assert.equal(h.writableCalls, 0);
  assert.equal(h.events.some(e => e.type === 'mux'), false);
  assert.equal(h.el('error').hidden, false);
  assert.equal(h.el('download').disabled, false);
  h.el('download').click();
  assert.equal(attempts, 2, 'retry requires and preserves the new click activation');
  await until(() => h.app.getState().activeJob === null, 'retry saved');
  assert.equal(h.el('error').hidden, true);
  assert.equal(h.el('status').textContent, `已保存：${h.handle.name}`);
  assert.equal(h.events.filter(e => e.type === 'mux').length, 1);
  assert.equal(h.requests.length, requestCount);
  assert.equal(h.sources.length, sourceCount);
});

test('locked and security-rejected file creation stays retryable and is not reported as user cancellation', async t => {
  for (const name of ['NoModificationAllowedError', 'AbortError']) {
    await t.test(name, async t => {
      let attempts = 0, h;
      h = setup(t, { createWritable() {
        if (++attempts === 1) throw new DOMException('Native writer blocked', name);
        return h.target;
      } });
      await h.ready();
      const pack = h.app.getState().prepared;
      h.el('download').click();
      await until(() => h.app.getState().activeJob === null, 'native failure shown');
      const firstName = h.handle.name;
      assert.equal(h.app.getState().prepared, pack);
      assert.equal(pack.controller.signal.aborted, false);
      assert.equal(h.events.some(e => e.type === 'mux'), false);
      assert.equal(h.el('error').hidden, false);
      assert.doesNotMatch(h.el('status').textContent, /已取消/);
      assert.equal(h.el('download').disabled, false);
      h.el('download').click();
      await until(() => h.app.getState().activeJob === null, 'new output saved');
      assert.notEqual(h.handle.name, firstName, 'another attempt gets another output filename');
      assert.equal(h.el('status').textContent, `已保存：${h.handle.name}`);
      assert.equal(h.target.closes, 1);
    });
  }
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
  const h = setup(t, { picker: false, pickerWindow: {} });
  assert.equal(typeof h.win.showDirectoryPicker, 'function', 'sandbox API presence must not override native picker availability');
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
