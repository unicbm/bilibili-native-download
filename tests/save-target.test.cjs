'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeFileTarget, createDownloadTag } = require('../safe-target.js');
const { createBiliCore } = require('../core.js');

const domError = (name, message = name) => new DOMException(message, name);
const isSaveError = error => error?.name === 'BndSaveError';
const chunk = data => ({ type: 'write', position: 0, data: new Uint8Array(data) });

/** Model the native transaction: writes touch a private swap, only close commits. */
function directoryFixture(initial = {}, hooks = {}) {
  const files = new Map();
  const calls = [];
  const transactions = [];
  const put = (name, bytes, kind = 'file') => {
    const entry = files.get(name);
    if (entry) { entry.bytes = Buffer.from(bytes); entry.lastModified++; entry.kind = kind; return entry; }
    const created = { bytes: Buffer.from(bytes), lastModified: 1, kind, locked: false, handle: null };
    files.set(name, created); return created;
  };
  Object.entries(initial).forEach(([name, bytes]) => put(name, bytes));
  const directory = { async getFileHandle(name, options = {}) {
    assert.equal(this, directory);
    calls.push({ method: 'getFileHandle', name, options: { ...options } });
    await hooks.lookup?.({ name, options, files, put });
    let entry = files.get(name);
    if (entry?.kind === 'directory') throw domError('TypeMismatchError');
    if (!entry) {
      if (!options.create) throw domError('NotFoundError');
      entry = put(name, []);
    }
    if (!entry.handle) {
      const handle = {
        name,
        async getFile() {
          assert.equal(this, handle);
          calls.push({ method: 'getFile', name });
          await hooks.snapshot?.({ name, entry, files, put });
          return { name, size: entry.bytes.length, lastModified: entry.lastModified };
        },
        async createWritable(options) {
          assert.equal(this, handle);
          calls.push({ method: 'createWritable', name, options: { ...options } });
          assert.deepEqual(options, { keepExistingData: false, mode: 'exclusive' });
          if (hooks.createError) throw hooks.createError;
          if (entry.locked) throw domError('NoModificationAllowedError');
          entry.locked = true;
          const tx = { bytes: Buffer.alloc(0), writes: 0, closes: 0, aborts: 0, finished: false };
          transactions.push(tx);
          const stream = {
            async write(part) {
              assert.equal(this, stream);
              tx.writes++;
              if (hooks.writeError) throw hooks.writeError;
              assert.equal(tx.finished, false);
              assert.equal(part.type, 'write');
              const bytes = Buffer.from(part.data);
              const next = Buffer.alloc(Math.max(tx.bytes.length, part.position + bytes.length));
              tx.bytes.copy(next); bytes.copy(next, part.position); tx.bytes = next;
            },
            async close() {
              assert.equal(this, stream);
              tx.closes++;
              if (hooks.closeError) throw hooks.closeError;
              assert.equal(tx.finished, false);
              entry.bytes = Buffer.from(tx.bytes); entry.lastModified++;
              tx.finished = true; entry.locked = false;
            },
            async abort() {
              assert.equal(this, stream);
              tx.aborts++; tx.finished = true; tx.bytes = Buffer.alloc(0); entry.locked = false;
            },
          };
          await hooks.opened?.({ name, entry, files, put, tx });
          return stream;
        },
      };
      entry.handle = handle;
    }
    return entry.handle;
  } };
  return { directory, files, calls, transactions, put };
}

test('directory collision handling skips existing videos and directories without opening their writers', async () => {
  const original = Buffer.from('original video A');
  const f = directoryFixture({ 'A.mp4': original });
  f.put('folder.mp4', [], 'directory');
  const names = ['A.mp4', 'folder.mp4', 'fresh.mp4'];
  const target = await createSafeFileTarget(f.directory, () => names.shift());
  assert.equal(target.name, 'fresh.mp4');
  assert.deepEqual(f.files.get('A.mp4').bytes, original);
  assert.deepEqual(f.calls.filter(c => c.method === 'createWritable').map(c => c.name), ['fresh.mp4']);
  assert.deepEqual(f.calls.filter(c => c.method === 'getFileHandle' && c.options.create).map(c => c.name), ['fresh.mp4']);
  await target.write(chunk([1, 2, 3]));
  assert.equal(f.files.get('fresh.mp4').bytes.length, 0, 'uncommitted bytes stay in the swap');
  await target.close();
  assert.deepEqual([...f.files.get('fresh.mp4').bytes], [1, 2, 3]);
  assert.deepEqual(f.files.get('A.mp4').bytes, original);
  assert.equal(f.transactions[0].closes, 1);
});

test('only NotFound permits creation; permission failure is not mistaken for an absent file', async () => {
  const original = Buffer.from('original video A');
  const f = directoryFixture({ 'A.mp4': original }, { lookup() { throw domError('NotAllowedError'); } });
  await assert.rejects(createSafeFileTarget(f.directory, () => 'new.mp4'), isSaveError);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.create, false);
  assert.equal(f.transactions.length, 0);
  assert.deepEqual(f.files.get('A.mp4').bytes, original);
});

test('a nonempty file appearing between absence check and creation is preserved before any writer opens', async () => {
  const original = Buffer.from('another process completed this video');
  const f = directoryFixture({}, { lookup({ name, options, put }) { if (options.create) put(name, original); } });
  await assert.rejects(createSafeFileTarget(f.directory, () => 'race.mp4'), isSaveError);
  assert.deepEqual(f.files.get('race.mp4').bytes, original);
  assert.equal(f.calls.filter(c => c.method === 'createWritable').length, 0);
});

test('exclusive writer acquisition catches a changed destination and aborts its swap without touching file bytes', async () => {
  const original = Buffer.from('external editor wrote after initial check');
  const f = directoryFixture({}, { opened({ name, put }) { put(name, original); } });
  await assert.rejects(createSafeFileTarget(f.directory, () => 'race.mp4'), isSaveError);
  assert.deepEqual(f.files.get('race.mp4').bytes, original);
  assert.equal(f.transactions[0].aborts, 1);
  assert.equal(f.transactions[0].closes, 0);
  assert.equal(f.files.get('race.mp4').locked, false);
});

test('a destination changed while downloading is not overwritten when close is requested', async () => {
  const f = directoryFixture();
  const target = await createSafeFileTarget(f.directory, () => 'new.mp4');
  await target.write(chunk([1, 2, 3]));
  const replacement = Buffer.from('externally replaced A');
  f.put('new.mp4', replacement);
  await assert.rejects(target.close(), isSaveError);
  assert.deepEqual(f.files.get('new.mp4').bytes, replacement);
  assert.equal(f.transactions[0].closes, 0);
  assert.equal(f.transactions[0].aborts, 1);
});

test('collision retries are bounded and never fall back to overwriting the existing name', async () => {
  const original = Buffer.from('keep A');
  const f = directoryFixture({ 'A.mp4': original });
  await assert.rejects(createSafeFileTarget(f.directory, () => 'A.mp4'), isSaveError);
  assert.equal(f.calls.filter(c => c.method === 'getFileHandle').length, 16);
  assert.equal(f.transactions.length, 0);
  assert.deepEqual(f.files.get('A.mp4').bytes, original);
});

test('permission, lock and security-scan errors opening a writer are save failures rather than user cancellation', async t => {
  for (const name of ['NotAllowedError', 'NoModificationAllowedError', 'AbortError']) {
    await t.test(name, async () => {
      const f = directoryFixture({}, { createError: domError(name, 'native file writer rejected') });
      await assert.rejects(createSafeFileTarget(f.directory, () => 'new.mp4'), isSaveError);
      assert.equal(f.files.get('new.mp4').bytes.length, 0);
      assert.equal(f.transactions.length, 0);
    });
  }
});

test('failed native commit aborts staging and leaves the directory entry unmodified', async t => {
  for (const name of ['NotAllowedError', 'QuotaExceededError', 'AbortError']) {
    await t.test(name, async () => {
      const f = directoryFixture({}, { closeError: domError(name, 'native commit rejected') });
      const target = await createSafeFileTarget(f.directory, () => 'new.mp4');
      await target.write(chunk([9, 8, 7]));
      await assert.rejects(target.close(), isSaveError);
      assert.equal(f.files.get('new.mp4').bytes.length, 0);
      assert.equal(f.transactions[0].aborts, 1);
      assert.equal(f.files.get('new.mp4').locked, false);
    });
  }
});

test('explicit abort discards new bytes; signal cancellation during writer acquisition releases the lock', async () => {
  const f = directoryFixture();
  const target = await createSafeFileTarget(f.directory, () => 'new.mp4');
  await target.write(chunk([1, 2]));
  await target.abort(domError('AbortError'));
  assert.equal(f.files.get('new.mp4').bytes.length, 0);
  assert.equal(f.transactions[0].closes, 0);
  assert.equal(f.transactions[0].aborts, 1);
  const controller = new AbortController();
  const racing = directoryFixture({}, { opened() { controller.abort(); } });
  await assert.rejects(createSafeFileTarget(racing.directory, () => 'cancel.mp4', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(racing.transactions[0].aborts, 1);
  assert.equal(racing.files.get('cancel.mp4').locked, false);
});

test('same-time download names differ and long UTF-8 names stay inside the portable filename budget', () => {
  const now = new Date('2026-11-02T07:30:00.000Z');
  const a = createDownloadTag({ now }), b = createDownloadTag({ now });
  assert.notEqual(a, b);
  assert.match(a, /[0-9a-f]{24}/i, 'the tag includes 96 random bits');
  const core = createBiliCore();
  const meta = { title: '视频😀'.repeat(100), part: '分P'.repeat(100), bvid: 'BV1TestVideo', page: 2, pageCount: 3 };
  const video = { label: '1080P 高码率', codec: 'H.264' };
  const first = core.filename(meta, video, a), second = core.filename(meta, video, b);
  assert.notEqual(first, second);
  assert.ok(Buffer.byteLength(first, 'utf8') <= 240);
  assert.ok(first.endsWith('.mp4'));
  assert.ok(first.includes(a));
  assert.ok(first.includes('BV1TestVideo'));
  assert.doesNotMatch(first, /[<>:"/\\|?*\u0000-\u001f]/);
});
