import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Users,
  ShieldCheck,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  AlertCircle,
  Network,
} from 'lucide-react';

export const WatcherView = ({
  broadcastId,
  onBack,
  broadcastManager,
  metrics,
  onOpenTopology,
}) => {
  const videoRef = useRef(null);
  const containerRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [preparingSlow, setPreparingSlow] = useState(false);
  const [connectionState, setConnectionState] = useState('connecting'); // 'connecting' | 'preparing' | 'playing' | 'buffering' | 'ended' | 'not_found' | 'error' | 'full'
  const [errorMessage, setErrorMessage] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Prevent stale closure in event handlers
  const connectionStateRef = useRef(connectionState);
  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    let t = null;
    if (connectionState === 'preparing' || connectionState === 'connecting') {
      t = setTimeout(() => {
        setPreparingSlow(true);
      }, 3500);
    } else {
      setPreparingSlow(false);
    }
    return () => clearTimeout(t);
  }, [connectionState]);

  useEffect(() => {
    if (videoRef.current && broadcastId) {
      setConnectionState('connecting');
      setErrorMessage('');

      broadcastManager.joinBroadcast({
        broadcastId,
        videoElement: videoRef.current,
      });

      const video = videoRef.current;

      const handlePlaying = () => {
        setConnectionState('playing');
        setIsPlaying(true);
        setAutoplayBlocked(false);
      };

      const handleWaiting = () => {
        if (connectionStateRef.current === 'playing') {
          setConnectionState('buffering');
        }
      };

      video.addEventListener('playing', handlePlaying);
      video.addEventListener('waiting', handleWaiting);

      // Listen for manager state changes
      const originalOnStateChange = broadcastManager.onStateChange;
      const originalOnLiveStateChange = broadcastManager.onLiveStateChange;

      broadcastManager.onStateChange = (state, newMetrics) => {
        if (originalOnStateChange) originalOnStateChange(state, newMetrics);

        if (state === 'streaming' && connectionStateRef.current === 'connecting') {
          setConnectionState('preparing');
        } else if (state === 'full') {
          setConnectionState('full');
          setErrorMessage('Stream is at capacity (maximum viewer limit reached)');
        } else if (state === 'ended') {
          setConnectionState('ended');
        } else if (state === 'not_found') {
          setConnectionState('not_found');
          setErrorMessage('Broadcast not found or has already ended');
        } else if (state === 'error') {
          setConnectionState('error');
          setErrorMessage(newMetrics?.errorMessage || 'Connection error occurred');
        } else if (state === 'reconnecting') {
          setConnectionState('buffering');
        }
      };

      broadcastManager.onLiveStateChange = (liveState) => {
        if (originalOnLiveStateChange) originalOnLiveStateChange(liveState);
        if (liveState?.autoplayBlocked) {
          setAutoplayBlocked(true);
        }
      };

      return () => {
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('waiting', handleWaiting);
        broadcastManager.onStateChange = originalOnStateChange;
        broadcastManager.onLiveStateChange = originalOnLiveStateChange;
        broadcastManager.stopBroadcast();
      };
    }
  }, [broadcastId]);

  const handleRetry = () => {
    if (videoRef.current && broadcastId) {
      setConnectionState('connecting');
      setErrorMessage('');
      broadcastManager.joinBroadcast({
        broadcastId,
        videoElement: videoRef.current,
      });
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => {
        setIsPlaying(true);
        setAutoplayBlocked(false);
      }).catch((e) => {
        if (e.name === 'NotAllowedError') {
          setAutoplayBlocked(true);
        }
      });
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !videoRef.current.muted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
    setAutoplayBlocked(false);
    if (!newMuted && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      if (val === 0) {
        videoRef.current.muted = true;
        setIsMuted(true);
      } else {
        videoRef.current.muted = false;
        setIsMuted(false);
        setAutoplayBlocked(false);
      }
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 text-white">
      {/* Viewer Header */}
      <div className="flex items-center justify-between pb-4 border-b border-[#29292F]">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-xl border border-[#29292F] bg-[#141418] text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-display font-black tracking-tight text-white">
                LIVE BROADCAST
              </h1>
              {connectionState === 'playing' && (
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-neon-rose text-white shadow-sm">
                  LIVE
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-[#A1A1AA]">
              Session ID: {broadcastId}
            </p>
          </div>
        </div>

        {/* Real Viewer Count */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[#29292F] bg-[#141418] font-mono text-xs text-white">
          <Users className="w-3.5 h-3.5 text-neon-rose" />
          <span>{metrics.viewerCount || 0} watching</span>
        </div>
      </div>

      {/* ─── CONSUMER LIVE VIDEO PLAYER ─── */}
      <div
        ref={containerRef}
        className="relative group rounded-2xl overflow-hidden border border-[#29292F] bg-[#0A0A0A] aspect-video flex items-center justify-center select-none shadow-2xl"
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain cursor-pointer"
          onClick={togglePlay}
        />

        {/* State Overlays */}
        {connectionState === 'connecting' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/80 backdrop-blur-xs flex flex-col items-center justify-center gap-3 pointer-events-none">
            <div className="w-10 h-10 border-3 border-cerulean-bright border-t-transparent rounded-full animate-spin shadow-[0_0_20px_rgba(0,194,255,0.4)]" />
            <span className="text-xs font-mono text-white tracking-wide">
              Connecting to broadcast...
            </span>
          </div>
        )}

        {connectionState === 'preparing' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/70 backdrop-blur-xs flex flex-col items-center justify-center gap-3">
            <div className="w-10 h-10 border-3 border-cerulean-bright border-t-transparent rounded-full animate-spin shadow-[0_0_20px_rgba(0,194,255,0.4)]" />
            <span className="text-xs font-mono text-white tracking-wide">
              Preparing live video stream...
            </span>
            {(preparingSlow || autoplayBlocked) && (
              <button
                onClick={togglePlay}
                className="mt-2 px-5 py-2.5 rounded-xl bg-neon-rose text-white font-display font-bold text-xs uppercase tracking-wider shadow-lg hover:brightness-110 transition-all cursor-pointer flex items-center gap-2"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Tap to Play Live</span>
              </button>
            )}
          </div>
        )}

        {connectionState === 'buffering' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/50 backdrop-blur-xs flex flex-col items-center justify-center gap-3 pointer-events-none">
            <div className="w-10 h-10 border-3 border-cerulean-bright border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-mono text-white">
              Buffering stream...
            </span>
          </div>
        )}

        {connectionState === 'full' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/95 flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#1E1E26] flex items-center justify-center text-neon-rose">
              <AlertCircle className="w-6 h-6" />
            </div>
            <p className="text-base font-display font-bold text-white">Stream is at capacity</p>
            <p className="text-xs font-mono text-[#A1A1AA]">{errorMessage || 'Maximum viewer limit reached (500 viewers). Please try again later.'}</p>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={handleRetry}
                className="px-4 py-2 rounded-xl border border-cerulean text-cerulean-bright font-display font-bold text-xs uppercase cursor-pointer"
              >
                Retry
              </button>
              <button
                onClick={onBack}
                className="px-4 py-2 rounded-xl bg-cerulean text-white font-display font-bold text-xs uppercase cursor-pointer"
              >
                Return Home
              </button>
            </div>
          </div>
        )}

        {connectionState === 'ended' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/95 flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#1E1E26] flex items-center justify-center text-[#A1A1AA]">
              <AlertCircle className="w-6 h-6 text-neon-rose" />
            </div>
            <p className="text-base font-display font-bold text-white">This broadcast has ended</p>
            <p className="text-xs font-mono text-[#A1A1AA]">The broadcaster stopped transmitting.</p>
            <button
              onClick={onBack}
              className="mt-2 px-5 py-2.5 rounded-xl bg-cerulean text-white font-display font-bold text-xs uppercase cursor-pointer"
            >
              Browse Streams
            </button>
          </div>
        )}

        {connectionState === 'not_found' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/95 flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#1E1E26] flex items-center justify-center text-neon-rose">
              <AlertCircle className="w-6 h-6" />
            </div>
            <p className="text-base font-display font-bold text-white">Stream Unavailable</p>
            <p className="text-xs font-mono text-[#A1A1AA]">The broadcast session ID does not exist or has ended.</p>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={handleRetry}
                className="px-4 py-2 rounded-xl border border-cerulean text-cerulean-bright font-display font-bold text-xs uppercase cursor-pointer"
              >
                Retry
              </button>
              <button
                onClick={onBack}
                className="px-4 py-2 rounded-xl bg-cerulean text-white font-display font-bold text-xs uppercase cursor-pointer"
              >
                Return Home
              </button>
            </div>
          </div>
        )}

        {connectionState === 'error' && (
          <div className="absolute inset-0 bg-[#0A0A0A]/95 flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#1E1E26] flex items-center justify-center text-neon-rose">
              <AlertCircle className="w-6 h-6" />
            </div>
            <p className="text-base font-display font-bold text-white">Connection Error</p>
            <p className="text-xs font-mono text-[#A1A1AA]">{errorMessage || 'Could not connect to stream.'}</p>
            <button
              onClick={handleRetry}
              className="mt-2 px-5 py-2.5 rounded-xl bg-cerulean text-white font-display font-bold text-xs uppercase cursor-pointer"
            >
              Retry Connection
            </button>
          </div>
        )}

        {/* Autoplay Muted Notice */}
        {autoplayBlocked && connectionState === 'playing' && (
          <div className="absolute top-4 inset-x-4 max-w-sm mx-auto p-3 rounded-xl bg-neon-rose text-white text-xs font-bold flex items-center justify-between shadow-xl z-30">
            <span>Audio is muted by browser.</span>
            <button
              onClick={toggleMute}
              className="px-3 py-1 rounded-lg bg-white text-zinc-950 text-xs font-bold uppercase cursor-pointer"
            >
              Unmute
            </button>
          </div>
        )}

        {/* Player Controls Bar */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0A0A0A]/90 via-[#0A0A0A]/40 to-transparent p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-between z-20">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer text-white"
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            </button>

            <div className="flex items-center gap-2">
              <button
                onClick={toggleMute}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer text-white"
              >
                {isMuted ? <VolumeX className="w-4 h-4 text-neon-rose" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-20 accent-cerulean-bright h-1 cursor-pointer"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {metrics.liveLatencyMs > 0 && (
              <span className="text-xs font-mono text-cerulean-bright font-semibold">
                ~{metrics.liveLatencyMs} ms delay
              </span>
            )}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer text-white"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ─── COLLAPSIBLE DIAGNOSTICS & P2P MESH PANEL ─── */}
      <div className="rounded-2xl border border-[#29292F] bg-[#141418] overflow-hidden">
        <button
          onClick={() => setShowDiagnostics(!showDiagnostics)}
          className="w-full px-5 py-3.5 flex items-center justify-between text-xs font-mono text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <Network className="w-3.5 h-3.5 text-cerulean-bright" />
            <span>P2P Mesh Network & Stream Provenance</span>
          </span>
          {showDiagnostics ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showDiagnostics && (
          <div className="px-5 pb-5 pt-2 border-t border-[#29292F]/60 space-y-4 text-xs font-mono">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Mesh Tier</span>
                <p className="text-sm font-bold text-cerulean-bright mt-0.5">
                  {metrics.tier === null ? 'Pending' : `Tier ${metrics.tier} ${metrics.activeChildren > 0 ? '(Relay)' : '(Leaf)'}`}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Upstream Source</span>
                <p className="text-sm font-bold text-white mt-0.5">
                  {metrics.parentPeerId ? metrics.parentPeerId.slice(-8) : (metrics.tier === 1 ? 'Broadcaster (Direct)' : 'Connecting...')}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Bitrate</span>
                <p className="text-sm font-bold text-cerulean-bright mt-0.5">{metrics.bitrateKbps} kbps</p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Relaying To</span>
                <p className="text-sm font-bold text-white mt-0.5">{metrics.activeChildren} children</p>
              </div>
            </div>

            {/* Deep Technical Diagnostics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Chunks In / Fwd</span>
                <p className="text-sm font-bold text-white mt-0.5">
                  {metrics.chunksReceived || 0} / {metrics.chunksForwarded || 0}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Last Packet Age</span>
                <p className="text-sm font-bold text-white mt-0.5">
                  {metrics.lastPacketAtAgeMs != null ? `${metrics.lastPacketAtAgeMs} ms` : 'N/A'}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Decoder State</span>
                <p className={`text-sm font-bold mt-0.5 ${metrics.waitingForKeyframe ? 'text-neon-rose' : 'text-cerulean-bright'}`}>
                  {metrics.waitingForKeyframe ? 'Awaiting Keyframe' : 'Synced'}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Gaps Skipped</span>
                <p className="text-sm font-bold text-white mt-0.5">{metrics.gapsSkipped || 0}</p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F] flex items-center justify-between">
              <span className="text-[10px] text-[#A1A1AA] uppercase">ICE Transport Candidate</span>
              <span className="text-xs font-mono text-cerulean-bright font-bold">
                {metrics.selectedCandidateType || 'unknown'}
              </span>
            </div>

            {/* Downstream Children Diagnostics */}
            {metrics.childLinks && metrics.childLinks.length > 0 && (
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F] space-y-2">
                <span className="text-[10px] text-[#A1A1AA] uppercase font-bold">Connected Downstream Peers</span>
                <div className="space-y-1.5">
                  {metrics.childLinks.map((child, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[11px] py-1 border-b border-[#29292F]/40 last:border-0">
                      <span className="font-mono text-white">Peer {child.peerId.slice(-8)}</span>
                      <div className="flex items-center gap-3">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${child.open ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                          {child.open ? 'OPEN' : 'CONNECTING'}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${child.hasSynced ? 'bg-cerulean/20 text-cerulean-bright' : 'bg-zinc-700 text-zinc-300'}`}>
                          {child.hasSynced ? 'SYNCED' : 'SYNCING'}
                        </span>
                        <span className="text-[#A1A1AA] text-[10px]">
                          Q: {child.queuedPackets}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {metrics.fingerprint && (
              <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F] space-y-1">
                <div className="flex items-center gap-1.5 text-cerulean-bright">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span className="font-bold text-[10px] uppercase">Verified Origin Fingerprint</span>
                </div>
                <p className="text-[11px] text-[#A1A1AA] break-all select-all">{metrics.fingerprint}</p>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button
                onClick={onOpenTopology}
                className="px-3.5 py-1.5 rounded-lg border border-cerulean/40 bg-cerulean/10 hover:bg-cerulean/20 text-cerulean-bright text-xs font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Network className="w-3.5 h-3.5" />
                <span>Open Visual Mesh Graph</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
