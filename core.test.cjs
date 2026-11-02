'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createBiliCore } = require('./core.js');
const core = createBiliCore();
const media = 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/123/video.m4s?deadline=2000000000&sign=a%2Bb';
const audio = 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/123/audio.m4s?deadline=2000000000&sign=x%2Fy';
const avc = (overrides = {}) => ({ id: 80, codecid: 7, codecs: 'avc1.640028', width: 1920, height: 1080, bandwidth: 8000000, baseUrl: media, ...overrides });
const aac = (overrides = {}) => ({ id: 30280, codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: audio, ...overrides });
const play = (overrides = {}) => ({
  timelength: 60000,
  support_formats: [{ quality: 120, new_description: '4K 超清' }, { quality: 80, new_description: '1080P 高清' }],
  dash: { duration: 60, video: [avc()], audio: [aac()] },
  ...overrides,
});

test('MD5 matches independent Node crypto over padding boundaries and UTF-8', () => {
  const inputs = ['', 'a', 'abc', 'message digest', '云龙 🐉 café', ...[54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1024].map(n => 'x'.repeat(n))];
  for (const input of inputs) {
    assert.equal(core.md5(input), createHash('md5').update(input, 'utf8').digest('hex'), `UTF-8 length=${Buffer.byteLength(input)}`);
  }
});

test('WBI key permutation and signature match published fixture', () => {
  const key = core.mixinKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  );
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
  assert.equal(core.signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.throws(() => core.mixinKey('https://i0.hdslb.com/short.png', 'https://i0.hdslb.com/short.png'), /密钥格式/);
});

test('WBI encodes spaces as %20, strips required punctuation and leaves caller params intact', () => {
  const params = { z: "a !'()* b", a: '五一四', 'a b': '🐉' };
  const before = structuredClone(params);
  const key = 'ea1db124af3c7062474693fa704f4ff8';
  const query = 'a=%E4%BA%94%E4%B8%80%E5%9B%9B&a%20b=%F0%9F%90%89&wts=1702204169&z=a%20%20b';
  assert.equal(core.signWbi(params, key, 1702204169), `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`);
  assert.deepEqual(params, before);
});

test('media URLs accept signed HTTPS CDN URLs and reject lookalike hosts and credentials', () => {
  assert.equal(core.safeMediaURL(media), media);
  assert.equal(core.safeMediaURL('https://xy123x45xy.mcdn.bilivideo.cn:4483/a.m4s?x=1'), 'https://xy123x45xy.mcdn.bilivideo.cn:4483/a.m4s?x=1');
  for (const bad of [
    'http://upos-sz-mirrorali.bilivideo.com/a.m4s',
    'https://bilivideo.com.evil.example/a.m4s',
    'https://evilbilivideo.com/a.m4s',
    'https://bilivideo.com@evil.example/a.m4s',
    'https://user:password@bilivideo.com/a.m4s',
    'https://localhost/a.m4s',
    'https://127.0.0.1/a.m4s',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'not a URL',
    null,
  ]) assert.equal(core.safeMediaURL(bad), null, String(bad));
});

test('stream URL aliases, duplicates and hostile backups are handled', () => {
  assert.deepEqual(core.streamURLs({ base_url: media, backup_url: [media, 'https://evil.example/video.m4s', audio] }), [media, audio]);
  assert.deepEqual(core.streamURLs({ baseUrl: media, backupUrl: 'invalid array' }), [media]);
});

test('current page identity ignores tracking parameters but respects p', () => {
  assert.deepEqual(core.pageIdentity('https://www.bilibili.com/video/BV1TestVideo/?p=2&vd_source=anything'), {
    id: 'BV1TestVideo', p: 2, key: 'BV1TestVideo:p2',
  });
  assert.equal(core.pageIdentity('https://www.bilibili.com/video/av123/').p, 1);
  for (const p of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(() => core.pageIdentity(`https://www.bilibili.com/video/BV1TestVideo/?p=${p}`), /分P参数/);
  }
});

test('selectPage uses explicit page number and refuses missing or invalid CID', () => {
  const view = { bvid: 'BV1TestVideo', aid: 123, title: 'Example', pages: [
    { page: 3, cid: 333, part: 'three' }, { page: 1, cid: 111, part: 'one' }, { page: 2, cid: 222, part: 'two', duration: 90 },
  ] };
  const identity = core.pageIdentity('https://www.bilibili.com/video/BV1TestVideo/?p=2');
  const selected = core.selectPage(view, identity);
  assert.equal(selected.cid, 222);
  assert.equal(selected.part, 'two');
  assert.equal(selected.page, 2);
  assert.equal(selected.pageCount, 3);
  assert.equal(selected.duration, 90);
  assert.throws(() => core.selectPage(view, { ...identity, p: 4 }), /找不到当前分P/);
  for (const cid of [0, -1, 2.5, 'bad', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => core.selectPage({ ...view, pages: [{ page: 2, cid }] }, identity), /找不到当前分P/);
  }
});

test('normalization exposes actual entitled streams, advertises missing qualities separately, and estimates bits correctly', () => {
  const normalized = core.normalizePlay(play());
  assert.equal(normalized.videos.length, 1);
  assert.equal(normalized.videos[0].id, 80);
  assert.equal(normalized.videos[0].estimate, 60000000);
  assert.equal(normalized.audios[0].estimate, 1440000);
  assert.deepEqual(normalized.advertised, ['4K 超清']);
  assert.equal(normalized.silent, false);
});

test('normalization deduplicates representations, orders codecs and prefers higher bitrate AAC', () => {
  const h264 = avc();
  const hevc = avc({ codecid: 12, codecs: 'hev1.1.6.L120.90', bandwidth: 5000000 });
  const av1 = avc({ codecid: 13, codecs: 'av01.0.08M.08', bandwidth: 4000000 });
  const result = core.normalizePlay(play({ dash: { duration: 60, video: [av1, hevc, h264, { ...h264 }], audio: [aac({ id: 30216, bandwidth: 64000 }), aac(), aac()] } }));
  assert.deepEqual(result.videos.map(v => v.codec), ['H.264', 'HEVC', 'AV1']);
  assert.deepEqual(result.audios.map(a => a.bandwidth), [192000, 64000]);
});

test('Dolby Vision by quality or codec is excluded and explained, while ordinary HDR remains available', () => {
  const hdr = avc({ id: 125, codecid: 12, codecs: 'hvc1.2.4.L153.B0' });
  const variants = [avc({ id: 126, codecid: 12, codecs: 'hev1.2.4.L153.B0' }), avc({ id: 80, codecid: 12, codecs: 'dvh1.05.06' }), avc({ id: 80, codecid: 12, codecs: 'dvhe.05.06' })];
  const result = core.normalizePlay(play({ dash: { duration: 60, video: [hdr, ...variants, avc()], audio: [aac()] } }));
  assert.deepEqual(result.videos.map(v => v.id), [125, 80]);
  assert.match(result.unsupported.join(' '), /杜比/);
  assert.throws(() => core.normalizePlay(play({ dash: { video: variants, audio: [aac()] } })), /杜比/);
});

test('DRM and non-AAC-only content fail explicitly; truly absent audio is marked silent', () => {
  assert.throws(() => core.normalizePlay(play({ is_drm: true })), /加密媒体/);
  assert.throws(() => core.normalizePlay(play({ dash: { video: [avc()], audio: [], dolby: { audio: [aac({ codecs: 'ec-3' })] }, flac: { audio: aac({ codecs: 'fLaC' }) } } })), /AAC/);
  assert.equal(core.normalizePlay(play({ dash: { video: [avc()], audio: null } })).silent, true);
  assert.throws(() => core.normalizePlay({ durl: [{ url: media }] }), /旧版分段/);
  assert.throws(() => core.normalizePlay(play({ dash: { video: [avc({ baseUrl: 'https://evil.example/a' })], audio: [] } })), /HTTPS CDN/);
});

test('filenames remain portable under Chinese, emoji, hostile labels and long titles', () => {
  const meta = { title: '视频', bvid: 'BV1TestVideo', page: 2, pageCount: 3, part: '第二部分' };
  const video = { label: '1080P 高清', codec: 'H.264' };
  for (const title of ['汉'.repeat(400), '🐉'.repeat(300), 'a'.repeat(400), 'a<>:"/\\|?*\0bad.  ']) {
    const filename = core.filename({ ...meta, title }, video);
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 240, `${Buffer.byteLength(filename, 'utf8')} bytes`);
    assert.ok(filename.length <= 240, `${filename.length} UTF-16 units`);
    assert.ok(filename.endsWith('.mp4'));
    assert.match(filename, /_BV1TestVideo_P2_/);
    assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.doesNotMatch(filename, /\uFFFD/);
  }
  const hostileSuffix = core.filename(meta, { label: '巨'.repeat(500), codec: 'C'.repeat(500) });
  assert.ok(Buffer.byteLength(hostileSuffix) <= 240);
  assert.ok(hostileSuffix.endsWith('.mp4'));
});

test('filenames avoid Windows reserved device prefixes including names with extensions', () => {
  const meta = { bvid: 'BV1TestVideo', page: 1, pageCount: 1 };
  const video = { label: '1080P', codec: 'H.264' };
  for (const title of ['CON', 'CON.txt', 'aux.log', 'NUL.zip', 'COM1.any', 'LPT9.text', 'COM¹.foo', 'LPT²']) {
    const filename = core.filename({ ...meta, title }, video);
    assert.doesNotMatch(filename, /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i, filename);
    assert.ok(filename.startsWith('_'), filename);
  }
});

test('positional memory writes patch old headers without increasing output size', async () => {
  const target = core.memoryTarget(100);
  await target.write({ type: 'write', position: 4, data: Uint8Array.from([5, 6, 7, 8]) });
  await target.write({ type: 'write', position: 0, data: Uint8Array.from([1, 2, 3, 4]) });
  await target.write({ type: 'write', position: 2, data: Uint8Array.from([9, 10]) });
  assert.equal(target.size, 8);
  await target.close();
  assert.equal(target.getBlob().type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await target.getBlob().arrayBuffer())], [1, 2, 9, 10, 5, 6, 7, 8]);
  await target.close();
  await assert.rejects(target.write({ type: 'write', position: 0, data: new Uint8Array(1) }), /已经关闭/);
});

test('memory writes crossing block boundaries preserve byte offsets and zero-filled holes', async () => {
  const block = 1024 * 1024;
  const target = core.memoryTarget(2 * block);
  const backing = Uint8Array.from([99, 10, 20, 30, 40, 88]);
  await target.write({ type: 'write', position: block - 2, data: backing.subarray(1, 5) });
  await target.write({ type: 'write', position: block - 1, data: Uint8Array.from([77, 66]).buffer });
  await target.close();
  const bytes = new Uint8Array(await target.getBlob().arrayBuffer());
  assert.equal(bytes.length, block + 2);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[block - 3], 0);
  assert.deepEqual([...bytes.subarray(block - 2)], [10, 77, 66, 40]);
});

test('memory target enforces limits, rejects invalid offsets, and discards aborted output', async () => {
  const target = core.memoryTarget(8);
  await assert.rejects(target.write({ type: 'write', position: 0, data: new Uint8Array(9) }), /内存下载/);
  assert.equal(target.size, 0);
  for (const position of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(target.write({ type: 'write', position, data: new Uint8Array(1) }), /无效/);
  }
  await target.write({ type: 'write', position: 0, data: Uint8Array.from([1, 2, 3]) });
  await target.abort();
  await target.close();
  assert.equal(target.getBlob(), null);
  await assert.rejects(target.write({ type: 'write', position: 0, data: new Uint8Array(1) }), /已经关闭/);
});

test('error redaction removes signed CDN query strings from user-visible errors', () => {
  assert.equal(core.safeError(new Error(`Failed ${media}`)), 'Failed upos-sz-mirrorali.bilivideo.com');
  assert.ok(core.safeError(new Error('x'.repeat(1000))).length <= 360);
});
