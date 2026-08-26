import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins'
import { disposeObject3D } from '@/utils/common/three-dispose'
import { EnvironmentManager } from '@/utils/common/environment'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import {
  GltfModelLoader,
  type GltfPickInfo,
  type ViewerCallbacks,
} from '@/utils/GltfModelLoader'
import type { SceneSourceKind, TilesetSourceConfig } from '@/utils/common/tileset'

// ========== 配置常量 ==========

/** 相机最远缩小倍数（相对初始聚焦距离） */
const ZOOM_LIMITS = {
  maxDistanceFactor: 1,
} as const

// ========== 控制器 ==========

/**
 * 3D Tiles 查看器控制器。
 *
 * 统一管理场景环境（天空/光照）、3D Tiles 瓦片集加载、相机/飞行/聚焦、
 * 双相机渲染循环、视口自适应和生命周期。
 */
export class TilesViewerController {
  // ---- Three.js 核心对象 ----
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 1, 1e7)
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  private readonly controls = new OrbitControls(this.camera, this.renderer.domElement)
  private readonly tilesetRoot = new THREE.Group()
  private readonly markerRoot = new THREE.Group()
  private readonly gltfModelLoader: GltfModelLoader
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())
  private pointMarkerRenderer: PointMarkerRenderer

  // ---- 环境管理 ----
  private environment: EnvironmentManager

  // ---- 3D Tiles 状态 ----
  private tilesRenderer: TilesRenderer | null = null
  private tilesetSource: TilesetSourceConfig | null = null
  private tilesetReady = false

  // ---- 双相机透视：Layer 0 外壳（3D Tiles）/ Layer 1 内部（GLB） ----
  private readonly camInner = new THREE.PerspectiveCamera(45, 1, 1, 1e7)
  private readonly rtInner = new THREE.WebGLRenderTarget(1, 1)
  private readonly sceneOverlay = new THREE.Scene()
  private readonly camOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10)

  // ---- 其他状态 ----
  private container: HTMLElement | null = null
  /** 场景范围（root 加载后由包围球得出），供相机聚焦与点位贴地回退 */
  private readonly sceneBounds = new THREE.Box3()
  /** 用户手动操作后禁止后续自动聚焦覆盖视角 */
  private hasSettledView = false
  /** 首次相机聚焦是否完成（用于控制画布淡入） */
  private firstFitDone = false
  private animationFrameId = 0
  private fitTimerId = 0
  private groundingTimerId = 0
  private readonly flyAnimation = {
    active: false,
    startTime: 0,
    duration: 0,
    fromPosition: new THREE.Vector3(),
    toPosition: new THREE.Vector3(),
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(),
  }

  constructor(callbacks: ViewerCallbacks = {}) {
    // 环境管理器：统一管理天空、光照、阴影、HDR、色调映射
    this.environment = new EnvironmentManager(this.scene, this.renderer)
    this.scene.add(this.environment.getSky())

    this.tilesetRoot.name = 'tileset-root'
    this.markerRoot.name = 'marker-root'
    this.scene.add(this.tilesetRoot)
    this.scene.add(this.markerRoot)

    // GLTF/GLB 模型加载器：维护独立的 gltf-root 容器
    this.gltfModelLoader = new GltfModelLoader({
      scene: this.scene,
      renderer: this.renderer,
      getEcefToSceneTransform: () => {
        const group = this.tilesRenderer?.group
        if (!group) return null
        group.updateMatrixWorld(true)
        return group.matrixWorld.clone()
      },
      whenTerrainReady: () => this.whenTerrainReady(),
      onPick: (info, position) => {
        callbacks.onGltfPick?.(info, position)
      },
      onRequestFitCamera: () => {
        this.hasSettledView = false
        this.scheduleCameraFit()
      },
    })

    // ---- 双相机透视基础设施 ----
    // 外相机（Layer 0）看 3D Tiles 外壳，内相机（Layer 1）看 GLB 内部结构
    this.camera.layers.set(0)
    this.camInner.layers.set(1)
    this.rtInner.texture.colorSpace = THREE.SRGBColorSpace

    // 全屏面片 + 正交场景：把内部渲染纹理叠加到屏幕顶层
    const quadMat = new THREE.MeshBasicMaterial({
      map: this.rtInner.texture,
      transparent: true,  // 启用纹理 alpha，外壳才能透出来
      depthTest: false,   // 叠加层永远绘制在场景之上
      depthWrite: false,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat)
    this.sceneOverlay.add(quad)

    // 启用 GLB 部件点击拾取（点击部件回调 onGltfPick，点击空白回调 null）
    this.gltfModelLoader.enablePicking(this.camera, this.renderer.domElement)

    this.pointMarkerRenderer = new PointMarkerRenderer({
      tilesetRoot: this.tilesetRoot,
      markerRoot: this.markerRoot,
      getTerrainGroup: () => this.findTerrainGroup(),
      getFallbackBounds: () => this.sceneBounds,
      flyTo: (target) => this.flyTo(target),
      onScheduleGrounding: (delay) => this.schedulePointGrounding(delay),
    })

    this.camera.position.set(0, 3000, 4000)

    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 1
    this.controls.maxDistance = 50000
    this.controls.target.set(0, 0, 0)
    // 用户手动操作后禁止后续自动聚焦覆盖视角
    this.controls.addEventListener('start', () => {
      this.hasSettledView = true
    })

    this.renderer.setPixelRatio(this.getPreferredPixelRatio())
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.autoClear = false // 手动控制清屏，保证三步渲染互不干扰

    // 画布初始隐藏，等首次相机聚焦就位后淡入，避免看到中间状态
    this.renderer.domElement.style.opacity = '0'
    this.renderer.domElement.style.transition = 'opacity 0.6s ease'
  }

  // ========== 公共方法 ==========

  /** 挂载 canvas 到容器，启动渲染循环 */
  mount(container: HTMLElement): void {
    this.container = container
    this.container.innerHTML = ''
    this.container.appendChild(this.renderer.domElement)

    if (container.style.position === '') {
      container.style.position = 'relative'
    }

    this.resizeObserver.observe(container)
    this.handleResize()
    this.startLoop()

      ; (window as unknown as { __tilesViewer?: TilesViewerController }).__tilesViewer = this
  }

  /** 加载 3D Tiles 场景 */
  async loadScene(sources: TilesetSourceConfig[]): Promise<void> {
    if (!this.container) {
      throw new Error('Three.js 容器尚未挂载。')
    }

    this.pointMarkerRenderer.clear()
    this.sceneBounds.makeEmpty()
    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    this.fitTimerId = 0
    this.groundingTimerId = 0

    await (this.renderer as THREE.WebGLRenderer & { init?: () => Promise<void> }).init?.()

    // 应用环境配置（天空、光照、渲染参数）
    await this.applyEnvConfig()

    // ---- 加载 3D Tiles 作为外壳（Layer 0）----
    const source = sources.find((item) => item.url)
    if (!source) {
      throw new Error('未提供可加载的 3DTiles 数据源。')
    }

    this.clearTileset()

    this.tilesetSource = source
    this.tilesRenderer = new TilesRenderer(source.url)
    this.tilesRenderer.setCamera(this.camera)
    this.tilesRenderer.setResolutionFromRenderer(this.camera, this.renderer)

    // 降低 SSE 阈值（默认 16px → 4px），让 TilesRenderer 加载更高层级的细节瓦片
    this.tilesRenderer.errorTarget = 0
    // 提高瓦片解析并发数（默认 5 → 10），加速高清瓦片加载
    this.tilesRenderer.parseQueue.maxJobs = 10

    // 坐标 recenter（大坐标 ECEF 场景归到原点附近）
    this.tilesRenderer.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }))

    // 所有瓦片网格分配到 Layer 0（外壳层），仅外相机可见
    this.tilesRenderer.addEventListener('load-model', ({ scene }: { scene: THREE.Object3D }) => {
      scene.traverse((obj: THREE.Object3D) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.layers.set(0)
        }
      })
    })

    // tileset 加载完成后，ReorientationPlugin 已把瓦片集居中到原点并调整为 +Y 上，
    // 这里只记录场景范围并聚焦相机（v0.5.1 事件名为 load-root-tileset）
    const boundingSphere = new THREE.Sphere()
    this.tilesRenderer.addEventListener('load-root-tileset', () => {
      const renderer = this.tilesRenderer
      if (!renderer) return
      if (renderer.getBoundingSphere(boundingSphere)) {
        const center = boundingSphere.center.clone().applyMatrix4(renderer.group.matrixWorld)
        this.sceneBounds.setFromCenterAndSize(
          center,
          new THREE.Vector3(
            boundingSphere.radius * 2,
            boundingSphere.radius * 2,
            boundingSphere.radius * 2,
          ),
        )
      }
      this.tilesetReady = true

      // 立即用 bounding sphere 完整范围聚焦相机（不等瓦片逐步加载），然后淡入画布
      if (!this.hasSettledView && !this.sceneBounds.isEmpty()) {
        const box = new THREE.Box3().copy(this.sceneBounds)
        const gltfBox = new THREE.Box3().setFromObject(this.gltfModelLoader.root)
        if (!gltfBox.isEmpty()) box.union(gltfBox)
        this.fitCameraToBox(box)
      }
      if (!this.firstFitDone) {
        this.firstFitDone = true
        this.renderer.domElement.style.opacity = '1'
      }
    })

    this.tilesetRoot.add(this.tilesRenderer.group)
  }

  /** 获取经纬度点位渲染器实例（供 PointLocatorForm 直接使用） */
  getPointMarkerRenderer(): PointMarkerRenderer {
    return this.pointMarkerRenderer
  }

  /** 获取 GLTF 模型加载器实例（供组件直接调用 loadGltf） */
  getGltfModelLoader(): GltfModelLoader {
    return this.gltfModelLoader
  }

  /** 用 NDC 坐标（-1 ~ 1，原点在画布中心）手动拾取 GLB 部件（调试工具） */
  pickGltfAt(ndcX: number, ndcY: number): GltfPickInfo | null {
    return this.gltfModelLoader.pick(this.camera, new THREE.Vector2(ndcX, ndcY))
  }

  /** 清除 GLB 部件高亮 */
  clearGltfHighlight(): void {
    this.gltfModelLoader.clearHighlight()
  }

  /** 获取瓦片图层及其显隐状态，供 UI 渲染 */
  getLayerList(): Array<{ id: string; name: string; kind: SceneSourceKind; visible: boolean }> {
    if (!this.tilesRenderer || !this.tilesetSource) return []
    return [
      {
        id: this.tilesetSource.id,
        name: this.tilesetSource.name,
        kind: this.tilesetSource.kind,
        visible: this.tilesRenderer.group.visible,
      },
    ]
  }

  /** 设置瓦片图层的显隐（true 显示 / false 隐藏） */
  setLayerVisible(sourceId: string, visible: boolean): void {
    if (this.tilesetSource?.id === sourceId && this.tilesRenderer) {
      this.tilesRenderer.group.visible = visible
    }
  }

  // ========== 环境配置 ==========

  /** 加载 env-config.json 并应用全部环境配置（天空、光照、阴影、渲染参数） */
  async applyEnvConfig(): Promise<void> {
    try {
      await this.environment.applyFromUrl('./config/env-config.json')
    } catch (e) {
      console.warn('[loadScene] 环境配置加载失败，使用默认参数。', e)
    }
  }

  /** 获取环境管理器实例（供外部读取天空、光照等状态） */
  getEnvironment(): EnvironmentManager {
    return this.environment
  }

  // ========== 相机飞行 ==========

  /** 平滑飞行到目标点，保持当前观察角度 */
  flyTo(target: THREE.Vector3, duration = 900): void {
    this.hasSettledView = true

    const distance = Math.max(this.pointMarkerRenderer.getMarkerScale() * 12, 120)
    const direction = new THREE.Vector3()
    this.camera.getWorldDirection(direction)

    const anim = this.flyAnimation
    anim.active = true
    anim.startTime = performance.now()
    anim.duration = duration
    anim.fromPosition.copy(this.camera.position)
    anim.toPosition.copy(target).addScaledVector(direction, -distance)
    anim.fromTarget.copy(this.controls.target)
    anim.toTarget.copy(target)
  }

  /** 每帧推进飞行动画（easeInOutCubic） */
  private updateFlyAnimation(): void {
    const anim = this.flyAnimation
    const elapsed = performance.now() - anim.startTime
    const t = Math.min(elapsed / anim.duration, 1)
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    this.camera.position.lerpVectors(anim.fromPosition, anim.toPosition, eased)
    this.controls.target.lerpVectors(anim.fromTarget, anim.toTarget, eased)
    this.camera.lookAt(this.controls.target)

    if (t >= 1) {
      anim.active = false
      this.camera.position.copy(anim.toPosition)
      this.controls.target.copy(anim.toTarget)
      this.controls.update()
    }
  }

  // ========== 销毁 ==========

  /** 销毁控制器，释放所有 GPU 资源与 DOM 监听 */
  destroy(): void {
    const debugWindow = window as unknown as { __tilesViewer?: TilesViewerController | null }
    if (debugWindow.__tilesViewer === this) {
      debugWindow.__tilesViewer = null
    }

    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    cancelAnimationFrame(this.animationFrameId)
    this.resizeObserver.disconnect()
    this.gltfModelLoader.disablePicking()
    this.clearTileset()
    this.pointMarkerRenderer.dispose()
    this.controls.dispose()
    this.environment.dispose()
    this.rtInner.dispose()

    disposeObject3D(this.scene)
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.container?.replaceChildren()
    this.container = null
  }

  // ========== 渲染循环 ==========

  private startLoop(): void {
    const renderFrame = () => {
      this.animationFrameId = window.requestAnimationFrame(renderFrame)

      if (this.flyAnimation.active) {
        this.updateFlyAnimation()
      } else {
        this.controls.update()
      }

      // TilesRenderer.update() 需要本帧最新的相机矩阵（LOD/frustum culling 在此完成）
      this.camera.updateMatrixWorld()
      if (this.tilesRenderer && this.tilesRenderer.group.visible) {
        this.tilesRenderer.update()
      }

      // 内部相机姿态完全复制外部相机（位置/朝向/投影同步）
      this.camInner.copy(this.camera)
      this.camInner.layers.set(1)

      // 临时禁用背景和雾，避免 Three.js 填充 render target
      const savedBackground = this.scene.background
      const savedFog = this.scene.fog
      this.scene.background = null
      this.scene.fog = null

      // 1. 渲染 GLB 到 rtInner（透明背景，轮廓网格已在 Layer 1 自动绘制）
      this.renderer.setRenderTarget(this.rtInner)
      this.renderer.setClearColor(0x000000, 0) // alpha=0 → 纹理背景透明
      this.renderer.clear(true, true, false)
      this.renderer.render(this.scene, this.camInner)

      // 恢复背景和雾效
      this.scene.background = savedBackground
      this.scene.fog = savedFog

      // 2. 渲染外壳到屏幕（Layer 0 的 3D Tiles + 天空）
      this.renderer.setRenderTarget(null)
      this.renderer.clear(true, true, false)
      this.renderer.render(this.scene, this.camera)

      // 3. 叠加 GLB（含轮廓）：只清深度、保留外壳颜色
      this.renderer.clearDepth()
      this.renderer.render(this.sceneOverlay, this.camOrtho)
    }

    renderFrame()
  }

  // ========== 3D Tiles 管理 ==========

  /** 释放并移除当前瓦片渲染器 */
  private clearTileset(): void {
    if (this.tilesRenderer) {
      this.tilesRenderer.deleteCamera(this.camera)
      this.tilesetRoot.remove(this.tilesRenderer.group)
      this.tilesRenderer.dispose()
      this.tilesRenderer = null
    }
    this.tilesetSource = null
    this.tilesetReady = false
  }

  // ========== 地形状态 ==========

  /**
   * 等待地形瓦片集根节点就绪（ReorientationPlugin 已算完场景矩阵）。
   * 无事件监听：每 100ms 轮询检测 root 是否就绪。
   */
  private whenTerrainReady(): Promise<void> {
    const tilesRenderer = this.tilesRenderer
    if (!tilesRenderer) {
      console.warn('[loadGltf] 未加载地形瓦片集，无法进行地理配准。')
      return Promise.resolve()
    }

    const isReady = () =>
      this.tilesetReady || Boolean((tilesRenderer as unknown as { root?: unknown }).root)
    if (isReady()) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timerId = window.setInterval(() => {
        if (isReady()) {
          window.clearInterval(timerId)
          resolve()
        }
      }, 100)
    })
  }

  /** 查找地形 tileset 的 group（供 ECEF → 局部坐标变换使用） */
  private findTerrainGroup(): THREE.Group | null {
    return this.tilesRenderer?.group ?? null
  }

  // ========== 视口自适应 ==========

  private handleResize(): void {
    if (!this.container) return

    const width = Math.max(this.container.clientWidth, 1)
    const height = Math.max(this.container.clientHeight, 1)

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(this.getPreferredPixelRatio())

    // 与 demo 一致：窗口变化时重新同步瓦片 SSE 分辨率
    this.tilesRenderer?.setResolutionFromRenderer(this.camera, this.renderer)

    // 同步内相机与渲染目标尺寸
    this.camInner.aspect = width / height
    this.camInner.updateProjectionMatrix()
    this.rtInner.setSize(width, height)
  }

  // ========== 相机聚焦 ==========

  /** 延迟用最新加载的地形几何体重新贴地点位（防抖） */
  private schedulePointGrounding(delay = 160): void {
    window.clearTimeout(this.groundingTimerId)
    this.groundingTimerId = window.setTimeout(() => {
      this.groundingTimerId = 0
      this.pointMarkerRenderer.refreshGrounding()
    }, delay)
  }

  /** 延迟触发相机自动聚焦（防抖 160ms），用于 GLTF 加载等后续场景变更 */
  private scheduleCameraFit(): void {
    if (this.hasSettledView) return

    window.clearTimeout(this.fitTimerId)
    this.fitTimerId = window.setTimeout(() => {
      if (this.hasSettledView) return

      const box = new THREE.Box3()
      if (!this.sceneBounds.isEmpty()) {
        box.copy(this.sceneBounds)
        const gltfBox = new THREE.Box3().setFromObject(this.gltfModelLoader.root)
        if (!gltfBox.isEmpty()) box.union(gltfBox)
      } else {
        this.tilesetRoot.updateMatrixWorld(true)
        box.setFromObject(this.tilesetRoot)
        box.union(new THREE.Box3().setFromObject(this.gltfModelLoader.root))
      }

      if (!box.isEmpty()) {
        this.fitCameraToBox(box)
      }

      // fallback: load-root-tileset 未触发淡入时补上
      if (!this.firstFitDone) {
        this.firstFitDone = true
        this.renderer.domElement.style.opacity = '1'
      }
    }, 160)
  }

  /** 根据包围盒调整相机位置与裁剪面/缩放范围 */
  private fitCameraToBox(box: THREE.Box3): boolean {
    if (box.isEmpty()) return false

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z)
    const safeDimension = maxDimension > 0 ? maxDimension : 10

    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5)
    const distance = safeDimension / (2 * Math.tan(halfFov))
    const fitDistance = distance * 1.65

    const offset = new THREE.Vector3(1.2, 0.9, 1.4).normalize().multiplyScalar(fitDistance)

    this.camera.position.copy(center).add(offset)
    this.camera.near = Math.max(safeDimension / 500, 0.1)
    this.camera.far = Math.max(safeDimension * 50, 5000)
    this.camera.updateProjectionMatrix()

    this.controls.minDistance = Math.max(safeDimension / 200, 1)
    this.controls.maxDistance = Math.max(fitDistance * ZOOM_LIMITS.maxDistanceFactor, safeDimension)
    this.controls.target.copy(center)
    this.controls.update()

    return true
  }

  /** 按真实设备像素比渲染，高分屏上限 2x 保护性能 */
  private getPreferredPixelRatio(): number {
    return THREE.MathUtils.clamp(window.devicePixelRatio || 1, 1, 2)
  }
}
