import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [react()],
  server: {
    port: 5174,
    open: false,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
