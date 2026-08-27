import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins'
import { disposeObject3D } from '@/utils/common/three-dispose'
import { EnvironmentManager } from '@/utils/common/environment'
import { CameraManager } from '@/utils/common/camera'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import {
  GltfModelLoader,
  type GltfPickInfo,
  type ViewerCallbacks,
} from '@/utils/GltfModelLoader'
import type { SceneSourceKind, TilesetSourceConfig } from '@/utils/common/tileset'

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
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  private readonly tilesetRoot = new THREE.Group()
  private readonly markerRoot = new THREE.Group()
  private readonly gltfModelLoader: GltfModelLoader
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())
  private pointMarkerRenderer: PointMarkerRenderer

  // ---- 相机管理 ----
  private cameraManager!: CameraManager

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
  private animationFrameId = 0
  /** 是否启用双相机透视渲染（默认开启：GLB 透明叠加在 3D Tiles 外壳上） */
  private dualPass = true

  constructor(callbacks: ViewerCallbacks = {}) {
    // 环境管理器
    this.environment = new EnvironmentManager(this.scene, this.renderer)
    this.scene.add(this.environment.getSky())

    this.tilesetRoot.name = 'tileset-root'
    this.markerRoot.name = 'marker-root'
    this.scene.add(this.tilesetRoot)
    this.scene.add(this.markerRoot)

    // 相机管理器：统一管理相机、轨道控制、飞行、聚焦
    this.cameraManager = new CameraManager(this.renderer.domElement, {
      onGrounding: () => {
        this.pointMarkerRenderer?.refreshGrounding()
      },
    })

    // GLTF/GLB 模型加载器：维护独立的 gltf-root 容器组
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
        // 无 3D Tiles 时，GLB 加载完自动聚焦到模型上
        if (this.tilesetReady) return
        const box = new THREE.Box3().setFromObject(this.gltfModelLoader.root)
        if (!box.isEmpty()) {
          this.cameraManager.fitToBox(box)
        }
      },
    })

    // ---- 双相机透视基础设施 ----
    // 外相机（Layer 0）看 3D Tiles 外壳，内相机（Layer 1）看 GLB 内部结构
    this.cameraManager.camera.layers.set(0)
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
    this.gltfModelLoader.enablePicking(this.cameraManager.camera, this.renderer.domElement)

    this.pointMarkerRenderer = new PointMarkerRenderer({
      tilesetRoot: this.tilesetRoot,
      markerRoot: this.markerRoot,
      getTerrainGroup: () => this.findTerrainGroup(),
      getFallbackBounds: () => this.sceneBounds,
      flyTo: (target) => this.flyTo(target),
      onScheduleGrounding: (delay) => this.cameraManager.scheduleGrounding(delay),
    })

    this.renderer.setPixelRatio(this.getPreferredPixelRatio())
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.autoClear = false // 双透模式手动控制清屏

    // 画布初始透明，等环境配置就绪后淡入，避免黑屏
    this.renderer.domElement.style.opacity = '0'
    this.renderer.domElement.style.transition = 'opacity 0.6s ease'
  }

  // ========== 公共方法 ==========

  /** 挂载 canvas 到容器，构建场景环境（天空+光照），启动渲染循环 */
  async mount(container: HTMLElement): Promise<void> {
    this.container = container
    this.container.innerHTML = ''
    this.container.appendChild(this.renderer.domElement)

    if (container.style.position === '') {
      container.style.position = 'relative'
    }

    this.resizeObserver.observe(container)
    this.handleResize()

    // 先构建场景环境（天空、光照），避免黑屏
    await this.applyEnvConfig()

    // 环境就绪，画布淡入
    this.renderer.domElement.style.opacity = '1'

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

    // ---- 加载 3D Tiles 作为外壳（Layer 0）----
    const source = sources.find((item) => item.url)
    if (!source) {
      throw new Error('未提供可加载的 3DTiles 数据源。')
    }

    this.clearTileset()

    this.tilesetSource = source
    this.tilesRenderer = new TilesRenderer(source.url)
    this.tilesRenderer.setCamera(this.cameraManager.camera)
    this.tilesRenderer.setResolutionFromRenderer(this.cameraManager.camera, this.renderer)

    // 坐标 recenter（ECEF 大坐标场景归到原点附近，并自动对齐地表法线方向）
    this.tilesRenderer.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }))

    // 瓦片网格分配到 Layer 0（外壳层），仅外相机可见（双透视渲染需要）
    this.tilesRenderer.addEventListener('load-model', ({ scene }: { scene: THREE.Object3D }) => {
      scene.traverse((obj: THREE.Object3D) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.layers.set(0)
        }
      })
    })

    // 适配大场景 + 错误处理
    let isFirstTileSet = true
    const boundingSphere = new THREE.Sphere()

    this.tilesRenderer.addEventListener('load-tile-set', () => {
      const renderer = this.tilesRenderer
      if (!renderer) return

      if (renderer.getBoundingSphere(boundingSphere)) {
        const radius = boundingSphere.radius

        // ReorientationPlugin 已完成居中 + 旋转，计算场景范围
        const center = new THREE.Vector3(0, 0, 0)
        this.sceneBounds.setFromCenterAndSize(
          center,
          new THREE.Vector3(radius * 2, radius * 2, radius * 2),
        )

        // 调整相机 near/far 以适应大场景
        const cam = this.cameraManager.camera
        cam.near = Math.max(radius * 0.0001, 0.01)
        cam.far = radius * 10
        cam.updateProjectionMatrix()

        // 动态设置缩放范围
        this.cameraManager.controls.minDistance = radius * 0.01
        this.cameraManager.controls.maxDistance = radius * 3
        this.cameraManager.controls.update()
      }

      this.tilesetReady = true

      // 只在首次 tileset 加载完成时自动定位相机，避免缩放后被重置
      if (!isFirstTileSet) return
      isFirstTileSet = false

      if (!this.cameraManager.isViewSettled() && !this.sceneBounds.isEmpty()) {
        const box = new THREE.Box3().copy(this.sceneBounds)
        const gltfBox = new THREE.Box3().setFromObject(this.gltfModelLoader.root)
        if (!gltfBox.isEmpty()) box.union(gltfBox)
        this.cameraManager.fitToBox(box)
      }
    })

    // 瓦片加载错误处理
    this.tilesRenderer.addEventListener('load-tile-error', (e: unknown) => {
      console.warn('[TilesViewerController] 瓦片加载错误:', e)
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
    return this.gltfModelLoader.pick(this.cameraManager.camera, new THREE.Vector2(ndcX, ndcY))
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
    this.cameraManager.flyTo(target, this.pointMarkerRenderer.getMarkerScale(), duration)
  }

  /** 当前是否启用双相机透视渲染 */
  isDualPass(): boolean {
    return this.dualPass
  }

  /**
   * 切换双相机透视模式。
   * - ON: GLB 在 Layer 1 由内相机渲染，透明叠加在 3D Tiles 外壳上
   * - OFF: 所有物体在 Layer 0，单相机单次渲染
   */
  setDualPass(enabled: boolean): void {
    if (this.dualPass === enabled) return
    this.dualPass = enabled

    if (enabled) {
      // 切回双透模式
      this.cameraManager.camera.layers.set(0)
      this.renderer.autoClear = false
      this.gltfModelLoader.setLayer(1)
    } else {
      // 切到单层模式
      this.cameraManager.camera.layers.enable(1) // 相机同时看到 Layer 0+1
      this.renderer.autoClear = true
      this.gltfModelLoader.setLayer(0)
    }
  }

  // ========== 销毁 ==========

  /** 销毁控制器，释放所有 GPU 资源与 DOM 监听 */
  destroy(): void {
    const debugWindow = window as unknown as { __tilesViewer?: TilesViewerController | null }
    if (debugWindow.__tilesViewer === this) {
      debugWindow.__tilesViewer = null
    }

    cancelAnimationFrame(this.animationFrameId)
    this.resizeObserver.disconnect()
    this.gltfModelLoader.disablePicking()
    this.clearTileset()
    this.pointMarkerRenderer.dispose()
    this.cameraManager.dispose()
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

      if (this.cameraManager.tickFlyAnimation()) {
        // 飞行动画进行中，跳过 controls.update()
      } else {
        this.cameraManager.controls.update()
      }

      const cam = this.cameraManager.camera
      // TilesRenderer.update() 需要本帧最新的相机矩阵（LOD/frustum culling 在此完成）
      cam.updateMatrixWorld()
      if (this.tilesRenderer && this.tilesRenderer.group.visible) {
        this.tilesRenderer.update()
      }

      if (this.dualPass) {
        // ---- 双相机透视：三步合成 ----
        // 内部相机姿态完全复制外部相机（位置/朝向/投影同步）
        this.camInner.copy(cam)
        this.camInner.layers.set(1)

        // 临时禁用背景和雾，避免 Three.js 填充 render target
        const savedBackground = this.scene.background
        const savedFog = this.scene.fog
        this.scene.background = null
        this.scene.fog = null

        // 1. 渲染 GLB 到 rtInner（透明背景）
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
        this.renderer.render(this.scene, cam)

        // 3. 叠加 GLB（含轮廓）：只清深度、保留外壳颜色
        this.renderer.clearDepth()
        this.renderer.render(this.sceneOverlay, this.camOrtho)
      } else {
        // ---- 单层模式：一步渲染 ----
        this.renderer.render(this.scene, cam)
      }
    }

    renderFrame()
  }

  // ========== 3D Tiles 管理 ==========

  /** 释放并移除当前瓦片渲染器 */
  private clearTileset(): void {
    if (this.tilesRenderer) {
      this.tilesRenderer.deleteCamera(this.cameraManager.camera)
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

    this.cameraManager.resize(width, height)
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(this.getPreferredPixelRatio())

    // 窗口变化时重新同步瓦片 SSE 分辨率
    this.tilesRenderer?.setResolutionFromRenderer(this.cameraManager.camera, this.renderer)

    // 双透模式下同步内相机与渲染目标尺寸
    if (this.dualPass) {
      this.camInner.aspect = width / height
      this.camInner.updateProjectionMatrix()
      this.rtInner.setSize(width, height)
    }
  }

  /** 获取相机管理器实例（供外部读取相机、控制器等状态） */
  getCameraManager(): CameraManager {
    return this.cameraManager
  }

  /** 按真实设备像素比渲染，高分屏上限 2x 保护性能 */
  private getPreferredPixelRatio(): number {
    return THREE.MathUtils.clamp(window.devicePixelRatio || 1, 1, 2)
  }
}
