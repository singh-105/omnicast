/**
 * OmniCast MediaSource Extensions (MSE) Live Playback Engine
 *
 * Implements:
 * - HTML5 video playback via MediaSource & SourceBuffer.
 * - Sequential FIFO append queue to prevent InvalidStateError.
 * - Robust stream initialization segment handling.
 * - Automatic buffer eviction/pruning to maintain bounded RAM usage.
 * - Live latency drift control (subtle catch-up to stay < 1.5s live edge).
 * - Autoplay restriction handling and recovery.
 */

export class MsePlayer {
  constructor({ videoElement, mimeType, onError, onLiveStateChange } = {}) {
    this.videoElement = videoElement;
    this.mimeType = mimeType || 'video/webm; codecs="vp8,opus"';
    this.onError = onError;
    this.onLiveStateChange = onLiveStateChange;

    this.mediaSource = null;
    this.sourceBuffer = null;
    this.isSourceOpen = false;
    this.appendQueue = [];
    this.isAppending = false;
    this.hasInitSegment = false;
    this.hasFirstKeyframe = false;
    this.allowPreKeyframeData = false;
    this.waitingForKeyframe = false;
    this.pruneInterval = null;
    this.driftInterval = null;
    this.isDestroyed = false;

    // Real-time playback instrumentation
    this.decodedFramesCount = 0;
    this.lastFpsSampleTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.lastFpsFrameCount = 0;
    this.currentDecodedFps = 0;

    this.initMediaSource();
    this.setupPerformanceInstrumentation();
  }

  setupPerformanceInstrumentation() {
    if (typeof window === 'undefined' || !this.videoElement) return;

    if ('requestVideoFrameCallback' in this.videoElement) {
      const onFrame = (now, metadata) => {
        if (this.isDestroyed) return;
        this.decodedFramesCount++;
        const elapsed = now - this.lastFpsSampleTime;
        if (elapsed >= 1000) {
          this.currentDecodedFps = Math.round(((this.decodedFramesCount - this.lastFpsFrameCount) * 1000) / elapsed);
          this.lastFpsFrameCount = this.decodedFramesCount;
          this.lastFpsSampleTime = now;
        }
        try {
          this.videoElement.requestVideoFrameCallback(onFrame);
        } catch (_) {}
      };
      try {
        this.videoElement.requestVideoFrameCallback(onFrame);
      } catch (_) {}
    }
  }

  initMediaSource() {
    if (typeof window === 'undefined' || !window.MediaSource) {
      throw new Error('MediaSource Extensions (MSE) are not supported by this browser');
    }

    this.mediaSource = new MediaSource();
    this.videoElement.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.isDestroyed) return;
      this.isSourceOpen = true;

      try {
        // Guard against duplicate addSourceBuffer if sourceopen fires more than once
        if (this.sourceBuffer || (this.mediaSource.sourceBuffers && this.mediaSource.sourceBuffers.length > 0)) {
          if (!this.sourceBuffer) {
            this.sourceBuffer = this.mediaSource.sourceBuffers[0];
          }
          this.processAppendQueue();
          return;
        }
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
        this.sourceBuffer.mode = 'segments';

        this.sourceBuffer.addEventListener('updateend', () => {
          this.isAppending = false;
          this.processAppendQueue();
        });

        this.sourceBuffer.addEventListener('error', (err) => {
          this.isAppending = false;
          const videoErr = this.videoElement ? this.videoElement.error : null;
          console.error('[MSE] SourceBuffer error event:', err, 'videoElement.error:', videoErr ? { code: videoErr.code, message: videoErr.message } : null);
          if (this.onError) this.onError(err);
        });

        // Start processing queue if items arrived before sourceopen
        this.processAppendQueue();
      } catch (err) {
        console.error('[MSE] Failed to create SourceBuffer:', err);
        if (this.onError) this.onError(err);
      }
    });

    // Start background buffer pruning (keep last 8s, bounded RAM)
    this.pruneInterval = setInterval(() => {
      this.pruneBuffer();
    }, 6000);

    // Start drift controller with fast 500ms cadence (keep video tightly at < 1.0s live edge)
    this.driftInterval = setInterval(() => {
      this.maintainLiveEdge();
    }, 500);
  }

  /**
   * Called when a sequence gap occurs in transport.
   * Quarantines delta frames until the next keyframe arrives to eliminate ghosting.
   */
  onGapOccurred() {
    this.waitingForKeyframe = true;
    console.warn('[MSE] Transport gap detected: quarantining delta frames until clean keyframe arrives to prevent ghosting.');
  }

  /**
   * Append a media chunk (Uint8Array or ArrayBuffer).
   * @param {Uint8Array|ArrayBuffer} chunkBytes
   * @param {boolean} isInit
   * @param {boolean} isKeyframe
   */
  /**
   * FIX-E (MSE): Append a media chunk to the SourceBuffer.
   * appendQueue entries are tagged with enqueue time and evicted if >3s old
   * to prevent stale data causing decoder errors under congestion.
   */
  appendChunk(chunkBytes, isInit = false, isKeyframe = false) {
    if (this.isDestroyed) return;

    const buffer = chunkBytes instanceof Uint8Array
      ? chunkBytes.buffer.slice(chunkBytes.byteOffset, chunkBytes.byteOffset + chunkBytes.byteLength)
      : chunkBytes;

    // FIX-E: Evict stale non-init entries from appendQueue before adding more.
    // If transport was congested and queued media is >3s old, the timestamps will
    // be wrong and the decoder will error on out-of-order presentation times.
    const MAX_APPEND_QUEUE_AGE_MS = 3000;
    if (!isInit && this.appendQueue.length > 0) {
      const now = Date.now();
      let staleCount = 0;
      this.appendQueue = this.appendQueue.filter(item => {
        // Keep init headers, special objects without timestamps, and recent items
        if (item && (item.isInitHeader || !item._queuedAt)) return true;
        if (now - item._queuedAt < MAX_APPEND_QUEUE_AGE_MS) return true;
        staleCount++;
        return false;
      });
      if (staleCount > 0) {
        console.warn(`[MSE] Evicted ${staleCount} stale appendQueue entries (>3s old). Will wait for keyframe.`);
        this.waitingForKeyframe = true; // Need clean keyframe after dropping stale data
      }
    }

    if (isInit) {
      if (!this.hasInitSegment) {
        this.hasInitSegment = true;
        this.hasFirstKeyframe = false; // Must wait for first decodable keyframe
        this.allowPreKeyframeData = true;
        this.waitingForKeyframe = false;
        this.appendQueue.unshift(buffer);
      } else {
        // Source switch or new epoch: append new track header in order with offset
        this.hasFirstKeyframe = false; // Reset to wait for clean keyframe from new source
        this.allowPreKeyframeData = true;
        this.waitingForKeyframe = false;
        this.appendQueue.push({ isInitHeader: true, buffer });
      }
      this.processAppendQueue();
      return;
    }

    // A decoder cannot decode delta frames before its first keyframe arrives!
    if (!this.hasFirstKeyframe) {
      if (!isKeyframe) {
        // Keep the WebM cluster context for a late joiner. The bootstrap
        // sender supplies a bounded contiguous window after the init segment;
        // dropping those pre-keyframe clusters can make a later keyframe
        // undecodable even though the bytes themselves arrived intact.
        if (!this.allowPreKeyframeData) return;
        this.appendQueue.push(buffer);
        this.processAppendQueue();
        return;
      }
      this.hasFirstKeyframe = true;
      this.allowPreKeyframeData = false;
      this.waitingForKeyframe = false;
    }

    // If waiting for a keyframe after a sequence gap, drop delta frames to prevent decoder ghosting/corruption!
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        return; // Drop corrupted delta frame until clean keyframe arrives
      }
      console.log('[MSE] Clean keyframe arrived after gap, resuming decode.');
      this.waitingForKeyframe = false;
    }

    // Tag with enqueue time for future age-based eviction
    const taggedBuffer = buffer;
    taggedBuffer._queuedAt = Date.now();
    this.appendQueue.push(taggedBuffer);
    this.processAppendQueue();
  }

  processAppendQueue() {
    if (
      this.isDestroyed ||
      !this.isSourceOpen ||
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.isAppending ||
      this.appendQueue.length === 0 ||
      (this.videoElement && this.videoElement.error)
    ) {
      return;
    }

    const nextItem = this.appendQueue.shift();
    let nextBuffer;

    if (nextItem && nextItem.isInitHeader) {
      nextBuffer = nextItem.buffer;
      try {
        if (this.sourceBuffer && !this.sourceBuffer.updating) {
          // Abort resets the byte stream parser to WAITING_FOR_SEGMENT so timestampOffset can be modified
          this.sourceBuffer.abort();
          const maxEnd = this.videoElement.buffered.length > 0
            ? this.videoElement.buffered.end(this.videoElement.buffered.length - 1)
            : 0;
          this.sourceBuffer.timestampOffset = maxEnd;
          console.log(`[MSE] Reset parser via abort() and updated timestampOffset to ${maxEnd.toFixed(2)}s for source switch`);

          // Seamlessly jump player across any gap to the live edge of the new stream
          if (this.videoElement.currentTime < maxEnd) {
            this.videoElement.currentTime = maxEnd;
          }
        }
      } catch (e) {
        console.warn('[MSE] Error setting timestampOffset:', e.message);
      }
    } else {
      nextBuffer = nextItem;
    }

    this.isAppending = true;

      try {
        this.sourceBuffer.appendBuffer(nextBuffer);

      // Attempt autoplay if paused and buffered enough
      if (this.videoElement.paused && this.videoElement.buffered.length > 0) {
        const bufStart = this.videoElement.buffered.start(0);
        if (this.videoElement.currentTime < bufStart) {
          this.videoElement.currentTime = bufStart;
        }
        this.playSafe();
      }
    } catch (err) {
      this.isAppending = false;
      console.warn('[MSE] appendBuffer exception:', err.name, err.message);

      if (err.name === 'QuotaExceededError') {
        // RAM quota reached, aggressively prune and retry
        this.pruneBuffer(true);
        this.appendQueue.unshift(nextBuffer);
        setTimeout(() => this.processAppendQueue(), 0);
      } else {
        // Fatal or invalid state: clear appendQueue to prevent infinite append retry loop
        this.appendQueue = [];
        if (this.onError) {
          this.onError(err);
        }
      }
    }
  }

  async playSafe() {
    if (!this.videoElement) return;
    try {
      await this.videoElement.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        // Autoplay blocked by browser policy, mute and try again
        this.videoElement.muted = true;
        try {
          await this.videoElement.play();
          if (this.onLiveStateChange) {
            this.onLiveStateChange({ autoplayBlocked: true, muted: true });
          }
        } catch (_) {
          if (this.onLiveStateChange) {
            this.onLiveStateChange({ autoplayBlocked: true, requiresUserGesture: true });
          }
        }
      }
    }
  }

  /**
   * Prune old buffer behind playback position to keep memory strictly bounded.
   */
  pruneBuffer(force = false) {
    if (
      !this.isSourceOpen ||
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.isAppending
    ) {
      return;
    }

    try {
      const currentTime = this.videoElement.currentTime;
      const keepDuration = force ? 3 : 8; // Keep 8s normally, 3s if RAM quota pressed
      if (currentTime > keepDuration) {
        this.sourceBuffer.remove(0, currentTime - keepDuration);
      }
    } catch (_) {}
  }

  /**
   * Keep playback tightly within target live window (~0.35s to 1.0s delay).
   * Bridges unbuffered gaps proactively to avoid stalled start or prepare freezes.
   */
  maintainLiveEdge() {
    if (!this.videoElement || this.videoElement.buffered.length === 0) return;

    try {
      const currentTime = this.videoElement.currentTime;

      // Check if currentTime is stuck in an unbuffered gap before or between ranges
      for (let i = 0; i < this.videoElement.buffered.length; i++) {
        const start = this.videoElement.buffered.start(i);
        if (currentTime < start) {
          console.log(`[MSE] Bridging unbuffered gap from ${currentTime.toFixed(2)}s to ${start.toFixed(2)}s`);
          this.videoElement.currentTime = start + 0.05;
          if (this.videoElement.paused) {
            this.playSafe();
          }
          return;
        }
      }

      if (this.videoElement.paused) {
        this.playSafe();
        return;
      }

      const bufferedEnd = this.videoElement.buffered.end(this.videoElement.buffered.length - 1);
      const lag = bufferedEnd - this.videoElement.currentTime;

      // Keep player tightly near the live edge without stuttering
      if (lag > 1.4) {
        // High latency detected: jump immediately to live edge
        this.videoElement.currentTime = Math.max(0, bufferedEnd - 0.35);
        this.videoElement.playbackRate = 1.0;
      } else if (lag > 0.7) {
        // Moderate latency: catch up smoothly without audio pitch distortion
        this.videoElement.playbackRate = 1.06;
      } else if (lag > 0.35) {
        // Optimal live edge range
        this.videoElement.playbackRate = 1.0;
      } else if (lag < 0.15) {
        // Near underrun: slight throttle to allow buffer cushion
        this.videoElement.playbackRate = 0.98;
      }
    } catch (_) {}
  }

  /**
   * Retrieve real-time decoded FPS, dropped frames, and buffer depth metrics.
   */
  getPlaybackStats() {
    let quality = null;
    if (this.videoElement && typeof this.videoElement.getVideoPlaybackQuality === 'function') {
      const q = this.videoElement.getVideoPlaybackQuality();
      quality = {
        totalFrames: q.totalVideoFrames,
        droppedFrames: q.droppedVideoFrames,
        corruptedFrames: q.corruptedVideoFrames,
      };
    }

    const bufferedEnd = (this.videoElement && this.videoElement.buffered.length > 0)
      ? this.videoElement.buffered.end(this.videoElement.buffered.length - 1)
      : 0;
    const current = this.videoElement ? this.videoElement.currentTime : 0;
    const bufferDepthSecs = Math.max(0, bufferedEnd - current);

    return {
      decodedFps: this.currentDecodedFps || (this.videoElement && !this.videoElement.paused ? 30 : 0),
      bufferDepthSecs: Number(bufferDepthSecs.toFixed(2)),
      quality,
    };
  }

  destroy() {
    this.isDestroyed = true;
    clearInterval(this.pruneInterval);
    clearInterval(this.driftInterval);
    this.appendQueue = [];

    if (this.sourceBuffer && this.isSourceOpen) {
      try {
        this.sourceBuffer.abort();
      } catch (_) {}
    }

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch (_) {}
    }

    if (this.videoElement) {
      this.videoElement.removeAttribute('src');
      this.videoElement.load();
    }

    this.mediaSource = null;
    this.sourceBuffer = null;
  }
}

