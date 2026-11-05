import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { LandingView } from './components/LandingView';
import { ExploreView } from './components/ExploreView';
import { StudioView } from './components/StudioView';
import { WatcherView } from './components/WatcherView';
import { TopologyModal } from './components/TopologyModal';
import { BroadcastManager } from './features/broadcast/broadcastManager';

function parseRoute() {
  if (typeof window === 'undefined') {
    return { view: 'landing', broadcastId: null };
  }

  const pathname = window.location.pathname.replace(/\/$/, '') || '/';
  const params = new URLSearchParams(window.location.search);

  // Check /watch/:id
  const watchMatch = pathname.match(/^\/watch\/([^/]+)$/);
  if (watchMatch) {
    return { view: 'watcher', broadcastId: decodeURIComponent(watchMatch[1]) };
  }

  if (pathname === '/explore') {
    return { view: 'explore', broadcastId: null };
  }

  if (pathname === '/studio') {
    return { view: 'studio', broadcastId: null };
  }

  // Query parameter compatibility
  const queryWatch = params.get('watch');
  if (queryWatch) {
    return { view: 'watcher', broadcastId: queryWatch };
  }
  if (params.get('studio') === 'true' || params.get('studio') === '1') {
    return { view: 'studio', broadcastId: null };
  }
  if (params.get('view') === 'explore') {
    return { view: 'explore', broadcastId: null };
  }

  return { view: 'landing', broadcastId: null };
}

export default function App() {
  const initialRoute = parseRoute();
  const [currentView, setCurrentView] = useState(initialRoute.view);
  const [selectedBroadcastId, setSelectedBroadcastId] = useState(initialRoute.broadcastId);
  const [isTopologyOpen, setIsTopologyOpen] = useState(false);
  const [activeBroadcasts, setActiveBroadcasts] = useState([]);
  const [isBroadcastsLoading, setIsBroadcastsLoading] = useState(false);

  const [metrics, setMetrics] = useState({
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
    decodedFps: 0,
    droppedFrames: 0,
    bufferDepthSecs: 0,
    captureFps: 0,
  });

  const broadcastManagerRef = useRef(null);

  const fetchActiveBroadcasts = useCallback(async () => {
    setIsBroadcastsLoading(true);
    try {
      const res = await fetch('/api/broadcasts');
      if (res.ok) {
        const list = await res.json();
        setActiveBroadcasts(Array.isArray(list) ? list : []);
      }
    } catch (err) {
      console.warn('[App] Could not fetch active broadcasts:', err.message);
    } finally {
      setIsBroadcastsLoading(false);
    }
  }, []);

  const navigateTo = useCallback((view, bcastId = null, replace = false) => {
    let path = '/';
    if (view === 'explore') path = '/explore';
    else if (view === 'studio') path = '/studio';
    else if (view === 'watcher' && bcastId) path = `/watch/${encodeURIComponent(bcastId)}`;

    if (window.location.pathname !== path || (view === 'watcher' && selectedBroadcastId !== bcastId)) {
      window.history[replace ? 'replaceState' : 'pushState']({ view, bcastId }, '', path);
    }

    // Stop current broadcast if navigating away from studio
    if (currentView === 'studio' && view !== 'studio' && broadcastManagerRef.current) {
      broadcastManagerRef.current.stopBroadcast();
    }

    setCurrentView(view);
    setSelectedBroadcastId(bcastId);

    if (view === 'landing' || view === 'explore') {
      fetchActiveBroadcasts();
    }
  }, [currentView, selectedBroadcastId, fetchActiveBroadcasts]);

  // Handle browser popstate (Back / Forward navigation)
  useEffect(() => {
    const handlePopState = () => {
      const route = parseRoute();
      setCurrentView(route.view);
      setSelectedBroadcastId(route.broadcastId);
      if (route.view === 'landing' || route.view === 'explore') {
        fetchActiveBroadcasts();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [fetchActiveBroadcasts]);

  // Initialize BroadcastManager and Signaling
  useEffect(() => {
    document.documentElement.classList.add('dark');

    const manager = new BroadcastManager({
      onMetrics: (newMetrics) => setMetrics(newMetrics),
      onStateChange: (state, newMetrics) => {
        if (newMetrics) setMetrics(newMetrics);
      },
      onError: (err) => console.error('[App] BroadcastManager error:', err),
      onBroadcastAnnounced: (broadcast) => {
        setActiveBroadcasts((prev) => {
          const exists = prev.some((b) => b.broadcastId === broadcast.broadcastId);
          if (exists) {
            return prev.map((b) => (b.broadcastId === broadcast.broadcastId ? { ...b, ...broadcast } : b));
          }
          return [broadcast, ...prev];
        });
      },
      onBroadcastEnded: (endedBroadcastId) => {
        setActiveBroadcasts((prev) => prev.filter((b) => b.broadcastId !== endedBroadcastId));
      },
    });

    broadcastManagerRef.current = manager;
    if (typeof window !== 'undefined') {
      window.__OMNICAST_MANAGER__ = manager;
    }

    manager.connectSignaling().then(() => {
      fetchActiveBroadcasts();
    }).catch((err) => {
      console.warn('[App] Initial signaling connection notice:', err.message);
    });

    return () => {
      manager.destroy();
    };
  }, [fetchActiveBroadcasts]);

  const handleJoinStream = (broadcastId) => {
    if (!broadcastId) return;
    navigateTo('watcher', broadcastId);
  };

  const handleGoToStudio = () => {
    navigateTo('studio');
  };

  const handleGoToExplore = () => {
    navigateTo('explore');
  };

  const handleBackToLanding = () => {
    navigateTo('landing');
  };

  const activeBcastId = selectedBroadcastId || broadcastManagerRef.current?.broadcastId;

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F7] flex flex-col font-sans selection:bg-neon-rose selection:text-white">
      {/* Premium Minimal Navigation */}
      <Navbar
        currentView={currentView}
        setCurrentView={(view) => {
          if (view === 'landing') handleBackToLanding();
          else if (view === 'explore') handleGoToExplore();
          else if (view === 'studio') handleGoToStudio();
          else navigateTo(view);
        }}
        metrics={metrics}
        onOpenTopology={() => setIsTopologyOpen(true)}
        localPeerId={broadcastManagerRef.current?.localPeerId}
        onGoToStudio={handleGoToStudio}
      />

      {/* Main View Router */}
      <main className="flex-1">
        {currentView === 'landing' && (
          <LandingView
            onGoToStudio={handleGoToStudio}
            onGoToExplore={handleGoToExplore}
            onJoinStream={handleJoinStream}
            activeBroadcasts={activeBroadcasts}
            onRefreshBroadcasts={fetchActiveBroadcasts}
            onOpenTopology={() => setIsTopologyOpen(true)}
          />
        )}

        {currentView === 'explore' && (
          <ExploreView
            activeBroadcasts={activeBroadcasts}
            onJoinStream={handleJoinStream}
            onGoToStudio={handleGoToStudio}
            onRefreshBroadcasts={fetchActiveBroadcasts}
            isLoading={isBroadcastsLoading}
          />
        )}

        {currentView === 'studio' && broadcastManagerRef.current && (
          <StudioView
            onBack={handleBackToLanding}
            broadcastManager={broadcastManagerRef.current}
            metrics={metrics}
          />
        )}

        {currentView === 'watcher' && broadcastManagerRef.current && selectedBroadcastId && (
          <WatcherView
            broadcastId={selectedBroadcastId}
            onBack={handleBackToLanding}
            broadcastManager={broadcastManagerRef.current}
            metrics={metrics}
            onOpenTopology={() => setIsTopologyOpen(true)}
          />
        )}
      </main>

      {/* Network Topology Modal */}
      <TopologyModal
        isOpen={isTopologyOpen}
        onClose={() => setIsTopologyOpen(false)}
        broadcastId={activeBcastId}
        localPeerId={broadcastManagerRef.current?.localPeerId}
      />

      {/* Minimal Premium Footer */}
      <footer className="border-t border-[#262630]/60 bg-[#0A0A0A] py-10 text-xs font-mono text-[#A1A1AA]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-display font-black text-white text-sm">OMNICAST</span>
            <span className="text-[10px] text-cerulean-bright">· P2P BROADCAST PROTOCOL</span>
          </div>

          <p className="text-[11px] opacity-75">
            Single-Encode · Real RTCDataChannels · Tree-Mesh Cascades · Zero CDN Video Egress
          </p>

          <p className="text-[10px] text-[#A1A1AA]/60">
            © {new Date().getFullYear()} OmniCast. Built for infinite reach.
          </p>
        </div>
      </footer>
    </div>
  );
}
