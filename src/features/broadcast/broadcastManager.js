/**
 * OmniCast Client Broadcast & Relay Manager
 *
 * Implements:
 * - PeerLink native WebRTC DataChannel transport (strictly zero centralized media forwarding).
 * - Multi-tier tree-mesh forwarding (Origin -> Tier 1 Relays -> Tier 2 Relays -> Leaf Viewers).
 * - Periodic keyframe epochs (MediaRecorder clean EBML init headers every 8s).
 * - Non-contiguous ring buffer retention ensuring late joiners and downstream relays get clean stream bootstrapping.
 * - Outgoing DataChannel backpressure management with chunk-level sequence dropping.
 * - SourceBuffer QuotaExceeded eviction and keyframe stall recovery timeouts.
 * - Exponential WebSocket backoff reconnection.
 * - 15-second ICE connect timeout reporting to topology coordinator.
 * - Origin ECDSA P-256 cryptographic authenticity verification.
 */

import { generateBroadcasterKeyPair, signChunk, verifyChunk, exportPublicKeyInfo, importPublicKey } from './crypto/signatures.js';
import { StreamCapture } from './capture/streamCapture.js';
import { MsePlayer } from './playback/msePlayer.js';
import { MediaRingBuffer } from './protocol/ringBuffer.js';
import { SequenceReorderQueue } from './protocol/ringBuffer.js';
import {
  fragmentChunk,
  PacketType,
  PacketFlags,
  deserializePacket,
  PacketReassembler,
} from './protocol/framing.js';
import { PeerLink } from './transport/peerConnection.js';

export class BroadcastManager {
  constructor({
    signalingUrl = null,
    onStateChange = null,
    onMetrics = null,
    onError = null,
    onStreamChanged = null,
    onBroadcastAnnounced = null,
    onBroadcastEnded = null,
  } = {}) {
    this.signalingUrl = signalingUrl || this.getDefaultSignalingUrl();
    this.onStateChange = onStateChange;
    this.onMetrics = onMetrics;
    this.onError = onError;
    this.onStreamChanged = onStreamChanged;
    this.onBroadcastAnnounced = onBroadcastAnnounced;
    this.onBroadcastEnded = onBroadcastEnded;
    this.ws = null;
    this.localPeerId = 'p' + Math.random().toString(36).substring(2, 9);
    this.role = 'idle'; // 'idle' | 'broadcaster' | 'viewer'
    this.broadcastId = null;
    this.tier = null;
    this.destroyed = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._lastRelayLog = 0;

    // Cryptographic Origin Identity (ECDSA P-256)
    this.keyPair = null;
    this.originPublicKey = null;
    this.originFingerprint = null;

    // Media & Playback Subsystems
    this.streamCapture = null;
    this.msePlayer = null;
    this.videoElement = null;
    this.streamMimeType = 'video/webm; codecs="vp8,opus"';

    // Bounded Ring Buffer & Sequence Control
    this.ringBuffer = new MediaRingBuffer({ maxItems: 240, maxDurationMs: 30000 });
    this.reassembler = new PacketReassembler(4000);
    this.reorderQueue = null;

    // WebRTC Peer Links (native RTCDataChannel)
    this.parentLink = null;
    this.children = new Map(); // childPeerId -> PeerLink
    this.standbyLinks = new Map(); // standbyPeerId -> PeerLink
    this.standbyCandidateIds = [];

    // Queue for processing
    this.originChunkQueue = [];
    this.isProcessingOriginChunks = false;
    this.incomingPacketQueue = [];
    this.isProcessingIncomingPackets = false;
    this.lastInitSequence = null;
    this.upstreamWatchdogTimer = null;
    this.lastPacketAt = 0;
    this.bootstrapRetryCount = 0;

    // Metrics & Telemetry
    this.metrics = {
      role: 'idle',
      tier: null,
      parentPeerId: null,
      activeChildren: 0,
      viewerCount: 0,
      bitrateKbps: 0,
      parentRtt: 0,
      liveLatencyMs: 0,
      bytesReceived: 0,
      bytesSent: 0,
      chunksEmitted: 0,
      chunksReceived: 0,
      chunksForwarded: 0,
      droppedChunks: 0,
      tamperedChunksDropped: 0,
      failovers: 0,
      captureFps: 0,
      decodedFps: 0,
      bufferDepthSecs: 0,
      droppedFrames: 0,
      totalFrames: 0,
      fingerprint: null,
      childLinks: [],
      lastPacketAtAgeMs: null,
      waitingForKeyframe: false,
      gapsSkipped: 0,
      selectedCandidateType: 'none',
    };
    this.metricsTimer = null;
    this.lastBytesReceived = 0;
    this.lastBytesSent = 0;

    this.pendingWsMessages = [];
  }

  getDefaultSignalingUrl() {
    if (typeof window === 'undefined') return 'ws://127.0.0.1:10000/signaling';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/signaling`;
  }

  /**
   * Connect to the signaling server with exponential backoff.
   */
  async connectSignaling() {
    this._reconnectAttempts = 0;
    return this._doConnectSignaling();
  }

  _doConnectSignaling() {
    return new Promise((resolve, reject) => {
      let isResolved = false;
      this.ws = new WebSocket(this.signalingUrl);

      this.ws.onopen = () => {
        this._reconnectAttempts = 0;
        console.log(`📡 Connected to OmniCast signaling server as ${this.localPeerId}`);

        // Announce identity and capabilities
        this.ws.send(JSON.stringify({
          type: 'announce',
          peerId: this.localPeerId,
          capabilities: this.getPeerCapabilities(),
        }));

        // Flush any messages queued before WebSocket finished opening
        while (this.pendingWsMessages.length > 0) {
          const msg = this.pendingWsMessages.shift();
          try {
            this.ws.send(JSON.stringify(msg));
          } catch (_) {}
        }

        this.startMetricsLoop();
        isResolved = true;
        resolve(this.localPeerId);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleSignalingMessage(msg);
        } catch (e) {
          console.warn('[BroadcastManager] Invalid signaling message:', e.message);
        }
      };

      this.ws.onerror = (err) => {
        if (!isResolved) {
          isResolved = true;
          reject(err);
        }
      };

      this.ws.onclose = () => {
        console.log('[BroadcastManager] Signaling closed');
        if (!this.destroyed && this._reconnectAttempts < 6) {
          const delay = Math.min(8000, 500 * Math.pow(2, this._reconnectAttempts));
          this._reconnectAttempts++;
          console.log(`[BroadcastManager] Reconnecting signaling in ${delay}ms (attempt ${this._reconnectAttempts}/6)...`);
          this._reconnectTimer = setTimeout(() => {
            if (!this.destroyed) {
              this._doConnectSignaling().catch(() => {});
            }
          }, delay);
        }
      };
    });
  }

  sendWs(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pendingWsMessages.push(msg);
    }
  }

  isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  getPeerCapabilities() {
    const isMobile = this.isMobileDevice();
    return {
      isMobile,
      userRelayPermitted: !isMobile,
    };
  }

  // ──────────────────────────────────────────────────────────
  // BROADCASTER WORKFLOW (Origin)
  // ──────────────────────────────────────────────────────────

  async startBroadcast({ title = 'OmniCast Live Stream', type = 'camera', maxChildren = null, deviceId = null } = {}) {
    this.role = 'broadcaster';
    this.tier = 0;
    this.metrics.tier = 0;
    this.metrics.parentPeerId = null;

    // Generate origin ECDSA P-256 keypair for segment signing
    this.keyPair = await generateBroadcasterKeyPair();
    const pubKeyInfo = await exportPublicKeyInfo(this.keyPair.publicKey);
    this.originFingerprint = pubKeyInfo.fingerprint;
    this.metrics.fingerprint = this.originFingerprint;
    if (this.onMetrics) {
      this.onMetrics({ ...this.metrics });
    }

    // Collision-resistant broadcast ID
    const timePart = Date.now().toString(36).slice(-6);
    const randPart = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 4)
      : Math.random().toString(36).substring(2, 6);
    this.broadcastId = `omni-${timePart}-${randPart}`;

    // Initialize media capture
    this.streamCapture = new StreamCapture({
      targetChunkMs: 500,
      onChunk: (chunk) => this.handleOriginChunk(chunk),
      onError: (err) => {
        console.error('[BroadcastManager] Capture error:', err);
        if (this.onError) this.onError(err);
      },
      onStop: () => this.stopBroadcast(),
      onSourceReverted: (newType, newStream) => {
        if (this.onStreamChanged) {
          this.onStreamChanged(newStream, newType);
        }
      },
    });

    let captureResult;
    if (type === 'screen') {
      captureResult = await this.streamCapture.startScreen({ withMic: true });
    } else {
      captureResult = await this.streamCapture.startCamera({ video: true, audio: true, deviceId });
    }

    this.streamMimeType = captureResult.mimeType;

    // Register broadcast session with topology coordinator
    this.sendWs({
      type: 'broadcast:create',
      broadcastId: this.broadcastId,
      title,
      originPubKey: pubKeyInfo.spkiBase64,
      mimeType: this.streamMimeType,
      maxChildren,
    });

    this.updateState('streaming');
    return {
      broadcastId: this.broadcastId,
      stream: captureResult.stream,
      fingerprint: this.originFingerprint,
    };
  }

  async switchSource({ type = 'camera', deviceId = null, forceReselect = false } = {}) {
    if (!this.streamCapture) {
      throw new Error('No active stream capture to switch');
    }
    const result = await this.streamCapture.switchSource({ type, deviceId, forceReselect });
    if (!result) return null;

    if (this.onStreamChanged) {
      this.onStreamChanged(result.stream, result.type);
    }
    return result;
  }

  hasSystemAudio() {
    return Boolean(this.streamCapture?.hasSystemAudio);
  }

  getAudioLevel() {
    return this.streamCapture ? this.streamCapture.getAudioLevel() : 0;
  }

  setMicMuted(muted) {
    if (this.streamCapture) {
      this.streamCapture.setMicMuted(muted);
    }
  }

  handleOriginChunk(chunk) {
    if (this.role !== 'broadcaster' || !chunk) return;
    this.originChunkQueue.push(chunk);
    void this.processOriginChunkQueue();
  }

  async processOriginChunkQueue() {
    if (this.isProcessingOriginChunks) return;
    this.isProcessingOriginChunks = true;
    try {
      while (this.role === 'broadcaster' && this.originChunkQueue.length > 0) {
        const chunk = this.originChunkQueue.shift();
        await this.processOriginChunk(chunk);
      }
    } finally {
      this.isProcessingOriginChunks = false;
    }
  }

  async processOriginChunk(chunk) {
    if (this.role !== 'broadcaster') return;

    this.metrics.chunksEmitted++;
    if (this.onMetrics) {
      this.onMetrics({ ...this.metrics });
    }

    // Sign the logical chunk using Origin ECDSA P-256 private key
    const isInitChunk = Boolean(chunk.isInit);
    const signature = await signChunk(this.keyPair.privateKey, {
      sessionId: this.broadcastId,
      sequence: chunk.sequence,
      timestamp: chunk.timestamp,
      type: isInitChunk ? PacketType.INIT_SEGMENT : PacketType.MEDIA_CHUNK,
      flags: isInitChunk ? PacketFlags.NONE : (chunk.isKeyframe ? PacketFlags.KEYFRAME : PacketFlags.NONE),
      payload: chunk.payload,
    });

    chunk.signature = signature;
    chunk.type = isInitChunk ? PacketType.INIT_SEGMENT : PacketType.MEDIA_CHUNK;

    // Cache initialization segment and verified chunk with signature attached
    if (chunk.isInit) {
      this.ringBuffer.setInitSegment(chunk);
    }
    this.ringBuffer.add(chunk);

    // Fragment chunk into transport-safe packets (≤ 48 KB)
    const packets = fragmentChunk({
      type: isInitChunk ? PacketType.INIT_SEGMENT : PacketType.MEDIA_CHUNK,
      isKeyframe: isInitChunk ? false : Boolean(chunk.isKeyframe),
      sequence: chunk.sequence,
      timestamp: chunk.timestamp,
      sessionId: this.broadcastId,
      signature,
      chunkPayload: chunk.payload,
    });

    // 1. Sync any newly connected children that were waiting for bootstrap keyframe
    for (const [, childLink] of this.children) {
      if (childLink.isOpen() && !childLink._hasSynced) {
        this.syncChildWithStream(childLink);
      }
    }

    // 2. Distribute binary packets directly to all downstream child DataChannels that are synced
    for (const [, childLink] of this.children) {
      if (childLink.isOpen() && childLink._hasSynced) {
        if (typeof childLink._lastSyncedSeq === 'number' && chunk.sequence <= childLink._lastSyncedSeq) {
          continue; // Already dispatched during syncChildWithStream
        }
        try {
          for (const packet of packets) {
            childLink.sendBinary(packet);
          }
        } catch (err) {
          console.warn(`[BroadcastManager] Failed to send packet to child ${childLink.remotePeerId.slice(-8)}:`, err.message);
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // VIEWER & RELAY WORKFLOW
  // ──────────────────────────────────────────────────────────

  async joinBroadcast({ broadcastId, videoElement }) {
    this.role = 'viewer';
    this.broadcastId = broadcastId;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectSignaling().catch(() => {});
    }
    this.startMetricsLoop();

    // Set up reorder queue for sequential playback
    this.reorderQueue = new SequenceReorderQueue({
      onEmit: (chunk) => this.renderChunk(chunk),
      onGap: (fromSeq, toSeq) => this.requestRetransmit(fromSeq, toSeq),
      onGapSkipped: (fromSeq, toSeq) => {
        if (this.msePlayer) {
          this.msePlayer.onGapOccurred();
        }
        if (this.parentLink && this.parentLink.isOpen()) {
          this.parentLink.sendControl({ type: 'bootstrap-req' });
        }
      },
    });

    // Request tree assignment from topology coordinator
    this.sendWs({
      type: 'broadcast:join',
      broadcastId,
      capabilities: this.getPeerCapabilities(),
    });

    this.videoElement = videoElement;
    this.updateState('connecting');
  }

  /**
   * Handle assignment received from Topology Coordinator.
   */
  async handleTopologyAssigned(msg) {
    const { parentPeerId, standbyParents, tier, originPubKey, mimeType } = msg;
    this.tier = tier;
    this.metrics.tier = tier;
    this.metrics.parentPeerId = parentPeerId;
    if (this.onMetrics) {
      this.onMetrics({ ...this.metrics });
    }
    this.standbyCandidateIds = standbyParents || [];
    this.streamMimeType = mimeType || this.streamMimeType;

    // Import origin public key for verifying media authenticity
    if (originPubKey && !this.originPublicKey) {
      try {
        this.originPublicKey = await importPublicKey(originPubKey);
        const info = await exportPublicKeyInfo(this.originPublicKey);
        this.originFingerprint = info.fingerprint;
        this.metrics.fingerprint = this.originFingerprint;
      } catch (e) {
        console.error('[BroadcastManager] Failed to import origin public key:', e);
      }
    }

    // Initialize MSE Player with the broadcast's codec format
    this.createMsePlayer();

    // Connect to active upstream parent via WebRTC DataChannel
    this.connectToParent(parentPeerId);

    // Warm up standby connections if candidates available
    this.prepareStandbys();
    this.startUpstreamWatchdog();

    this.updateState('streaming');
  }

  connectToParent(parentPeerId) {
    if (this.parentLink) {
      if (this.parentLink.remotePeerId === parentPeerId && this.parentLink.isOpen()) {
        return; // Already actively connected to this parent
      }
      const oldLink = this.parentLink;
      this.parentLink = null;
      oldLink.cleanup();
    }

    console.log(`🔗 Connecting WebRTC upstream to parent ${parentPeerId.slice(-8)}`);

    this.parentLink = new PeerLink({
      remotePeerId: parentPeerId,
      broadcastId: this.broadcastId,
      isInitiator: true, // child dials parent
      sendSignal: (toPeerId, type, data) => this.sendSignalRelay(toPeerId, type, data),
      onBinaryMessage: (buf) => this.handleIncomingBinary(buf),
      onControlMessage: (ctrl) => this.handleParentControlMessage(ctrl),
      onStateChange: (state) => {
        if (state === 'open') {
          console.log(`[BroadcastManager] Upstream DataChannel to parent ${parentPeerId.slice(-8)} is OPEN!`);
          this.updateState('streaming');
        }
        if (state === 'closed' || state === 'failed') {
          console.warn(`[BroadcastManager] Parent connection lost! Triggering failover...`);
          this.updateState('reconnecting');
          this.triggerFailover();
        }
      },
    });

    // 15-second ICE connect timeout
    this.parentLink.startIceConnectTimeout(() => {
      console.warn(`[BroadcastManager] Parent connection ICE timeout (15s), reporting link failed`);
      this.sendWs({
        type: 'topology:link-failed',
        broadcastId: this.broadcastId,
        failedParentPeerId: parentPeerId,
      });
      this.triggerFailover();
    });

    this.parentLink.createAndSendOffer();
  }

  prepareStandbys() {
    for (const standbyId of this.standbyCandidateIds.slice(0, 2)) {
      if (!this.standbyLinks.has(standbyId) && standbyId !== this.metrics.parentPeerId) {
        const link = new PeerLink({
          remotePeerId: standbyId,
          broadcastId: this.broadcastId,
          isInitiator: false,
          sendSignal: (toPeerId, type, data) => this.sendSignalRelay(toPeerId, type, data),
          onBinaryMessage: (buf) => this.handleIncomingBinary(buf),
        });
        this.standbyLinks.set(standbyId, link);
      }
    }
  }

  startUpstreamWatchdog() {
    if (this.upstreamWatchdogTimer) clearInterval(this.upstreamWatchdogTimer);
    this.lastPacketAt = Date.now();
    this.bootstrapRetryCount = 0;

    this.upstreamWatchdogTimer = setInterval(() => {
      if (this.role !== 'viewer' || !this.broadcastId) return;
      if (!this.parentLink) return;
      const silentMs = Date.now() - this.lastPacketAt;
      if (silentMs < 7000) return;

      this.bootstrapRetryCount++;
      if (this.parentLink.isOpen()) {
        this.parentLink.sendControl({ type: 'bootstrap-req' });
      }

      if (silentMs > 12000) {
        this.updateState('reconnecting');
      }

      if (this.bootstrapRetryCount >= 4 || silentMs > 18000) {
        console.warn(`[BroadcastManager] Upstream watchdog: ${silentMs}ms silent, triggering failover...`);
        this.bootstrapRetryCount = 0;
        this.lastPacketAt = Date.now();
        this.triggerFailover();
      }
    }, 3000);
  }

  /**
   * Handle incoming binary packet on RTCDataChannel.
   */
  handleIncomingBinary(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) return;
    this.lastPacketAt = Date.now();
    this.bootstrapRetryCount = 0;
    this.incomingPacketQueue.push(arrayBuffer);
    void this.processIncomingPacketQueue();
  }

  createMsePlayer() {
    if (!this.videoElement || this.msePlayer) return;
    this.msePlayer = new MsePlayer({
      videoElement: this.videoElement,
      mimeType: this.streamMimeType,
      onError: (err) => this.onError && this.onError(err),
      onLiveStateChange: (state) => {
        if (this.onLiveStateChange) this.onLiveStateChange(state);
      },
      onNeedBootstrap: () => {
        console.warn('[BroadcastManager] MsePlayer requested bootstrap resync');
        if (this.parentLink && this.parentLink.isOpen()) {
          this.parentLink.sendControl({ type: 'bootstrap-req' });
        }
      },
    });
  }

  resetPlaybackForResync() {
    this.lastInitSequence = null;
    if (this.msePlayer) {
      this.msePlayer.destroy();
      this.msePlayer = null;
    }
    this.reassembler.clear();
    if (this.reorderQueue) this.reorderQueue.reset();
    this.createMsePlayer();
  }

  async processIncomingPacketQueue() {
    if (this.isProcessingIncomingPackets) return;
    this.isProcessingIncomingPackets = true;
    try {
      while (this.incomingPacketQueue.length > 0) {
        const packetBuffer = this.incomingPacketQueue.shift();
        await this.processIncomingBinary(packetBuffer);
      }
    } finally {
      this.isProcessingIncomingPackets = false;
    }
  }

  async processIncomingBinary(arrayBuffer) {
    this.metrics.bytesReceived += arrayBuffer.byteLength;

    try {
      const packet = deserializePacket(arrayBuffer);

      // Ingest fragment into reassembler with raw packet buffer preserved
      const completeChunk = this.reassembler.ingest(packet, arrayBuffer);
      if (!completeChunk) {
        return; // waiting for remaining fragments
      }

      this.metrics.chunksReceived++;
      this.bootstrapRetryCount = 0;

      // Verify origin ECDSA P-256 signature before playback or forwarding
      if (this.originPublicKey) {
        const isValid = await verifyChunk(this.originPublicKey, completeChunk);
        if (!isValid) {
          this.metrics.tamperedChunksDropped++;
          console.warn(`[Security] Dropped forged/tampered chunk ${completeChunk.sequence}!`);
          return;
        }
      }

      // Calculate glass-to-glass latency estimate
      if (completeChunk.timestamp) {
        const diff = Date.now() - completeChunk.timestamp;
        if (diff >= 0 && diff < 8000) {
          this.metrics.liveLatencyMs = diff;
        } else if (this.msePlayer) {
          this.metrics.liveLatencyMs = Math.round(this.msePlayer.getPlaybackStats().bufferDepthSecs * 1000);
        }
      }

      // Save verified chunk in local ring buffer
      if (completeChunk.type === PacketType.INIT_SEGMENT) {
        this.ringBuffer.setInitSegment(completeChunk);
      }
      this.ringBuffer.add(completeChunk);

      // ── CASCADE FORWARDING: Forward all verified wire packets to downstream children ──
      if (completeChunk.rawPackets && completeChunk.rawPackets.length > 0) {
        for (const raw of completeChunk.rawPackets) {
          this.forwardToChildren(raw, completeChunk.sequence);
        }
      } else {
        this.forwardToChildren(arrayBuffer, completeChunk.sequence);
      }

      // If this was an init segment or keyframe, sync any children that were waiting
      if (completeChunk.type === PacketType.INIT_SEGMENT || completeChunk.isKeyframe) {
        for (const [, childLink] of this.children) {
          if (childLink.isOpen() && !childLink._hasSynced) {
            this.syncChildWithStream(childLink);
          }
        }
      }

      // Push to reorder queue for local playback
      if (completeChunk.type === PacketType.INIT_SEGMENT) {
        if (this.lastInitSequence === completeChunk.sequence) {
          return; // Skip duplicate init segment to protect SourceBuffer against demuxer abort
        }
        this.lastInitSequence = completeChunk.sequence;
        if (this.reorderQueue) {
          this.reorderQueue.reset();
        }
        this.renderChunk(completeChunk);
      } else if (this.reorderQueue) {
        this.reorderQueue.push(completeChunk);
      }
    } catch (err) {
      console.warn('[BroadcastManager] Packet error:', err.message);
    }
  }

  renderChunk(chunk) {
    if (this.msePlayer) {
      this.msePlayer.appendChunk(
        chunk.payload,
        chunk.type === PacketType.INIT_SEGMENT,
        Boolean(chunk.isKeyframe)
      );
    }
  }

  /**
   * Forwards incoming verified binary chunk to all active downstream children.
   */
  forwardToChildren(arrayBuffer, chunkSeq = null) {
    if (this.children.size === 0) return;

    // Throttled debug log per relay hop
    if (!this._lastRelayLog || Date.now() - this._lastRelayLog > 1000) {
      this._lastRelayLog = Date.now();
      for (const [childId, childLink] of this.children) {
        console.debug(`[Relay] relay forward seq=${chunkSeq} to child ${childId.slice(-8)} (synced=${childLink._hasSynced})`);
      }
    }

    for (const [, childLink] of this.children) {
      if (!childLink._hasSynced && childLink.isOpen()) {
        this.syncChildWithStream(childLink);
      }

      if (childLink.isOpen() && childLink._hasSynced) {
        if (typeof chunkSeq === 'number' && typeof childLink._lastSyncedSeq === 'number' && chunkSeq <= childLink._lastSyncedSeq) {
          continue; // Already dispatched during syncChildWithStream
        }
        try {
          const sent = childLink.sendBinary(arrayBuffer);
          if (sent) {
            this.metrics.chunksForwarded++;
            this.metrics.bytesSent += arrayBuffer.byteLength;
          }
        } catch (err) {
          console.warn(`[BroadcastManager] Failed to forward packet to child ${childLink.remotePeerId.slice(-8)}:`, err.message);
        }
      }
    }
  }

  /**
   * Request retransmission from parent when sequence gap detected.
   */
  requestRetransmit(fromSeq, toSeq) {
    if (this.parentLink && this.parentLink.isOpen()) {
      this.parentLink.sendControl({
        type: 'retransmit-req',
        fromSeq,
        toSeq,
      });
      this.metrics.droppedChunks += (toSeq - fromSeq + 1);
    }
  }

  handleParentControlMessage(msg) {
    if (msg.type === 'heartbeat') {
      if (this.parentLink && this.parentLink.isOpen()) {
        this.parentLink.sendControl({ type: 'heartbeat-ack', timestamp: msg.timestamp });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // DOWNSTREAM CHILD MANAGEMENT (Relay Parent Mode)
  // ──────────────────────────────────────────────────────────

  handleChildAssigned(childPeerId) {
    console.log(`👶 Child peer ${childPeerId.slice(-8)} assigned to us`);

    // Prepare receiver link for child
    if (!this.children.has(childPeerId)) {
      const childLink = new PeerLink({
        remotePeerId: childPeerId,
        broadcastId: this.broadcastId,
        isInitiator: false, // parent receives offer from child
        sendSignal: (toPeerId, type, data) => this.sendSignalRelay(toPeerId, type, data),
        onControlMessage: (ctrl) => this.handleChildControlMessage(childPeerId, ctrl),
        onStateChange: (state) => {
          if (state === 'open') {
            this.syncChildWithStream(childLink);
          }
          if (state === 'closed' || state === 'failed') {
            this.children.delete(childPeerId);
            this.metrics.activeChildren = this.children.size;
          }
        },
      });

      this.children.set(childPeerId, childLink);
      this.metrics.activeChildren = this.children.size;

      // Fallback check in case child opened before listener attached
      const checkAndSendInit = setInterval(() => {
        if (childLink.isOpen()) {
          clearInterval(checkAndSendInit);
          this.syncChildWithStream(childLink);
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkAndSendInit);
        if (childLink.isOpen() && !childLink._hasSynced) {
          this.syncChildWithStream(childLink);
        }
      }, 500);
    }
  }

  /**
   * Sends the stream initialization segment and recent keyframe chunks
   * to a newly connected child so it can start decoding video immediately.
   * Only marks child as synced if both init segment and keyframe are sent.
   */
  syncChildWithStream(childLink) {
    if (!childLink || !childLink.isOpen() || childLink._hasSynced) return false;

    const initSeg = this.ringBuffer.getInitSegment();
    const recentChunks = this.ringBuffer.getSinceLatestKeyframe();

    // If init segment or keyframe is not ready yet, wait until one is available
    if (!initSeg || recentChunks.length === 0 || !recentChunks.some((chunk) => chunk.isKeyframe)) {
      return false; // Not ready to sync yet
    }

    childLink._hasSynced = true;
    childLink._lastSyncedSeq = recentChunks[recentChunks.length - 1].sequence;

    // 1. Send initialization segment (EBML header)
    const packets = fragmentChunk({
      type: PacketType.INIT_SEGMENT,
      isKeyframe: false,
      sequence: typeof initSeg.sequence === 'number' ? initSeg.sequence : 0,
      timestamp: initSeg.timestamp,
      sessionId: this.broadcastId,
      signature: initSeg.signature,
      chunkPayload: initSeg.payload,
    });
    for (const p of packets) {
      childLink.sendBinary(p);
    }

    // 2. Send latest keyframe and subsequent chunks from ring buffer for immediate playback
    for (const chunk of recentChunks) {
      if (chunk.isInit || chunk.type === PacketType.INIT_SEGMENT) continue;
      const isInit = Boolean(chunk.isInit || chunk.type === PacketType.INIT_SEGMENT);
      const pkts = fragmentChunk({
        type: isInit ? PacketType.INIT_SEGMENT : PacketType.MEDIA_CHUNK,
        isKeyframe: isInit ? false : Boolean(chunk.isKeyframe),
        sequence: chunk.sequence,
        timestamp: chunk.timestamp,
        sessionId: this.broadcastId,
        signature: chunk.signature,
        chunkPayload: chunk.payload,
      });
      for (const p of pkts) {
        childLink.sendBinary(p);
      }
    }
    return true;
  }

  handleChildControlMessage(childPeerId, msg) {
    if (msg.type === 'bootstrap-req') {
      const childLink = this.children.get(childPeerId);
      if (childLink) {
        childLink._hasSynced = false;
        const synced = this.syncChildWithStream(childLink);
        if (!synced && this.parentLink && this.parentLink.isOpen()) {
          // Cannot satisfy locally yet, pass upstream to origin
          this.parentLink.sendControl({ type: 'bootstrap-req' });
        }
      }
      return;
    }

    if (msg.type === 'retransmit-req') {
      const { fromSeq, toSeq } = msg;
      const childLink = this.children.get(childPeerId);
      if (childLink && childLink.isOpen()) {
        const chunks = this.ringBuffer.getRange(fromSeq, toSeq);
        for (const chunk of chunks) {
          const isInit = Boolean(chunk.isInit || chunk.type === PacketType.INIT_SEGMENT);
          const packets = fragmentChunk({
            type: isInit ? PacketType.INIT_SEGMENT : PacketType.MEDIA_CHUNK,
            isKeyframe: isInit ? false : Boolean(chunk.isKeyframe),
            sequence: chunk.sequence,
            timestamp: chunk.timestamp,
            sessionId: this.broadcastId,
            signature: chunk.signature,
            chunkPayload: chunk.payload,
          });
          for (const p of packets) {
            childLink.sendBinary(p);
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // SELF-HEALING FAILOVER (< 400ms target)
  // ──────────────────────────────────────────────────────────

  async triggerFailover() {
    const startTime = performance.now();
    this.metrics.failovers++;
    this.resetPlaybackForResync();

    if (this.standbyCandidateIds.length > 0) {
      const promotedStandby = this.standbyCandidateIds.shift();
      console.log(`⚡ Instant Failover: Promoting standby parent ${promotedStandby.slice(-8)}`);

      // Inform coordinator of standby promotion
      this.sendWs({
        type: 'topology:promote-standby',
        broadcastId: this.broadcastId,
        standbyPeerId: promotedStandby,
      });

      // Clean up standby link
      const existingStandby = this.standbyLinks.get(promotedStandby);
      if (existingStandby) {
        this.standbyLinks.delete(promotedStandby);
        existingStandby.cleanup();
      }

      // Switch to standby link as active parent
      this.connectToParent(promotedStandby);

      const failoverDurationMs = Math.round(performance.now() - startTime);
      console.log(`⏱️ Failover switch completed in ${failoverDurationMs} ms`);
    } else {
      // Re-join broadcast to get fresh parent assignment
      this.sendWs({
        type: 'broadcast:join',
        broadcastId: this.broadcastId,
        capabilities: this.getPeerCapabilities(),
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  // SIGNALING & COORDINATION DISPATCHER
  // ──────────────────────────────────────────────────────────

  sendSignalRelay(toPeerId, signalType, signalData) {
    this.sendWs({
      type: 'signal:relay',
      toPeerId,
      broadcastId: this.broadcastId,
      signalType,
      signalData,
    });
  }

  handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'broadcast:list-response':
        if (this.onBroadcastsList) this.onBroadcastsList(msg.broadcasts);
        break;

      case 'topology:assigned':
        this.handleTopologyAssigned(msg);
        break;

      case 'topology:child-assigned':
        this.handleChildAssigned(msg.childPeerId);
        break;

      case 'topology:reparent':
        console.log(`🔄 Upstream parent departed, reparenting to ${msg.newParentPeerId.slice(-8)}`);
        this.metrics.parentPeerId = msg.newParentPeerId;
        this.standbyCandidateIds = msg.standbyParents || [];
        this.resetPlaybackForResync();
        this.handleTopologyAssigned({
          ...msg,
          parentPeerId: msg.newParentPeerId,
          mimeType: this.streamMimeType,
        });
        break;

      case 'signal:relay': {
        const { fromPeerId, signalType, signalData } = msg;

        // Is it for our parent connection?
        if (this.parentLink && this.parentLink.remotePeerId === fromPeerId) {
          this.parentLink.handleSignal(signalType, signalData);
          return;
        }

        // Is it for one of our child connections?
        let childLink = this.children.get(fromPeerId);
        if (!childLink && signalType === 'offer' && (this.role === 'broadcaster' || this.role === 'viewer')) {
          this.handleChildAssigned(fromPeerId);
          childLink = this.children.get(fromPeerId);
        }

        if (childLink) {
          childLink.handleSignal(signalType, signalData);
          return;
        }

        // Is it for a standby link?
        const standbyLink = this.standbyLinks.get(fromPeerId);
        if (standbyLink) {
          standbyLink.handleSignal(signalType, signalData);
          return;
        }
        break;
      }

      case 'broadcast:viewer-count':
        this.metrics.viewerCount = msg.viewerCount;
        if (this.onMetrics) {
          this.onMetrics({ ...this.metrics });
        }
        break;

      case 'broadcast:announced':
        if (this.onBroadcastAnnounced) this.onBroadcastAnnounced(msg.broadcast);
        break;

      case 'broadcast:ended':
        console.log('[BroadcastManager] Broadcast has ended:', msg.broadcastId);
        if (this.onBroadcastEnded) this.onBroadcastEnded(msg.broadcastId);
        if (this.broadcastId === msg.broadcastId) {
          this.stopBroadcast();
          this.updateState('ended');
        }
        break;

      case 'signal:failed':
        console.warn(`[BroadcastManager] Signal delivery failed to peer ${msg.targetPeerId}:`, msg.reason);
        if (this.parentLink && this.parentLink.remotePeerId === msg.targetPeerId) {
          this.triggerFailover();
        }
        break;

      case 'error':
        console.warn('[BroadcastManager] Signaling error received:', msg.code, msg.message);
        if (msg.code === 'ROOM_FULL') {
          this.updateState('full', { errorCode: msg.code, errorMessage: msg.message });
        } else if (msg.code === 'JOIN_FAILED') {
          this.updateState('not_found', { errorMessage: msg.message });
        } else {
          this.updateState('error', { errorCode: msg.code, errorMessage: msg.message });
        }
        if (this.onError) this.onError(new Error(msg.message || msg.code));
        break;

      default:
        break;
    }
  }

  startMetricsLoop() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);

    this.metricsTimer = setInterval(async () => {
      // Calculate bitrate
      const bytesNow = this.metrics.bytesReceived;
      const bytesSentNow = this.metrics.bytesSent;
      const deltaBytes = (bytesNow - this.lastBytesReceived) + (bytesSentNow - this.lastBytesSent);
      this.metrics.bitrateKbps = Math.round((deltaBytes * 8) / 1024);
      this.lastBytesReceived = bytesNow;
      this.lastBytesSent = bytesSentNow;

      this.metrics.role = this.role;
      this.metrics.tier = this.tier;
      this.metrics.activeChildren = this.children.size;

      // Measure RTT and candidate stats with parent
      if (this.parentLink) {
        const stats = await this.parentLink.measureStats();
        this.metrics.parentRtt = stats.rttMs;
        this.metrics.selectedCandidateType = stats.selectedCandidateType || this.parentLink.selectedCandidateType || 'unknown';
      } else {
        this.metrics.selectedCandidateType = 'none';
      }

      // Collect real-time video playback quality & decoder telemetry
      if (this.msePlayer) {
        const pStats = this.msePlayer.getPlaybackStats();
        this.metrics.decodedFps = pStats.decodedFps;
        this.metrics.bufferDepthSecs = pStats.bufferDepthSecs;
        if (pStats.quality) {
          this.metrics.droppedFrames = pStats.quality.droppedFrames || 0;
          this.metrics.totalFrames = pStats.quality.totalFrames || 0;
        }
        this.metrics.waitingForKeyframe = Boolean(this.msePlayer.waitingForKeyframe);
      } else {
        this.metrics.waitingForKeyframe = false;
      }

      if (this.reorderQueue) {
        this.metrics.gapsSkipped = this.reorderQueue.gapsSkipped || 0;
      }

      this.metrics.childLinks = Array.from(this.children.entries()).map(([pid, link]) => ({
        peerId: pid,
        open: link.isOpen(),
        hasSynced: Boolean(link._hasSynced),
        queuedPackets: link.pendingQueue ? link.pendingQueue.length : 0,
        candidateType: link.selectedCandidateType || link.stats?.selectedCandidateType || 'unknown',
      }));

      this.metrics.lastPacketAtAgeMs = this.lastPacketAt ? Math.max(0, Date.now() - this.lastPacketAt) : null;

      if (this.streamCapture) {
        this.metrics.captureFps = this.streamCapture.getCaptureFps();
      }

      if (this.onMetrics) {
        this.onMetrics({ ...this.metrics });
      }

      // Send telemetry report to server
      if (this.broadcastId) {
        this.sendWs({
          type: 'telemetry:report',
          broadcastId: this.broadcastId,
          peerId: this.localPeerId,
          stats: { ...this.metrics },
        });
      }
    }, 1000);
  }

  updateState(state, extra = {}) {
    if (this.onStateChange) {
      this.onStateChange(state, { ...this.metrics, ...extra });
    }
  }

  stopBroadcast() {
    if (this.role === 'broadcaster' && this.broadcastId) {
      this.sendWs({
        type: 'broadcast:stop',
        broadcastId: this.broadcastId,
      });
    } else if (this.broadcastId) {
      this.sendWs({
        type: 'broadcast:leave',
        broadcastId: this.broadcastId,
      });
    }

    if (this.streamCapture) {
      this.streamCapture.stop();
      this.streamCapture = null;
    }

    if (this.msePlayer) {
      this.msePlayer.destroy();
      this.msePlayer = null;
    }

    if (this.parentLink) {
      this.parentLink.cleanup();
      this.parentLink = null;
    }

    for (const [, child] of this.children) {
      child.cleanup();
    }
    this.children.clear();

    for (const [, standby] of this.standbyLinks) {
      standby.cleanup();
    }
    this.standbyLinks.clear();

    this.ringBuffer.clear();
    if (this.upstreamWatchdogTimer) {
      clearInterval(this.upstreamWatchdogTimer);
      this.upstreamWatchdogTimer = null;
    }
    this.originChunkQueue = [];
    this.incomingPacketQueue = [];
    if (this.reorderQueue) {
      this.reorderQueue.reset();
    }
    this.reassembler.clear();

    this.standbyCandidateIds = [];
    this.bootstrapRetryCount = 0;
    this.videoElement = null;
    this.lastInitSequence = null;

    this.role = 'idle';
    this.broadcastId = null;
    this.updateState('idle');
  }

  destroy() {
    this.destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.stopBroadcast();
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }
}
