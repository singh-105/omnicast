import React, { useState, useEffect } from 'react';
import { X, Network, Users, Radio, RefreshCw, Layers } from 'lucide-react';

export const TopologyModal = ({
  isOpen,
  onClose,
  broadcastId,
  localPeerId,
}) => {
  const [topology, setTopology] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTopology = async () => {
    if (!broadcastId) return;
    setIsLoading(true);
    try {
      const host = window.location.hostname || 'localhost';
      const res = await fetch(`http://${host}:10000/api/broadcasts/${broadcastId}/topology`);
      if (res.ok) {
        const data = await res.json();
        setTopology(data);
      }
    } catch (e) {
      console.warn('[Topology] Failed to fetch snapshot:', e.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchTopology();
      const interval = setInterval(fetchTopology, 3000);
      return () => clearInterval(interval);
    }
  }, [isOpen, broadcastId]);

  if (!isOpen) return null;

  const tiersMap = new Map();
  if (topology?.nodes) {
    for (const node of topology.nodes) {
      const t = node.tier || 0;
      if (!tiersMap.has(t)) tiersMap.set(t, []);
      tiersMap.get(t).push(node);
    }
  }

  const sortedTiers = Array.from(tiersMap.keys()).sort((a, b) => a - b);

  return (
    <div className="fixed inset-0 z-50 bg-[#0A0A0A]/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-3xl border border-[#262630] bg-[#111115] text-[#F5F5F7] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#262630] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-cerulean/10 border border-cerulean/30 flex items-center justify-center text-cerulean-bright">
              <Network className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-sm tracking-wide text-white uppercase">
                Tree-Mesh Cascade Topology
              </h2>
              <p className="text-[10px] font-mono text-[#A1A1AA]">
                Live Real-Time Coordinator Graph
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchTopology}
              className="p-2 rounded-xl border border-[#262630] bg-[#0A0A0A] text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
              title="Refresh Graph"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl border border-[#262630] bg-[#0A0A0A] text-[#A1A1AA] hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Summary Badges */}
          <div className="grid grid-cols-3 gap-3 text-xs font-mono">
            <div className="p-4 rounded-2xl border border-[#262630] bg-[#0A0A0A] text-center space-y-1">
              <p className="text-[10px] uppercase text-[#A1A1AA]">Total Audience</p>
              <p className="text-2xl font-display font-bold text-cerulean-bright">
                {topology?.totalViewers ?? 0}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-[#262630] bg-[#0A0A0A] text-center space-y-1">
              <p className="text-[10px] uppercase text-[#A1A1AA]">Depth</p>
              <p className="text-2xl font-display font-bold text-neon-rose">
                Tier {topology?.maxTier ?? 0}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-[#262630] bg-[#0A0A0A] text-center space-y-1">
              <p className="text-[10px] uppercase text-[#A1A1AA]">Relay Fanout</p>
              <p className="text-2xl font-display font-bold text-white">5 max</p>
            </div>
          </div>

          {/* Hierarchical Tiers Visualizer */}
          {!topology || sortedTiers.length === 0 ? (
            <div className="py-16 text-center text-xs font-mono text-[#A1A1AA]">
              No active broadcast stream selected. Join or start a stream to inspect its live topology.
            </div>
          ) : (
            <div className="space-y-6">
              {sortedTiers.map((tierNum) => {
                const nodes = tiersMap.get(tierNum) || [];
                return (
                  <div key={tierNum} className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-mono font-bold text-[#A1A1AA] uppercase tracking-wider">
                      <span className="text-cerulean-bright font-bold">●</span>
                      <span>
                        {tierNum === 0
                          ? 'Tier 0 · Origin Broadcaster'
                          : `Tier ${tierNum} · ${tierNum === 1 ? 'Primary Cascading Relays' : 'Downstream Audience'}`}
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#18181E] border border-[#262630] text-[#A1A1AA]">
                        {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      {nodes.map((node) => {
                        const isMe = node.peerId === localPeerId;
                        return (
                          <div
                            key={node.peerId}
                            className={`px-4 py-3 rounded-2xl border text-xs font-mono space-y-1 transition-all ${
                              isMe
                                ? 'bg-cerulean/15 border-cerulean-bright text-white shadow-[0_0_15px_rgba(0,194,255,0.3)] ring-1 ring-cerulean-bright'
                                : node.isOrigin
                                ? 'bg-neon-rose/10 border-neon-rose/40 text-neon-rose'
                                : 'bg-[#0A0A0A] border-[#262630] text-[#A1A1AA]'
                            }`}
                          >
                            <div className="flex items-center gap-2 font-bold text-white">
                              {node.isOrigin ? (
                                <Radio className="w-3.5 h-3.5 text-neon-rose" />
                              ) : (
                                <Users className="w-3.5 h-3.5 text-cerulean-bright" />
                              )}
                              <span>
                                {node.isOrigin ? 'Origin Broadcaster' : node.peerId.slice(-8)}
                                {isMe && ' (You)'}
                              </span>
                            </div>

                            <div className="text-[10px] opacity-75 flex items-center gap-3">
                              <span>Children: {node.childCount}/5</span>
                              {node.isMobile && <span>📱 Mobile Leaf</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
