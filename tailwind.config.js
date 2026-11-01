/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        jet: '#0A0A0A',
        cerulean: {
          DEFAULT: '#007BA7',
          light: '#00A3E0',
          bright: '#00C2FF',
          glow: 'rgba(0, 194, 255, 0.25)',
        },
        neon: {
          rose: '#FF2D95',
          glow: '#FF5CA8',
          subtle: 'rgba(255, 45, 149, 0.15)',
        },
        surface: {
          dark: '#111115',
          elevated: '#18181E',
          border: '#262630',
        },
        apptext: {
          primary: '#F5F5F7',
          secondary: '#A1A1AA',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      backgroundImage: {
        'glow-gradient': 'radial-gradient(ellipse at 50% 0%, rgba(0, 123, 167, 0.15) 0%, rgba(255, 45, 149, 0.08) 40%, rgba(10, 10, 10, 0) 70%)',
      },
    },
  },
  plugins: [],
}
