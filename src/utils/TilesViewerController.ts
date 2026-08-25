import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins'
import { Sky } from 'three/addons/objects/Sky.js'
import { disposeObject3D } from '@/utils/common/three-dispose'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import {
  GltfModelLoader,
  type GltfLoadOptions,
  type GltfPickInfo,
} from '@/utils/GltfModelLoader'
import type { SceneSourceKind, TilesetSourceConfig } from '@/utils/common/tileset'

// ========== 环境配置类型 ==========

interface EnvConfig {
  version: number
  sky: { enabled: boolean; turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number }
  sun: { elevation: number; azimuth: number; syncSunToLight: boolean }
  directionalLight: { intensity: number; color: string; yaw: number; pitch: number }
  shadow: { enabled: boolean; resolution: number; range: number; offsetX: number; offsetY: number; bias: number }
  environment: { hdrPath: string; envIntensity: number; bgIntensity: number; exposure: number }
  bloom: { enabled: boolean; strength: number; radius: number; threshold: number }
}

// ========== 配置常量 ==========

/** 相机最远缩小倍数（相对初始聚焦距离） */
const ZOOM_LIMITS = {
  maxDistanceFactor: 1,
} as const

// ========== 接口定义 ==========

export interface ViewerCallbacks {
  /** 点击 GLB 模型部件时的回调（info 为 null 表示点击未命中模型，可关闭弹窗） */
  onGltfPick?: (
    info: GltfPickInfo | null,
    position: { x: number; y: number } | null,
  ) => void
}

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
  private readonly dracoLoader = new DRACOLoader()
  private readonly ktx2Loader = new KTX2Loader()
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())
  private readonly pointMarkerRenderer: PointMarkerRenderer

  // ---- 天空与环境 ----
  private readonly sky: Sky
  private readonly sunPosition = new THREE.Vector3()
  /** HDR 环境贴图（studio.exr），为 PBR 材质提供环境反射与背景 */
  private hdrTexture: THREE.Texture | null = null

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
    this.dracoLoader.setDecoderPath(DRACO_GLTF_CONFIG)

    // 天空：Preetham 物理大气散射模型
    this.sky = new Sky()
    this.sky.scale.setScalar(45000)
    this.scene.add(this.sky)
    // 默认天空参数（后续由 applyEnvConfig 覆盖）
    const skyUniforms = this.sky.material.uniforms
    skyUniforms['turbidity'].value = 10
    skyUniforms['rayleigh'].value = 2
    skyUniforms['mieCoefficient'].value = 0.005
    skyUniforms['mieDirectionalG'].value = 0.8
    this.sunPosition.set(0, 1, 0)
    skyUniforms['sunPosition'].value.copy(this.sunPosition)
    // PMREM 环境贴图：从天空烘焙，为 PBR 材质提供环境反射
    this.bakeSkyEnvMap()

    this.tilesetRoot.name = 'tileset-root'
    this.markerRoot.name = 'marker-root'
    this.scene.add(this.tilesetRoot)
    this.scene.add(this.markerRoot)

    // GLTF/GLB 模型加载器：维护独立的 gltf-root 容器，复用 DRACO/KTX2 解压
    this.gltfModelLoader = new GltfModelLoader({
      scene: this.scene,
      renderer: this.renderer,
      dracoLoader: this.dracoLoader,
      ktx2Loader: this.ktx2Loader,
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
    })

    this.camera.position.set(160, 140, 180)

    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 1
    this.controls.maxDistance = 10000
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

    this.clearLonLatPoint()
    this.sceneBounds.makeEmpty()
    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    this.fitTimerId = 0
    this.groundingTimerId = 0

    await (this.renderer as THREE.WebGLRenderer & { init?: () => Promise<void> }).init?.()
    this.ktx2Loader.detectSupport(this.renderer)

    // 应用环境配置（天空、光照、渲染参数）
    try {
      await this.applyEnvConfig()
    } catch (e) {
      console.warn('[loadScene] 环境配置加载失败，使用默认参数。', e)
    }

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
      this.scheduleCameraFit()
    })

    this.tilesetRoot.add(this.tilesRenderer.group)
  }

  /** 渲染经纬度定位点并飞行到该点 */
  async renderLonLatPoint(longitude: number, latitude: number, height?: number): Promise<void> {
    const pointPosition = await this.pointMarkerRenderer.render(longitude, latitude, height)
    this.flyTo(pointPosition)
    this.schedulePointGrounding(1000)
  }

  /** 清除经纬度定位点 */
  clearLonLatPoint(): void {
    this.pointMarkerRenderer.clear()
  }

  /**
   * 在场景中直接加载并渲染一个 GLTF/GLB 模型（委托给 GltfModelLoader）。
   *
   * @param url - 模型资源地址，如 './data/gltf/jfs-bim.glb'
   * @param options.center - 是否把模型包围盒中心移到原点（默认 true；
   *   提供 geo 配准时自动改为 false，由地理配准定位）
   * @param options.geo - 地理配准参数：把 GLB 局部坐标自动映射到 CGCS2000 真实坐标，
   *   再进入场景坐标系，位置与朝向一次到位（推荐方式）
   * @param options.fitCamera - 加载完成后是否自动聚焦相机到包含模型在内的场景（默认 true）
   * @returns 加载完成的模型根节点（THREE.Group）
   */
  async loadGltf(
    url: string,
    options: GltfLoadOptions & { fitCamera?: boolean } = {},
  ): Promise<THREE.Group> {
    const loadOptions: GltfLoadOptions = { layer: 1, ...options }
    const model = options.geo
      ? await this.gltfModelLoader.load(url, { ...loadOptions, center: false })
      : await this.gltfModelLoader.load(url, loadOptions)

    if (options.fitCamera !== false) {
      this.hasSettledView = false
      this.scheduleCameraFit()
    }

    return model
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

  /** 应用环境配置：天空、HDR、光照、阴影、渲染参数（对齐 environment.js importConfig） */
  async applyEnvConfig(): Promise<void> {
    const cfg = await this.loadEnvConfig()

    // ---- 天空参数 ----
    const skyUniforms = this.sky.material.uniforms
    skyUniforms['turbidity'].value = cfg.sky.turbidity
    skyUniforms['rayleigh'].value = cfg.sky.rayleigh
    skyUniforms['mieCoefficient'].value = cfg.sky.mieCoefficient
    skyUniforms['mieDirectionalG'].value = cfg.sky.mieDirectionalG

    // ---- 太阳位置 ----
    const phi = THREE.MathUtils.degToRad(90 - cfg.sun.elevation)
    const theta = THREE.MathUtils.degToRad(cfg.sun.azimuth)
    this.sunPosition.setFromSphericalCoords(1, phi, theta)
    skyUniforms['sunPosition'].value.copy(this.sunPosition)

    // ---- 色调映射与曝光 ----
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = cfg.environment.exposure

    // ---- 从天空烘焙 PMREM 环境贴图 ----
    this.bakeSkyEnvMap()




    // ---- 天空可见性（对齐 applySky）----
    this.sky.visible = cfg.sky.enabled

    if (!cfg.sky.enabled) {
      // ---- 加载 HDR 环境贴图（studio.exr）----
      await this.loadHdrEnvironment(cfg.environment.hdrPath)
    }


    // ---- 环境强度 & 背景（对齐 applyAllParams 中 envInt / bgInt 逻辑）----
    const envInt = cfg.environment.envIntensity
    if (envInt > 0 && this.hdrTexture) {
      this.scene.environment = this.hdrTexture
      this.scene.environmentIntensity = envInt
    } else if (envInt > 0) {
      this.scene.environment = null
      this.scene.environmentIntensity = envInt
    } else {
      // envInt = 0 → 保留天空 PMREM 烘焙结果作为环境贴图
      this.scene.environmentIntensity = 0
    }

    const bgInt = cfg.environment.bgIntensity
    if (bgInt > 0 && this.hdrTexture) {
      this.scene.background = this.hdrTexture
      this.scene.backgroundIntensity = bgInt
    } else if (bgInt > 0) {
      this.scene.background = new THREE.Color(0x000000)
      this.scene.backgroundIntensity = bgInt
    } else {
      this.scene.background = new THREE.Color(0x1a1a2e)
      this.scene.backgroundIntensity = 0
    }

    // ---- 光照 ----
    // 移除旧灯光（保留 tileset-root 和 marker-root）
    const toRemove: THREE.Object3D[] = []
    this.scene.traverse((obj) => {
      if ((obj as THREE.Light).isLight) toRemove.push(obj)
    })
    toRemove.forEach((obj) => {
      obj.parent?.remove(obj)
    })

    // 主方向光（从配置读取方向 / 强度 / 颜色）
    const mainLight = new THREE.DirectionalLight(cfg.directionalLight.color, cfg.directionalLight.intensity)
    const yaw = THREE.MathUtils.degToRad(cfg.directionalLight.yaw)
    const pitch = THREE.MathUtils.degToRad(cfg.directionalLight.pitch)
    mainLight.position.setFromSphericalCoords(200, Math.PI / 2 - pitch, yaw)
    mainLight.layers.enableAll()
    this.scene.add(mainLight)

    // 太阳同步：方向光跟随太阳方向
    if (cfg.sun.syncSunToLight) {
      mainLight.position.copy(this.sunPosition).multiplyScalar(200)
    }

    // ---- 阴影（对齐 applyShadowToggle）----
    if (cfg.shadow.enabled) {
      mainLight.castShadow = true
      this.renderer.shadowMap.enabled = true
      mainLight.shadow.mapSize.set(cfg.shadow.resolution, cfg.shadow.resolution)
      mainLight.shadow.camera.left = -cfg.shadow.range + cfg.shadow.offsetX
      mainLight.shadow.camera.right = cfg.shadow.range + cfg.shadow.offsetX
      mainLight.shadow.camera.top = cfg.shadow.range + cfg.shadow.offsetY
      mainLight.shadow.camera.bottom = -cfg.shadow.range + cfg.shadow.offsetY
      mainLight.shadow.bias = cfg.shadow.bias
      mainLight.shadow.camera.updateProjectionMatrix()
    }

    // 半球光（环境补光）
    const hemiLight = new THREE.HemisphereLight('#dbeafe', '#020617', 0.6)
    hemiLight.position.set(0, 1, 0)
    hemiLight.layers.enableAll()
    this.scene.add(hemiLight)

    // 补光（对侧柔光）
    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.4)
    fillLight.position.set(-100, 60, -80)
    fillLight.layers.enableAll()
    this.scene.add(fillLight)
  }

  /** 加载 HDR 环境贴图（EXR 格式），为 PBR 材质提供环境反射与背景 */
  private loadHdrEnvironment(path: string): Promise<void> {
    if (!path) return Promise.resolve()
    return new Promise<void>((resolve) => {
      new EXRLoader().load(
        path,
        (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping
          this.hdrTexture = tex
          resolve()
        },
        undefined,
        (err) => {
          console.warn('[applyEnvConfig] HDR 加载失败', err)
          resolve()
        },
      )
    })
  }

  /** 从 env-config.json 加载环境配置 */
  private async loadEnvConfig(): Promise<EnvConfig> {
    const res = await fetch('./config/env-config.json')
    if (!res.ok) {
      throw new Error(`环境配置加载失败: ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<EnvConfig>
  }


  /** 从当前天空烘焙 PMREM 环境贴图，为 PBR 材质提供环境反射 */
  private bakeSkyEnvMap(): void {
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer)
    pmremGenerator.compileEquirectangularShader()

    const skyScene = new THREE.Scene()
    const skyCopy = new Sky()
    skyCopy.material.uniforms['turbidity'].value = this.sky.material.uniforms['turbidity'].value
    skyCopy.material.uniforms['rayleigh'].value = this.sky.material.uniforms['rayleigh'].value
    skyCopy.material.uniforms['mieCoefficient'].value = this.sky.material.uniforms['mieCoefficient'].value
    skyCopy.material.uniforms['mieDirectionalG'].value = this.sky.material.uniforms['mieDirectionalG'].value
    skyCopy.material.uniforms['sunPosition'].value.copy(this.sunPosition)
    skyScene.add(skyCopy)

    const envMap = pmremGenerator.fromScene(skyScene).texture

    if (this.scene.environment) {
      this.scene.environment.dispose()
    }
    this.scene.environment = envMap

    pmremGenerator.dispose()
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
    this.ktx2Loader.dispose()
    this.dracoLoader.dispose()
    if (this.scene.environment) {
      this.scene.environment.dispose()
      this.scene.environment = null
    }
    if (this.hdrTexture) {
      this.hdrTexture.dispose()
      this.hdrTexture = null
    }
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

  /** 延迟触发相机自动聚焦（防抖 160ms），用户已手动操作则跳过 */
  private scheduleCameraFit(): void {
    if (this.hasSettledView) return

    window.clearTimeout(this.fitTimerId)
    this.fitTimerId = window.setTimeout(() => {
      if (this.hasSettledView) return

      this.tilesetRoot.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(this.tilesetRoot)
      box.union(new THREE.Box3().setFromObject(this.gltfModelLoader.root))
      if (box.isEmpty() && !this.sceneBounds.isEmpty()) {
        box.copy(this.sceneBounds)
      }
      if (!box.isEmpty()) {
        this.fitCameraToBox(box)
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
