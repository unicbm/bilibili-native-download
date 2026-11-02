/* Bili Native Download: lossless DASH -> MP4 remux adapter.
 * Engine code: MIT. Requires the separately licensed Mediabunny 1.65.0.
 * No decoder, encoder, WASM worker, cookie access, or external service is used.
 */
function createMediaEngine(MB) {
  'use strict';

  if (!MB || !MB.Input || !MB.CustomSource || !MB.EncodedPacketSink) {
    throw new Error('MP4 合并组件未加载。');
  }
  const MiB = 1024 * 1024;
  const videoCodecs = new Set(['avc', 'hevc', 'av1']);

  const abortError = () => new DOMException('下载已取消', 'AbortError');
  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError();
  }
  function publicError(error, signal) {
    if (signal && signal.aborted) return abortError();
    if (/encrypt|decrypt|resolveKeyId|\bDRM\b/i.test(String(error && error.message))) {
      return new Error('该媒体使用加密封装，当前脚本无法合并。');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  function createInput(source, signal) {
    if (!source || !Number.isSafeInteger(source.size) || source.size <= 0 || typeof source.read !== 'function') {
      throw new Error('媒体大小或分段读取接口无效，请重新解析。');
    }
    return new MB.Input({
      formats: [MB.MP4],
      source: new MB.CustomSource({
        getSize: () => source.size,
        read: async (start, end) => {
          checkAbort(signal);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.size) {
            throw new Error('媒体读取范围无效。');
          }
          const data = await source.read(start, end, signal);
          checkAbort(signal);
          if (!ArrayBuffer.isView(data) || data.byteLength !== end - start) {
            throw new Error('媒体分段长度不符，已停止合并以避免损坏文件。');
          }
          return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        },
        // The caller may have its own bounded download cache. This is the
        // demuxer's independent upper bound; no entire-video buffer is made.
        maxCacheSize: 8 * MiB,
        prefetchProfile: 'network',
        // Background-prefetch failures will be retried by the reader when the
        // bytes are needed. Never create an unhandled rejection after cancel.
        handleUnhandledError: () => {},
      }),
    });
  }

  async function describeTrack(input, kind, signal) {
    checkAbort(signal);
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    if (!track) throw new Error(kind === 'video' ? '选定视频流中没有视频轨道。' : '选定音频流中没有音频轨道。');
    const [codec, decoderConfig, duration, firstTimestamp, internalCodec] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
      track.getDurationFromMetadata(),
      track.getFirstTimestamp(),
      track.getInternalCodecId(),
    ]);
    checkAbort(signal);
    if (internalCodec === 'encv' || internalCodec === 'enca') throw new Error('Encrypted media is unsupported.');
    if (!decoderConfig || !codec || (kind === 'video' ? !videoCodecs.has(codec) : codec !== 'aac')) {
      throw new Error(kind === 'video' ? '该视频编码暂不支持合并，请选择 H.264、HEVC 或 AV1。' : '该音频编码暂不支持合并，请选择普通 AAC 音轨。');
    }
    const details = { kind, codec, decoderConfig, duration, firstTimestamp };
    if (kind === 'video') {
      const [width, height, transformationMatrix] = await Promise.all([
        track.getDisplayWidth(), track.getDisplayHeight(), track.getTransformationMatrix(),
      ]);
      Object.assign(details, { width, height, transformationMatrix });
    } else {
      Object.assign(details, { sampleRate: decoderConfig.sampleRate, channels: decoderConfig.numberOfChannels });
    }
    return { track, details };
  }

  /** Inspect a range-readable MP4 without decoding or retaining its media. */
  async function inspectSource(source, { kind = 'video', signal } = {}) {
    let input;
    try {
      checkAbort(signal);
      input = createInput(source, signal);
      const { details } = await describeTrack(input, kind, signal);
      return details;
    } catch (error) {
      throw publicError(error, signal);
    } finally {
      if (input) input.dispose();
    }
  }

  /**
   * source: { size, read(start, endExclusive, signal): Promise<Uint8Array> }
   * target: { write({type:'write', position, data}), close(), abort(reason) }
   * A native FileSystemWritableFileStream also satisfies target.
   * This function owns target completion: closes once after success; aborts
   * once on all failures, including metadata/initialization failures.
   * Source adapters remain caller-owned (e.g. close their cache in finally).
   */
  async function muxToTarget({ videoSource, audioSource = null, target, signal, onProgress } = {}) {
    const inputs = [];
    const jobs = [];
    let output;
    let failed = false;
    let finalizing = false;
    let completed = false;
    let targetFinished = false;
    let outputBytes = 0;
    let lastReport = 0;
    let duration = 0;
    let failure;
    let stage = 'inspecting';
    let activeVideo = 0;
    let activeAudio = 0;

    if (!target || typeof target.write !== 'function' || typeof target.close !== 'function' || typeof target.abort !== 'function') {
      throw new Error('文件写入接口无效。');
    }
    async function abortTarget(reason) {
      if (targetFinished) return;
      targetFinished = true;
      try { await target.abort(reason); } catch (_) { /* retain the original failure */ }
    }
    async function closeTarget() {
      if (targetFinished) return;
      if (failed || !finalizing || (signal && signal.aborted)) {
        await abortTarget(failure || abortError());
        return;
      }
      try {
        await target.close();
        targetFinished = true;
      } catch (error) {
        failed = true;
        failure = error;
        await abortTarget(error);
        throw error;
      }
    }
    function progress(force = false) {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (!force && now - lastReport < 200) return;
      lastReport = now;
      const active = jobs.filter(job => !job.done);
      const seconds = active.length ? Math.min(...active.map(job => job.seconds)) : Math.max(0, ...jobs.map(job => job.seconds));
      try {
        onProgress({ stage, seconds, duration, videoPackets: activeVideo, audioPackets: activeAudio, outputBytes });
      } catch (_) { /* a detached UI must not damage a download */ }
    }

    try {
      checkAbort(signal);
      progress(true);
      // Open serially so a failed audio initialization cannot leave an
      // unobserved video promise or undisposed input behind.
      for (const [source, kind] of [[videoSource, 'video'], [audioSource, 'audio']]) {
        if (kind === 'audio' && !source) continue;
        const input = createInput(source, signal);
        inputs.push(input);
        const { track, details } = await describeTrack(input, kind, signal);
        const packetSource = kind === 'video' ? new MB.EncodedVideoPacketSource(details.codec) : new MB.EncodedAudioPacketSource(details.codec);
        const iterator = new MB.EncodedPacketSink(track).packets();
        jobs.push({ kind, details, packetSource, iterator, next: null, done: false, sent: false, seconds: 0 });
        duration = Math.max(duration, Number.isFinite(details.duration) ? details.duration : 0);
      }
      checkAbort(signal);
      const stream = new WritableStream({
        async write(chunk) {
          checkAbort(signal);
          try {
            await target.write({ type: 'write', position: chunk.position, data: chunk.data });
            outputBytes = Math.max(outputBytes, chunk.position + chunk.data.byteLength);
          } catch (error) {
            failed = true;
            failure = error;
            throw error;
          }
        },
        close: closeTarget,
        abort: abortTarget,
      });
      output = new MB.Output({
        // Standard seekable MP4. Appending moov at the end avoids whole-file
        // RAM buffering and supports more players than fragmented MP4.
        format: new MB.Mp4OutputFormat({ fastStart: false }),
        target: new MB.StreamTarget(stream, { chunked: true, chunkSize: 2 * MiB }),
      });
      for (const job of jobs) {
        const metadata = { decoderConfig: job.details.decoderConfig };
        if (job.kind === 'video') {
          metadata.transformationMatrix = job.details.transformationMatrix;
          output.addVideoTrack(job.packetSource, metadata);
        } else {
          output.addAudioTrack(job.packetSource, metadata);
        }
      }
      await output.start();
      stage = 'mux';
      // Each iterator yields decode order. Keep one lookahead packet from
      // each track and interleave the tracks; never sort an individual
      // track by PTS (which would corrupt B-frame decode order).
      for (const job of jobs) job.next = await job.iterator.next();
      for (;;) {
        checkAbort(signal);
        for (const job of jobs) {
          if (!job.done && job.next.done) {
            job.done = true;
            job.packetSource.close();
          }
        }
        const pending = jobs.filter(job => !job.done);
        if (!pending.length) break;
        let job = pending[0];
        for (let i = 1; i < pending.length; i++) {
          if (pending[i].next.value.timestamp < job.next.value.timestamp) job = pending[i];
        }
        const packet = job.next.value;
        const metadata = job.sent ? undefined : { decoderConfig: job.details.decoderConfig };
        await job.packetSource.add(packet, metadata);
        job.sent = true;
        job.seconds = Math.max(job.seconds, packet.timestamp + packet.duration);
        if (job.kind === 'video') activeVideo++; else activeAudio++;
        progress();
        job.next = await job.iterator.next();
        // Let click/cancel/render events run even when a long sequence of
        // packets is already cached and every awaited promise resolves now.
        if ((activeVideo + activeAudio) % 512 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!activeVideo) throw new Error('视频流没有可用画面，文件未保存。');
      if (audioSource && !activeAudio) throw new Error('音频流没有可用声音，文件未保存。');
      checkAbort(signal);
      stage = 'finalizing';
      progress(true);
      finalizing = true;
      await output.finalize();
      completed = true;
      stage = 'done';
      progress(true);
      return { outputBytes, videoPackets: activeVideo, audioPackets: activeAudio, duration: Math.max(0, ...jobs.map(job => job.seconds)) };
    } catch (error) {
      failed = true;
      failure = publicError(error, signal);
      throw failure;
    } finally {
      if (!completed) {
        // output.cancel closes its StreamTarget; closeTarget deliberately
        // turns that operation into abort for unsuccessful output.
        if (output && output.state !== 'finalized' && output.state !== 'canceled') {
          try { await output.cancel(); } catch (_) { /* abort below */ }
        }
        await abortTarget(failure || abortError());
      }
      // Disposing the source first aborts speculative demux reads, so an
      // iterator's cleanup cannot keep waiting for a canceled network read.
      for (const input of inputs) {
        try { input.dispose(); } catch (_) { /* cleanup is best effort */ }
      }
      for (const job of jobs) {
        try { await job.iterator.return(); } catch (_) { /* cleanup is best effort */ }
      }
    }
  }

  return { inspectSource, muxToTarget };
}

if (typeof module === 'object' && module && module.exports) module.exports = { createMediaEngine };
