import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    // 绑定所有 IPv4 地址（含 127.0.0.1），避免仅监听 IPv6 ::1 导致浏览器访问 localhost 失败
    host: '0.0.0.0',
    port: 9526,
    proxy: {
      '/api': {
        target: 'http://localhost:9528',
        changeOrigin: true,
      },
      // 容器终端 WebSocket 代理
      '/ws': {
        target: 'ws://localhost:9528',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // 路由懒加载产生的异步 chunk 名使用可读名，便于排查体积
    rollupOptions: {
      output: {
        // 函数式分包：将 react 运行时与路由库抽成独立 vendor chunk（长期稳定，利于浏览器缓存）
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/react-router') || id.includes('node_modules/react-router-dom')) {
            return 'vendor-router';
          }
        },
      },
    },
  },
});
