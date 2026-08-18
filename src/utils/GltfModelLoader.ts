import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { disposeObject3D } from '@/utils/three-dispose'

/** GLTF/GLB 加载选项 */
export interface GltfLoadOptions {
  /** 是否把模型包围盒中心移到原点（默认 true，避免大坐标浮点精度问题） */
  center?: boolean
}

/** GltfModelLoader 的依赖注入 */
export interface GltfModelLoaderDeps {
  /** 模型挂载的目标场景 */
  scene: THREE.Scene
  /** 复用的 DRACO 解压加载器 */
  dracoLoader: DRACOLoader
  /** 复用的 KTX2 纹理加载器 */
  ktx2Loader: KTX2Loader
  /** 可选：模型加载完成后对模型做纹理质量增强（由使用方提供实现） */
  enhanceTextures?: (model: THREE.Object3D) => void
}

/**
 * GLTF/GLB 模型加载器。
 *
 * 负责把外部 GLB/GLTF 模型直接加载进场景：
 * 创建 GLTFLoader 并接入 DRACO/KTX2 解压能力、可选居中到原点，
 * 所有模型统一挂到 root 容器组下（root 已在构造函数中加入 scene）。
 */
export class GltfModelLoader {
  /** 所有已加载模型的父级容器组（已加入 scene） */
  readonly root: THREE.Group

  private readonly deps: GltfModelLoaderDeps
  private readonly loader: GLTFLoader

  constructor(deps: GltfModelLoaderDeps) {
    this.deps = deps

    this.root = new THREE.Group()
    this.root.name = 'gltf-root'
    this.deps.scene.add(this.root)

    this.loader = new GLTFLoader()
    this.loader.setDRACOLoader(this.deps.dracoLoader)
    this.loader.setKTX2Loader(this.deps.ktx2Loader)
  }

  /** 加载并渲染一个 GLTF/GLB 模型，返回模型根节点 */
  async load(url: string, options: GltfLoadOptions = {}): Promise<THREE.Group> {
    const { center = true } = options

    const model = (await this.loader.loadAsync(url)).scene
    model.name = model.name || 'gltf-model'
    this.deps.enhanceTextures?.(model)

    if (center) {
      const box = new THREE.Box3().setFromObject(model)
      if (!box.isEmpty()) {
        model.position.sub(box.getCenter(new THREE.Vector3()))
      }
    }

    this.root.add(model)
    return model
  }

  /** 清除并释放所有已加载的 GLTF 模型 */
  clear(): void {
    disposeObject3D(this.root)
    this.root.clear()
  }
}
