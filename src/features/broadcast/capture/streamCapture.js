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
export function getSupportedMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return 'video/webm; codecs="vp8,opus"';
  }

  for (const mime of SUPPORTED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return '';
}

export class StreamCapture {
  constructor({ onChunk, onError, onStop, onSourceReverted } = {}) {
    this.onChunk = onChunk; // (chunkObject) => void
    this.onError = onError;
    this.onStop = onStop;
    this.onSourceReverted = onSourceReverted; // (newType, newStream) => void

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
  }

  /**
   * Starts capturing camera & microphone.
   */
  async startCamera({ video = true, audio = true, resolution = '720p' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera/Microphone capture is not supported in this browser');
    }

    const is540p = resolution === '540p';
    const constraints = {
      video: video
        ? {
            width: is540p ? { ideal: 960, max: 960 } : { ideal: 1280, max: 1280 },
            height: is540p ? { ideal: 540, max: 540 } : { ideal: 720, max: 720 },
            frameRate: { ideal: 30, max: 30 },
          }
        : false,
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
      } else {
        throw err;
      }
    }
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

    this.attachTrackListeners(finalStream, 'screen');
    this.currentSourceType = 'screen';
    return this.initRecorder(finalStream);
  }

  /**
   * Attach lifecycle listeners to stream tracks to detect unexpected disconnects or native browser stops.
   */
  attachTrackListeners(stream, sourceType) {
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', async () => {
        if (this.isSwitchingSource) return;
        console.log(`[Capture] Video track for ${sourceType} ended`);
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
   * Dynamic live source switching (Camera ↔ Screen Share) during a live broadcast.
   * Preserves continuous sequence numbering and session continuity.
   */
  async switchSource({ type = 'camera', withMic = true } = {}) {
    if (type === this.currentSourceType && this.mediaStream && this.isRecording) {
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
      // Switch back to Camera
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
    if (!isSourceSwitch) {
      this.sequence = 0;
      this.initSegment = null;
    }

    this.mimeType = getSupportedMimeType();
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

        const isInitChunk = this.isFirstChunkOfRecorder;
        this.isFirstChunkOfRecorder = false;

        // The first emitted chunk of the recorder contains the initialization segment
        if (isInitChunk) {
          this.initSegment = payloadBytes;
        }

        let isKeyframe = false;
        if (isInitChunk) {
          isKeyframe = false; // EBML container header is an init segment, not a video keyframe
        } else if (this.isSecondChunkOfNewSource || this.sequence === 1) {
          // The first video chunk following container header is always an independent keyframe
          isKeyframe = true;
          this.isSecondChunkOfNewSource = false;
        } else {
          isKeyframe = this.probeKeyframe(payloadBytes);
        }

        const chunkObj = {
          sequence: this.sequence,
          timestamp: Date.now(),
          isInit: isInitChunk,
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

    // Start recording in ~500 ms chunks
    this.mediaRecorder.start(this.timesliceMs);
    this.isRecording = true;

    return {
      stream: this.mediaStream,
      mimeType: this.mimeType,
    };
  }

  /**
   * Inspects bytes to accurately determine if chunk contains a VP8 video keyframe.
   * Matches the official VP8 uncompressed header start code (0x9D 0x01 0x2A) preceded by keyframe tag (bit 0 == 0).
   */
  probeKeyframe(bytes) {
    if (!bytes || bytes.length < 16) return false;

    // Scan for VP8 keyframe start code (0x9D 0x01 0x2A preceded by frame_type bit 0 == 0)
    for (let i = 1; i < Math.min(bytes.length - 3, 2048); i++) {
      if (bytes[i] === 0x9d && bytes[i + 1] === 0x01 && bytes[i + 2] === 0x2a) {
        if ((bytes[i - 1] & 0x01) === 0) {
          return true;
        }
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
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (_) {}
    }
    this.cleanup();
  }

  cleanup() {
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
