import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4174', changeOrigin: false },
      '/events': { target: 'http://127.0.0.1:4174', changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const file = id.replaceAll('\\', '/');
          if (!file.includes('/node_modules/')) return;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(file)) return 'vendor-react';
          if (/\/node_modules\/(@codemirror|@lezer)\//.test(file)) return 'vendor-editor';
          if (
            /\/node_modules\/(react-markdown|remark-[^/]+|micromark[^/]*|mdast-util-[^/]+|hast-util-[^/]+|rehype-[^/]+|unist-util-[^/]+|vfile[^/]*|unified|bail|trough|devlop|zwitch|ccount|character-entities|decode-named-character-reference|longest-streak|markdown-table|escape-string-regexp|space-separated-tokens|comma-separated-tokens|trim-lines|property-information|html-url-attributes|is-plain-obj)\//.test(
              file
            )
          )
            return 'vendor-markdown';
        },
      },
    },
  },
  test: {
    // Nested Git worktrees and preserved build copies live inside the checkout;
    // running their test suites from the main tree duplicates every test.
    exclude: [
      ...configDefaults.exclude,
      '.agents/**',
      '.local-preserved/**',
      '.opnex-live-build-*/**',
      'tmp/**',
    ],
  },
});
