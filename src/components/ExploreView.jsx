import React, { useState } from 'react';
import {
  Search,
  Video,
  Play,
  Users,
  Clock,
  Radio,
  ArrowRight,
  RefreshCw,
  Tv,
  ExternalLink,
} from 'lucide-react';

export const ExploreView = ({
  activeBroadcasts = [],
  onJoinStream,
  onGoToStudio,
  onRefreshBroadcasts,
  isLoading = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [directInput, setDirectInput] = useState('');

  const parseStreamInput = (input) => {
    let raw = input.trim();
    if (!raw) return '';
    // Handle full URLs like https://host/watch/omni-123 or http://localhost:5173/?watch=omni-123
    if (raw.includes('/watch/')) {
      const parts = raw.split('/watch/');
      if (parts[1]) {
        return parts[1].split('?')[0].split('/')[0].trim();
      }
    }
    if (raw.includes('watch=')) {
      return raw.split('watch=')[1].split('&')[0].trim();
    }
    return raw;
  };

  const handleDirectJoin = (e) => {
    e.preventDefault();
    const bcastId = parseStreamInput(directInput);
    if (bcastId) {
      onJoinStream(bcastId);
    }
  };

  const filteredBroadcasts = activeBroadcasts.filter((b) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    const title = (b.title || '').toLowerCase();
    const id = (b.broadcastId || '').toLowerCase();
    const peer = (b.originPeerId || '').toLowerCase();
    return title.includes(q) || id.includes(q) || peer.includes(q);
  });

  const formatStartedTime = (createdAt) => {
    if (!createdAt) return 'Just now';
    const elapsedSecs = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
    if (isNaN(elapsedSecs) || elapsedSecs < 60) return 'Just started';
    const mins = Math.floor(elapsedSecs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10 text-white animate-fadeIn">
      {/* ─── PAGE HEADER & DISCOVERY HERO ─── */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-[#29292F]">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#141418] border border-[#29292F] text-[#A1A1AA]">
            <Radio className="w-3.5 h-3.5 text-cerulean-bright animate-pulse" />
            <span>Decentralized Live Mesh</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-display font-black tracking-tight text-white">
            EXPLORE LIVE STREAMS
          </h1>
          <p className="text-sm text-[#A1A1AA] max-w-xl">
            Watch real-time live video relayed directly between browser peers via WebRTC DataChannels.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onRefreshBroadcasts) onRefreshBroadcasts();
            }}
            disabled={isLoading}
            className="p-3 rounded-xl border border-[#29292F] bg-[#141418] hover:bg-[#18181E] active:scale-95 text-[#A1A1AA] hover:text-white transition-all cursor-pointer disabled:opacity-50"
            title="Refresh active broadcasts"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-cerulean-bright' : ''}`} />
          </button>
          <button
            onClick={onGoToStudio}
            className="px-5 py-3 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(0,123,167,0.3)] active:scale-95 cursor-pointer shrink-0"
          >
            <Video className="w-4 h-4" />
            <span>Go Live</span>
          </button>
        </div>
      </div>

      {/* ─── SEARCH & DIRECT JOIN SECTION ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Real-Time Filter Search */}
        <div className="lg:col-span-7 relative">
          <Search className="w-4 h-4 text-[#A1A1AA] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search streams by title, stream ID, or broadcaster..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-3.5 rounded-xl border border-[#29292F] bg-[#141418] text-white placeholder-[#A1A1AA]/50 text-xs font-mono focus:outline-none focus:border-cerulean-bright transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-mono text-[#A1A1AA] hover:text-white px-2 py-1"
            >
              Clear
            </button>
          )}
        </div>

        {/* Direct Link / ID Join Box */}
        <form onSubmit={handleDirectJoin} className="lg:col-span-5 flex items-center gap-2">
          <input
            type="text"
            placeholder="Paste stream link or ID (e.g. omni-...)..."
            value={directInput}
            onChange={(e) => setDirectInput(e.target.value)}
            className="w-full px-4 py-3.5 rounded-xl border border-[#29292F] bg-[#141418] text-white placeholder-[#A1A1AA]/50 text-xs font-mono focus:outline-none focus:border-neon-rose/70 transition-colors"
          />
          <button
            type="submit"
            disabled={!directInput.trim()}
            className="px-5 py-3.5 rounded-xl font-display font-bold text-xs uppercase tracking-wider text-white bg-gradient-to-r from-neon-rose to-rose-600 hover:from-rose-500 hover:to-neon-rose transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0 shadow-[0_0_15px_rgba(255,45,149,0.3)] active:scale-95 flex items-center gap-1.5"
          >
            <span>Watch</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>

      {/* ─── BROADCASTS GRID / FEED ─── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-[#A1A1AA] uppercase tracking-wider">
            {filteredBroadcasts.length} {filteredBroadcasts.length === 1 ? 'Stream Available' : 'Streams Available'}
          </span>
          {searchQuery && (
            <span className="text-cerulean-bright">
              Filtering for "{searchQuery}"
            </span>
          )}
        </div>

        {filteredBroadcasts.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredBroadcasts.map((bcast) => {
              const viewerCount = bcast.viewerCount || 0;
              return (
                <div
                  key={bcast.broadcastId}
                  onClick={() => onJoinStream(bcast.broadcastId)}
                  className="group rounded-2xl border border-[#29292F] bg-[#141418] hover:border-cerulean-bright/50 overflow-hidden cursor-pointer transition-all duration-200 hover:scale-[1.02] shadow-lg flex flex-col"
                >
                  {/* Visual Card Header / Thumbnail Area */}
                  <div className="relative aspect-video w-full bg-[#0A0A0A] overflow-hidden flex items-center justify-center border-b border-[#29292F]">
                    {/* Dark gradient backdrop */}
                    <div className="absolute inset-0 bg-gradient-to-tr from-[#0A0A0A] via-[#111115] to-[#18181E]" />
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cerulean/15 via-transparent to-transparent opacity-60" />

                    {/* Cyber Grid Lines Effect */}
                    <div className="absolute inset-0 opacity-10 bg-[linear-gradient(to_right,#808080_1px,transparent_1px),linear-gradient(to_bottom,#808080_1px,transparent_1px)] bg-[size:24px_24px]" />

                    {/* Play Hover Overlay */}
                    <div className="relative z-10 w-12 h-12 rounded-full bg-cerulean/20 border border-cerulean-bright/60 flex items-center justify-center text-cerulean-bright group-hover:scale-110 group-hover:bg-cerulean group-hover:text-zinc-950 transition-all shadow-[0_0_20px_rgba(0,194,255,0.3)]">
                      <Play className="w-5 h-5 fill-current ml-0.5" />
                    </div>

                    {/* Live Badge */}
                    <div className="absolute top-3 left-3 z-10">
                      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-bold bg-neon-rose text-white shadow-[0_0_12px_rgba(255,45,149,0.4)]">
                        <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                        LIVE
                      </span>
                    </div>

                    {/* Viewer Counter */}
                    <div className="absolute top-3 right-3 z-10">
                      <span className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-mono font-semibold bg-[#0A0A0A]/85 backdrop-blur-md border border-[#29292F] text-[#F5F5F7]">
                        <Users className="w-3 h-3 text-neon-rose" />
                        <span>{viewerCount}</span>
                      </span>
                    </div>

                    {/* Codec / Resolution Badge */}
                    <div className="absolute bottom-2.5 right-3 z-10">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#0A0A0A]/80 border border-[#29292F] text-[#A1A1AA]">
                        HD · 30 FPS
                      </span>
                    </div>
                  </div>

                  {/* Card Content */}
                  <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                    <div className="space-y-1.5">
                      <h3 className="font-display font-bold text-base text-white group-hover:text-cerulean-bright transition-colors line-clamp-1">
                        {bcast.title || 'Live OmniCast Stream'}
                      </h3>
                      <div className="flex items-center gap-2 text-xs font-mono text-[#A1A1AA]">
                        <span className="truncate max-w-[140px] text-[#A1A1AA]/80">
                          {bcast.broadcastId}
                        </span>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-cerulean-bright" />
                          {formatStartedTime(bcast.createdAt)}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2 flex items-center justify-between border-t border-[#29292F]/60 text-xs font-mono">
                      <span className="text-[11px] text-[#A1A1AA]/60 truncate max-w-[120px]">
                        By {bcast.originPeerId ? bcast.originPeerId.slice(-8) : 'Origin'}
                      </span>
                      <span className="text-cerulean-bright font-bold flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                        <span>Watch Live</span>
                        <ArrowRight className="w-3 h-3" />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty State */
          <div className="rounded-2xl border border-[#29292F] bg-[#111115] p-12 text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-[#18181E] border border-[#29292F] flex items-center justify-center mx-auto text-[#A1A1AA]">
              <Tv className="w-8 h-8 text-cerulean-bright/70" />
            </div>

            <div className="max-w-md mx-auto space-y-2">
              <h3 className="text-lg font-display font-bold text-white">
                {searchQuery ? 'No Matching Broadcasts Found' : 'No Live Broadcasts Active'}
              </h3>
              <p className="text-xs text-[#A1A1AA] leading-relaxed">
                {searchQuery
                  ? `No active streams match your query "${searchQuery}". Check the Stream ID or clear the search to view all.`
                  : 'The decentralized peer mesh is standing by. Be the first creator to launch a live broadcast to audiences worldwide.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              {searchQuery ? (
                <button
                  onClick={() => setSearchQuery('')}
                  className="px-5 py-2.5 rounded-xl border border-[#29292F] bg-[#18181E] text-xs font-mono text-white hover:border-cerulean-bright transition-colors cursor-pointer"
                >
                  Clear Search Filter
                </button>
              ) : (
                <button
                  onClick={onGoToStudio}
                  className="px-6 py-3 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(0,123,167,0.3)] active:scale-95 cursor-pointer"
                >
                  <Video className="w-4 h-4" />
                  <span>Go Live Now</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

