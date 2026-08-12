import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_DEV_PROXY_TARGET?.trim()

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '0.0.0.0',
      port: Number(env.VITE_DEV_SERVER_PORT || 5173),
      strictPort: true,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      proxy: proxyTarget
        ? {
            '/external-tiles': {
              target: proxyTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/external-tiles/, ''),
            },
          }
        : undefined,
    },
    preview: {
      host: '0.0.0.0',
      port: Number(env.VITE_PREVIEW_PORT || 4173),
      strictPort: true,
    },
    build: {
      target: 'esnext',
      sourcemap: true,
    },
  }
})
