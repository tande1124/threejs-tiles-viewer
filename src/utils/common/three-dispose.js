import * as THREE from 'three'

/**
 * 递归释放 Three.js Object3D 及其子树中所有 GPU 资源
 * 包括几何体（Geometry）、材质（Material）以及材质中引用的纹理（Texture）
 *
 * @param {THREE.Object3D} root - 需要递归释放的根节点
 */
export function disposeObject3D(root) {
  root.traverse((object) => {
    const mesh = object
    const geometry = mesh.geometry

    // 释放几何体占用的 GPU 缓冲区
    if (geometry) {
      geometry.dispose()
    }

    const material = mesh.material

    // 释放单个或数组形式的材质
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial)
    } else if (material) {
      disposeMaterial(material)
    }
  })
}

/**
 * 释放单个材质及其内部引用的所有纹理
 *
 * @param {THREE.Material} material - 需要释放的材质
 */
function disposeMaterial(material) {
  // 遍历材质的所有属性，释放其中的纹理对象
  Object.values(material).forEach((value) => {
    if (value && typeof value === 'object' && 'isTexture' in value) {
      value.dispose()
    }
  })

  // 最后释放材质本身
  material.dispose()
}
