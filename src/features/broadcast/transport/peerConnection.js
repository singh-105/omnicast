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
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
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
    const rawUrls = import.meta.env.VITE_TURN_URL;
    const urls = rawUrls.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) {
      baseConfig.iceServers.push({
        urls,
        username: import.meta.env.VITE_TURN_USERNAME || '',
        credential: import.meta.env.VITE_TURN_PASSWORD || '',
      });
    }
  }

  return baseConfig;
}

// Backpressure thresholds for RTCDataChannel (128KB low mark, 1MB high mark)
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024; // 256 KB
export const MAX_BUFFERED_AMOUNT_HIGH = 1024 * 1024;     // 1024 KB (1 MB)
export const MAX_PENDING_QUEUE_PACKETS = 256;

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
    this.pendingQueue = [];
    this.pendingQueueBytes = 0;
    this.pendingIceCandidates = [];
    this._ownerCleanup = false;
    this._hasSynced = false;
    this.iceConnectTimer = null;
    this.selectedCandidateType = 'unknown';
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      packetsSent: 0,
      packetsReceived: 0,
      rttMs: 0,
      selectedCandidateType: 'unknown',
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
      if (!this._ownerCleanup && this.onStateChange) {
        this.onStateChange(this.state);
      }

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
      this.clearIceConnectTimeout();
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
      if (!this._ownerCleanup && this.onStateChange) {
        this.onStateChange('closed');
      }
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
   * Send binary data packet over the media DataChannel with backpressure queueing.
   */
  sendBinary(arrayBuffer) {
    if (!this.mediaChannel || this.mediaChannel.readyState !== 'open') {
      return false;
    }

    // Never overtake packets already queued for this ordered channel. Doing
    // so lets a newly arrived chunk pass an older bootstrap/gap-recovery
    // packet and makes the receiver's reorder queue stall indefinitely.
    if (this.pendingQueue.length > 0 || this.mediaChannel.bufferedAmount > MAX_BUFFERED_AMOUNT_HIGH) {
      this.isBackpressured = true;
      if (this.pendingQueue.length >= MAX_PENDING_QUEUE_PACKETS) {
        this.dropOldestLogicalChunk();
      }
      this.pendingQueue.push(arrayBuffer);
      this.pendingQueueBytes += arrayBuffer.byteLength;

      // Always attempt to drain if channel has available capacity or schedule immediate drain
      if (this.mediaChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT_HIGH) {
        this.flushPendingQueue();
      } else if (!this._drainTimer) {
        this._drainTimer = setTimeout(() => {
          this._drainTimer = null;
          this.flushPendingQueue();
        }, 15);
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
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    if (!this.mediaChannel || this.mediaChannel.readyState !== 'open') return;

    while (
      this.pendingQueue.length > 0 &&
      this.mediaChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT_HIGH
    ) {
      const buf = this.pendingQueue.shift();
      this.pendingQueueBytes -= buf.byteLength;
      if (!this.sendBinaryNow(buf)) {
        // If sending threw or failed, restore to head of queue
        this.pendingQueue.unshift(buf);
        this.pendingQueueBytes += buf.byteLength;
        break;
      }
    }

    this.isBackpressured = this.pendingQueue.length > 0 || this.mediaChannel.bufferedAmount > MAX_BUFFERED_AMOUNT_HIGH;

    // Safety fallback: if items remain in queue because buffer is saturated, schedule drain check
    if (this.pendingQueue.length > 0 && !this._drainTimer) {
      this._drainTimer = setTimeout(() => {
        this._drainTimer = null;
        this.flushPendingQueue();
      }, 15);
    }
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

  dropOldestLogicalChunk() {
    if (this.pendingQueue.length === 0) return;
    let targetSeq = null;
    for (const buf of this.pendingQueue) {
      if (buf.byteLength >= 11) {
        const view = new DataView(buf);
        const type = view.getUint8(5);
        const flags = view.getUint8(6);
        const isInit = type === 0x01;
        const isKeyframe = (flags & 0x01) !== 0;
        if (!isInit && !isKeyframe) {
          targetSeq = view.getUint32(7);
          break;
        }
      }
    }

    if (targetSeq === null && this.pendingQueue[0].byteLength >= 11) {
      targetSeq = new DataView(this.pendingQueue[0]).getUint32(7);
    }

    if (targetSeq !== null) {
      const remaining = [];
      let droppedBytes = 0;
      let droppedCount = 0;
      for (const buf of this.pendingQueue) {
        let seq = null;
        if (buf.byteLength >= 11) {
          seq = new DataView(buf).getUint32(7);
        }
        if (seq === targetSeq) {
          droppedBytes += buf.byteLength;
          droppedCount++;
        } else {
          remaining.push(buf);
        }
      }
      this.pendingQueue = remaining;
      this.pendingQueueBytes = Math.max(0, this.pendingQueueBytes - droppedBytes);
      console.warn(`[Transport] Backpressure drop: purged logical chunk seq=${targetSeq} (${droppedCount} frags, ${droppedBytes}B) on ${this.remotePeerId.slice(-8)}`);
      this._hasSynced = false;
      if (this.onBackpressureDrop) {
        this.onBackpressureDrop(targetSeq);
      }
    } else {
      const dropped = this.pendingQueue.shift();
      this.pendingQueueBytes = Math.max(0, this.pendingQueueBytes - dropped.byteLength);
      this._hasSynced = false;
    }
  }

  startIceConnectTimeout(onTimeout) {
    this.clearIceConnectTimeout();
    this.iceConnectTimer = setTimeout(() => {
      this.iceConnectTimer = null;
      if (!this.isOpen()) {
        console.warn(`[Transport] 15s ICE connect timeout reached for ${this.remotePeerId.slice(-8)}`);
        if (onTimeout) onTimeout();
      }
    }, 15000);
  }

  clearIceConnectTimeout() {
    if (this.iceConnectTimer) {
      clearTimeout(this.iceConnectTimer);
      this.iceConnectTimer = null;
    }
  }

  async measureStats() {
    if (!this.pc || typeof this.pc.getStats !== 'function') return this.stats;
    try {
      const reports = await this.pc.getStats();
      let activePair = null;
      const candidates = new Map();
      reports.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
          activePair = report;
          if (typeof report.currentRoundTripTime === 'number') {
            this.stats.rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        } else if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, report);
        }
      });
      if (activePair) {
        const local = candidates.get(activePair.localCandidateId);
        const remote = candidates.get(activePair.remoteCandidateId);
        if (local && remote) {
          this.selectedCandidateType = `${local.candidateType} -> ${remote.candidateType}`;
          this.stats.selectedCandidateType = this.selectedCandidateType;
        }
      }
    } catch (_) {}
    return this.stats;
  }

  cleanup() {
    this._ownerCleanup = true;
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    this.clearIceConnectTimeout();
    this.onBinaryMessage = null;
    this.onControlMessage = null;
    this.onStateChange = null;

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
    this.pendingQueue = [];
    this.pendingQueueBytes = 0;
    this.pendingIceCandidates = [];
    this.state = 'closed';
  }
}

