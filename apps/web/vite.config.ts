import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 局域网可访问
    port: 5173,
    proxy: {
      '/api': {
        // NT_API_TARGET：另起一套隔离服务端时覆盖（缺省是本机 8787）
        target: process.env.NT_API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
