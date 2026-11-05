/**
 * OmniCast Stream Capture & Single-Encoding Engine
 *
 * Implements:
 * - Camera & microphone capture with track lifecycle monitoring.
 * - Screen share capture with optional mic mixing and native toolbar stop handling.
 * - Dynamic live source switching (Camera ↔ Screen Share) without tearing down the broadcast session.
 * - Safe handling of user-cancelled screen pickers.
 * - MIME/codec auto-detection prioritizing MSE cross-browser playback.
 * - Single-encode pipeline emitting ~500ms signed logical chunks.
 * - Dedicated handling of the stream initialization segment and EBML micro-chunk accumulation.
 */

// Preferred codecs in order of MSE playback compatibility across Chrome, Firefox, Edge
export const SUPPORTED_MIME_TYPES = [
  'video/webm; codecs="vp8,opus"',
  'video/webm; codecs="vp8"',
  'video/webm; codecs="h264,opus"',
  'video/webm; codecs="vp9,opus"',
  'video/webm',
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4',
];

/**
 * Returns the best supported MIME type for live encoding and MSE playback.
 */
export function getSupportedMimeType({ hasAudio = true } = {}) {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return hasAudio ? 'video/webm; codecs="vp8,opus"' : 'video/webm; codecs="vp8"';
  }

  const mimeTypes = hasAudio
    ? SUPPORTED_MIME_TYPES
    : SUPPORTED_MIME_TYPES.filter((mime) => !mime.includes('opus') && !mime.includes('mp4a'));

  for (const mime of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return '';
}

export const KEYFRAME_EPOCH_MS =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_KEYFRAME_EPOCH_MS)
    ? Number(import.meta.env.VITE_KEYFRAME_EPOCH_MS)
    : 8000;

export class StreamCapture {
  constructor({ onChunk, onError, onStop, onSourceReverted, keyframeEpochMs = KEYFRAME_EPOCH_MS } = {}) {
    this.onChunk = onChunk; // (chunkObject) => void
    this.onError = onError;
    this.onStop = onStop;
    this.onSourceReverted = onSourceReverted; // (newType, newStream) => void
    this.keyframeEpochMs = keyframeEpochMs;
    this.epochInterval = null;

    this.mediaStream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.sequence = 0;
    this.mimeType = '';
    this.audioContext = null;
    this.initSegment = null;
    this.timesliceMs = 300; // ~300ms chunks: cuts chunk delivery latency from 500ms
    this.currentSourceType = 'camera'; // 'camera' | 'screen'
    this.stashedFirstChunk = null;
    this.isSwitchingSource = false;
    this.isRecoveringCamera = false;
    this.cameraRecoveryTimer = null;
    this.trackGeneration = 0;
    this.fallbackAnimationId = null;
    this.fallbackDrawTimer = null;
    this.fallbackCanvas = null;
    this.recorderGeneration = 0;
  }

  /**
   * Starts capturing camera & microphone.
   */
  async startCamera({ video = true, audio = true, resolution = '720p', deviceId = null } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera/Microphone capture is not supported in this browser');
    }

    const is540p = resolution === '540p';
    let videoConstraint = video
      ? {
          width: is540p ? { ideal: 960, max: 960 } : { ideal: 1280, max: 1280 },
          height: is540p ? { ideal: 540, max: 540 } : { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 },
        }
      : false;

    if (deviceId && videoConstraint) {
      videoConstraint.deviceId = { ideal: deviceId };
    } else if (video && navigator.mediaDevices?.enumerateDevices) {
      // Prefer standard RGB color webcams over Windows Hello / IR sensor devices
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === 'videoinput');
        const rgbCamera = videoDevices.find((d) => d.label && !/ir\b|infrared/i.test(d.label));
        if (rgbCamera && rgbCamera.deviceId) {
          videoConstraint.deviceId = { ideal: rgbCamera.deviceId };
        }
      } catch (_) {}
    }

    const constraints = {
      video: videoConstraint,
      audio: audio
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : false,
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        console.warn('[StreamCapture] Video constraints overconstrained, falling back to basic media');
        stream = await navigator.mediaDevices.getUserMedia({
          video: Boolean(video),
          audio: audio ? { echoCancellation: true } : false,
        });
      } else if (err.name === 'NotFoundError' || err.name === 'NotReadableError' || err.name === 'AbortError') {
        const fallbackStream = this.createFallbackStream();
        if (!fallbackStream) throw err;
        console.warn('[StreamCapture] Camera unavailable; starting with a standby video frame');
        stream = fallbackStream;
      } else {
        throw err;
      }
    }
    this.mediaStream = stream;
    this.attachTrackListeners(stream, 'camera');
    this.currentSourceType = 'camera';
    return this.initRecorder(stream);
  }

  /**
   * Starts capturing screen with optional microphone mix.
   */
  async startScreen({ withMic = true } = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported in this browser');
    }

    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true, // system/tab audio
    });

    let finalStream = screenStream;

    // If user also wants mic audio mixed into the screen broadcast
    if (withMic && navigator.mediaDevices.getUserMedia) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
          if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
          }
          const dest = this.audioContext.createMediaStreamDestination();

          if (screenStream.getAudioTracks().length > 0) {
            const screenSource = this.audioContext.createMediaStreamSource(screenStream);
            screenSource.connect(dest);
          }

          const micSource = this.audioContext.createMediaStreamSource(micStream);
          micSource.connect(dest);

          finalStream = new MediaStream([
            ...screenStream.getVideoTracks(),
            ...dest.stream.getAudioTracks(),
          ]);
        }
      } catch (e) {
        console.warn('[Capture] Could not capture microphone for screen mix:', e.message);
      }
    }

    this.mediaStream = finalStream;
    this.attachTrackListeners(finalStream, 'screen');
    this.currentSourceType = 'screen';
    return this.initRecorder(finalStream);
  }

  /**
   * Attach lifecycle listeners to stream tracks to detect unexpected disconnects or native browser stops.
   */
  attachTrackListeners(stream, sourceType) {
    const videoTrack = stream.getVideoTracks()[0];
    const generation = ++this.trackGeneration;
    if (videoTrack) {
      videoTrack.addEventListener('ended', async () => {
        // A replaced stream can emit `ended` asynchronously after its tracks
        // were deliberately stopped. Only recover the currently active stream.
        if (this.isSwitchingSource || stream !== this.mediaStream || generation !== this.trackGeneration) return;
        console.warn(`[Capture] ${sourceType} video input became unavailable; attempting recovery`);
        if (sourceType === 'screen') {
          // Native browser "Stop sharing" clicked -> cleanly revert to camera
          console.log('[Capture] Reverting to camera after screen share stopped...');
          try {
            const reverted = await this.switchSource({ type: 'camera' });
            if (this.onSourceReverted && reverted) {
              this.onSourceReverted('camera', reverted.stream);
            }
          } catch (err) {
            console.error('[Capture] Failed to revert to camera:', err);
          }
        } else {
          await this.recoverCamera();
        }
      });

      videoTrack.addEventListener('mute', () => {
        console.warn(`[Capture] ${sourceType} video track muted by device/OS`);
      });

      videoTrack.addEventListener('unmute', () => {
        console.log(`[Capture] ${sourceType} video track unmuted`);
      });
    }
  }

  /**
   * Recover a camera that disappeared without ending the broadcast. This is
   * common with laptop camera power management and also makes headless fake
   * capture devices restart cleanly instead of leaving MediaRecorder alive
   * with no video chunks.
   */
  async recoverCamera() {
    if (this.isRecoveringCamera || !this.isRecording || this.currentSourceType !== 'camera') return;

    this.isRecoveringCamera = true;
    try {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280, max: 1280 },
              height: { ideal: 720, max: 720 },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });

          this.replaceActiveStream(newStream, this.sequence > 0);
          this.isSwitchingSource = false;
          console.log('[Capture] Camera recovered; continuing the active broadcast');
          return;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }

      // Keep the broadcast alive with a visible animated standby frame when
      // the browser cannot reacquire a camera (for example a disconnected USB
      // camera or a headless test device). Audio is preserved when available.
      const fallbackStream = this.createFallbackStream();
      if (fallbackStream) {
        this.replaceActiveStream(fallbackStream, this.sequence > 0);
        console.warn('[Capture] Camera unavailable; broadcasting a standby video frame until it returns');
      } else if (lastError && this.onError) {
        this.onError(lastError);
      }
    } finally {
      this.isSwitchingSource = false;
      this.isRecoveringCamera = false;
    }
  }

  replaceActiveStream(newStream, isSourceSwitch = true) {
    this.isSwitchingSource = true;
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
      if (this.mediaRecorder.state !== 'inactive') {
        try { this.mediaRecorder.stop(); } catch (_) {}
      }
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }

    this.mediaStream = newStream;
    this.stashedFirstChunk = null;
    this.attachTrackListeners(newStream, 'camera');
    this.initRecorder(newStream, isSourceSwitch);
    this.isSwitchingSource = false;
  }

  createFallbackStream() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;

    this.stopFallbackAnimation();
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) return null;

    // Keep the standby image simple. A tiny changing marker makes every
    // captureStream tick observable without a full-canvas animation loop.
    context.fillStyle = '#090b12';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#16b8f3';
    context.font = 'bold 38px sans-serif';
    context.fillText('OMNICAST', 72, 92);
    context.fillStyle = '#a1a1aa';
    context.font = '24px sans-serif';
    context.fillText('Camera reconnecting…', 72, 145);
    this.fallbackCanvas = canvas;
    let marker = false;
    this.fallbackDrawTimer = setInterval(() => {
      marker = !marker;
      context.fillStyle = marker ? '#16b8f3' : '#0b6d91';
      context.fillRect(canvas.width - 120, 72, 24, 24);
    }, 1000 / 30);

    const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
    const audioTracks = this.mediaStream
      ? this.mediaStream.getAudioTracks().filter((track) => track.readyState === 'live').map((track) => track.clone())
      : [];
    return new MediaStream([videoTrack, ...audioTracks]);
  }

  stopFallbackAnimation() {
    if (this.fallbackAnimationId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.fallbackAnimationId);
    }
    this.fallbackAnimationId = null;
    if (this.fallbackDrawTimer !== null) {
      clearInterval(this.fallbackDrawTimer);
      this.fallbackDrawTimer = null;
    }
    this.fallbackCanvas = null;
  }

  /**
   * Dynamic live source switching (Camera ↔ Screen Share) during a live broadcast.
   * Preserves continuous sequence numbering and session continuity.
   */
  async switchSource({ type = 'camera', withMic = true, deviceId = null } = {}) {
    if (type === this.currentSourceType && this.mediaStream && this.isRecording && !deviceId) {
      return { stream: this.mediaStream, type };
    }

    console.log(`[Capture] Switching live source from ${this.currentSourceType} to ${type}...`);
    let newStream;

    if (type === 'screen') {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen sharing is not supported in this browser');
      }
      try {
        newStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always', frameRate: { ideal: 30, max: 30 } },
          audio: true,
        });
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          console.log('[Capture] User cancelled screen picker dialog; active stream remains unchanged.');
          return null; // Cancelled gracefully
        }
        throw err;
      }

      // Mix mic if requested
      if (withMic && navigator.mediaDevices.getUserMedia) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            if (this.audioContext) {
              try { this.audioContext.close(); } catch (_) {}
            }
            this.audioContext = new AudioCtx();
            if (this.audioContext.state === 'suspended') {
              await this.audioContext.resume();
            }
            const dest = this.audioContext.createMediaStreamDestination();
            if (newStream.getAudioTracks().length > 0) {
              const screenSource = this.audioContext.createMediaStreamSource(newStream);
              screenSource.connect(dest);
            }
            const micSource = this.audioContext.createMediaStreamSource(micStream);
            micSource.connect(dest);
            newStream = new MediaStream([
              ...newStream.getVideoTracks(),
              ...dest.stream.getAudioTracks(),
            ]);
          }
        } catch (_) {}
      }
    } else {
      // Switch back to Camera (or switch camera device)
      const videoConfig = {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      };
      if (deviceId) {
        videoConfig.deviceId = { ideal: deviceId };
      }
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: videoConfig,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (_) {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: Boolean(deviceId ? { deviceId: { ideal: deviceId } } : true),
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      }
    }

    this.isSwitchingSource = true;

    // Clear previous recorder listeners so its onstop doesn't fire this.onStop()
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
      if (this.mediaRecorder.state !== 'inactive') {
        try { this.mediaRecorder.stop(); } catch (_) {}
      }
    }

    // Stop and release previous stream tracks so camera light turns off or screen sharing ends
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }

    this.mediaStream = newStream;
    this.currentSourceType = type;
    this.attachTrackListeners(newStream, type);

    // Reset accumulator for the new container header
    this.stashedFirstChunk = null;
    this.initRecorder(newStream, /* isSourceSwitch= */ true);
    this.isSwitchingSource = false;

    return {
      stream: this.mediaStream,
      type: this.currentSourceType,
    };
  }

  /**
   * Set up MediaRecorder with ~500ms timeslice and single-encoding pipeline.
   */
  initRecorder(stream, isSourceSwitch = false) {
    this.mediaStream = stream;
    const recorderGeneration = ++this.recorderGeneration;
    if (!isSourceSwitch) {
      this.sequence = 0;
      this.initSegment = null;
    }

    this.mimeType = getSupportedMimeType({ hasAudio: stream.getAudioTracks().length > 0 });
    if (!this.mimeType) {
      throw new Error('No compatible video/audio encoding format found for this browser');
    }

    const options = {
      mimeType: this.mimeType,
      videoBitsPerSecond: 1200000, // 1.2 Mbps optimal for 720p 30fps VP8
      audioBitsPerSecond: 128000,  // 128 kbps audio
    };

    try {
      this.mediaRecorder = new MediaRecorder(stream, options);
    } catch (_) {
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.mimeType });
    }

    this.isFirstChunkOfRecorder = true;
    this.isSecondChunkOfNewSource = isSourceSwitch;

    this.mediaRecorder.ondataavailable = async (event) => {
      // A pending Blob.arrayBuffer() from a recorder that was replaced can
      // resolve after the new recorder starts. Never mix those old clusters
      // into the new container epoch.
      if (recorderGeneration !== this.recorderGeneration) return;
      if (!event.data || event.data.size === 0) return;

      try {
        const arrayBuffer = await event.data.arrayBuffer();
        let payloadBytes = new Uint8Array(arrayBuffer);

        // Handle Chromium MediaRecorder edge case where the very first byte (0x1a)
        // is flushed in a micro-chunk before the rest of the EBML header arrives.
        if (this.stashedFirstChunk) {
          const combined = new Uint8Array(this.stashedFirstChunk.byteLength + payloadBytes.byteLength);
          combined.set(this.stashedFirstChunk, 0);
          combined.set(payloadBytes, this.stashedFirstChunk.byteLength);
          payloadBytes = combined;
          this.stashedFirstChunk = null;
        } else if (this.isFirstChunkOfRecorder && payloadBytes.byteLength < 128) {
          console.warn(`[Capture] First chunk too small (${payloadBytes.byteLength}B), stashing to combine with header`);
          this.stashedFirstChunk = payloadBytes;
          return;
        }

        if (this.isFirstChunkOfRecorder) {
          this.isFirstChunkOfRecorder = false;

          // Split the very first recorder burst into:
          // 1. Pure EBML container init segment (0 to clusterIdx)
          // 2. First Matroska Cluster with initial VP8/H.264 keyframe (clusterIdx to end)
          let clusterIdx = -1;
          for (let i = 0; i < payloadBytes.length - 4; i++) {
            if (
              payloadBytes[i] === 0x1f &&
              payloadBytes[i + 1] === 0x43 &&
              payloadBytes[i + 2] === 0xb6 &&
              payloadBytes[i + 3] === 0x75
            ) {
              clusterIdx = i;
              break;
            }
          }

          if (clusterIdx > 0) {
            const initHeader = payloadBytes.slice(0, clusterIdx);
            const firstCluster = payloadBytes.slice(clusterIdx);

            this.initSegment = initHeader;

            // Emit Init Segment (seq 0)
            const initChunk = {
              sequence: this.sequence,
              timestamp: Date.now(),
              isInit: true,
              isKeyframe: false,
              payload: initHeader,
              mimeType: this.mimeType,
            };
            this.sequence++;
            if (this.onChunk) {
              this.onChunk(initChunk);
            }

            // Emit First Keyframe Chunk (seq 1)
            const keyframeChunk = {
              sequence: this.sequence,
              timestamp: Date.now(),
              isInit: false,
              isKeyframe: true,
              payload: firstCluster,
              mimeType: this.mimeType,
            };
            this.sequence++;
            if (this.onChunk) {
              this.onChunk(keyframeChunk);
            }
            return;
          } else {
            // Fallback if no cluster found in first burst
            this.initSegment = payloadBytes;
            this.isNextChunkKeyframe = true;
            const initChunk = {
              sequence: this.sequence,
              timestamp: Date.now(),
              isInit: true,
              isKeyframe: false,
              payload: payloadBytes,
              mimeType: this.mimeType,
            };
            this.sequence++;
            if (this.onChunk) {
              this.onChunk(initChunk);
            }
            return;
          }
        }

        let isKeyframe = false;
        if (this.isNextChunkKeyframe || this.isSecondChunkOfNewSource || this.sequence === 1) {
          isKeyframe = true;
          this.isNextChunkKeyframe = false;
          this.isSecondChunkOfNewSource = false;
        } else {
          isKeyframe = this.probeKeyframe(payloadBytes);
        }

        const chunkObj = {
          sequence: this.sequence,
          timestamp: Date.now(),
          isInit: false,
          isKeyframe,
          payload: payloadBytes,
          mimeType: this.mimeType,
        };

        this.sequence++;

        if (this.onChunk) {
          this.onChunk(chunkObj);
        }
      } catch (err) {
        console.error('[Capture] Error processing chunk:', err);
        if (this.onError) this.onError(err);
      }
    };

    this.mediaRecorder.onerror = (e) => {
      console.error('[Capture] MediaRecorder error:', e);
      if (this.onError) this.onError(e);
    };

    this.mediaRecorder.onstop = () => {
      this.isRecording = false;
      if (!isSourceSwitch) {
        this.cleanup();
        if (this.onStop) this.onStop();
      }
    };

    // Start recording in ~300 ms chunks
    this.mediaRecorder.start(this.timesliceMs);
    this.isRecording = true;

    if (!isSourceSwitch) {
      this.startEpochTimer();
    }

    return {
      stream: this.mediaStream,
      mimeType: this.mimeType,
    };
  }

  startEpochTimer() {
    this.stopEpochTimer();
    this.epochInterval = setInterval(() => {
      this.restartEpoch();
    }, this.keyframeEpochMs);
  }

  stopEpochTimer() {
    if (this.epochInterval) {
      clearInterval(this.epochInterval);
      this.epochInterval = null;
    }
  }

  restartEpoch() {
    if (!this.isRecording || this.isSwitchingSource || !this.mediaStream) return;
    const tracks = this.mediaStream.getVideoTracks();
    if (tracks.length === 0 || tracks[0].readyState !== 'live') return;
    console.log(`[Capture] Starting fresh keyframe epoch (${this.keyframeEpochMs}ms elapsed)`);
    this.isSwitchingSource = true;
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
      if (this.mediaRecorder.state !== 'inactive') {
        try { this.mediaRecorder.stop(); } catch (_) {}
      }
    }
    // Do NOT stop tracks of this.mediaStream! Keep active captured tracks live.
    this.stashedFirstChunk = null;
    this.initRecorder(this.mediaStream, /* isSourceSwitch= */ true);
    this.isSwitchingSource = false;
  }

  /**
   * Inspects bytes to accurately determine if chunk contains a VP8/H.264 video keyframe.
   * Matches the official VP8 uncompressed header start code (0x9D 0x01 0x2A) preceded by keyframe tag (bit 0 == 0).
   */
  probeKeyframe(bytes) {
    if (!bytes || bytes.length < 16) return false;
    // Check for VP8 start code 0x9D 0x01 0x2A with bit 0 == 0
    for (let i = 0; i < Math.min(bytes.length - 6, 256); i++) {
      if (bytes[i + 3] === 0x9d && bytes[i + 4] === 0x01 && bytes[i + 5] === 0x2a) {
        if ((bytes[i] & 0x01) === 0) {
          return true;
        }
      }
    }
    // Check for H.264 NAL type 5 (IDR) or 7 (SPS)
    for (let i = 0; i < Math.min(bytes.length - 5, 256); i++) {
      if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && (bytes[i + 2] === 0x01 || (bytes[i + 2] === 0x00 && bytes[i + 3] === 0x01))) {
        const nalIndex = bytes[i + 2] === 0x01 ? i + 3 : i + 4;
        const nalType = bytes[nalIndex] & 0x1f;
        if (nalType === 5 || nalType === 7) return true;
      }
    }
    return false;
  }

  getCaptureFps() {
    if (!this.mediaStream) return 0;
    const videoTrack = this.mediaStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') return 0;
    const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
    return Math.round(settings.frameRate || 30);
  }

  getInitSegment() {
    return this.initSegment;
  }

  stop() {
    this.stopEpochTimer();
    if (this.cameraRecoveryTimer) {
      clearTimeout(this.cameraRecoveryTimer);
      this.cameraRecoveryTimer = null;
    }
    this.isRecoveringCamera = false;
    this.stopFallbackAnimation();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (_) {}
    }
    this.cleanup();
  }

  cleanup() {
    this.stopEpochTimer();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
      this.mediaStream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (_) {}
      this.audioContext = null;
    }
    this.isRecording = false;
  }
}
