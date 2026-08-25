import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { disposeObject3D } from '@/utils/common/three-dispose'
import {
  calibrateGeoReferenceFromAnchor,
  createGeoReferenceMatrix,
  type GeoReferenceParams,
} from '@/utils/common/geo-coordinate'

/** GLTF/GLB 加载选项 */
export interface GltfLoadOptions {
  /** 是否把模型包围盒中心移到原点（默认 true，避免大坐标浮点精度问题） */
  center?: boolean
  /** 模型网格分配的图层编号（双相机模式下 1=内部层，默认不设置） */
  layer?: number
  /** 地理配准参数：把 GLB 局部坐标自动映射到 CGCS2000 真实坐标再进入场景坐标系 */
  geo?: GeoReferenceParams
}

/** GLB 部件点击拾取信息 */
export interface GltfPickInfo {
  /** 选中的部件对象（命中网格向上最近的命名祖先，轮廓/半透明作用于整个部件） */
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
  /** WebGL 渲染器（用于获取最大各向异性等 GPU 能力） */
  renderer?: THREE.WebGLRenderer
  /** 复用的 DRACO 解压加载器 */
  dracoLoader: DRACOLoader
  /** 复用的 KTX2 纹理加载器 */
  ktx2Loader: KTX2Loader
  /** 可选：获取 ECEF → 场景坐标的变换矩阵（地理配准用） */
  getEcefToSceneTransform?: () => THREE.Matrix4 | null
  /** 可选：等待地形瓦片集就绪（地理配准用） */
  whenTerrainReady?: () => Promise<void>
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
 * 选中部件通过背面放大法绘制白色轮廓线（无需后处理）。
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

  // ---- 部件选中状态 ----
  /** 当前选中的部件对象（null 表示无选中） */
  private highlightedObject: THREE.Object3D | null = null
  /** 选中部件的半透明不透明度 */
  private static readonly SELECTED_OPACITY = 0.5
  /** 选中前每个网格的原始材质（恢复时用） */
  private readonly originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  /** 选中时克隆出的临时材质（清除时释放） */
  private readonly clonedMaterials = new Set<THREE.Material>()
  /** 轮廓线容器（克隆网格 + 白色背面材质） */
  private readonly outlineGroup = new THREE.Group()
  /** 轮廓线共享材质：白色、反面绘制、略微放大 */
  private readonly outlineMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.BackSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  /** 部件放大比例（相对于部件包围盒） */
  private static readonly OUTLINE_SCALE = 1.02

  constructor(deps: GltfModelLoaderDeps) {
    this.deps = deps

    this.root = new THREE.Group()
    this.root.name = 'gltf-root'
    this.outlineGroup.name = 'outline-group'
    this.outlineGroup.layers.set(1) // 轮廓线仅内相机(Layer 1)可见
    this.deps.scene.add(this.outlineGroup)
    this.deps.scene.add(this.root)

    this.loader = new GLTFLoader()
    this.loader.setDRACOLoader(this.deps.dracoLoader)
    this.loader.setKTX2Loader(this.deps.ktx2Loader)
    // 射线拾取启用所有图层，确保 Layer 1（GLB 内部层）的网格也能被点击命中
    // （双相机模式下 GLB 网格被设到 Layer 1，Raycaster 默认只检测 Layer 0）
    this.raycaster.layers.enableAll()
  }

  /** 加载并渲染一个 GLTF/GLB 模型，返回模型根节点 */
  async load(url: string, options: GltfLoadOptions = {}): Promise<THREE.Group> {
    const { center = true, layer, geo } = options

    const model = (await this.loader.loadAsync(url)).scene
    model.name = model.name || 'gltf-model'
    this.enhanceTextures(model)

    if (center) {
      const box = new THREE.Box3().setFromObject(model)
      if (!box.isEmpty()) {
        model.position.sub(box.getCenter(new THREE.Vector3()))
      }
    }

    // 分配到指定图层（双相机模式：Layer 1 = GLB 内部层）
    if (layer !== undefined) {
      model.traverse((obj: THREE.Object3D) => {
        if ((obj as THREE.Mesh).isMesh) obj.layers.set(layer)
      })
    }

    // 地理配准：用 CGCS2000 坐标把模型定位到场景中
    if (geo) {
      await this.applyGeoReference(model, geo)
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

    // 选中整个「部件」：取命名的最近祖先，保证轮廓/半透明作用于整个部件而非单个网格
    const part = this.resolvePartObject(object, model)

    return {
      object: part,
      name: this.resolveObjectName(part),
      path: this.buildObjectPath(part, model),
      worldPosition: hit.point.clone(),
      localPosition: model.worldToLocal(hit.point.clone()),
      distance: hit.distance,
      model,
    }
  }

  /**
   * 选中指定 GLB 部件：部件整体半透明 + 白色轮廓线。
   * 传 null 清除当前选中。
   */
  highlight(object: THREE.Object3D | null): void {
    this.clearHighlight()
    this.highlightedObject = object
    if (!object) return

    // ── 1. 部件整体半透明 ──
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      const original = mesh.material
      const materials = Array.isArray(original) ? original : [original]
      const clones = materials.map((mat) => {
        const clone = mat.clone()
        clone.transparent = true
        clone.opacity = GltfModelLoader.SELECTED_OPACITY
        clone.depthWrite = false
        clone.needsUpdate = true
        this.clonedMaterials.add(clone)
        return clone
      })
      mesh.material = Array.isArray(original) ? clones : clones[0]
      this.originalMaterials.set(mesh, original)
    })

    // ── 2. 白色轮廓线（背面放大法） ──
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object)
    const center = box.getCenter(new THREE.Vector3())
    const scale = GltfModelLoader.OUTLINE_SCALE

    const scaleMatrix = new THREE.Matrix4()
      .makeTranslation(center.x, center.y, center.z)
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))

    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      const clone = mesh.clone()
      clone.material = this.outlineMaterial

      mesh.updateMatrixWorld(true)
      clone.matrix.copy(mesh.matrixWorld)
      clone.matrix.premultiply(scaleMatrix)
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale)

      clone.layers.set(1)
      clone.renderOrder = 999
      this.outlineGroup.add(clone)
    })
  }

  /** 清除当前选中，恢复原始材质并移除轮廓网格 */
  clearHighlight(): void {
    // 恢复原始材质
    for (const [mesh, original] of this.originalMaterials) {
      mesh.material = original
    }
    this.originalMaterials.clear()
    for (const mat of this.clonedMaterials) {
      mat.dispose()
    }
    this.clonedMaterials.clear()

    // 移除轮廓网格
    while (this.outlineGroup.children.length > 0) {
      this.outlineGroup.remove(this.outlineGroup.children[0])
    }
    this.highlightedObject = null
  }

  /** 当前选中的部件对象（null 表示无选中；供 OutlinePass 绘制白色轮廓） */
  getHighlightedObject(): THREE.Object3D | null {
    return this.highlightedObject
  }

  /** 清除并释放所有已加载的 GLTF 模型 */
  clear(): void {
    this.clearHighlight()
    disposeObject3D(this.root)
    this.root.clear()
  }

  // ========== 地理配准 ==========

  /**
   * 用一个已知公共点反算 GLB 的地理配准参数（调试工具）。
   * 输入「模型里某构件的局部坐标（加载后米值）+ 它在地形上的经纬度/高程」，
   * 控制台打印可直接写进配置的 GeoReferenceParams。
   */
  calibrateFromAnchor(
    local: { x: number; y: number; z: number },
    longitude: number,
    latitude: number,
    height: number,
    verticalScale = 1,
    centralMeridianDeg = 114,
  ): GeoReferenceParams {
    const params = calibrateGeoReferenceFromAnchor(
      local,
      { longitude, latitude, height },
      centralMeridianDeg,
      verticalScale,
    )
    console.log('[地理配准] 已用已知点反算参数，写入模型配置即可自动定位:')
    console.log(JSON.stringify(params, null, 2))
    return params
  }

  /** 按地理配准参数把 GLB 定位到场景（等待地形就绪后应用矩阵） */
  private async applyGeoReference(
    model: THREE.Object3D,
    params: GeoReferenceParams,
  ): Promise<void> {
    await this.deps.whenTerrainReady?.()
    const ecefToScene = this.deps.getEcefToSceneTransform?.()
    if (!ecefToScene) {
      console.warn('[GltfModelLoader] ECEF → 场景变换不可用，无法进行地理配准。')
      return
    }
    const matrix = createGeoReferenceMatrix(params, ecefToScene)
    model.matrix.identity()
    model.applyMatrix4(matrix)
  }

  // ========== 纹理质量增强 ==========

  /** 提升模型纹理采样质量（各向异性 + 三线性过滤） */
  private enhanceTextures(scene: THREE.Object3D): void {
    const maxAnisotropy =
      this.deps.renderer?.capabilities.getMaxAnisotropy?.() ?? 16

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return

      const material = mesh.material
      if (!material) return

      const materials = Array.isArray(material) ? material : [material]
      for (const mat of materials) {
        if (!mat) continue

        for (const key of Object.keys(mat)) {
          const value = (mat as unknown as Record<string, unknown>)[key]
          if (!value || !(value as THREE.Texture).isTexture) continue

          const texture = value as THREE.Texture
          texture.anisotropy = maxAnisotropy

          const mipCount = Array.isArray(texture.mipmaps) ? texture.mipmaps.length : 0
          if (mipCount > 1) {
            texture.minFilter = THREE.LinearMipmapLinearFilter
          } else if (!(texture instanceof THREE.CompressedTexture)) {
            // 压缩纹理无法 GPU 生成 mipmap，保持 LinearFilter
            texture.minFilter = THREE.LinearMipmapLinearFilter
            texture.generateMipmaps = true
          }

          texture.needsUpdate = true
        }
      }
    })
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

  /** 取「部件」对象：命中网格向上取最近的有名字的祖先（整个部件一起选中） */
  private resolvePartObject(object: THREE.Object3D, model: THREE.Group): THREE.Object3D {
    let node: THREE.Object3D | null = object
    while (node && node !== model) {
      if (node.name) return node
      node = node.parent
    }
    return object
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
