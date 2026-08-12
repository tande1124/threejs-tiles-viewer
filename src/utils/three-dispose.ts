import * as THREE from 'three'

/**
 * 可被释放的材质类型扩展
 * 用于遍历材质属性中可能存在的纹理引用
 */
type DisposableMaterial = THREE.Material & Record<string, unknown>

/**
 * 递归释放 Three.js Object3D 及其子树中所有 GPU 资源
 * 包括几何体（Geometry）、材质（Material）以及材质中引用的纹理（Texture）
 *
 * @param root - 需要递归释放的根节点
 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined

    // 释放几何体占用的 GPU 缓冲区
    if (geometry) {
      geometry.dispose()
    }

    const material = mesh.material as THREE.Material | THREE.Material[] | undefined

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
 * @param material - 需要释放的材质
 */
function disposeMaterial(material: THREE.Material): void {
  const target = material as DisposableMaterial

  // 遍历材质的所有属性，释放其中的纹理对象
  Object.values(target).forEach((value) => {
    if (value && typeof value === 'object' && 'isTexture' in value) {
      ;(value as THREE.Texture).dispose()
    }
  })

  // 最后释放材质本身
  material.dispose()
}