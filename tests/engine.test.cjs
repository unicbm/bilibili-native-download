'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const MB = require('mediabunny');
const { createMediaEngine } = require('../engine.js');
const engine = createMediaEngine(MB);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-remux-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = name => path.join(dir, name);
const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
const video = file('video-fmp4.mp4');
const audio = file('audio-fmp4.mp4');
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-g', '30', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', video]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000', '-t', '3', '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', audio]);

function source(filename) {
  const fd = fs.openSync(filename, 'r');
  return {
    size: fs.fstatSync(fd).size,
    async read(start, end, signal) {
      signal?.throwIfAborted();
      const data = Buffer.alloc(end - start);
      const n = fs.readSync(fd, data, 0, data.length, start);
      return data.subarray(0, n);
    },
    close() { fs.closeSync(fd); },
  };
}
function target(filename, { failWrite = false } = {}) {
  const fd = fs.openSync(filename, 'w');
  let finished = false;
  const stats = { closes: 0, aborts: 0, writes: 0 };
  return {
    stats,
    async write(chunk) {
      stats.writes++;
      if (failWrite) throw new Error('Simulated disk full');
      assert.equal(chunk.type, 'write');
      fs.writeSync(fd, chunk.data, 0, chunk.data.length, chunk.position);
    },
    async close() { stats.closes++; if (!finished) fs.closeSync(fd); finished = true; },
    async abort() { stats.aborts++; if (!finished) fs.closeSync(fd); finished = true; fs.rmSync(filename, { force: true }); },
  };
}
function packets(filename, kind) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', kind, '-show_packets', '-show_entries', 'packet=pts_time,dts_time,duration_time,data_hash', '-show_data_hash', 'sha256', '-of', 'json', filename], { encoding: 'utf8' })).packets;
}
function comparePackets(input, output, kind) {
  const a = packets(input, kind), b = packets(output, kind);
  assert.equal(b.length, a.length, 'packet count');
  assert.deepEqual(b.map(p => p.data_hash), a.map(p => p.data_hash), 'encoded payloads preserved in decode order');
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(Number(a[i].pts_time) - Number(b[i].pts_time)) < 0.0001, `PTS ${i}`);
  }
}
async function remux(v, a, out) {
  const vs = source(v), as = a ? source(a) : null, t = target(out);
  try {
    const result = await engine.muxToTarget({ videoSource: vs, audioSource: as, target: t });
    assert.equal(t.stats.closes, 1);
    assert.equal(t.stats.aborts, 0);
    assert.equal(result.outputBytes, fs.statSync(out).size);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'null', '-'], { stdio: 'pipe' });
    return result;
  } finally { vs.close(); as?.close(); }
}

test('fragmented DASH H.264 B-frames + AAC: real playable MP4, exact packet payloads and PTS', async () => {
  const out = file('fmp4-merged.mp4');
  const result = await remux(video, audio, out);
  assert.equal(result.videoPackets, 90);
  assert.equal(result.audioPackets, 142);
  comparePackets(video, out, 'v:0');
  comparePackets(audio, out, 'a:0');
});

test('progressive MP4 DASH with separate tracks retains payloads and timing', async () => {
  const vp = file('video-progressive.mp4'), ap = file('audio-progressive.mp4'), out = file('progressive-merged.mp4');
  ffmpeg(['-i', video, '-c', 'copy', '-movflags', '+faststart', vp]);
  ffmpeg(['-i', audio, '-c', 'copy', '-movflags', '+faststart', ap]);
  await remux(vp, ap, out);
  comparePackets(vp, out, 'v:0');
  comparePackets(ap, out, 'a:0');
});

test('HEVC and AV1 pass through without invoking browser decoders; video-only works', async () => {
  for (const [codec, args] of [
    ['hevc', ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:log-level=error']],
    ['av1', ['-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-row-mt', '1', '-threads', '2']],
  ]) {
    const v = file(`${codec}.mp4`), out = file(`${codec}-merged.mp4`);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=12', '-t', '1', '-an', ...args, '-movflags', '+faststart', v]);
    const result = await remux(v, null, out);
    assert.equal(result.audioPackets, 0);
    comparePackets(v, out, 'v:0');
  }
});

test('encrypted media is rejected and incomplete target is aborted', async () => {
  const encrypted = file('encrypted.mp4');
  ffmpeg(['-i', video, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', '11111111111111111111111111111111', '-encryption_kid', '22222222222222222222222222222222', encrypted]);
  const vs = source(encrypted), t = target(file('encrypted-output.mp4'));
  try {
    await assert.rejects(engine.muxToTarget({ videoSource: vs, target: t }), /加密/);
    assert.equal(t.stats.closes, 0);
    assert.equal(t.stats.aborts, 1);
  } finally { vs.close(); }
});

test('truncated range is rejected before committing any target', async () => {
  const vs = source(video), originalRead = vs.read, t = target(file('bad-range.mp4'));
  vs.read = async (...args) => (await originalRead(...args)).subarray(1);
  try {
    await assert.rejects(engine.muxToTarget({ videoSource: vs, target: t }), /长度不符/);
    assert.equal(t.stats.closes, 0);
    assert.equal(t.stats.aborts, 1);
  } finally { vs.close(); }
});

test('cancellation during an outstanding range read aborts once and never commits', async () => {
  const controller = new AbortController();
  const t = target(file('canceled.mp4'));
  const vs = {
    size: fs.statSync(video).size,
    read: (start, end, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
      queueMicrotask(() => controller.abort());
    }),
  };
  await assert.rejects(engine.muxToTarget({ videoSource: vs, target: t, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(t.stats.closes, 0);
  assert.equal(t.stats.aborts, 1);
});

test('disk failure aborts the incomplete output instead of closing it as success', async () => {
  const vs = source(video), as = source(audio), t = target(file('disk-failure.mp4'), { failWrite: true });
  try {
    await assert.rejects(engine.muxToTarget({ videoSource: vs, audioSource: as, target: t }), /disk full/);
    assert.equal(t.stats.closes, 0);
    assert.equal(t.stats.aborts, 1);
  } finally { vs.close(); as.close(); }
});
