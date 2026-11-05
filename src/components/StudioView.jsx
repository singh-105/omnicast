import React, { useState, useRef, useEffect } from 'react';
import {
  Video,
  Mic,
  MicOff,
  Monitor,
  Copy,
  Check,
  Users,
  ShieldCheck,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Clock,
  Layers,
  Activity,
  Zap,
  Globe,
} from 'lucide-react';

export const StudioView = ({
  onBack,
  broadcastManager,
  metrics,
}) => {
  const [streamType, setStreamType] = useState('camera'); // 'camera' | 'screen'
  const [streamTitle, setStreamTitle] = useState('My OmniCast Live Stream');
  const [isLive, setIsLive] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeStream, setActiveStream] = useState(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [durationSecs, setDurationSecs] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [localMetrics, setLocalMetrics] = useState(metrics || {});
  const [availableCameras, setAvailableCameras] = useState([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');

  // Discover and enumerate available cameras
  useEffect(() => {
    async function loadCameras() {
      if (navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter((d) => d.kind === 'videoinput');
          setAvailableCameras(videoInputs);
          if (videoInputs.length > 0 && !selectedCameraId) {
            // Prioritize standard color webcams over Windows Hello IR sensors
            const nonIr = videoInputs.find((d) => d.label && !/ir\b|infrared/i.test(d.label));
            setSelectedCameraId(nonIr ? nonIr.deviceId : videoInputs[0].deviceId);
          }
        } catch (_) {}
      }
    }
    loadCameras();
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', loadCameras);
      return () => navigator.mediaDevices.removeEventListener('devicechange', loadCameras);
    }
  }, []);

  useEffect(() => {
    if (!broadcastManager) return;
    const orig = broadcastManager.onMetrics;
    broadcastManager.onMetrics = (m) => {
      if (orig) orig(m);
      setLocalMetrics({ ...m });
    };
    return () => {
      broadcastManager.onMetrics = orig;
    };
  }, [broadcastManager]);

  const displayMetrics = { ...metrics, ...localMetrics, ...(broadcastManager?.metrics || {}) };

  const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const maxChildren = parseInt(urlParams.get('maxChildren') || '5', 10);

  const localVideoRef = useRef(null);

  // Bind video stream to preview
  useEffect(() => {
    if (localVideoRef.current && activeStream) {
      localVideoRef.current.srcObject = activeStream;
    }
  }, [activeStream]);

  // Handle stream changed from manager (e.g. native browser stop-sharing reversion)
  useEffect(() => {
    if (broadcastManager) {
      broadcastManager.onStreamChanged = (newStream, newType) => {
        setActiveStream(newStream);
        setStreamType(newType);
      };
    }
  }, [broadcastManager]);

  // Live stream duration counter
  useEffect(() => {
    let interval = null;
    if (isLive) {
      interval = setInterval(() => {
        setDurationSecs((prev) => prev + 1);
      }, 1000);
    } else {
      setDurationSecs(0);
    }
    return () => clearInterval(interval);
  }, [isLive]);

  const formatDuration = (totalSeconds) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleStartBroadcast = async () => {
    setErrorMsg('');
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const maxChildren = parseInt(urlParams.get('maxChildren') || '5', 10);
      const res = await broadcastManager.startBroadcast({
        title: streamTitle,
        type: streamType,
        maxChildren,
        deviceId: streamType === 'camera' ? selectedCameraId : null,
      });
      setActiveStream(res.stream);
      setIsLive(true);
      // Re-enumerate to get fresh device labels once permission is active
      if (navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        setAvailableCameras(videoInputs);
      }
    } catch (err) {
      console.error('[Studio] Start broadcast error:', err);
      setErrorMsg(err.message || 'Failed to start broadcast');
    }
  };

  const handleCameraChange = async (newDeviceId) => {
    setSelectedCameraId(newDeviceId);
    if (isLive && streamType === 'camera') {
      try {
        const res = await broadcastManager.switchSource({ type: 'camera', deviceId: newDeviceId });
        if (res?.stream) {
          setActiveStream(res.stream);
        }
      } catch (err) {
        console.warn('[Studio] Camera switch error:', err);
        setErrorMsg(`Failed to switch camera: ${err.message}`);
      }
    }
  };

  const handleStopBroadcast = () => {
    broadcastManager.stopBroadcast();
    if (activeStream) {
      activeStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
      setActiveStream(null);
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setIsLive(false);
  };

  const handleSwitchSource = async (newType) => {
    if (newType === streamType) return;
    setErrorMsg('');

    if (isLive) {
      try {
        const res = await broadcastManager.switchSource({
          type: newType,
          deviceId: newType === 'camera' ? selectedCameraId : null,
        });
        if (res) {
          setStreamType(res.type);
          setActiveStream(res.stream);
        }
      } catch (err) {
        console.error('[Studio] Source switch error:', err);
        setErrorMsg(err.message || 'Failed to switch source');
      }
    } else {
      setStreamType(newType);
    }
  };

  const toggleAudio = () => {
    if (activeStream) {
      activeStream.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsAudioMuted(!isAudioMuted);
    }
  };

  const getViewerUrl = () => {
    if (!broadcastManager.broadcastId) return '';
    const publicUrl = import.meta.env.VITE_PUBLIC_URL || (typeof window !== 'undefined' ? window.OMNICAST_PUBLIC_URL : null);
    const base = publicUrl ? publicUrl.replace(/\/$/, '') : window.location.origin;
    return `${base}/watch/${broadcastManager.broadcastId}`;
  };

  const isLocalLink = typeof window !== 'undefined' &&
    !import.meta.env.VITE_PUBLIC_URL &&
    !window.OMNICAST_PUBLIC_URL &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const copyViewerUrl = () => {
    const url = getViewerUrl();
    if (url) {
      navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 text-white">
      {/* Studio Header Bar */}
      <div className="flex items-center justify-between pb-4 border-b border-[#29292F]">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-xl border border-[#29292F] bg-[#141418] text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-display font-black tracking-tight text-white">
              BROADCASTER STUDIO
            </h1>
            <p className="text-xs font-mono text-[#A1A1AA]">
              {isLive ? `Live Session: ${broadcastManager.broadcastId}` : 'Standby · Ready to Broadcast'}
            </p>
          </div>
        </div>

        {/* Live Status Indicator (Only One) */}
        {isLive && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono font-bold bg-neon-rose/15 text-neon-rose border border-neon-rose/30 shadow-[0_0_12px_rgba(255,45,149,0.3)]">
              <span className="w-2 h-2 rounded-full bg-neon-rose animate-ping" />
              <span>LIVE · ON AIR</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-mono text-[#A1A1AA]">
              <Clock className="w-3.5 h-3.5 text-cerulean-bright" />
              <span>{formatDuration(durationSecs)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Error Banner */}
      {errorMsg && (
        <div className="p-4 rounded-xl border border-neon-rose/40 bg-neon-rose/10 text-xs font-mono text-neon-rose flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="font-bold underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Studio Workspace: 16:9 Video Monitor + Right Settings Column */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: 16:9 Video Monitor */}
        <div className="lg:col-span-8 space-y-4">
          <div className="relative aspect-video rounded-2xl overflow-hidden border border-[#29292F] bg-[#0A0A0A] flex items-center justify-center shadow-2xl">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
            />

            {/* Standby Placeholder when camera is inactive */}
            {!isLive && !activeStream && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0A0A0A]">
                <div className="w-16 h-16 rounded-2xl bg-[#141418] border border-[#29292F] flex items-center justify-center text-[#A1A1AA]">
                  {streamType === 'screen' ? <Monitor className="w-8 h-8" /> : <Video className="w-8 h-8" />}
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-display font-bold text-white">Preview Off</p>
                  <p className="text-xs font-mono text-[#A1A1AA]">
                    Click &ldquo;Start Live Broadcast&rdquo; to activate your {streamType === 'screen' ? 'screen' : 'camera'}
                  </p>
                </div>
              </div>
            )}

            {/* Single Top-Left LIVE Badge on active stream */}
            {isLive && (
              <div className="absolute top-4 left-4 flex items-center gap-2">
                <div className="px-2.5 py-1 rounded-lg bg-[#0A0A0A]/85 backdrop-blur-md text-xs font-mono font-bold text-neon-rose border border-neon-rose/40 flex items-center gap-1.5 shadow-lg">
                  <span className="w-2 h-2 rounded-full bg-neon-rose animate-ping" />
                  <span>ON AIR</span>
                </div>
                <div className="px-2.5 py-1 rounded-lg bg-[#0A0A0A]/85 backdrop-blur-md text-xs font-mono text-white border border-[#29292F]">
                  {formatDuration(durationSecs)}
                </div>
              </div>
            )}
          </div>

          {/* Source Controls Under Video */}
          <div className="p-4 rounded-xl border border-[#29292F] bg-[#141418] flex flex-wrap items-center justify-between gap-4">
            {/* Camera vs Screen Share Switcher */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-[#A1A1AA] mr-1">Source:</span>
              <button
                type="button"
                onClick={() => handleSwitchSource('camera')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  streamType === 'camera'
                    ? 'bg-cerulean text-white shadow-[0_0_12px_rgba(0,123,167,0.4)]'
                    : 'bg-[#1E1E26] text-[#A1A1AA] hover:text-white border border-[#29292F]'
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                <span>Camera</span>
              </button>

              {streamType === 'camera' && availableCameras.length > 1 && (
                <select
                  value={selectedCameraId}
                  onChange={(e) => handleCameraChange(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-mono bg-[#1E1E26] text-white border border-[#29292F] focus:border-cerulean outline-none cursor-pointer max-w-[200px] truncate"
                  title="Select Camera Device"
                >
                  {availableCameras.map((cam, idx) => (
                    <option key={cam.deviceId || idx} value={cam.deviceId}>
                      {cam.label || `Camera ${idx + 1}`}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => handleSwitchSource('screen')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  streamType === 'screen'
                    ? 'bg-cerulean text-white shadow-[0_0_12px_rgba(0,123,167,0.4)]'
                    : 'bg-[#1E1E26] text-[#A1A1AA] hover:text-white border border-[#29292F]'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span>Screen Share</span>
              </button>
            </div>

            {/* Mic Toggle */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggleAudio}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  isAudioMuted
                    ? 'bg-neon-rose/20 text-neon-rose border border-neon-rose/40'
                    : 'bg-[#1E1E26] text-white border border-[#29292F]'
                }`}
              >
                {isAudioMuted ? <MicOff className="w-3.5 h-3.5 text-neon-rose" /> : <Mic className="w-3.5 h-3.5 text-cerulean-bright" />}
                <span>{isAudioMuted ? 'Mic Muted' : 'Mic Active'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Broadcast Controls & Share Link */}
        <div className="lg:col-span-4 space-y-4">
          {/* Broadcast Settings Card */}
          <div className="p-5 rounded-2xl border border-[#29292F] bg-[#141418] space-y-4">
            <div>
              <label className="block text-xs font-mono text-[#A1A1AA] uppercase tracking-wider mb-1.5">
                Stream Title
              </label>
              <input
                type="text"
                disabled={isLive}
                value={streamTitle}
                onChange={(e) => setStreamTitle(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#29292F] bg-[#0A0A0A] text-xs font-mono text-white focus:outline-none focus:border-cerulean-bright disabled:opacity-60"
                placeholder="Name your broadcast..."
              />
            </div>

            {/* Single Start / End Action Button */}
            {!isLive ? (
              <button
                onClick={handleStartBroadcast}
                className="w-full py-3.5 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-xs uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(0,123,167,0.3)] active:scale-95 cursor-pointer flex items-center justify-center gap-2"
              >
                <Video className="w-4 h-4" />
                <span>Start Live Broadcast</span>
              </button>
            ) : (
              <button
                onClick={handleStopBroadcast}
                className="w-full py-3.5 rounded-xl bg-neon-rose hover:bg-rose-600 text-white font-display font-bold text-xs uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(255,45,149,0.3)] active:scale-95 cursor-pointer flex items-center justify-center gap-2"
              >
                <span>End Broadcast</span>
              </button>
            )}
          </div>

          {/* Audience Share Link Card */}
          {isLive && (
            <div className="p-5 rounded-2xl border border-[#29292F] bg-[#141418] space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Viewer Share Link
                </span>
                <span className="text-xs font-mono text-neon-rose font-bold flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {displayMetrics.viewerCount || 0} Viewers
                </span>
              </div>

              {isLocalLink && (
                <div className="p-3 rounded-xl bg-cerulean/10 border border-cerulean/20 text-[11px] font-mono text-cerulean-bright flex items-start gap-2">
                  <Globe className="w-4 h-4 shrink-0 mt-0.5 text-cerulean-bright" />
                  <span className="leading-relaxed">
                    Local Network Link · Audience on this computer or LAN can join. For internet audiences, share from your public domain or tunnel.
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={getViewerUrl()}
                  className="w-full px-3 py-2 rounded-xl border border-[#29292F] bg-[#0A0A0A] text-xs font-mono text-[#A1A1AA] truncate focus:outline-none select-all"
                />
                <button
                  onClick={copyViewerUrl}
                  className="px-3.5 py-2 rounded-xl border border-cerulean/40 bg-cerulean/10 hover:bg-cerulean/20 text-cerulean-bright text-xs font-mono font-bold flex items-center gap-1 cursor-pointer shrink-0 transition-colors"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedLink ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Quick Metrics */}
          {isLive && (
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-3.5 rounded-xl border border-[#29292F] bg-[#141418] space-y-1">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Audience</span>
                <p className="text-base font-bold text-white">{displayMetrics.viewerCount || 0} watching</p>
              </div>
              <div className="p-3.5 rounded-xl border border-[#29292F] bg-[#141418] space-y-1">
                <span className="text-[10px] text-[#A1A1AA] uppercase">Direct Children</span>
                <p className="text-base font-bold text-cerulean-bright">{displayMetrics.activeChildren || 0} / {maxChildren} max</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── OPTIONAL COLLAPSIBLE TECHNICAL DIAGNOSTICS ─── */}
      {isLive && (
        <div className="rounded-2xl border border-[#29292F] bg-[#141418] overflow-hidden">
          <button
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="w-full px-5 py-3.5 flex items-center justify-between text-xs font-mono text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-cerulean-bright" />
              <span>Technical Diagnostics & Origin Provenance</span>
            </span>
            {showDiagnostics ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showDiagnostics && (
            <div className="px-5 pb-5 pt-2 border-t border-[#29292F]/60 space-y-4 text-xs font-mono">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                  <span className="text-[10px] text-[#A1A1AA] uppercase">Upload Rate</span>
                  <p className="text-sm font-bold text-cerulean-bright mt-0.5">{displayMetrics.bitrateKbps || 0} kbps</p>
                </div>
                <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                  <span className="text-[10px] text-[#A1A1AA] uppercase">Emitted Chunks</span>
                  <p className="text-sm font-bold text-white mt-0.5">{displayMetrics.chunksEmitted || 0}</p>
                </div>
                <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                  <span className="text-[10px] text-[#A1A1AA] uppercase">Bytes Out</span>
                  <p className="text-sm font-bold text-white mt-0.5">{((displayMetrics.bytesSent || 0) / 1024).toFixed(1)} KB</p>
                </div>
                <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F]">
                  <span className="text-[10px] text-[#A1A1AA] uppercase">Mesh Fanout</span>
                  <p className="text-sm font-bold text-white mt-0.5">{displayMetrics.activeChildren || 0} Tier-1 Nodes</p>
                </div>
              </div>

              {(displayMetrics.fingerprint || broadcastManager.originFingerprint) && (
                <div className="p-3 rounded-lg bg-[#0A0A0A] border border-[#29292F] space-y-1">
                  <div className="flex items-center gap-1.5 text-cerulean-bright">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span className="font-bold text-[10px] uppercase">ECDSA P-256 Origin Fingerprint</span>
                  </div>
                  <p className="text-[11px] text-[#A1A1AA] break-all select-all">{displayMetrics.fingerprint || broadcastManager.originFingerprint}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
