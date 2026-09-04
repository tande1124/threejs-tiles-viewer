import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 插件：解码 /data/ 路径中的特殊字符（如 %2B → +）。
 * tileset.json 里的瓦片路径用 %2B 编码了 + 号，
 * Vite 静态文件服务不会自动解码导致 404，与 demo 的 serveTilesData 对齐。
 */
function decodeTileUrls() {
  return {
    name: 'decode-tile-urls',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.includes('%')) {
          req.url = decodeURIComponent(req.url)
        }
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_DEV_PROXY_TARGET?.trim()

  return {
    base: mode === 'development' ? '/' : '/threeJs-3D/',
    plugins: [decodeTileUrls(), vue()],
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
      outDir: 'D:/System/threeJs-3D',
    },
  }
})
