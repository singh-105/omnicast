/**
 * OmniCast Native WebRTC RTCPeerConnection & RTCDataChannel Transport
 *
 * Implements:
 * - Direct browser-to-browser P2P communication.
 * - Binary RTCDataChannel for media fragments with backpressure flow control.
 * - Dedicated control channel for heartbeats and gap retransmit requests.
 * - Standard public STUN servers and optional TURN fallback.
 * - Graceful connection lifecycle and resource cleanup.
 */

export const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
  iceCandidatePoolSize: 2,
};

export function getEffectiveRtcConfig(customConfig = null) {
  if (customConfig) return customConfig;
  if (typeof window !== 'undefined' && window.OMNICAST_RTC_CONFIG) {
    return window.OMNICAST_RTC_CONFIG;
  }

  const baseConfig = {
    ...DEFAULT_RTC_CONFIG,
    iceServers: [...DEFAULT_RTC_CONFIG.iceServers],
  };

  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TURN_URL) {
    baseConfig.iceServers.push({
      urls: import.meta.env.VITE_TURN_URL,
      username: import.meta.env.VITE_TURN_USERNAME || '',
      credential: import.meta.env.VITE_TURN_PASSWORD || '',
    });
  }

  return baseConfig;
}

// Backpressure thresholds for RTCDataChannel
// FIX-E: Tightened from 1MB to 512KB HIGH mark; reduced queue from 256 to 64 packets.
// With 1MB HIGH and 256 packets an overtaken viewer accumulated ~30s of backlog silently.
// 512KB HIGH catches congestion faster; 64-packet queue is ~3-4s at 1.2Mbps which is
// enough for bootstrap burst without accumulating stale live media.
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024;  // 64 KB low-water mark
export const MAX_BUFFERED_AMOUNT_HIGH = 512 * 1024;      // 512 KB high-water mark
export const MAX_PENDING_QUEUE_PACKETS = 128;            // Max packets in app-layer queue
export const MAX_PENDING_QUEUE_BYTES   = 512 * 1024;    // 512 KB byte ceiling on queue
// If the oldest queued packet is older than this, the peer is irrecoverably behind.
// Drop it cleanly here rather than delivering stale data that will make the decoder error.
export const MAX_PENDING_QUEUE_AGE_MS  = 4000;          // 4 seconds

export class PeerLink {
  /**
   * @param {Object} options
   * @param {string} options.remotePeerId
   * @param {string} options.broadcastId
   * @param {boolean} options.isInitiator - True if this peer creates the offer
   * @param {Function} options.sendSignal - (toPeerId, signalType, signalData) => void
   * @param {Function} [options.onBinaryMessage] - (ArrayBuffer) => void
   * @param {Function} [options.onControlMessage] - (Object) => void
   * @param {Function} [options.onStateChange] - (state) => void
   * @param {Object} [options.rtcConfig]
   */
  constructor({
    remotePeerId,
    broadcastId,
    isInitiator = false,
    sendSignal,
    onBinaryMessage,
    onControlMessage,
    onStateChange,
    onIceStateChange,
    rtcConfig = null,
  }) {
    this.remotePeerId = remotePeerId;
    this.broadcastId = broadcastId;
    this.isInitiator = isInitiator;
    this.sendSignal = sendSignal;
    this.onBinaryMessage = onBinaryMessage;
    this.onControlMessage = onControlMessage;
    this.onStateChange = onStateChange;
    this.onIceStateChange = onIceStateChange;

    this.pc = null;
    this.mediaChannel = null;
    this.controlChannel = null;
    this.state = 'new';
    this.iceState = 'new';
    this.isBackpressured = false;
    this.pendingQueue = [];      // Array of { buf: ArrayBuffer, queuedAt: number }
    this.pendingQueueBytes = 0;
    this.pendingIceCandidates = [];
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      packetsSent: 0,
      packetsReceived: 0,
      rttMs: 0,
    };

    this.initPeerConnection(getEffectiveRtcConfig(rtcConfig));
  }

  initPeerConnection(config) {
    this.pc = new RTCPeerConnection(config);

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.sendSignal) {
        this.sendSignal(this.remotePeerId, 'candidate', event.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.iceState = this.pc.iceConnectionState;
      if (this.onIceStateChange) this.onIceStateChange(this.iceState);
      if (this.iceState === 'failed') {
        console.warn(`[Transport] ICE failed with ${this.remotePeerId.slice(-8)}. Restarting ICE...`);
        try { this.pc.restartIce(); } catch (_) {}
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.state = this.pc.connectionState;
      if (this.onStateChange) this.onStateChange(this.state);

      if (this.state === 'failed' || this.state === 'closed') {
        this.cleanup();
      }
    };

    if (this.isInitiator) {
      // Create outbound DataChannels
      this.mediaChannel = this.pc.createDataChannel('omnicast-media', {
        ordered: true,
      });
      this.setupMediaChannel(this.mediaChannel);

      this.controlChannel = this.pc.createDataChannel('omnicast-control', {
        ordered: true,
      });
      this.setupControlChannel(this.controlChannel);
    } else {
      // Receiver: listen for incoming DataChannels
      this.pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === 'omnicast-media') {
          this.mediaChannel = channel;
          this.setupMediaChannel(channel);
        } else if (channel.label === 'omnicast-control') {
          this.controlChannel = channel;
          this.setupControlChannel(channel);
        }
      };
    }
  }

  setupMediaChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    channel.onopen = () => {
      this.state = 'open';
      if (this.onStateChange) this.onStateChange('open');
    };

    channel.onbufferedamountlow = () => {
      this.isBackpressured = false;
      this.flushPendingQueue();
    };

    channel.onmessage = (event) => {
      this.stats.bytesReceived += event.data.byteLength;
      this.stats.packetsReceived++;
      if (this.onBinaryMessage) {
        this.onBinaryMessage(event.data);
      }
    };

    channel.onclose = () => {
      this.state = 'closed';
      if (this.onStateChange) this.onStateChange('closed');
    };

    channel.onerror = (err) => {
      console.warn(`[Transport] Media channel error with ${this.remotePeerId}:`, err);
    };
  }

  setupControlChannel(channel) {
    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (this.onControlMessage) {
          this.onControlMessage(msg);
        }
      } catch (_) {}
    };
  }

  /**
   * Initiator creates and sends the WebRTC SDP offer.
   */
  async createAndSendOffer() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal(this.remotePeerId, 'offer', this.pc.localDescription);
    } catch (err) {
      console.error('[Transport] createOffer error:', err);
    }
  }

  /**
   * Handles incoming signaling messages (offer, answer, candidate).
   */
  async handleSignal(signalType, signalData) {
    if (!this.pc) return;

    try {
      if (signalType === 'offer') {
        if (this.pc.signalingState !== 'stable') {
          // If already in another state, ignore duplicate or racing offer
          return;
        }
        await this.pc.setRemoteDescription(new RTCSessionDescription(signalData));
        await this.flushPendingIceCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal(this.remotePeerId, 'answer', this.pc.localDescription);
      } else if (signalType === 'answer') {
        if (this.pc.signalingState !== 'have-local-offer') {
          // If not waiting for an answer (e.g. already stable), ignore duplicate answer
          return;
        }
        await this.pc.setRemoteDescription(new RTCSessionDescription(signalData));
        await this.flushPendingIceCandidates();
      } else if (signalType === 'candidate') {
        if (signalData) {
          if (!this.pc.remoteDescription) {
            // Buffer candidate if remoteDescription has not resolved yet
            this.pendingIceCandidates.push(signalData);
          } else {
            await this.pc.addIceCandidate(new RTCIceCandidate(signalData));
          }
        }
      }
    } catch (err) {
      console.warn(`[Transport] handleSignal warning (${signalType}):`, err.message);
    }
  }

  async flushPendingIceCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingIceCandidates.length > 0) {
      const cand = this.pendingIceCandidates.shift();
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (_) {}
    }
  }

  /**
   * FIX-E: Send binary data with byte-bounded, age-bounded backpressure queue.
   *
   * Changes from pre-fix:
   * 1. Queue is bounded by BOTH packet count AND total bytes.
   * 2. Each entry tracks its enqueue timestamp for age-based eviction.
   * 3. If the oldest queued entry is older than MAX_PENDING_QUEUE_AGE_MS, the
   *    queue is flushed (peer is irrecoverably behind) so it can re-bootstrap.
   * 4. This prevents one slow viewer from silently accumulating a 60s backlog
   *    while other children receive stale data.
   */
  sendBinary(arrayBuffer) {
    if (!this.mediaChannel || this.mediaChannel.readyState !== 'open') {
      return false;
    }

    // Check if oldest queued entry is too old → peer is severely behind.
    // Drop the queue so the peer falls back to bootstrap recovery rather than
    // playing minutes of stale video after the queue finally drains.
    if (this.pendingQueue.length > 0) {
      const oldestAge = Date.now() - this.pendingQueue[0].queuedAt;
      if (oldestAge > MAX_PENDING_QUEUE_AGE_MS) {
        console.warn(`[Transport] Peer ${this.remotePeerId.slice(-8)} queue age ${oldestAge}ms > ${MAX_PENDING_QUEUE_AGE_MS}ms limit. Flushing stale backlog.`);
        this.pendingQueue = [];
        this.pendingQueueBytes = 0;
        this.isBackpressured = false;
        // Don't send new data either — let the peer re-bootstrap from watchdog
        return false;
      }
    }

    // Never overtake packets already queued for this ordered channel.
    if (this.pendingQueue.length > 0 || this.mediaChannel.bufferedAmount > MAX_BUFFERED_AMOUNT_HIGH) {
      this.isBackpressured = true;
      // FIX-E: Enforce BOTH packet count AND byte ceiling
      if (this.pendingQueue.length < MAX_PENDING_QUEUE_PACKETS && this.pendingQueueBytes < MAX_PENDING_QUEUE_BYTES) {
        this.pendingQueue.push({ buf: arrayBuffer, queuedAt: Date.now() });
        this.pendingQueueBytes += arrayBuffer.byteLength;
      } else {
        const now = Date.now();
        if (!this._lastQueueFullLog || now - this._lastQueueFullLog > 2000) {
          this._lastQueueFullLog = now;
          console.warn(`[Transport] Queue full on ${this.remotePeerId.slice(-8)}: ${this.pendingQueue.length} pkts / ${(this.pendingQueueBytes/1024).toFixed(0)}KB`);
        }
      }
      return false;
    }

    return this.sendBinaryNow(arrayBuffer);
  }

  sendBinaryNow(arrayBuffer) {
    try {
      this.mediaChannel.send(arrayBuffer);
      this.stats.bytesSent += arrayBuffer.byteLength;
      this.stats.packetsSent++;
      return true;
    } catch (err) {
      console.warn('[Transport] send error:', err.message);
      return false;
    }
  }

  flushPendingQueue() {
    if (!this.mediaChannel || this.mediaChannel.readyState !== 'open') return;

    while (
      this.pendingQueue.length > 0 &&
      this.mediaChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT_HIGH
    ) {
      const entry = this.pendingQueue[0];
      // FIX-E: Age check on flush too — drop entire backlog if stale
      if (Date.now() - entry.queuedAt > MAX_PENDING_QUEUE_AGE_MS) {
        console.warn(`[Transport] Flushing stale queue on ${this.remotePeerId.slice(-8)} (${this.pendingQueue.length} packets)`);
        this.pendingQueue = [];
        this.pendingQueueBytes = 0;
        break;
      }
      this.pendingQueue.shift();
      this.pendingQueueBytes -= entry.buf.byteLength;
      if (!this.sendBinaryNow(entry.buf)) {
        break;
      }
    }

    this.isBackpressured = this.pendingQueue.length > 0 || this.mediaChannel.bufferedAmount > MAX_BUFFERED_AMOUNT_HIGH;
  }

  /**
   * Send control message (JSON).
   */
  sendControl(obj) {
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      try {
        this.controlChannel.send(JSON.stringify(obj));
        return true;
      } catch (_) {}
    }
    return false;
  }

  isOpen() {
    return this.mediaChannel && this.mediaChannel.readyState === 'open';
  }

  async measureStats() {
    if (!this.pc || typeof this.pc.getStats !== 'function') return this.stats;
    try {
      const reports = await this.pc.getStats();
      reports.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (typeof report.currentRoundTripTime === 'number') {
            this.stats.rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        }
      });
    } catch (_) {}
    return this.stats;
  }

  cleanup() {
    // Detach all callbacks first so tear-down does not trigger false disconnect loops
    this.onStateChange = null;
    this.onBinaryMessage = null;
    this.onControlMessage = null;

    if (this.mediaChannel) {
      try {
        this.mediaChannel.onopen = null;
        this.mediaChannel.onclose = null;
        this.mediaChannel.onerror = null;
        this.mediaChannel.onmessage = null;
        this.mediaChannel.close();
      } catch (_) {}
      this.mediaChannel = null;
    }
    if (this.controlChannel) {
      try {
        this.controlChannel.onmessage = null;
        this.controlChannel.close();
      } catch (_) {}
      this.controlChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.ondatachannel = null;
        this.pc.close();
      } catch (_) {}
      this.pc = null;
    }
    this.pendingQueue = [];      // Reset queue (entries are {buf, queuedAt})
    this.pendingQueueBytes = 0;
    this.pendingIceCandidates = [];
    this.state = 'closed';
  }
}

