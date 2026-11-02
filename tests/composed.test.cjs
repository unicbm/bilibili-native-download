'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const MB = require('mediabunny');
const { createRangeEngine } = require('../range-engine.js');
const { createMediaEngine } = require('../engine.js');
const MiB = 1024 ** 2;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-composed-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = name => path.join(dir, name);
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 4 * MiB });
const ffmpeg = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const video = file('video.mp4'), audio = file('audio.mp4');
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '45', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-bf', '3', '-threads', '2', '-g', '30', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', video]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1357:sample_rate=48000', '-t', '45', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', audio]);

function cdn() {
  const fds = new Map([['/video', fs.openSync(video, 'r')], ['/audio', fs.openSync(audio, 'r')]]);
  const stats = { active: 0, peak: 0, requests: 0, injectedFailures: 0, maxRequest: 0 };
  return {
    stats,
    close() { for (const fd of fds.values()) fs.closeSync(fd); },
    async request({ url, start, endExclusive, signal }) {
      signal.throwIfAborted();
      stats.active++; stats.peak = Math.max(stats.peak, stats.active); stats.requests++;
      stats.maxRequest = Math.max(stats.maxRequest, endExclusive - start);
      const u = new URL(url), fd = fds.get(u.pathname), size = fs.fstatSync(fd).size;
      const end = Math.min(size, endExclusive), body = Buffer.alloc(end - start);
      fs.readSync(fd, body, 0, body.length, start);
      let status = 206;
      if (u.hostname.startsWith('a.') && u.pathname === '/video' && start >= 16 * MiB && !stats.injectedFailures) {
        status = 503;
        stats.injectedFailures++;
      }
      try {
        await new Promise((resolve, reject) => {
          const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
          // Out-of-order chunk completion and an initially slower backup.
          const timer = setTimeout(finish, u.hostname.startsWith('b.') ? 9 : (start % (4 * MiB) === 0 ? 4 : 1));
          const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('abort', 'AbortError')); };
          signal.addEventListener('abort', stop, { once: true });
        });
        return { status, headers: { 'content-range': `bytes ${start}-${end - 1}/${size}`, 'content-length': String(body.length) }, body };
      } finally { stats.active--; }
    }
  };
}

function destination(name, failWrite = false) {
  const filename = file(name), fd = fs.openSync(filename, 'w');
  let finished = false;
  const stats = { closes: 0, aborts: 0 };
  return {
    filename, stats,
    async write(chunk) {
      if (failWrite) throw new Error('simulated disk full');
      fs.writeSync(fd, chunk.data, 0, chunk.data.length, chunk.position);
    },
    async close() { stats.closes++; if (!finished) fs.closeSync(fd); finished = true; },
    async abort() { stats.aborts++; if (!finished) fs.closeSync(fd); finished = true; fs.rmSync(filename, { force: true }); }
  };
}
async function sources(network, signal) {
  const range = createRangeEngine(network), limiter = range.createLimiter(4);
  const raw = await Promise.all(['/video', '/audio'].map(track => range.buildSource({
    urls: [`https://a.bilivideo.com${track}?signed=kept`, `https://b.bilivideo.com${track}?signed=kept`],
    limiter, signal, concurrency: 4, chunkSize: 2 * MiB, maxCacheBytes: 32 * MiB
  })));
  const readStats = raw.map(() => ({ calls: 0, maxRange: 0 }));
  const wrapped = raw.map((src, i) => ({
    size: src.size,
    read(start, end, signal) {
      readStats[i].calls++;
      readStats[i].maxRange = Math.max(readStats[i].maxRange, end - start);
      return src.read(start, end, signal);
    }
  }));
  return { raw, wrapped, readStats, limiter, dispose() { raw.forEach(src => src.dispose()); } };
}
function encodedHash(filename, stream) {
  return run('ffmpeg', ['-v', 'error', '-i', filename, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
}

test('~70MiB real DASH remux with concurrent ranges, LRU eviction and CDN failover preserves both encoded tracks', async t => {
  assert.ok(fs.statSync(video).size > 64 * MiB, 'fixture exceeds two cache windows');
  const network = cdn(), src = await sources(network), target = destination('merged.mp4');
  try {
    const result = await createMediaEngine(MB).muxToTarget({ videoSource: src.wrapped[0], audioSource: src.wrapped[1], target });
    assert.equal(result.videoPackets, 1350);
    assert.equal(target.stats.closes, 1);
    assert.equal(target.stats.aborts, 0);
    assert.equal(network.stats.injectedFailures, 1);
    assert.ok(network.stats.peak <= 4);
    assert.ok(network.stats.maxRequest <= 2 * MiB);
    assert.ok(src.raw.every(s => s.stats.peakCacheBytes <= 32 * MiB));
    assert.equal(encodedHash(target.filename, '0:v:0'), encodedHash(video, '0:v:0'));
    assert.equal(encodedHash(target.filename, '0:a:0'), encodedHash(audio, '0:a:0'));
    ffmpeg(['-i', target.filename, '-f', 'null', '-']);
    const streams = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', target.filename])).streams;
    assert.deepEqual(streams.map(s => s.codec_name), ['h264', 'aac']);
    assert.ok(Math.abs(Number(streams[0].duration) - 45) < 0.1);
    t.diagnostic(JSON.stringify({ inputVideoBytes: src.raw[0].size, outputBytes: result.outputBytes, network: network.stats, demuxReads: src.readStats, rangeCachePeak: src.raw.map(s => s.stats.peakCacheBytes) }));
  } finally { src.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); network.close(); }
});

test('cancel during real mux aborts the output and all underlying requests', async () => {
  const controller = new AbortController(), network = cdn(), src = await sources(network, controller.signal), target = destination('canceled.mp4');
  try {
    await assert.rejects(createMediaEngine(MB).muxToTarget({
      videoSource: src.wrapped[0], audioSource: src.wrapped[1], target, signal: controller.signal,
      onProgress(p) { if (p.stage === 'mux' && p.seconds >= 5) controller.abort(); }
    }), { name: 'AbortError' });
    assert.equal(target.stats.closes, 0);
    assert.equal(target.stats.aborts, 1);
    assert.equal(fs.existsSync(target.filename), false);
  } finally { src.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); network.close(); }
  assert.equal(network.stats.active, 0);
  assert.equal(src.limiter.active, 0);
  assert.equal(src.limiter.pending, 0);
});

test('disk error in composed engine aborts output; caller finally releases network work', async () => {
  const network = cdn(), src = await sources(network), target = destination('disk-error.mp4', true);
  try {
    await assert.rejects(createMediaEngine(MB).muxToTarget({ videoSource: src.wrapped[0], audioSource: src.wrapped[1], target }), /disk full/);
    assert.equal(target.stats.closes, 0);
    assert.equal(target.stats.aborts, 1);
  } finally { src.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); network.close(); }
  assert.equal(network.stats.active, 0);
  assert.equal(src.limiter.active, 0);
  assert.equal(src.limiter.pending, 0);
});
