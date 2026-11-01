/**
 * OmniCast Client Broadcast & Relay Manager
 *
 * Orchestrates:
 * 1. WebRTC signaling via central WebSocket (zero media on WS!).
 * 2. Origin media capture, ECDSA P-256 signing, and multi-child distribution.
 * 3. Viewer receiving, ECDSA verification, MSE rendering, and downstream forwarding.
 * 4. Tree-mesh cascade with 5-child fanout bound.
 * 5. Standby parent management and sub-400ms automatic failover.
 * 6. Live telemetry and real-time performance instrumentation.
 */

import { StreamCapture } from './capture/streamCapture.js';
import { PeerLink, DEFAULT_RTC_CONFIG } from './transport/peerConnection.js';
import { MsePlayer } from './playback/msePlayer.js';
import {
  PacketType,
  PacketFlags,
  fragmentChunk,
  deserializePacket,
  PacketReassembler,
} from './protocol/framing.js';
import { MediaRingBuffer, SequenceReorderQueue } from './protocol/ringBuffer.js';
import {
  generateBroadcasterKeyPair,
  exportPublicKeyInfo,
  importPublicKey,
  signChunk,
  verifyChunk,
} from './crypto/signatures.js';

export class BroadcastManager {
  constructor({
    signalingUrl,
    onStateChange,
    onMetrics,
    onError,
    onStreamChanged,
    onBroadcastAnnounced,
    onBroadcastEnded,
  } = {}) {
    this.signalingUrl = signalingUrl || this.getDefaultSignalingUrl();
    this.onStateChange = onStateChange;
    this.onMetrics = onMetrics;
    this.onError = onError;
    this.onStreamChanged = onStreamChanged;
    this.onBroadcastAnnounced = onBroadcastAnnounced;
    this.onBroadcastEnded = onBroadcastEnded;

    this.localPeerId = 'peer-' + Math.random().toString(36).substring(2, 10);
    this.role = 'idle'; // 'broadcaster' | 'viewer' | 'relay' | 'idle'
    this.broadcastId = null;
    this.streamTitle = '';
    this.tier = 0;

    // Cryptography
    this.keyPair = null;
    this.originPublicKey = null;
    this.originFingerprint = '';

    // Networking
    this.ws = null;
    this.pendingWsMessages = [];
    this.children = new Map(); // childPeerId -> PeerLink
    this.parentLink = null;     // active upstream PeerLink
    this.standbyLinks = new Map(); // standbyPeerId -> PeerLink
    this.standbyCandidateIds = [];

    // Media & Playback
    this.streamCapture = null;
    this.msePlayer = null;
    this.ringBuffer = new MediaRingBuffer({ maxItems: 25, maxDurationMs: 5000 });
    this.reorderQueue = null;
    this.reassembler = new PacketReassembler();

    // Telemetry & Stats
    this.metrics = {
      role: 'idle',
      tier: null,
      activeChildren: 0,
      parentPeerId: null,
      parentRtt: 0,
      bytesReceived: 0,
      bytesSent: 0,
      chunksEmitted: 0,
      chunksReceived: 0,
      chunksForwarded: 0,
      tamperedChunksDropped: 0,
      droppedChunks: 0,
      failovers: 0,
      viewerCount: 0,
      bitrateKbps: 0,
      liveLatencyMs: 0,
      fingerprint: '',
    };

    this.metricsTimer = null;
    this.lastBytesReceived = 0;
    this.lastBytesSent = 0;
  }

  getDefaultSignalingUrl() {
    if (typeof window === 'undefined') return 'ws://127.0.0.1:10000/signaling';

    // 1. Explicit environment variable override
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SIGNALING_URL) {
      return import.meta.env.VITE_SIGNALING_URL;
    }

    // 2. Same-Origin WebSocket URL:
    // Routes through Vite dev proxy (or production reverse proxy) on standard port
    // Resolves both mixed-content HTTPS restrictions and public tunnel port-forwarding issues.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/signaling`;
  }

  /**
   * Connect to the signaling server.
   */
  async connectSignaling() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.signalingUrl);

      this.ws.onopen = () => {
        console.log(`📡 Connected to OmniCast signaling server as ${this.localPeerId}`);
        // Announce identity and capabilities
        this.ws.send(JSON.stringify({
          type: 'announce',
          peerId: this.localPeerId,
          capabilities: {
            isMobile: this.isMobileDevice(),
            userRelayPermitted: true,
          },
        }));

        // Flush any messages queued before WebSocket finished opening
        while (this.pendingWsMessages.length > 0) {
          const msg = this.pendingWsMessages.shift();
          try {
            this.ws.send(JSON.stringify(msg));
          } catch (_) {}
        }

        this.startMetricsLoop();
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
        console.error('[BroadcastManager] Signaling error:', err);
        if (this.onError) this.onError(err);
        reject(err);
      };

      this.ws.onclose = () => {
        console.log('[BroadcastManager] Signaling closed');
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

  // ──────────────────────────────────────────────────────────
  // BROADCASTER WORKFLOW (Origin)
  // ──────────────────────────────────────────────────────────

  async startBroadcast({ title = 'Live OmniCast Stream', type = 'camera', maxChildren = 5 } = {}) {
    this.role = 'broadcaster';
    this.tier = 0;
    // Collision-resistant 16-character broadcast ID: fits exactly in 16-byte wire framing
    const timePart = Date.now().toString(36).slice(-6);
    const randPart = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 4)
      : Math.random().toString(36).substring(2, 6);
    this.broadcastId = `omni-${timePart}-${randPart}`;
    this.streamTitle = title;

    // 1. Generate origin ECDSA P-256 signing key pair
    this.keyPair = await generateBroadcasterKeyPair();
    const pubInfo = await exportPublicKeyInfo(this.keyPair.publicKey);
    this.originFingerprint = pubInfo.fingerprint;
    this.metrics.fingerprint = this.originFingerprint;

    // 2. Start media capture and single encoding
    this.streamCapture = new StreamCapture({
      onChunk: (chunk) => this.handleOriginChunk(chunk),
      onError: (err) => this.onError && this.onError(err),
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
      captureResult = await this.streamCapture.startCamera({ video: true, audio: true });
    }

    // 3. Register broadcast session on signaling server
    this.sendWs({
      type: 'broadcast:create',
      broadcastId: this.broadcastId,
      title: this.streamTitle,
      originPubKey: pubInfo.spkiBase64,
      mimeType: captureResult.mimeType,
      maxChildren,
    });

    this.updateState('broadcasting');
    return {
      broadcastId: this.broadcastId,
      stream: captureResult.stream,
      fingerprint: this.originFingerprint,
    };
  }

  /**
   * Switch live video/audio source dynamically (Camera ↔ Screen Share) without ending the broadcast.
   */
  async switchSource({ type = 'camera' } = {}) {
    if (!this.streamCapture) {
      throw new Error('No active stream capture to switch');
    }
    const result = await this.streamCapture.switchSource({ type });
    if (!result) return null;

    if (this.onStreamChanged) {
      this.onStreamChanged(result.stream, result.type);
    }
    return result;
  }

  /**
   * Origin Chunk Handler: Sign once, fragment, and distribute over RTCDataChannels.
   */
  async handleOriginChunk(chunk) {
    if (this.role !== 'broadcaster') return;

    this.metrics.chunksEmitted++;

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

    // Set up reorder queue for sequential playback
    this.reorderQueue = new SequenceReorderQueue({
      onEmit: (chunk) => this.renderChunk(chunk),
      onGap: (fromSeq, toSeq) => this.requestRetransmit(fromSeq, toSeq),
      onGapSkipped: (fromSeq, toSeq) => {
        if (this.msePlayer) {
          this.msePlayer.onGapOccurred();
        }
      },
    });

    // Request tree assignment from topology coordinator
    this.sendWs({
      type: 'broadcast:join',
      broadcastId,
      capabilities: {
        isMobile: this.isMobileDevice(),
        userRelayPermitted: true,
      },
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
    this.standbyCandidateIds = standbyParents || [];

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
    if (this.videoElement && !this.msePlayer) {
      this.msePlayer = new MsePlayer({
        videoElement: this.videoElement,
        mimeType: mimeType || 'video/webm; codecs="vp8,opus"',
        onError: (err) => this.onError && this.onError(err),
        onLiveStateChange: (state) => {
          if (this.onLiveStateChange) {
            this.onLiveStateChange(state);
          }
        },
      });
    }

    // Connect to active upstream parent via WebRTC DataChannel
    this.connectToParent(parentPeerId);

    // Warm up standby connections if candidates available
    this.prepareStandbys();

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

    this.parentLink.createAndSendOffer();
  }

  prepareStandbys() {
    // Keep 1 or 2 standby candidate links ready
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

  /**
   * Handle incoming binary packet on RTCDataChannel.
   */
  async handleIncomingBinary(arrayBuffer) {
    this.metrics.bytesReceived += arrayBuffer.byteLength;

    try {
      const packet = deserializePacket(arrayBuffer);

      // Ingest fragment into reassembler with raw packet buffer preserved
      const completeChunk = this.reassembler.ingest(packet, arrayBuffer);
      if (!completeChunk) {
        return; // waiting for remaining fragments
      }

      this.metrics.chunksReceived++;

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
        this.metrics.liveLatencyMs = Math.max(0, Date.now() - completeChunk.timestamp);
      }

      // Save verified chunk in local ring buffer
      if (completeChunk.type === PacketType.INIT_SEGMENT) {
        this.ringBuffer.setInitSegment(completeChunk);
      }
      this.ringBuffer.add(completeChunk);

      // ── CASCADE FORWARDING: Forward all verified wire packets to downstream children ──
      if (completeChunk.rawPackets && completeChunk.rawPackets.length > 0) {
        for (const raw of completeChunk.rawPackets) {
          this.forwardToChildren(raw);
        }
      } else {
        this.forwardToChildren(arrayBuffer);
      }

      // Push to reorder queue for local playback
      if (completeChunk.type === PacketType.INIT_SEGMENT) {
        // Init segment bypasses sequence queue and feeds directly to MSE
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
   * Ensures children are bootstrapped with init segment and keyframe before receiving live chunks.
   */
  forwardToChildren(arrayBuffer) {
    if (this.children.size === 0) return;

    for (const [, childLink] of this.children) {
      if (childLink.isOpen()) {
        if (!childLink._hasSynced) {
          this.syncChildWithStream(childLink);
        }
        if (childLink._hasSynced) {
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
      // Respond to heartbeat
      if (this.parentLink) {
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

      // Fallback check in case child opened before listener
      const checkAndSendInit = setInterval(() => {
        if (childLink.isOpen()) {
          clearInterval(checkAndSendInit);
          this.syncChildWithStream(childLink);
        }
      }, 50);

      setTimeout(() => clearInterval(checkAndSendInit), 5000);
    }
  }

  /**
   * Sends the stream initialization segment and recent keyframe chunks
   * to a newly connected child so it can start decoding video immediately.
   * Only marks child as synced if both init segment and keyframe are sent.
   */
  syncChildWithStream(childLink) {
    if (!childLink || !childLink.isOpen() || childLink._hasSynced) return;

    const initSeg = this.ringBuffer.getInitSegment();
    const recentChunks = this.ringBuffer.getSinceLatestKeyframe();

    // If init segment or keyframe is not ready yet, wait until one is available
    if (!initSeg || recentChunks.length === 0) {
      return; // Do NOT set _hasSynced = true yet! Will sync when first keyframe is added.
    }

    childLink._hasSynced = true;

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
      if (chunk.isInit || chunk.type === PacketType.INIT_SEGMENT) continue; // init segment already sent
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
  }

  handleChildControlMessage(childPeerId, msg) {
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

    if (this.standbyCandidateIds.length > 0) {
      const promotedStandby = this.standbyCandidateIds[0];
      console.log(`⚡ Instant Failover: Promoting standby parent ${promotedStandby.slice(-8)}`);

      // Inform coordinator of standby promotion
      this.sendWs({
        type: 'topology:promote-standby',
        broadcastId: this.broadcastId,
        standbyPeerId: promotedStandby,
      });

      // Switch to standby link
      this.connectToParent(promotedStandby);

      const failoverDurationMs = Math.round(performance.now() - startTime);
      console.log(`⏱️ Failover switch completed in ${failoverDurationMs} ms`);
    } else {
      // Re-join broadcast to get fresh parent assignment
      this.sendWs({
        type: 'broadcast:join',
        broadcastId: this.broadcastId,
        capabilities: {
          isMobile: this.isMobileDevice(),
          userRelayPermitted: true,
        },
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
        this.connectToParent(msg.newParentPeerId);
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
        if (msg.code === 'JOIN_FAILED') {
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

      // Measure RTT with parent
      if (this.parentLink) {
        const stats = await this.parentLink.measureStats();
        this.metrics.parentRtt = stats.rttMs;
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
      }

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

  updateState(state) {
    if (this.onStateChange) {
      this.onStateChange(state, { ...this.metrics });
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
    if (this.reorderQueue) {
      this.reorderQueue.reset();
    }
    this.reassembler.clear();

    this.role = 'idle';
    this.broadcastId = null;
    this.updateState('idle');
  }

  destroy() {
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

