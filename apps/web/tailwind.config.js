/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 亮色 · 古典主义（象牙纸 / 钴蓝 / 鎏金）
        light: {
          bg: '#f2efe8',
          ink: '#16181f',
          inkMuted: '#5c5a52',
          inkFaint: '#8d8a80',
          line: '#ddd7c9',
          lineStrong: '#c9c1ae',
          accent: '#2f5bd7',
          accentSoft: '#e7ebf9',
          gold: '#a8853f',
          panel: 'rgba(252,250,245,0.66)',
          panelStrong: 'rgba(253,252,248,0.86)',
        },
        // 暗色 · 超现实主义（曜石黑 / 朱砂红 / 鎏金）
        dark: {
          bg: '#07060a',
          ink: '#efe9e0',
          inkMuted: '#a49c92',
          inkFaint: '#6d6660',
          line: '#291f26',
          lineStrong: '#3d2c35',
          accent: '#f0354a',
          accentSoft: 'rgba(240,53,74,0.12)',
          gold: '#e0b45a',
          panel: 'rgba(16,13,18,0.74)',
          panelStrong: 'rgba(20,16,22,0.9)',
        },
      },
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'Songti SC', 'Noto Serif SC', 'SimSun', 'serif'],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable Text',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'ui-monospace', 'Consolas', 'monospace'],
      },
      borderRadius: {
        '2.5xl': '1.25rem',
      },
      keyframes: {
        caret: {
          '0%, 45%': { opacity: '1' },
          '50%, 100%': { opacity: '0.12' },
        },
        floaty: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        sheen: {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        riseIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        caret: 'caret 1.05s steps(1) infinite',
        floaty: 'floaty 7s ease-in-out infinite',
        sheen: 'sheen 3.5s ease-in-out infinite',
        riseIn: 'riseIn 0.32s cubic-bezier(0.22,1,0.36,1)',
      },
      transitionTimingFunction: {
        silk: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
