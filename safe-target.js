'use strict';

// Choose a directory, never an existing file: showSaveFilePicker is allowed to
// clear the selected file before resolving. See WICG File System Access §3.4.
// https://wicg.github.io/file-system-access/#api-showsavefilepicker

function saveError(error) {
  if (error?.name === 'BndSaveError') return error;
  const code = error?.name || 'SAVE_FAILED';
  const messages = {
    NotAllowedError: '没有获得文件夹的写入权限。请选择允许写入的文件夹。',
    SecurityError: '浏览器不允许访问这个文件夹。请重新选择保存文件夹并允许写入。',
    NoModificationAllowedError: '新文件被其他任务占用，已停止保存。请重新选择文件夹或稍后重试。',
    NotFoundError: '保存文件夹或新文件已被移动、删除。请重新选择保存文件夹。',
    QuotaExceededError: '磁盘可用空间不足，文件未保存完成。请释放空间或换一个文件夹。',
    AbortError: '浏览器中止了文件写入或安全检查，文件未保存完成。请重新选择文件夹后重试。',
  };
  const result = new Error(messages[code] || `保存失败：${String(error?.message || error || '无法写入文件')}。请重新选择文件夹后重试。`, { cause: error });
  result.name = 'BndSaveError';
  result.code = code;
  return result;
}

function conflict(code, message) {
  const error = new Error(message);
  error.name = 'BndSaveError';
  error.code = code;
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
}

function createDownloadTag({ crypto = globalThis.crypto, now = new Date() } = {}) {
  if (typeof crypto?.getRandomValues !== 'function' || !Number.isFinite(now.getTime())) {
    throw conflict('UNIQUE_NAME_UNAVAILABLE', '无法生成新的文件名，请更新浏览器后重试。');
  }
  const random = new Uint8Array(12); // 96 bits, also separates concurrent tabs.
  crypto.getRandomValues(random);
  const pad = n => String(n).padStart(2, '0');
  const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${time}-${Array.from(random, n => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Create a fresh output in a user-selected directory. makeName must generate
 * a new portable component on each call (the UI includes a random tag).
 * No directory enumeration, existing-file writer, or removeEntry is used.
 * Browser writes are staged until close; abort never commits those bytes.
 */
async function createSafeFileTarget(directory, makeName, { signal } = {}) {
  let handle, name, initial, stream;
  let state = 'opening', abortPromise;

  async function abort(reason) {
    if (state === 'committed') return;
    if (abortPromise) return abortPromise;
    state = 'aborted';
    abortPromise = (async () => {
      try { if (stream && typeof stream.abort === 'function') await stream.abort(reason); } catch { /* preserve the original failure */ }
    })();
    return abortPromise;
  }

  async function snapshot() {
    const file = await handle.getFile();
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || !Number.isFinite(file.lastModified)) {
      throw conflict('FILE_UNVERIFIED', '无法确认新文件的状态，已停止保存。请重新选择文件夹。');
    }
    return { size: file.size, lastModified: file.lastModified };
  }

  async function verifyUnchanged() {
    checkAbort(signal);
    const current = await snapshot();
    if (current.size !== 0 || current.lastModified !== initial.lastModified) {
      throw conflict('FILE_CHANGED', '新文件已被其他任务修改，已停止保存并保留文件现状。');
    }
    checkAbort(signal);
  }

  try {
    checkAbort(signal);
    if (typeof directory?.getFileHandle !== 'function' || typeof makeName !== 'function') {
      throw conflict('DIRECTORY_UNAVAILABLE', '浏览器没有提供可写的文件夹，请重新选择。');
    }
    // getFileHandle has no atomic create-exclusive flag. Random names avoid
    // accidental races; probes skip all existing entries, including empty ones.
    for (let attempt = 0; attempt < 16; attempt++) {
      checkAbort(signal);
      name = makeName();
      if (typeof name !== 'string' || !name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
        throw conflict('INVALID_FILENAME', '生成的文件名无效，已停止保存。');
      }
      let occupied = false;
      try {
        await directory.getFileHandle(name, { create: false });
        occupied = true;
      } catch (error) {
        if (error?.name === 'TypeMismatchError') occupied = true;
        else if (error?.name !== 'NotFoundError') throw error; // unreadable != absent
      }
      checkAbort(signal);
      if (occupied) continue;
      try {
        handle = await directory.getFileHandle(name, { create: true });
      } catch (error) {
        if (error?.name === 'TypeMismatchError') continue;
        throw error;
      }
      break;
    }
    if (!handle) throw conflict('NAME_CONFLICT', '多次遇到同名文件，已停止保存。');
    checkAbort(signal);
    if (typeof handle.getFile !== 'function' || typeof handle.createWritable !== 'function') {
      throw conflict('FILE_UNVERIFIED', '浏览器无法检查或写入新文件，已停止保存。');
    }
    initial = await snapshot();
    if (initial.size !== 0) throw conflict('FILE_EXISTS', '新文件名已被其他任务使用，已保留已有文件。');
    checkAbort(signal);
    // Never retry without exclusive mode when the browser reports a lock error.
    stream = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
    if (!stream || ['write', 'close', 'abort'].some(key => typeof stream[key] !== 'function')) {
      throw conflict('WRITER_UNAVAILABLE', '浏览器没有提供完整的文件写入接口。');
    }
    await verifyUnchanged();
    state = 'open';
  } catch (error) {
    await abort(error);
    checkAbort(signal);
    throw saveError(error);
  }

  return {
    name,
    get committed() { return state === 'committed'; },
    async write(chunk) {
      if (state !== 'open') throw conflict('WRITER_CLOSED', '文件写入已经结束。');
      try { checkAbort(signal); await stream.write(chunk); checkAbort(signal); }
      catch (error) { await abort(error); checkAbort(signal); throw saveError(error); }
    },
    async close() {
      if (state === 'committed') return;
      if (state !== 'open') throw conflict('WRITER_CLOSED', '文件写入已经结束，无法提交。');
      state = 'closing';
      try {
        await verifyUnchanged();
        if(state!=='closing')throw conflict('WRITER_CLOSED','文件写入已取消，无法提交。');
        // No await between the last cancellation check and starting commit.
        await stream.close();
        state = 'committed';
      } catch (error) { await abort(error); checkAbort(signal); throw saveError(error); }
    },
    abort,
  };
}

module.exports = { createDownloadTag, createSafeFileTarget, saveError };
