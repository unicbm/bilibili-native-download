'use strict';
/**
 * Release artifact smoke test: no application module imports and no network.
 * Dependencies: npm install; FFmpeg + FFprobe on PATH; npm run build first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const bundlePath = path.join(__dirname, '../dist/bilibili-native-download.user.js');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
const ffmpeg = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const encodedHash = (filename, stream) => run('ffmpeg', ['-v', 'error', '-i', filename, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();

test('actual release userscript: toolbar -> authenticated WBI parse -> GM ranges -> tree-shaken MP4 mux -> saved audiovisual file', async t => {
  assert.ok(fs.existsSync(bundlePath), 'Run npm run build to produce the release userscript');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-release-smoke-'));
  const videoFile = path.join(dir, 'video.mp4'), audioFile = path.join(dir, 'audio.mp4'), outputFile = path.join(dir, 'output.mp4');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-g', '30', '-threads', '2', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', videoFile]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000', '-t', '3', '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', audioFile]);
  const sourceData = { '/video.m4s': fs.readFileSync(videoFile), '/audio.m4s': fs.readFileSync(audioFile) };
  const sourceURL = (track, backup = false) => `https://${backup ? 'backup' : 'primary'}.bilivideo.com/${track}.m4s?deadline=2000000000&sign=local-test`;
  const bvid = 'BV1BundleSmoke', href = `https://www.bilibili.com/video/${bvid}/?p=2`;
  const apiCalls = [], gmCalls = [], menuCalls = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('<!doctype html><html><body><div class="video-toolbar-container"><div class="video-toolbar-left-main"><button class="video-share">分享</button></div></div></body></html>', {
    url: href, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  t.after(() => dom.window.close());
  const win = dom.window, doc = win.document;
  // jsdom owns DOM objects; Node supplies standards-compatible binary/stream APIs.
  for (const name of ['TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal', 'DOMException', 'Response', 'Request', 'Headers', 'Blob', 'structuredClone']) {
    if (globalThis[name]) win[name] = globalThis[name];
  }
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  win.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  win.GM_getValue = (_key, fallback) => fallback;
  win.GM_setValue = () => {};
  win.GM_registerMenuCommand = (name, handler) => menuCalls.push({ name, handler });
  win.fetch = async (rawURL, options) => {
    const url = String(rawURL), parsed = new URL(url);
    apiCalls.push({ url, options });
    assert.equal(parsed.origin, 'https://api.bilibili.com', 'Only the intended API origin is queried');
    assert.equal(options.credentials, 'include', 'Existing browser session is requested');
    assert.equal(options.redirect, 'error');
    options.signal?.throwIfAborted();
    let json;
    if (parsed.pathname === '/x/web-interface/view') {
      assert.equal(parsed.searchParams.get('bvid'), bvid);
      json = { code: 0, data: { bvid, aid: 12, title: '发布版合成验证', pages: [{ page: 1, cid: 111, part: '第一段' }, { page: 2, cid: 222, part: '第二段', duration: 3 }] } };
    } else if (parsed.pathname === '/x/web-interface/nav') {
      json = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
    } else if (parsed.pathname === '/x/player/wbi/playurl') {
      assert.equal(parsed.searchParams.get('cid'), '222');
      assert.equal(parsed.searchParams.get('qn'), '127');
      assert.equal(parsed.searchParams.get('fnval'), '4048');
      assert.match(parsed.searchParams.get('w_rid'), /^[0-9a-f]{32}$/);
      json = { code: 0, data: { support_formats: [{ quality: 80, new_description: '1080P 高清' }], dash: {
        duration: 3,
        video: [{ id: 80, codecid: 7, codecs: 'avc1.640028', width: 320, height: 180, frameRate: '30', bandwidth: 800000, baseUrl: sourceURL('video'), backupUrl: [sourceURL('video', true)] }],
        audio: [{ id: 30280, codecs: 'mp4a.40.2', bandwidth: 128000, baseUrl: sourceURL('audio'), backupUrl: [sourceURL('audio', true)] }]
      } } };
    } else throw new Error(`Unexpected API path ${parsed.pathname}`);
    const response = new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  let activeGM = 0, peakGM = 0;
  const pendingGM = new Set();
  win.GM_xmlhttpRequest = details => {
    gmCalls.push(details);
    const url = new URL(details.url), data = sourceData[url.pathname];
    assert.ok(data, 'GM requests are media requests, never a hidden external service');
    assert.equal(details.method, 'GET');
    assert.equal(details.responseType, 'arraybuffer');
    assert.equal(details.headers.Referer, 'https://www.bilibili.com/');
    assert.equal(details.headers.Cookie, undefined);
    assert.equal(details.headers.Authorization, undefined);
    const match = /^bytes=(\d+)-(\d+)$/.exec(details.headers.Range);
    assert.ok(match, 'Range header is required');
    const start = Number(match[1]), end = Math.min(data.length, Number(match[2]) + 1);
    const body = data.subarray(start, end);
    const responseHeaders = `Content-Range: bytes ${start}-${end - 1}/${data.length}\r\nContent-Length: ${body.length}\r\nContent-Type: video/mp4\r\n`;
    let settled = false;
    activeGM++; peakGM = Math.max(peakGM, activeGM);
    const finish = () => { if (settled) return false; settled = true; activeGM--; pendingGM.delete(handle); return true; };
    const timer = setTimeout(() => {
      if (settled) return;
      details.onreadystatechange?.({ readyState: 2, status: 206, finalUrl: details.url, responseHeaders });
      if (settled) return;
      details.onprogress?.({ readyState: 3, status: 206, finalUrl: details.url, responseHeaders, loaded: body.length, total: body.length });
      if (!finish()) return;
      // Produce a browser-realm ArrayBuffer, exactly as GM's arraybuffer mode does.
      const copy = new win.Uint8Array(body.length); copy.set(body);
      details.onload({ readyState: 4, status: 206, finalUrl: details.url, responseHeaders, response: copy.buffer });
    }, url.hostname.startsWith('backup') ? 3 : 1);
    const handle = { abort() { clearTimeout(timer); if (finish()) details.onabort?.(); } };
    pendingGM.add(handle);
    return handle;
  };
  let targetCloses = 0, targetAborts = 0, pickerCalls = 0, writableCalls = 0, maxWritten = 0;
  let outputFD = null, finished = false, suggestedName = '';
  t.after(() => { pendingGM.forEach(handle => handle.abort()); if (outputFD !== null && !finished) fs.closeSync(outputFD); });
  win.showSaveFilePicker = options => {
    pickerCalls++; suggestedName = options.suggestedName;
    return Promise.resolve({ async createWritable() {
      writableCalls++; outputFD = fs.openSync(outputFile, 'w');
      return {
        async write({ type, position, data }) {
          assert.equal(type, 'write');
          assert.ok(Number.isSafeInteger(position) && position >= 0);
          const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          fs.writeSync(outputFD, bytes, 0, bytes.length, position);
          maxWritten = Math.max(maxWritten, position + bytes.length);
        },
        async close() { targetCloses++; if (!finished) fs.closeSync(outputFD); finished = true; },
        async abort() { targetAborts++; if (!finished) fs.closeSync(outputFD); finished = true; fs.rmSync(outputFile, { force: true }); }
      };
    } });
  };
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /==UserScript==/);
  win.eval(bundle);
  const toolbar = doc.querySelector('.video-toolbar-left-main'), button = doc.querySelector('#bnd-download-entry');
  assert.ok(button, 'Actual bundled entry point created its toolbar UI');
  assert.equal(button.parentElement, toolbar);
  assert.equal(menuCalls.length, 1);
  const shadow = doc.querySelector('#bnd-panel-host').shadowRoot;
  const el = id => shadow.querySelector(`[data-id="${id}"]`);
  async function until(predicate, label) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.equal(errors.length, 0, errors.map(e => e.stack || String(e)).join('\n'));
      assert.equal(el('error').hidden, true, `UI error while ${label}: ${el('error').textContent}`);
      if (Date.now() >= deadline) assert.fail(`Timed out: ${label}; status=${el('status').textContent}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  button.click();
  await until(() => !el('download').disabled, 'parsing and CDN preparation');
  assert.equal(shadow.querySelector('dialog').open, true);
  assert.equal(el('rows').children.length, 1);
  assert.match(el('total').textContent, /已校验/);
  assert.match(el('title').textContent, /P2 第二段/);
  assert.equal(el('save-mode').value, 'disk');
  assert.deepEqual(apiCalls.map(c => new URL(c.url).pathname), ['/x/web-interface/view', '/x/web-interface/nav', '/x/player/wbi/playurl']);
  assert.equal(gmCalls.length, 4, 'Video and audio each probe both CDN candidates');
  el('download').click();
  assert.equal(pickerCalls, 1, 'Picker call occurs synchronously in click activation');
  await until(() => /已保存/.test(el('status').textContent), 'MP4 remux and target completion');
  assert.equal(writableCalls, 1);
  assert.equal(targetCloses, 1);
  assert.equal(targetAborts, 0);
  assert.equal(maxWritten, fs.statSync(outputFile).size);
  assert.match(suggestedName, /_BV1BundleSmoke_P2_1080P 高清_H\.264\.mp4$/);
  assert.equal(activeGM, 0);
  assert.ok(peakGM <= 4);
  assert.equal(errors.length, 0);
  assert.equal(encodedHash(outputFile, '0:v:0'), encodedHash(videoFile, '0:v:0'));
  assert.equal(encodedHash(outputFile, '0:a:0'), encodedHash(audioFile, '0:a:0'));
  ffmpeg(['-i', outputFile, '-f', 'null', '-']);
  const streams = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', outputFile])).streams;
  assert.deepEqual(streams.map(s => s.codec_name), ['h264', 'aac']);
  assert.equal(Number(streams[0].nb_frames), 90);
  t.diagnostic(JSON.stringify({ bundleBytes: Buffer.byteLength(bundle), outputBytes: maxWritten, apiCalls: apiCalls.length, gmRequests: gmCalls.length, peakGM, videoFrames: Number(streams[0].nb_frames), audioFrames: Number(streams[1].nb_frames), closed: targetCloses, aborted: targetAborts }));
});
