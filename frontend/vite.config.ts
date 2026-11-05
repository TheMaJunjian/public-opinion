import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { randomUUID } from 'node:crypto'
import type { ViteDevServer } from 'vite'
import { offlineViewerPlugin } from './offlineViewerPlugin'
import { publicDocsPlugin } from './publicDocsPlugin'

const buildId = randomUUID()

function addPublicTextEncoding(server: Pick<ViteDevServer, 'middlewares'>) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] === '/llms.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
    }
    next()
  })
}

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        // Shared by the workbench, its lazy views and the reading controls.
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (path.endsWith('/src/utils/modelBridge.ts')) return 'message-model';
          // Layout is shared by the workbench's reading order and deferred graph views.
          if (['frameLayoutCore', 'graphColumnRules', 'discussionLayout'].some(name => path.endsWith(`/src/utils/${name}.ts`))) return 'graph-layout';
          if (path.endsWith('/src/pages/workbench/model/readingProgress.ts')) return 'reading-progress';
          if (path.endsWith('/src/pages/workbench/useSendPreview.ts')) return 'send-preview';
        },
      },
    },
  },
  define: { __APP_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), publicDocsPlugin(), offlineViewerPlugin(buildId), {
    name: 'public-text-encoding',
    configureServer: addPublicTextEncoding,
    configurePreviewServer: addPublicTextEncoding,
  }, {
    name: 'app-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id: buildId }) })
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
})
