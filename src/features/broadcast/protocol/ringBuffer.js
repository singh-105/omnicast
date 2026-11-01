/**
 * OmniCast Bounded Media Ring Buffer & Sequence Reordering Queue
 *
 * Provides:
 * 1. Monotonic chunk sequencing and jitter reordering.
 * 2. Duplicate chunk rejection.
 * 3. Bounded ~3-second RAM cache for fast standby failover retransmissions.
 */

export class MediaRingBuffer {
  /**
   * @param {Object} options
   * @param {number} [options.maxItems=60] - Maximum logical chunks retained (~18s at 300ms)
   * @param {number} [options.maxDurationMs=15000] - Evict items older than 15 seconds
   */
  constructor({ maxItems = 60, maxDurationMs = 15000 } = {}) {
    this.maxItems = maxItems;
    this.maxDurationMs = maxDurationMs;
    // Map of sequence -> chunkObject
    this.buffer = new Map();
    // Cache for initialization segment (must persist across the entire broadcast)
    this.initSegment = null;
    this.highestSequence = -1;
    // Track sequence number of the most recent verified keyframe
    this.latestKeyframeSeq = -1;
  }

  /**
   * Set or get the persistent stream initialization segment (EBML header).
   */
  setInitSegment(chunk) {
    this.initSegment = chunk;
  }

  getInitSegment() {
    return this.initSegment;
  }

  /**
   * Adds a verified chunk to the ring buffer.
   * Evicts older chunks beyond capacity or time limits.
   */
  add(chunk) {
    if (!chunk || typeof chunk.sequence !== 'number') return;

    if (chunk.sequence > this.highestSequence) {
      this.highestSequence = chunk.sequence;
    }

    if (chunk.isKeyframe) {
      this.latestKeyframeSeq = chunk.sequence;
    }

    this.buffer.set(chunk.sequence, {
      ...chunk,
      bufferedAt: Date.now(),
    });

    this.prune();
  }

  /**
   * Check if a sequence number is already buffered.
   */
  has(sequence) {
    return this.buffer.has(sequence);
  }

  /**
   * Retrieve a specific chunk by sequence number.
   */
  get(sequence) {
    return this.buffer.get(sequence) || null;
  }

  /**
   * Get an array of chunks within a sequence range [fromSeq, toSeq].
   */
  getRange(fromSeq, toSeq) {
    const result = [];
    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const chunk = this.buffer.get(seq);
      if (chunk) result.push(chunk);
    }
    return result;
  }

  /**
   * Get all currently buffered media chunks sorted by sequence.
   */
  getAll() {
    return Array.from(this.buffer.values()).sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Returns all chunks starting from the most recent keyframe up to the newest sequence.
   * Enables immediate, stall-free playback synchronization for late-joining children.
   */
  getSinceLatestKeyframe() {
    const all = this.getAll();
    if (all.length === 0) return [];

    let keyframeIndex = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].isKeyframe) {
        keyframeIndex = i;
        break;
      }
    }

    if (keyframeIndex === -1) {
      // Do not return arbitrary delta frames without a keyframe base to prevent decoder errors
      return [];
    }
    return all.slice(keyframeIndex);
  }

  /**
   * Size of buffer in chunks.
   */
  size() {
    return this.buffer.size;
  }

  /**
   * Total bytes currently stored in RAM ring buffer.
   */
  byteLength() {
    let bytes = 0;
    if (this.initSegment?.payload) {
      bytes += this.initSegment.payload.byteLength;
    }
    for (const chunk of this.buffer.values()) {
      if (chunk.payload) bytes += chunk.payload.byteLength;
    }
    return bytes;
  }

  prune() {
    const now = Date.now();

    // 1. Evict by age, BUT ALWAYS preserve the latest keyframe and any chunks following it
    for (const [seq, chunk] of this.buffer) {
      if (this.latestKeyframeSeq !== -1 && seq >= this.latestKeyframeSeq) {
        // Protect active GOP from eviction so late joiners can always bootstrap
        continue;
      }
      if (now - chunk.bufferedAt > this.maxDurationMs) {
        this.buffer.delete(seq);
      }
    }

    // 2. Evict by max count if still exceeded, strictly preserving latest keyframe GOP
    if (this.buffer.size > this.maxItems) {
      const sortedKeys = Array.from(this.buffer.keys()).sort((a, b) => a - b);
      for (const seq of sortedKeys) {
        if (this.buffer.size <= this.maxItems) break;
        if (this.latestKeyframeSeq !== -1 && seq >= this.latestKeyframeSeq) {
          // Never evict the active keyframe or subsequent frames
          break;
        }
        this.buffer.delete(seq);
      }
    }
  }

  clear() {
    this.buffer.clear();
    this.initSegment = null;
    this.highestSequence = -1;
    this.latestKeyframeSeq = -1;
  }
}

/**
 * Reordering and deduplication queue for sequential playback.
 * Ensures chunks are fed to the decoder in contiguous sequence 0, 1, 2, 3...
 */
export class SequenceReorderQueue {
  /**
   * @param {Object} options
   * @param {number} [options.maxJitterWindow=10] - Maximum out-of-order gap before skipping
   * @param {number} [options.gapTimeoutMs=250] - Max time to wait for a missing sequence before skipping (~250ms)
   * @param {Function} [options.onEmit] - Callback when in-order chunk is ready: (chunk) => void
   * @param {Function} [options.onGap] - Callback when sequence gap is detected: (missingSeqFrom, missingSeqTo) => void
   * @param {Function} [options.onGapSkipped] - Callback when sequence gap times out: (fromSeq, toSeq) => void
   */
  constructor({ maxJitterWindow = 10, gapTimeoutMs = 250, onEmit = null, onGap = null, onGapSkipped = null } = {}) {
    this.maxJitterWindow = maxJitterWindow;
    this.gapTimeoutMs = gapTimeoutMs;
    this.onEmit = onEmit;
    this.onGap = onGap;
    this.onGapSkipped = onGapSkipped;

    this.expectedSequence = null; // Next expected sequence
    this.queue = new Map(); // sequence -> chunk
    this.gapTimer = null;
    this.processedSequences = new Set(); // Small LRU / set to dedupe
    this.maxDedupeSize = 100;
  }

  /**
   * Push an incoming chunk into the reorder queue.
   */
  push(chunk) {
    if (!chunk || typeof chunk.sequence !== 'number') return;
    const seq = chunk.sequence;

    // Reject duplicate if already processed
    if (this.processedSequences.has(seq)) {
      return;
    }

    // Initialize expected sequence on first arrival
    if (this.expectedSequence === null) {
      this.expectedSequence = seq;
    }

    // If chunk is older than expected, we either already passed it or it arrived too late
    if (seq < this.expectedSequence) {
      return;
    }

    this.queue.set(seq, chunk);
    this.drain();
  }

  /**
   * Drain in-order contiguous chunks from the queue.
   */
  drain() {
    while (this.queue.has(this.expectedSequence)) {
      this.clearGapTimer();
      const chunk = this.queue.get(this.expectedSequence);
      this.queue.delete(this.expectedSequence);

      this.markProcessed(this.expectedSequence);
      this.expectedSequence++;

      if (this.onEmit) {
        this.onEmit(chunk);
      }
    }

    // If there are still items in the queue, we have a gap!
    if (this.queue.size > 0 && !this.gapTimer) {
      const lowestAvailable = Math.min(...this.queue.keys());
      if (this.onGap && lowestAvailable > this.expectedSequence) {
        this.onGap(this.expectedSequence, lowestAvailable - 1);
      }

      // Schedule gap timeout to skip missing chunks and prevent stalling
      this.gapTimer = setTimeout(() => {
        this.handleGapTimeout();
      }, this.gapTimeoutMs);
    }
  }

  handleGapTimeout() {
    this.clearGapTimer();
    if (this.queue.size === 0) return;

    // Advance expectedSequence to lowest available sequence in queue
    const lowestAvailable = Math.min(...this.queue.keys());
    console.warn(`[ReorderQueue] Gap timeout! Skipping from sequence ${this.expectedSequence} to ${lowestAvailable}`);
    const gapFrom = this.expectedSequence;
    const gapTo = lowestAvailable - 1;
    this.expectedSequence = lowestAvailable;

    if (this.onGapSkipped) {
      this.onGapSkipped(gapFrom, gapTo);
    }

    this.drain();
  }

  clearGapTimer() {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  markProcessed(seq) {
    this.processedSequences.add(seq);
    if (this.processedSequences.size > this.maxDedupeSize) {
      const first = this.processedSequences.values().next().value;
      this.processedSequences.delete(first);
    }
  }

  reset(nextExpectedSeq = null) {
    this.clearGapTimer();
    this.queue.clear();
    this.processedSequences.clear();
    this.expectedSequence = nextExpectedSeq;
  }
}

