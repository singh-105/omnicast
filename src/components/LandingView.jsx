import React, { useState } from 'react';
import {
  Video,
  Play,
  Users,
  Search,
  Tv,
  Radio,
  Clock,
  ArrowRight,
} from 'lucide-react';

export const LandingView = ({
  onGoToStudio,
  onGoToExplore,
  onJoinStream,
  activeBroadcasts = [],
}) => {
  const [streamInput, setStreamInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const handleManualJoin = (e) => {
    e.preventDefault();
    if (!streamInput.trim()) return;

    let bcastId = streamInput.trim();
    if (bcastId.includes('/watch/')) {
      const parts = bcastId.split('/watch/');
      if (parts[1]) {
        bcastId = parts[1].split('?')[0].split('/')[0].trim();
      }
    } else if (bcastId.includes('watch=')) {
      bcastId = bcastId.split('watch=')[1].split('&')[0].trim();
    }
    onJoinStream(bcastId);
  };

  const featuredStream = activeBroadcasts.length > 0 ? activeBroadcasts[0] : null;
  const filteredStreams = activeBroadcasts.filter((b) =>
    (b.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (b.broadcastId || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-16 pb-24 text-white">
      {/* ─── FEATURED LIVE HERO (PRIME VIDEO / NETFLIX STYLE) ─── */}
      <section className="relative w-full">
        {featuredStream ? (
          /* Live Stream Featured Billboard */
          <div className="relative w-full min-h-[480px] sm:min-h-[540px] lg:min-h-[600px] flex items-center bg-[#111115] overflow-hidden border-b border-[#29292F]">
            {/* Cinematic Gradient Backdrop */}
            <div className="absolute inset-0 bg-gradient-to-r from-[#0A0A0A] via-[#0A0A0A]/85 to-transparent z-10" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-transparent to-transparent z-10" />

            {/* Ambient Lighting Accents */}
            <div className="absolute -top-24 right-1/4 w-[500px] h-[500px] bg-cerulean/20 rounded-full blur-[140px] pointer-events-none" />
            <div className="absolute -bottom-24 right-10 w-[400px] h-[400px] bg-neon-rose/15 rounded-full blur-[120px] pointer-events-none" />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 relative z-20 w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              <div className="lg:col-span-7 space-y-6">
                {/* Live Badge & Category */}
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-neon-rose text-white shadow-[0_0_15px_rgba(255,45,149,0.5)]">
                    <span className="w-2 h-2 rounded-full bg-white animate-ping" />
                    LIVE NOW
                  </span>
                  <span className="text-xs font-mono text-[#A1A1AA] uppercase tracking-wider">
                    Featured Broadcast
                  </span>
                </div>

                {/* Stream Title */}
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-display font-black tracking-tight text-white leading-tight">
                  {featuredStream.title || 'Live OmniCast Stream'}
                </h1>

                {/* Stream Metadata */}
                <div className="flex items-center gap-6 text-xs font-mono text-[#A1A1AA]">
                  <span className="flex items-center gap-1.5 text-white">
                    <Users className="w-4 h-4 text-neon-rose" />
                    <span className="font-bold">{featuredStream.viewerCount || 1}</span> Viewers
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-cerulean-bright" />
                    Streaming Live
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#18181E] border border-[#29292F] text-xs">
                    HD
                  </span>
                </div>

                <p className="text-sm sm:text-base text-[#A1A1AA] max-w-xl line-clamp-3">
                  Stream ID: <span className="font-mono text-white">{featuredStream.broadcastId}</span>. Broadcasted directly via browser WebRTC DataChannels.
                </p>

                {/* Primary Actions */}
                <div className="flex flex-wrap items-center gap-4 pt-2">
                  <button
                    onClick={() => onJoinStream(featuredStream.broadcastId)}
                    className="px-8 py-3.5 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-sm uppercase tracking-wider flex items-center gap-2.5 transition-all shadow-[0_0_25px_rgba(0,123,167,0.4)] active:scale-95 cursor-pointer"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>Watch Now</span>
                  </button>
                  <button
                    onClick={onGoToStudio}
                    className="px-6 py-3.5 rounded-xl border border-[#29292F] hover:border-white/40 bg-[#18181E] text-white font-display font-semibold text-sm transition-colors cursor-pointer"
                  >
                    Start Your Stream
                  </button>
                </div>
              </div>

              {/* Right Side: Visual Stream Preview Card */}
              <div className="lg:col-span-5 hidden lg:block">
                <div
                  onClick={() => onJoinStream(featuredStream.broadcastId)}
                  className="group relative aspect-video rounded-2xl overflow-hidden border border-[#29292F] bg-[#141418] cursor-pointer shadow-2xl transition-all hover:scale-[1.02] hover:border-cerulean"
                >
                  <div className="absolute inset-0 bg-gradient-to-tr from-[#0A0A0A] via-transparent to-cerulean/10" />
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <div className="w-16 h-16 rounded-full bg-cerulean/20 border border-cerulean-bright/50 flex items-center justify-center text-cerulean-bright group-hover:scale-110 transition-transform shadow-[0_0_20px_rgba(0,194,255,0.4)]">
                      <Play className="w-7 h-7 fill-current ml-1" />
                    </div>
                    <span className="text-xs font-mono font-bold uppercase tracking-widest text-[#A1A1AA] group-hover:text-white transition-colors">
                      Click to Watch
                    </span>
                  </div>
                  <div className="absolute top-4 left-4">
                    <span className="px-2.5 py-1 rounded bg-neon-rose text-white text-[11px] font-mono font-bold uppercase">
                      LIVE
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Brand Hero Billboard When No Stream Is Active */
          <div className="relative w-full min-h-[460px] sm:min-h-[520px] flex items-center bg-[#0F0F12] overflow-hidden border-b border-[#29292F]">
            {/* Dark Ambient Lighting */}
            <div className="absolute top-0 right-1/4 w-[600px] h-[600px] bg-cerulean/15 rounded-full blur-[160px] pointer-events-none" />
            <div className="absolute bottom-0 left-1/3 w-[500px] h-[500px] bg-neon-rose/10 rounded-full blur-[140px] pointer-events-none" />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 relative z-10 w-full">
              <div className="max-w-3xl space-y-6">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#141418] border border-[#29292F] text-[#A1A1AA]">
                  <span className="w-2 h-2 rounded-full bg-cerulean-bright animate-pulse" />
                  <span>Next-Generation Live Streaming</span>
                </div>

                <h1 className="text-4xl sm:text-6xl font-display font-black tracking-tight text-white leading-tight">
                  LIVE STREAMING, <br />
                  <span className="text-cerulean-bright">POWERED BY PEERS.</span>
                </h1>

                <p className="text-base sm:text-lg text-[#A1A1AA] leading-relaxed max-w-2xl">
                  Broadcast camera or screen directly from your browser to global audiences.
                  Streamlined, high-definition, and built with decentralized WebRTC DataChannel tree cascades.
                </p>

                {/* Primary Actions */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 pt-2">
                  <button
                    onClick={onGoToStudio}
                    className="px-8 py-4 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-[0_0_25px_rgba(0,123,167,0.3)] active:scale-95 cursor-pointer"
                  >
                    <Video className="w-4 h-4" />
                    <span>Go Live Now</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>

                  <form onSubmit={handleManualJoin} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Enter Stream ID / URL..."
                      value={streamInput}
                      onChange={(e) => setStreamInput(e.target.value)}
                      className="px-4 py-4 rounded-xl border border-[#29292F] bg-[#141418] text-white placeholder-[#A1A1AA]/50 text-xs font-mono w-full sm:w-64 focus:outline-none focus:border-cerulean-bright transition-colors"
                    />
                    <button
                      type="submit"
                      disabled={!streamInput.trim()}
                      className="px-5 py-4 rounded-xl font-display font-bold text-xs uppercase tracking-wider text-cerulean-bright border border-cerulean/40 bg-[#141418] hover:bg-cerulean/10 hover:border-cerulean-bright transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    >
                      Watch
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ─── LIVE STREAMS ROW (PRIME VIDEO / NETFLIX HORIZONTAL BROWSE) ─── */}
      <section id="explore-streams" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-display font-black tracking-tight text-white flex items-center gap-2.5">
              <span>Live Streams</span>
              {activeBroadcasts.length > 0 && (
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-neon-rose/15 text-neon-rose border border-neon-rose/30">
                  {activeBroadcasts.length}
                </span>
              )}
            </h2>
            <p className="text-xs text-[#A1A1AA] font-mono mt-1">
              Real-time decentralized broadcasts streaming right now
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            {onGoToExplore && (
              <button
                onClick={onGoToExplore}
                className="text-xs font-mono font-bold text-cerulean-bright hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer px-3 py-2 rounded-lg bg-[#141418] border border-[#29292F]"
              >
                <span>Open Explore</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Search Filter */}
            {activeBroadcasts.length > 1 && (
              <div className="relative w-full sm:w-64">
                <Search className="w-4 h-4 text-[#A1A1AA] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter streams..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 rounded-xl border border-[#29292F] bg-[#141418] text-xs font-mono text-white placeholder-[#A1A1AA]/50 focus:outline-none focus:border-cerulean-bright"
                />
              </div>
            )}
          </div>
        </div>

        {/* Stream Cards Grid */}
        {filteredStreams.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredStreams.map((bcast) => (
              <div
                key={bcast.broadcastId}
                onClick={() => onJoinStream(bcast.broadcastId)}
                className="group relative rounded-2xl overflow-hidden border border-[#29292F] bg-[#141418] hover:border-cerulean transition-all duration-300 cursor-pointer flex flex-col hover:shadow-[0_0_30px_rgba(0,123,167,0.2)]"
              >
                {/* 16:9 Thumbnail Area */}
                <div className="relative aspect-video bg-[#0A0A0A] flex items-center justify-center overflow-hidden border-b border-[#29292F]">
                  <div className="w-12 h-12 rounded-full bg-cerulean/20 border border-cerulean-bright/40 flex items-center justify-center text-cerulean-bright group-hover:scale-110 transition-transform">
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                  </div>

                  {/* Badges */}
                  <div className="absolute top-3 left-3">
                    <span className="px-2 py-0.5 rounded bg-neon-rose text-white font-mono font-bold text-[10px] uppercase flex items-center gap-1 shadow-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                      LIVE
                    </span>
                  </div>

                  <div className="absolute bottom-3 right-3 px-2 py-0.5 rounded bg-[#0A0A0A]/80 backdrop-blur-xs font-mono text-[10px] text-[#A1A1AA] border border-[#29292F]">
                    {bcast.viewerCount || 1} watching
                  </div>
                </div>

                {/* Card Info */}
                <div className="p-4 space-y-2 flex-1 flex flex-col justify-between">
                  <div>
                    <h3 className="font-display font-bold text-sm text-white group-hover:text-cerulean-bright transition-colors line-clamp-1">
                      {bcast.title || 'Live Stream'}
                    </h3>
                    <p className="text-xs font-mono text-[#A1A1AA] truncate mt-1">
                      ID: {bcast.broadcastId}
                    </p>
                  </div>

                  <div className="pt-2 flex items-center justify-between text-xs font-mono border-t border-[#29292F]/60 text-[#A1A1AA]">
                    <span>Broadcaster: {bcast.originPeerId ? bcast.originPeerId.slice(-8) : 'Origin'}</span>
                    <span className="text-cerulean-bright font-semibold group-hover:underline">Watch &rarr;</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Polished OTT Empty State */
          <div className="p-12 rounded-3xl border border-[#29292F] bg-[#141418] text-center space-y-5 max-w-xl mx-auto my-8">
            <div className="w-16 h-16 rounded-2xl bg-[#1E1E26] border border-[#29292F] flex items-center justify-center mx-auto text-[#A1A1AA]">
              <Tv className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-display font-bold text-white">
                No active live broadcasts right now
              </h3>
              <p className="text-xs font-mono text-[#A1A1AA]">
                Start your own stream to begin broadcasting to viewers worldwide.
              </p>
            </div>
            <button
              onClick={onGoToStudio}
              className="px-6 py-3 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-xs uppercase tracking-wider inline-flex items-center gap-2 transition-all cursor-pointer shadow-md"
            >
              <Video className="w-4 h-4" />
              <span>Go Live In Studio</span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
