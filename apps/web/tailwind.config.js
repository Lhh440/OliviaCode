/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 浅色 · 黑鱼白水：纸白的水、墨黑的鱼、一点暖赭
        light: {
          bg: '#f2f1ec',
          ink: '#14161a',
          inkMuted: '#565a61',
          inkFaint: '#83868d',
          line: '#dedcd5',
          lineStrong: '#c8c5bc',
          accent: '#14161a',
          accentSoft: 'rgba(20,22,26,0.07)',
          gold: '#a07850',
          panel: 'rgba(252,251,247,0.72)',
          panelStrong: 'rgba(255,254,250,0.95)',
        },
        // 深色 · 白鱼黑水：夜水、骨白的鱼、微光
        dark: {
          bg: '#08090a',
          ink: '#f2f1ec',
          inkMuted: '#a5a6a4',
          inkFaint: '#7a7c80',
          line: '#232529',
          lineStrong: '#33363b',
          accent: '#f2f1ec',
          accentSoft: 'rgba(242,241,236,0.10)',
          gold: '#c9a887',
          panel: 'rgba(12,13,15,0.74)',
          panelStrong: 'rgba(15,16,18,0.94)',
        },
      },
      // 全站一套字体：Inter 管拉丁，HarmonyOS Sans SC 管汉字（见 styles/fonts.css）。
      // Inter 没有汉字，汉字自动落到后面的 HarmonyOS；两者都没有的字形才用系统字体兜底。
      fontFamily: {
        sans: [
          'Inter',
          '"HarmonyOS Sans SC"',
          'Segoe UI Variable Text',
          'Microsoft YaHei UI',
          'PingFang SC',
          'system-ui',
          'sans-serif',
        ],
        // 展示文字（品牌名、留白页大标题）也用同一套：黑鱼白水这套视觉没有衬线的位置
        serif: ['Inter', '"HarmonyOS Sans SC"', 'Georgia', 'system-ui', 'serif'],
        // 代码与 diff 必须等宽：Inter / HarmonyOS 都没有等宽变体，
        // 所以拉丁走 JetBrains Mono / Consolas，汉字回落到 HarmonyOS Sans SC
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'ui-monospace',
          'Consolas',
          '"HarmonyOS Sans SC"',
          'monospace',
        ],
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
