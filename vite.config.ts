import { defineConfig } from 'vite';

export default defineConfig({
  // 本地开发时，把 /api 请求代理到 wrangler dev（端口 8789；8787 留给 ipynb-to-pdf 的 pdf-server）
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8789',
    },
  },
  build: {
    outDir: 'dist',
  },
});
