import * as THREE from 'three'

/**
 * 创建禁用 Mipmap 的 GLTF 纹理插件
 *
 * Three.js 默认会自动为纹理生成 mipmap 链（generateMipmaps=true），
 * 然后使用 mipmap-based 的 minFilter（如 LinearMipmapLinearFilter）。
 *
 * mipmap 会降低 GPU 内存中纹理的有效分辨率：
 * - 缩小场景中远处纹理经过 mip 级别降采样后会"糊"
 * - 放大场景中高分辨率纹理的对比度细节也会因 mip 插值而弱化
 *
 * 此插件在纹理被创建后、上传到 GPU 前，将每一张纹理设置为：
 * - generateMipmaps: false → 不生成 mipmap，始终使用全分辨率
 * - minFilter: LinearFilter → 缩小采样时直接线性插值（无 mipmap 降级）
 *
 * 注意：
 * - 无 mipmap 时，远处纹理可能出现莫尔纹（aliasing），这是清晰度的代价
 * - KTX2 压缩纹理自带内嵌 mipmap，不受 generateMipmaps 影响
 *
 * @returns 符合 GLTF loader plugin 接口的对象
 */
export function createNoMipmapPlugin() {
  return (parser: unknown) => {
    const runtimeParser = parser as {
      loadTexture: (
        textureIndex: number,
      ) => Promise<THREE.Texture>
    }

    // 保留原始的 loadTexture 方法
    const originalLoadTexture = runtimeParser.loadTexture.bind(runtimeParser)

    // 重写：每张纹理加载后立即禁用 mipmap
    runtimeParser.loadTexture = (textureIndex: number) => {
      return originalLoadTexture(textureIndex).then((texture: THREE.Texture) => {
        if (texture && texture.isTexture) {
          // 压缩纹理（KTX2 等）自带内嵌 mipmap，跳过
          const isCompressed = !!(texture as unknown as Record<string, unknown>).isCompressedTexture
          if (!isCompressed) {
            // 非压缩纹理：禁用 mipmap 生成，改为纯线性过滤
            texture.generateMipmaps = false
            texture.minFilter = THREE.LinearFilter
            texture.needsUpdate = true
          }
        }
        return texture
      })
    }

    return {
      name: 'NO_MIPMAP_PLUGIN',
    }
  }
}
