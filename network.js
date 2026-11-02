/* Bili Native Download: browser session API and bounded GM Range transport. MIT. */
function createBiliNetwork(options) {
  'use strict';
  const { core, gmRequest, nativeFetch } = options || {};
  if (!core || typeof core.signWbi !== 'function' || typeof gmRequest !== 'function') {
    throw new Error('下载网络组件未正确加载。');
  }
  const API_ORIGIN = 'https://api.bilibili.com';
  // Never include the video's signed query, access token or current URL in
  // the Referer. Bilibili's normal site origin is sufficient for the CDN.
  const REFERRER = 'https://www.bilibili.com/';
  const KEY_TTL = 5 * 60 * 1000;
  const API_TIMEOUT = 15000;
  const API_BODY_LIMIT = 8 * 1024 * 1024;
  const RANGE_LIMIT = 16 * 1024 * 1024;
  let cachedKey = null;
  let keyGeneration = 0;

  const aborted = () => new DOMException('下载已取消', 'AbortError');
  const checkAbort = signal => { if (signal && signal.aborted) throw aborted(); };
  const timeoutError = () => Object.assign(new Error('网络请求超时，请稍后重试。'), { name: 'TimeoutError' });
  function apiError(json) {
    const code = Number(json && json.code);
    const messages = {
      '-101': '当前登录会话不可用，请在 B站网页重新登录后重试。',
      '-403': 'B站拒绝了播放信息请求，请重新解析后重试。',
      '-412': 'B站暂时限制了请求，请稍后重试。',
      '-352': 'B站要求完成验证，请先在网页正常播放后重试。',
      '-404': '这个视频不存在或当前无法访问。',
      '62002': '这个视频不存在或当前无法访问。',
    };
    const detail = typeof json?.message === 'string' ? core.safeError(json.message).slice(0, 160) : '';
    return Object.assign(new Error(messages[String(code)] || `B站接口返回错误（${Number.isFinite(code) ? code : '未知'}）${detail ? `：${detail}` : '。'}`), { code, api: true });
  }
  function httpError(status) {
    const message = status === 412 || status === 429
      ? 'B站暂时限制了请求，请稍后重试。'
      : `网络请求失败：HTTP ${status || '未知'}。`;
    return Object.assign(new Error(message), { status });
  }
  function parseHeaders(raw) {
    const headers = Object.create(null);
    for (const line of String(raw || '').split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at < 1) continue;
      const key = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
    }
    return headers;
  }
  function safeApiURL(raw) {
    try {
      const u = new URL(raw);
      return u.origin === API_ORIGIN && !u.username && !u.password ? u.href : null;
    } catch (_) { return null; }
  }
  function checkedJSON(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, 'code')) {
      throw new Error('B站接口响应格式异常，请稍后重新解析。');
    }
    return value;
  }

  /** One GM operation with manual deadline, size cap, abort and URL checks. */
  function gmTransport({ url, signal, timeoutMs, byteLimit, range, json = false, onProgress }) {
    const checkURL = json ? safeApiURL : core.safeMediaURL;
    const allowed = checkURL(url);
    if (!allowed) return Promise.reject(new Error('请求地址不属于允许的 B站接口或媒体 CDN。'));
    return new Promise((resolve, reject) => {
      let done = false;
      let handle;
      let timer;
      let mustAbort = false;
      const started = Date.now();
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error, value, abortHandle = false) => {
        if (done) return;
        done = true;
        cleanup();
        if (abortHandle) {
          mustAbort = true;
          try { handle?.abort(); } catch (_) { /* already finished */ }
        }
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(aborted(), null, true);
      const inspectHeaders = r => {
        if (done) return false;
        if (r.finalUrl && !checkURL(r.finalUrl)) {
          finish(new Error('请求被重定向到了非 B站地址，已停止下载。'), null, true);
          return false;
        }
        const status = Number(r.status);
        if (Number(r.readyState) >= 2 || status) {
          if (range && status === 200) {
            finish(Object.assign(new Error('CDN 忽略了 Range，已中止完整文件响应。'), { status: 200, name: 'RangeValidationError' }), null, true);
            return false;
          }
          if (status && (range ? status !== 206 : status < 200 || status >= 300)) {
            finish(httpError(status), null, true);
            return false;
          }
          const length = Number(parseHeaders(r.responseHeaders)['content-length']);
          if (Number.isFinite(length) && length > byteLimit) {
            finish(new Error('服务器返回的数据超过请求大小，已停止下载。'), null, true);
            return false;
          }
        }
        return true;
      };
      if (signal?.aborted) { finish(aborted()); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(timeoutError(), null, true), timeoutMs);
      const headers = { Referer: REFERRER };
      if (range) headers.Range = `bytes=${range.start}-${range.endExclusive - 1}`;
      try {
        handle = gmRequest({
          method: 'GET', url: allowed, headers,
          responseType: json ? 'json' : 'arraybuffer',
          anonymous: false,
          fetch: false,
          timeout: timeoutMs,
          onreadystatechange: inspectHeaders,
          onprogress(r) {
            if (!inspectHeaders(r)) return;
            if (Number(r.loaded) > byteLimit) {
              finish(new Error('服务器忽略了分段大小，已中止超量响应。'), null, true);
              return;
            }
            if (typeof onProgress === 'function') {
              try { onProgress({ loaded: Number(r.loaded) || 0, total: Number(r.total) || 0 }); } catch (_) { /* UI observer */ }
            }
          },
          onload(r) {
            if (!inspectHeaders(r) || done) return;
            if (!r.finalUrl || !checkURL(r.finalUrl)) {
              finish(new Error('无法确认最终下载地址，已停止下载。'), null, true);
              return;
            }
            if (range && r.status !== 206) { finish(httpError(r.status)); return; }
            try {
              if (json) {
                const value = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
                finish(null, checkedJSON(value));
              } else {
                const body = r.response;
                if (Object.prototype.toString.call(body) !== '[object ArrayBuffer]') throw new Error('CDN 返回了无效的二进制数据。');
                if (body.byteLength > byteLimit) throw new Error('CDN 分段大小超出请求范围。');
                finish(null, { status: r.status, headers: parseHeaders(r.responseHeaders), body, finalUrl: r.finalUrl, elapsedMs: Date.now() - started });
              }
            } catch (error) {
              finish(error instanceof SyntaxError ? new Error('B站接口响应不是有效 JSON。') : error, null, true);
            }
          },
          onerror() { finish(new Error(json ? 'B站接口连接失败，请检查网络和脚本权限。' : 'CDN 连接失败，请检查网络和脚本的跨域访问权限。')); },
          ontimeout() { finish(timeoutError(), null, true); },
          onabort() { finish(signal?.aborted ? aborted() : new Error('网络请求被中止。')); },
        });
        // A mocked/failed request can complete synchronously before assigning
        // the abort handle; still honor the decision exactly once afterward.
        if (mustAbort) {
          try { handle?.abort(); } catch (_) { /* already finished */ }
        }
      } catch (_) {
        finish(new Error('油猴跨域请求不可用，请检查脚本权限。'));
      }
    });
  }

  async function getJSON(url, signal) {
    checkAbort(signal);
    if (!safeApiURL(url)) throw new Error('B站接口地址无效。');
    if (typeof nativeFetch !== 'function') {
      return gmTransport({ url, signal, timeoutMs: API_TIMEOUT, byteLimit: API_BODY_LIMIT, json: true });
    }
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, API_TIMEOUT);
    try {
      let response;
      try {
        response = await nativeFetch(url, {
          method: 'GET', credentials: 'include', mode: 'cors', cache: 'no-store',
          redirect: 'error', referrer: REFERRER, referrerPolicy: 'strict-origin-when-cross-origin',
          signal: controller.signal,
        });
      } catch (error) {
        checkAbort(signal);
        if (expired) throw timeoutError();
        if (error?.name === 'AbortError') throw aborted();
        // Only a transport/CORS failure reaches the GM fallback. API status
        // and business errors below never trigger a second transport attempt.
        return await gmTransport({ url, signal, timeoutMs: API_TIMEOUT, byteLimit: API_BODY_LIMIT, json: true });
      }
      checkAbort(signal);
      if (!response.ok) throw httpError(response.status);
      if (response.url && !safeApiURL(response.url)) throw new Error('B站接口跳转地址无效。');
      const contentLength = Number(response.headers?.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > API_BODY_LIMIT) throw new Error('B站接口响应过大。');
      let data;
      try { data = await response.json(); }
      catch (error) {
        checkAbort(signal);
        if (expired) throw timeoutError();
        throw new Error('B站接口响应不是有效 JSON。');
      }
      checkAbort(signal);
      return checkedJSON(data);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    }
  }

  function clearKeys() { cachedKey = null; keyGeneration++; }
  async function wbiKey(signal) {
    checkAbort(signal);
    if (cachedKey && Date.now() - cachedKey.at < KEY_TTL) return cachedKey.value;
    const generation = keyGeneration;
    const json = await getJSON(`${API_ORIGIN}/x/web-interface/nav`, signal);
    // Anonymous nav responses may have code=-101 and still publish valid
    // public WBI image keys. These keys are not authentication credentials.
    const imageKeys = json?.data?.wbi_img;
    if (!imageKeys?.img_url || !imageKeys?.sub_url) {
      if (Number(json.code) !== 0) throw apiError(json);
      throw new Error('B站没有返回有效签名参数，请稍后重新解析。');
    }
    const value = core.mixinKey(imageKeys.img_url, imageKeys.sub_url);
    checkAbort(signal);
    if (generation === keyGeneration) cachedKey = { value, at: Date.now() };
    return value;
  }

  async function getMeta(href, signal) {
    checkAbort(signal);
    const pageURL = new URL(href);
    if (pageURL.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(pageURL.hostname) || pageURL.username || pageURL.password) {
      throw new Error('请在 B站视频页面打开下载。');
    }
    const identity = core.pageIdentity(href);
    const query = new URLSearchParams(identity.id.startsWith('BV') ? { bvid: identity.id } : { aid: identity.id.slice(2) });
    const json = await getJSON(`${API_ORIGIN}/x/web-interface/view?${query}`, signal);
    if (Number(json.code) !== 0) throw apiError(json);
    if (!json.data) throw new Error('B站未返回视频信息。');
    return core.selectPage(json.data, identity);
  }

  async function getPlay(meta, { signal, qn = 127, refreshKeys = false } = {}) {
    checkAbort(signal);
    if (!meta || !/^BV[0-9A-Za-z]+$/.test(meta.bvid || '') || !Number.isSafeInteger(Number(meta.cid)) || Number(meta.cid) <= 0) {
      throw new Error('视频或分P信息无效，请重新解析。');
    }
    if (!Number.isSafeInteger(qn) || qn < 1 || qn > 127) throw new Error('清晰度参数无效。');
    if (refreshKeys) clearKeys();
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = await wbiKey(signal);
      const params = { bvid: meta.bvid, cid: Number(meta.cid), qn, fnver: 0, fnval: 4048, fourk: 1 };
      const query = core.signWbi(params, key);
      const json = await getJSON(`${API_ORIGIN}/x/player/wbi/playurl?${query}`, signal);
      if (Number(json.code) === 0) {
        if (!json.data) throw new Error('B站未返回播放信息。');
        return json.data;
      }
      if (Number(json.code) === -403 && attempt === 0) { clearKeys(); continue; }
      throw apiError(json);
    }
  }

  function requestRange({ url, start, endExclusive, signal, timeoutMs = 25000, onProgress } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive - start > RANGE_LIMIT) {
      return Promise.reject(new Error('下载分片范围无效。'));
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 120000) : 25000;
    return gmTransport({ url, signal, timeoutMs: timeout, byteLimit: endExclusive - start, range: { start, endExclusive }, onProgress });
  }

  return { getMeta, getPlay, requestRange, clearKeys };
}

if (typeof module === 'object' && module && module.exports) module.exports = { createBiliNetwork };
