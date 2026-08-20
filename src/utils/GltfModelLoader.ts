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

/** GLB 部件点击拾取信息 */
export interface GltfPickInfo {
  /** 命中的网格对象 */
  object: THREE.Object3D
  /** 部件名称（对象本身无名字时取最近的有名字的祖先） */
  name: string
  /** 从模型根节点到命中对象的节点路径 */
  path: string
  /** 命中点世界坐标（场景坐标系，单位米） */
  worldPosition: THREE.Vector3
  /** 命中点在模型根节点局部坐标系下的坐标（单位米） */
  localPosition: THREE.Vector3
  /** 相机到命中点的距离（单位米） */
  distance: number
  /** 命中的模型根节点 */
  model: THREE.Group
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
  /** 可选：点击部件高亮颜色（默认橙色 #ff8800） */
  highlightColor?: THREE.ColorRepresentation
  /**
   * 可选：点击 GLB 部件时回调部件信息与点击位置（视口坐标）。
   * info 为 null 表示点击未命中模型（可关闭弹窗），此时 position 也为 null。
   */
  onPick?: (
    info: GltfPickInfo | null,
    position: { x: number; y: number } | null,
  ) => void
}

/**
 * GLTF/GLB 模型加载器。
 *
 * 负责把外部 GLB/GLTF 模型直接加载进场景：
 * 创建 GLTFLoader 并接入 DRACO/KTX2 解压能力、可选居中到原点，
 * 所有模型统一挂到 root 容器组下（root 已在构造函数中加入 scene）。
 * 同时提供点击拾取能力：enablePicking 后点击 GLB 部件会通过 deps.onPick
 * 回调该部件的位置/名称等详情，未命中模型时回调 null。
 */
export class GltfModelLoader {
  /** 所有已加载模型的父级容器组（已加入 scene） */
  readonly root: THREE.Group

  private readonly deps: GltfModelLoaderDeps
  private readonly loader: GLTFLoader
  private readonly raycaster = new THREE.Raycaster()

  // ---- 点击拾取状态 ----
  private pickCamera: THREE.Camera | null = null
  private pickDomElement: HTMLElement | null = null
  private readonly pickPointerStart = new THREE.Vector2()

  // ---- 部件高亮状态 ----
  private readonly highlightColor: THREE.Color
  private highlightedObject: THREE.Object3D | null = null
  /** 高亮前每个网格的原始材质（恢复时用） */
  private readonly highlightedOriginalMaterials = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >()
  /** 高亮时克隆出的临时材质（清除时释放） */
  private readonly highlightedClonedMaterials = new Set<THREE.Material>()

  constructor(deps: GltfModelLoaderDeps) {
    this.deps = deps
    this.highlightColor = new THREE.Color(deps.highlightColor ?? '#ff8800')

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

  /**
   * 启用点击拾取：在 domElement 上监听点击，命中 GLB 部件时通过
   * deps.onPick 回调部件信息，点击空白（未命中模型）时回调 null。
   * 拖动旋转/平移不触发拾取。
   */
  enablePicking(camera: THREE.Camera, domElement: HTMLElement): void {
    if (this.pickDomElement === domElement) return
    this.disablePicking()
    this.pickCamera = camera
    this.pickDomElement = domElement
    domElement.addEventListener('pointerdown', this.handlePickPointerDown)
    domElement.addEventListener('click', this.handlePickClick)
  }

  /** 停止点击拾取并释放监听 */
  disablePicking(): void {
    if (this.pickDomElement) {
      this.pickDomElement.removeEventListener('pointerdown', this.handlePickPointerDown)
      this.pickDomElement.removeEventListener('click', this.handlePickClick)
    }
    this.pickCamera = null
    this.pickDomElement = null
  }

  /**
   * 用归一化设备坐标（NDC，x/y ∈ -1 ~ 1，原点在画布中心）对已加载的 GLB
   * 模型做射线拾取，未命中任何部件时返回 null。
   * 调试可用 __tilesViewer.pickGltfAt(x, y) 手动调用。
   */
  pick(camera: THREE.Camera, ndc: THREE.Vector2): GltfPickInfo | null {
    if (this.root.children.length === 0) return null

    camera.updateMatrixWorld()
    this.root.updateMatrixWorld(true)
    this.raycaster.setFromCamera(ndc, camera)
    const hits = this.raycaster.intersectObjects(this.root.children, true)

    const hit = hits.find((item) => this.isVisibleInTree(item.object))
    if (!hit) return null

    const object = hit.object
    const model = this.findModelRoot(object)
    if (!model) return null

    return {
      object,
      name: this.resolveObjectName(object),
      path: this.buildObjectPath(object, model),
      worldPosition: hit.point.clone(),
      localPosition: model.worldToLocal(hit.point.clone()),
      distance: hit.distance,
      model,
    }
  }

  /**
   * 高亮指定 GLB 部件（或其子树）：克隆部件材质并叠加高亮色，
   * 不影响共享同一材质的其他部件。传 null 清除当前高亮。
   */
  highlight(object: THREE.Object3D | null): void {
    if (this.highlightedObject === object) return
    this.clearHighlight()
    if (!object) return

    this.highlightedObject = object
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      const original = mesh.material
      const materials = Array.isArray(original) ? original : [original]
      const clones = materials.map((material) => {
        const clone = material.clone()
        this.applyHighlightToMaterial(clone)
        this.highlightedClonedMaterials.add(clone)
        return clone
      })

      mesh.material = Array.isArray(original) ? clones : clones[0]
      this.highlightedOriginalMaterials.set(mesh, original)
    })
  }

  /** 清除当前高亮，恢复部件原始材质 */
  clearHighlight(): void {
    if (!this.highlightedObject) return

    for (const [mesh, original] of this.highlightedOriginalMaterials) {
      mesh.material = original
    }
    this.highlightedOriginalMaterials.clear()

    for (const material of this.highlightedClonedMaterials) {
      material.dispose()
    }
    this.highlightedClonedMaterials.clear()

    this.highlightedObject = null
  }

  /** 清除并释放所有已加载的 GLTF 模型 */
  clear(): void {
    this.clearHighlight()
    disposeObject3D(this.root)
    this.root.clear()
  }

  // ========== 点击拾取实现 ==========

  private readonly handlePickPointerDown = (event: PointerEvent): void => {
    this.pickPointerStart.set(event.clientX, event.clientY)
  }

  private readonly handlePickClick = (event: MouseEvent): void => {
    if (!this.pickCamera || !this.pickDomElement) return

    // 拖动旋转/平移后松开也会触发 click，位移超过阈值视为拖拽，不拾取
    if (
      Math.hypot(
        event.clientX - this.pickPointerStart.x,
        event.clientY - this.pickPointerStart.y,
      ) > 5
    ) {
      return
    }

    const info = this.pick(this.pickCamera, this.clientToNdc(event, this.pickDomElement))
    // 命中则高亮该部件，点击空白清除高亮
    this.highlight(info?.object ?? null)
    this.deps.onPick?.(info, info ? { x: event.clientX, y: event.clientY } : null)
  }

  /** 给克隆材质叠加高亮色（优先用 emissive，无 emissive 的材质直接混色） */
  private applyHighlightToMaterial(material: THREE.Material): void {
    const highlightable = material as THREE.MeshStandardMaterial & {
      emissive?: THREE.Color
      emissiveIntensity?: number
    }

    if (highlightable.emissive) {
      highlightable.emissive.copy(this.highlightColor)
      highlightable.emissiveIntensity = 0.6
    } else {
      const colorMaterial = material as THREE.MeshBasicMaterial
      if (colorMaterial.color) {
        colorMaterial.color.lerp(this.highlightColor, 0.35)
      }
    }

    material.needsUpdate = true
  }

  private clientToNdc(event: MouseEvent, domElement: HTMLElement): THREE.Vector2 {
    const rect = domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  /** 命中对象及其所有祖先是否可见（不可见对象不参与拾取） */
  private isVisibleInTree(object: THREE.Object3D): boolean {
    let node: THREE.Object3D | null = object
    while (node) {
      if (node.visible === false) return false
      node = node.parent
    }
    return true
  }

  /** 找到命中对象所属的模型根节点（root 的直接子级） */
  private findModelRoot(object: THREE.Object3D): THREE.Group | null {
    let node: THREE.Object3D | null = object
    while (node && node.parent && node.parent !== this.root) {
      node = node.parent
    }
    return node && node.parent === this.root ? (node as THREE.Group) : null
  }

  /** 取部件名称：对象本身无名字时向上取最近的有名字的祖先 */
  private resolveObjectName(object: THREE.Object3D): string {
    let node: THREE.Object3D | null = object
    while (node && node !== this.root) {
      if (node.name) return node.name
      node = node.parent
    }
    return '(未命名部件)'
  }

  /** 生成「模型根 → 命中对象」的节点路径 */
  private buildObjectPath(object: THREE.Object3D, model: THREE.Group): string {
    const names: string[] = []
    let node: THREE.Object3D | null = object
    while (node && node !== model) {
      names.unshift(node.name || '(未命名)')
      node = node.parent
    }
    names.unshift(model.name || 'gltf-model')
    return names.join(' / ')
  }
}
