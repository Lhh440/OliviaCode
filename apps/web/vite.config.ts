import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * M7：给打包后的页面加 CSP（dev 模式放宽 Vite HMR 所需的内联脚本与 ws）。
 * 预览视图是独立 webContents，不经过这里。
 */
function cspPlugin(): Plugin {
  const prod =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: olivia-artifact:; media-src 'self' olivia-artifact:; " +
    "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
  const dev =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; " +
    "font-src 'self' data:; connect-src 'self' ws://127.0.0.1:5273 ws://localhost:5273; " +
    "object-src 'none'; base-uri 'none'; frame-src 'none'";
  return {
    name: 'olivia-csp',
    transformIndexHtml(html, context) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: context.server ? dev : prod },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  resolve: {
    alias: {
      '@olivia/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // 只绑 localhost 时 Vite 会监听 ::1，桌面端的 127.0.0.1 反而连不上（靠双栈回退才侥幸能用）
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
});
