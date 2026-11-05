import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  test: { exclude: ['e2e/**', 'node_modules/**', 'dist/**'] },
  server: { proxy: { '/api': 'http://localhost:8080', '/demo': 'http://localhost:8080' } },
});
