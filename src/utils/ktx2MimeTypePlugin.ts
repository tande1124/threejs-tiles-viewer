import { LoaderUtils } from 'three'
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'

/**
 * GLTF 解析器接口的简化类型定义
 * 描述 GLTFLoader 内部解析器对象的结构，方便插件扩展图片加载逻辑
 */
interface GLTFParserLike {
  json: {
    images?: Array<{
      /** 图片资源的 URI 路径 */
      uri?: string
      /** 指向二进制缓冲区的索引 */
      bufferView?: number
      /** 图片 MIME 类型（如 image/ktx2、image/png 等） */
      mimeType?: string
    }>
  }
  options: {
    /** 资源根路径 */
    path?: string
  }
  /** 加载缓存（sourceIndex → Promise），避免重复加载 */
  sourceCache: Record<number, Promise<unknown>>
  /** 获取依赖数据（如 bufferView） */
  getDependency: (type: string, index: number) => Promise<ArrayBuffer>
  /** 原生的图片加载方法 */
  loadImageSource: (sourceIndex: number, loader: unknown) => Promise<unknown>
}

/**
 * 创建 KTX2 MIME 类型图片加载插件
 *
 * GLTFLoader 默认无法识别 image/ktx2 类型的图片（KTX2 是 GPU 压缩纹理格式），
 * 此插件通过劫持 loadImageSource 方法，拦截 mimeType === 'image/ktx2' 的图片资源，
 * 使用 KTX2Loader 来加载和解析 GPU 压缩纹理，从而显著减小纹理内存占用。
 *
 * @param ktx2Loader - 已初始化的 KTX2 加载器实例
 * @returns 符合 GLTFExtensionsPlugin 接口的插件对象
 */
export function createKtx2MimeTypePlugin(ktx2Loader: KTX2Loader) {
  return (parser: unknown) => {
    const runtimeParser = parser as GLTFParserLike

    return {
    name: 'TRAE_KTX2_MIME_TYPE_PLUGIN',
    /**
     * 在解析 GLTF 根节点之前执行
     * 替换原生的 loadImageSource 方法，加入 KTX2 加载逻辑
     */
    beforeRoot() {
      // 保留原始的图片加载方法
      const originalLoadImageSource = runtimeParser.loadImageSource.bind(runtimeParser)

      // 重写图片加载方法
      runtimeParser.loadImageSource = (sourceIndex: number, loader: unknown) => {
        const sourceDef = runtimeParser.json.images?.[sourceIndex]

        // 非 KTX2 图片直接走原始加载逻辑
        if (!sourceDef || sourceDef.mimeType !== 'image/ktx2') {
          return originalLoadImageSource(sourceIndex, loader)
        }

        // 如果已有缓存，返回缓存的纹理克隆
        if (runtimeParser.sourceCache[sourceIndex] !== undefined) {
          return runtimeParser.sourceCache[sourceIndex].then((texture) =>
            (texture as { clone?: () => unknown }).clone?.() ?? texture,
          )
        }

        const urlFactory = globalThis.URL
        let sourceUri: string | Promise<string> = sourceDef.uri || ''
        let objectUrl = ''

        // 如果图片数据存储在 bufferView 中（嵌入式二进制数据）
        if (sourceDef.bufferView !== undefined) {
          sourceUri = runtimeParser
            .getDependency('bufferView', sourceDef.bufferView)
            .then((bufferView) => {
            // 将二进制数据封装为 Blob 并创建临时 ObjectURL
            const blob = new Blob([bufferView], { type: sourceDef.mimeType })
            objectUrl = urlFactory.createObjectURL(blob)
            return objectUrl
          })
        } else if (sourceDef.uri === undefined) {
          // 既无 URI 也无 bufferView，无法加载
          throw new Error(`THREE.GLTFLoader: Image ${sourceIndex} is missing URI and bufferView`)
        }

        // 使用 KTX2Loader 加载纹理，加载完成后清理临时 URL
        const promise = Promise.resolve(sourceUri)
          .then((resolvedSourceUri) =>
            ktx2Loader.loadAsync(
              LoaderUtils.resolveURL(resolvedSourceUri, runtimeParser.options.path || ''),
            ),
          )
          .then((texture) => {
            // 释放临时创建的 ObjectURL，避免内存泄漏
            if (objectUrl) {
              urlFactory.revokeObjectURL(objectUrl)
            }

            // 标记纹理需要更新，并记录 MIME 类型
            texture.needsUpdate = true
            texture.userData.mimeType = sourceDef.mimeType
            return texture
          })

        // 缓存加载结果，避免重复加载
        runtimeParser.sourceCache[sourceIndex] = promise
        return promise
      }

      return null
    },
    }
  }
}