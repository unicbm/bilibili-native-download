/* Bili Native Download: bounded HTTP Range reader. No external dependencies. */
function createRangeEngine(options) {
  'use strict';
  const { request } = options;
  if (typeof request !== 'function') throw new TypeError('request adapter is required');
  const MiB = 1024 * 1024;
  const now = () => typeof performance === 'object' ? performance.now() : Date.now();
  const abortError = () => Object.assign(new Error('下载已取消'), { name: 'AbortError' });
  const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
  const safeCall = (fn, value) => { try { fn?.(value); } catch (_) { /* UI observers cannot corrupt downloads. */ } };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.floor(Number(n) || min)));

  class RangeValidationError extends Error {
    constructor(message) { super(message); this.name = 'RangeValidationError'; }
  }

  function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const stop = () => { cleanup(); reject(abortError()); };
      const cleanup = () => signal.removeEventListener('abort', stop);
      signal.addEventListener('abort', stop, { once: true });
      Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  /** A shared limiter can cap video and audio requests together. */
  function createLimiter(concurrency = 4) {
    const limit = clamp(concurrency, 1, 8);
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < limit && queue.length) {
        const task = queue.shift();
        task.signal?.removeEventListener('abort', task.stop);
        if (task.signal?.aborted) { task.reject(abortError()); continue; }
        active++;
        Promise.resolve().then(task.fn).then(task.resolve, task.reject).finally(() => { active--; pump(); });
      }
    };
    return {
      get active() { return active; },
      get pending() { return queue.length; },
      get concurrency() { return limit; },
      run(fn, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
          const task = { fn, signal, resolve, reject, stop: null };
          task.stop = () => {
            const index = queue.indexOf(task);
            if (index >= 0) queue.splice(index, 1);
            reject(abortError());
          };
          signal?.addEventListener('abort', task.stop, { once: true });
          queue.push(task);
          pump();
        });
      }
    };
  }

  function validate(response, start, requestedEnd, knownSize) {
    if (response.status !== 206) {
      if (response.status === 200) throw new RangeValidationError('CDN 忽略了 Range，拒绝将完整文件误当成分片');
      if (response.status === 416) throw new RangeValidationError('CDN 文件范围已变化，请重新解析');
      throw Object.assign(new Error(`CDN 请求失败：HTTP ${response.status}`), { status: response.status });
    }
    const value = String(response.headers?.['content-range'] || '');
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
    if (!match) throw new RangeValidationError('CDN 缺少有效 Content-Range，无法校验分片');
    const actualStart = Number(match[1]), actualEnd = Number(match[2]) + 1, size = Number(match[3]);
    if (![actualStart, actualEnd, size].every(Number.isSafeInteger) || size <= 0 || actualEnd > size || actualStart >= actualEnd) {
      throw new RangeValidationError('CDN 返回了无效的文件范围');
    }
    if (actualStart !== start || actualEnd !== Math.min(requestedEnd, size)) {
      throw new RangeValidationError('CDN 分片起止位置与请求不符');
    }
    if (knownSize !== undefined && size !== knownSize) throw new RangeValidationError('备用 CDN 文件大小不一致');
    const encoding = String(response.headers?.['content-encoding'] || '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') throw new RangeValidationError('CDN 压缩了分片，无法安全按字节拼接');
    let body = response.body;
    if (ArrayBuffer.isView(body)) body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') body = new Uint8Array(body);
    else throw new RangeValidationError('CDN 返回的数据不是二进制分片');
    if (body.byteLength !== actualEnd - actualStart) throw new RangeValidationError('CDN 分片未下载完整');
    const contentLength = response.headers?.['content-length'];
    if (contentLength !== undefined && Number(contentLength) !== body.byteLength) throw new RangeValidationError('CDN Content-Length 与分片长度不符');
    return { body, size };
  }

  async function buildSource({
    urls, concurrency = 4, chunkSize = 2 * MiB, maxCacheBytes = 32 * MiB,
    signal, onProgress, onRoute, limiter, timeoutMs = 25000,
    sampleBytes = 256 * 1024, prefetch = true
  }) {
    checkAbort(signal);
    concurrency = clamp(concurrency, 1, 8);
    chunkSize = clamp(chunkSize, 1024, 8 * MiB);
    maxCacheBytes = clamp(maxCacheBytes, chunkSize, 128 * MiB);
    sampleBytes = clamp(sampleBytes, 1, Math.min(chunkSize, 256 * 1024));
    timeoutMs = clamp(timeoutMs, 100, 120000);
    const pool = limiter || createLimiter(concurrency);
    const candidates = [...new Set((urls || []).filter(url => typeof url === 'string'))].slice(0, 4).map(url => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('CDN 地址必须为不含账号信息的 HTTPS 地址');
      return { url, hostname: parsed.hostname, speed: 0, failures: 0, quarantined: false, error: '', latencyMs: 0, size: 0 };
    });
    if (!candidates.length) throw new Error('没有可用的 CDN 地址');
    const controller = new AbortController();
    const lifetime = controller.signal;
    const relayAbort = () => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    const stats = {
      downloadedBytes: 0, requests: 0, failures: 0, activeRequests: 0,
      peakActiveRequests: 0, cacheBytes: 0, peakCacheBytes: 0,
      cachedChunks: 0, pendingChunks: 0, throughput: 0, totalBytes: 0
    };
    let disposed = false;
    let currentRoute = '';
    let stage = 'probe';
    const report = () => safeCall(onProgress, { ...stats, stage });
    const cache = new Map();
    const inFlight = new Map();
    let prefix = null;
    let size = 0;

    async function getRange(route, start, endExclusive, expectedSize) {
      return pool.run(async () => {
        checkAbort(lifetime);
        const local = new AbortController();
        const relay = () => local.abort();
        lifetime.addEventListener('abort', relay, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; local.abort(); }, timeoutMs);
        const started = now();
        stats.activeRequests++;
        stats.requests++;
        stats.peakActiveRequests = Math.max(stats.peakActiveRequests, stats.activeRequests);
        try {
          const response = await waitFor(Promise.resolve().then(() => request({
            url: route.url, method: 'GET', start, endExclusive, signal: local.signal, timeoutMs
          })), local.signal);
          checkAbort(lifetime);
          const transferred = response.body?.byteLength || 0;
          stats.downloadedBytes += transferred;
          const elapsed = Math.max(1, now() - started);
          const rate = transferred * 1000 / elapsed;
          stats.throughput = stats.throughput ? 0.75 * stats.throughput + 0.25 * rate : rate;
          const result = validate(response, start, endExclusive, expectedSize);
          route.speed = route.speed ? 0.7 * route.speed + 0.3 * rate : rate;
          route.latencyMs = elapsed;
          route.size = result.size;
          return result;
        } catch (error) {
          if (lifetime.aborted) throw abortError();
          stats.failures++;
          if (timedOut) throw Object.assign(new Error('CDN 请求超时，正在尝试备用线路'), { name: 'TimeoutError' });
          throw error;
        } finally {
          clearTimeout(timer);
          lifetime.removeEventListener('abort', relay);
          stats.activeRequests--;
          report();
        }
      }, lifetime);
    }

    function updateCacheStats() {
      stats.cacheBytes = (prefix?.byteLength || 0) + [...cache.values()].reduce((total, item) => total + item.byteLength, 0);
      stats.cachedChunks = cache.size;
      stats.pendingChunks = inFlight.size;
      stats.peakCacheBytes = Math.max(stats.peakCacheBytes, stats.cacheBytes);
    }
    function storeChunk(index, body) {
      if (disposed) return;
      if (index === 0) prefix = null;
      cache.delete(index);
      cache.set(index, body);
      let used = (prefix?.byteLength || 0) + [...cache.values()].reduce((total, item) => total + item.byteLength, 0);
      while (used > maxCacheBytes && cache.size) {
        const oldest = cache.keys().next().value;
        used -= cache.get(oldest).byteLength;
        cache.delete(oldest);
      }
      updateCacheStats();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      signal?.removeEventListener('abort', relayAbort);
      cache.clear();
      prefix = null;
      updateCacheStats();
    }

    try {
      // At most two probes run concurrently, even if the download pool is larger.
      const probeLimiter = createLimiter(Math.min(2, concurrency));
      const probes = await Promise.allSettled(candidates.map(route => probeLimiter.run(() => getRange(route, 0, sampleBytes), lifetime)));
      checkAbort(lifetime);
      const referenceIndex = probes.findIndex(result => result.status === 'fulfilled');
      if (referenceIndex < 0) {
        const why = probes[0]?.reason?.message || '网络请求失败';
        throw new Error(`所有 CDN 分片探测失败：${why}`);
      }
      const reference = probes[referenceIndex].value;
      size = reference.size;
      prefix = reference.body;
      for (let i = 0; i < probes.length; i++) {
        const result = probes[i], route = candidates[i];
        if (result.status === 'rejected') { route.quarantined = true; route.error = result.reason?.message || '线路探测失败'; continue; }
        const other = result.value;
        if (other.size !== size || other.body.length !== prefix.length || other.body.some((value, index) => value !== prefix[index])) {
          route.quarantined = true;
          route.error = '备用线路的文件大小或起始内容与主线路不一致';
        }
      }
      stats.totalBytes = size;
      stage = 'download';
      if (prefix.length === Math.min(chunkSize, size)) storeChunk(0, prefix);
      else updateCacheStats();
      report();
    } catch (error) { dispose(); throw error; }

    async function fetchChunk(index) {
      checkAbort(lifetime);
      const chunkStart = index * chunkSize;
      const end = Math.min(size, chunkStart + chunkSize);
      const seed = index === 0 ? prefix : null;
      const start = chunkStart + (seed?.byteLength || 0);
      if (start === end && seed) return seed;
      let lastError;
      // Prefer throughput, penalize recent failures; try alternatives before retrying.
      const ordered = candidates.filter(route => !route.quarantined).sort((a, b) => b.speed / (1 + b.failures * 4) - a.speed / (1 + a.failures * 4));
      for (let pass = 0; pass < 2; pass++) {
        for (const route of ordered) {
          checkAbort(lifetime);
          if (route.quarantined) continue;
          try {
            const { body } = await getRange(route, start, end, size);
            checkAbort(lifetime);
            route.failures = Math.max(0, route.failures - 1);
            if (currentRoute !== route.url) {
              currentRoute = route.url;
              safeCall(onRoute, { url: route.url, hostname: route.hostname, reason: lastError ? 'failover' : 'selected', speed: route.speed });
            }
            if (!seed) return body;
            const joined = new Uint8Array(end - chunkStart);
            joined.set(seed);
            joined.set(body, seed.byteLength);
            return joined;
          } catch (error) {
            if (lifetime.aborted || error.name === 'AbortError') throw abortError();
            route.failures++;
            route.error = error.message;
            lastError = error;
            if (error instanceof RangeValidationError) route.quarantined = true;
          }
        }
      }
      throw new Error(`可用 CDN 均未完成分片：${lastError?.message || '请重新解析视频地址'}`);
    }

    function getChunk(index) {
      checkAbort(lifetime);
      if (cache.has(index)) {
        const body = cache.get(index);
        cache.delete(index);
        cache.set(index, body);
        return Promise.resolve(body);
      }
      if (inFlight.has(index)) return inFlight.get(index);
      const promise = fetchChunk(index).then(body => { checkAbort(lifetime); storeChunk(index, body); return body; });
      inFlight.set(index, promise);
      updateCacheStats();
      const finished = () => { inFlight.delete(index); updateCacheStats(); };
      promise.then(finished, finished);
      return promise;
    }

    async function read(start, endExclusive, readSignal) {
      checkAbort(lifetime);
      checkAbort(readSignal);
      if (![start, endExclusive].every(Number.isSafeInteger) || start < 0 || endExclusive < start || endExclusive > size) {
        throw new RangeError('读取范围超出文件边界');
      }
      if (start === endExclusive) return new Uint8Array(0);
      const output = new Uint8Array(endExclusive - start);
      const first = Math.floor(start / chunkSize), last = Math.floor((endExclusive - 1) / chunkSize);
      for (let index = first; index <= last; index++) {
        checkAbort(lifetime);
        checkAbort(readSignal);
        const required = getChunk(index);
        if (prefetch) {
          for (let next = index + 1; next < index + concurrency && next * chunkSize < size && inFlight.size < concurrency; next++) {
            // Errors are observed; a demanded read later retries a failed speculative chunk.
            getChunk(next).catch(() => {});
          }
        }
        const chunk = await waitFor(required, readSignal);
        const left = Math.max(start, index * chunkSize), right = Math.min(endExclusive, (index + 1) * chunkSize);
        output.set(chunk.subarray(left - index * chunkSize, right - index * chunkSize), left - start);
      }
      return output;
    }

    return { size, read, dispose, stats, routes: candidates, chunkSize, maxCacheBytes };
  }

  return { buildSource, createLimiter };
}

if (typeof module === 'object' && module.exports) module.exports = { createRangeEngine };
