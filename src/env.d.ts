/// <reference types="vite/client" />

/**
 * Vite 环境变量类型声明
 * 为 import.meta.env 提供 TypeScript 智能提示和类型检查
 */
interface ImportMetaEnv {
  /** 应用标题 */
  readonly VITE_APP_TITLE: string
  /** 默认 3D Tiles 资源地址 */
  readonly VITE_DEFAULT_TILESET: string
  /** Tiles 清单文件路径 */
  readonly VITE_TILES_MANIFEST_PATH: string
  /** 开发服务器端口（可选） */
  readonly VITE_DEV_SERVER_PORT?: string
  /** 预览服务器端口（可选） */
  readonly VITE_PREVIEW_PORT?: string
  /** 开发代理目标地址（可选） */
  readonly VITE_DEV_PROXY_TARGET?: string
}

/** 扩展 Vite 的 ImportMeta 接口 */
interface ImportMeta {
  readonly env: ImportMetaEnv
}
