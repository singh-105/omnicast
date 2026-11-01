import React from 'react';

/**
 * OmniCast Original Brand Symbol & Wordmark
 *
 * Visual Concept:
 * An abstract interconnected orbital signal mark.
 * Two interlocking parabolic energy arcs (Cerulean Blue & Neon Rose)
 * converging around a central broadcast node, symbolizing peer-to-peer live cascade.
 */
export const OmniCastSymbol = ({ size = 32, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`shrink-0 ${className}`}
  >
    <defs>
      <linearGradient id="omni-blue" x1="4" y1="4" x2="36" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#00C2FF" />
        <stop offset="100%" stopColor="#007BA7" />
      </linearGradient>
      <linearGradient id="omni-rose" x1="44" y1="4" x2="12" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#FF5CA8" />
        <stop offset="100%" stopColor="#FF2D95" />
      </linearGradient>
      <filter id="omni-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
    </defs>

    {/* Outer Interlocking Cascade Arcs */}
    <path
      d="M24 6C14.059 6 6 14.059 6 24C6 29.382 8.368 34.212 12.147 37.5L16.29 33.357C13.67 30.985 12 27.688 12 24C12 17.373 17.373 12 24 12C27.688 12 30.985 13.67 33.357 16.29L37.5 12.147C34.212 8.368 29.382 6 24 6Z"
      fill="url(#omni-blue)"
    />
    <path
      d="M24 42C33.941 42 42 33.941 42 24C42 18.618 39.632 13.788 35.853 10.5L31.71 14.643C34.33 17.015 36 20.312 36 24C36 30.627 30.627 36 24 36C20.312 36 17.015 34.33 14.643 31.71L10.5 35.853C13.788 39.632 18.618 42 24 42Z"
      fill="url(#omni-rose)"
    />

    {/* Core Broadcast Nucleus */}
    <circle cx="24" cy="24" r="5" fill="#F5F5F7" filter="url(#omni-glow)" />
    <circle cx="24" cy="24" r="2.5" fill="#0A0A0A" />
  </svg>
);

export const OmniCastLogo = ({
  size = 'md', // 'sm' | 'md' | 'lg'
  showWordmark = true,
  className = '',
  onClick,
}) => {
  const symbolSizes = {
    sm: 24,
    md: 32,
    lg: 40,
  };

  const textSizes = {
    sm: 'text-base tracking-tight',
    md: 'text-xl tracking-tight',
    lg: 'text-2xl tracking-tighter',
  };

  return (
    <div
      onClick={onClick}
      className={`inline-flex items-center gap-2.5 select-none ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      <OmniCastSymbol size={symbolSizes[size] || 32} />
      {showWordmark && (
        <span className={`font-display font-black text-white ${textSizes[size] || 'text-xl'}`}>
          OMNI<span className="text-cerulean-bright">CAST</span>
        </span>
      )}
    </div>
  );
};

