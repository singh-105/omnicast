import React, { useState } from 'react';
import { Video, Menu, X } from 'lucide-react';
import { OmniCastLogo } from './OmniCastLogo';

export const Navbar = ({
  currentView,
  setCurrentView,
  metrics,
  onGoToStudio,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigateTo = (view) => {
    setCurrentView(view);
    setMobileMenuOpen(false);
  };

  return (
    <header className="border-b border-[#29292F] sticky top-0 z-50 bg-[#0A0A0A]/95 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand Logo */}
        <OmniCastLogo
          size="md"
          onClick={() => navigateTo('landing')}
        />

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
          <button
            onClick={() => navigateTo('landing')}
            className={`transition-colors cursor-pointer flex items-center gap-1.5 ${
              currentView === 'landing' ? 'text-white font-semibold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            <span>Home</span>
            {currentView === 'landing' && <span className="w-1.5 h-1.5 rounded-full bg-cerulean-bright" />}
          </button>
          <button
            onClick={() => navigateTo('explore')}
            className={`transition-colors cursor-pointer flex items-center gap-1.5 ${
              currentView === 'explore' ? 'text-white font-semibold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            <span>Explore</span>
            {currentView === 'explore' && <span className="w-1.5 h-1.5 rounded-full bg-cerulean-bright" />}
          </button>
        </nav>

        {/* Right Actions */}
        <div className="hidden sm:flex items-center gap-3">
          {/* Active Broadcast Badge */}
          {metrics.role === 'broadcaster' && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-neon-rose/15 text-neon-rose border border-neon-rose/30 shadow-[0_0_12px_rgba(255,45,149,0.25)]">
              <span className="w-2 h-2 rounded-full bg-neon-rose animate-ping" />
              <span>LIVE</span>
            </div>
          )}

          {currentView !== 'studio' && (
            <button
              onClick={onGoToStudio}
              className="px-4 py-2 rounded-xl bg-cerulean hover:bg-cerulean-bright text-white hover:text-zinc-950 font-display font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-[0_0_20px_rgba(0,123,167,0.3)] hover:shadow-[0_0_25px_rgba(0,194,255,0.5)] active:scale-95"
            >
              <Video className="w-3.5 h-3.5" />
              <span>Go Live</span>
            </button>
          )}
        </div>

        {/* Mobile Hamburger Toggle */}
        <div className="flex sm:hidden items-center gap-2">
          {currentView !== 'studio' && (
            <button
              onClick={onGoToStudio}
              className="px-3 py-1.5 rounded-lg bg-cerulean text-white font-display font-bold text-xs uppercase tracking-wider flex items-center gap-1 cursor-pointer"
            >
              <Video className="w-3.5 h-3.5" />
              <span>Go Live</span>
            </button>
          )}

          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-lg border border-[#29292F] text-[#A1A1AA] hover:text-white transition-colors"
            aria-label="Toggle mobile menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="sm:hidden border-b border-[#29292F] bg-[#141418] px-4 py-4 space-y-3">
          <button
            onClick={() => navigateTo('landing')}
            className={`w-full text-left py-2 text-sm font-medium transition-colors ${
              currentView === 'landing' ? 'text-cerulean-bright font-bold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            Home
          </button>
          <button
            onClick={() => navigateTo('explore')}
            className={`w-full text-left py-2 text-sm font-medium transition-colors ${
              currentView === 'explore' ? 'text-cerulean-bright font-bold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            Explore
          </button>
          {currentView !== 'studio' && (
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onGoToStudio();
              }}
              className="w-full text-left py-2 text-sm font-medium text-neon-rose font-bold flex items-center gap-2"
            >
              <Video className="w-4 h-4" />
              <span>Go Live</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
};
