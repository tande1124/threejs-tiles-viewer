import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/three/plugins'
import { disposeObject3D } from '@/utils/three-dispose'
import { createKtx2MimeTypePlugin } from '@/utils/ktx2MimeTypePlugin'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import { GltfModelLoader, type GltfLoadOptions } from '@/utils/GltfModelLoader'
import {
  calibrateGeoReferenceFromAnchor,
  createGeoReferenceMatrix,
  type GeoReferenceParams,
} from '@/utils/geo-coordinate'
import type { TilesetSourceConfig } from '@/utils/tileset'

// ========== 配置常量 ==========

/** 复用的空包围盒 */
const EMPTY_BOX = new THREE.Box3()

/** 天空盒配色与程序化白云参数 */
const SKY_BACKGROUND = {
  top: '#1e6fd9',
  horizon: '#d8e7f5',
  bottom: '#0b1526',
  fog: '#d8e7f5',
  fogNear: 8000,
  fogFar: 50000,
  cloudColor: '#ffffff',
  cloudScale: 3.2,
  cloudOpacity: 0.9,
} as const

/** 3D Tiles 高清调度参数（errorTarget 越小越清晰、越费性能） */
const TILE_QUALITY = {
  errorTarget: 4,
  maxTilesProcessed: 4000,
  // 重新开启祖先/同级瓦片加载。
  // node_modules 中的 3d-tiles-renderer 已本地修补 v0.5.1 的占位逻辑：
  // 空占位瓦片（empty.glb）不再让父级 allChildrenLoaded 永久为 false，
  // 外部 tileset（.json）加载中也不会被误判为占位，因此不再卡 LOD；
  // 开启后子瓦片未就绪时父级会占位显示，放大/平移不再出现缺失区域。
  loadSiblings: true,
  loadAncestors: true,
  maxDepth: 64,
  cacheMinSize: 12000,
  cacheMaxSize: 20000,
  cacheMinBytes: 1024 * 1024 * 1024,
  cacheMaxBytes: 2 * 1024 * 1024 * 1024,
} as const

/** 相机最远缩小倍数（相对初始聚焦距离） */
const ZOOM_LIMITS = {
  maxDistanceFactor: 1,
} as const

// ========== 接口定义 ==========

export interface ViewerStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  progress: number
  message: string
  error?: string
}

export interface ViewerCallbacks {
  onStatusChange?: (status: ViewerStatus) => void
}

interface TilesetEntryListeners {
  loadRootTileset: () => void
  loadModel: (event: { scene: THREE.Object3D }) => void
  tilesLoadEnd: () => void
  loadError: (event: { error: Error; url: string | URL }) => void
}

interface RootBoundingVolume {
  box?: number[]
}

interface TilesetRootMetadata {
  transform?: number[]
  boundingVolume?: RootBoundingVolume
}

interface TilesetMetadata {
  root?: TilesetRootMetadata
}

interface ManagedTilesetEntry {
  config: TilesetSourceConfig
  renderer: TilesRenderer
  listeners: TilesetEntryListeners
  state: 'loading' | 'ready' | 'error'
  settled: boolean
  hasContent: boolean
  metadata: TilesetRootMetadata | null
  error?: string
}

// ========== 控制器 ==========

/**
 * 3D Tiles 查看器控制器：负责渲染管线、相机控制、瓦片加载与资源释放。
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
  private readonly callbacks: ViewerCallbacks
  private readonly timer = new THREE.Timer()
  private readonly tilesetRoot = new THREE.Group()
  private readonly markerRoot = new THREE.Group()
  private readonly gltfModelLoader: GltfModelLoader
  private readonly skyBox: THREE.Mesh
  private readonly dracoLoader = new DRACOLoader()
  private readonly ktx2Loader = new KTX2Loader()
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())
  private readonly resolutionSize = new THREE.Vector2()
  private readonly pointMarkerRenderer: PointMarkerRenderer
  /** 坐标轴辅助线（X 红 / Y 绿 / Z 蓝），单位尺寸创建、按场景包围盒缩放 */
  private readonly axesHelper = new THREE.AxesHelper(1)
  private axesVisible = true

  // ---- 内部状态 ----
  private container: HTMLElement | null = null
  private readonly tilesetEntries = new Map<string, ManagedTilesetEntry>()
  private animationFrameId = 0
  private fitTimerId = 0
  private groundingTimerId = 0
  private hasSettledView = false
  private hasAutoLoggedDiagnostics = false
  private debugHud: HTMLElement | null = null
  private debugHudLastUpdate = 0
  private lastStatusKey = ''
  private metadataSceneBounds = new THREE.Box3()
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
    this.callbacks = callbacks
    this.timer.connect(document)
    this.dracoLoader.setDecoderPath(DRACO_GLTF_CONFIG)

    // 天空、雾与背景
    this.skyBox = this.createSkyBox()
    this.scene.fog = new THREE.Fog(
      new THREE.Color(SKY_BACKGROUND.fog),
      SKY_BACKGROUND.fogNear,
      SKY_BACKGROUND.fogFar,
    )
    this.scene.background = new THREE.Color(SKY_BACKGROUND.bottom)

    // 三级光照：半球光 + 主方向光 + 补光
    const hemisphereLight = new THREE.HemisphereLight('#dbeafe', '#020617', 1.35)
    hemisphereLight.position.set(0, 1, 0)
    this.scene.add(hemisphereLight)

    const directionalLight = new THREE.DirectionalLight('#ffffff', 1.65)
    directionalLight.position.set(120, 180, 90)
    this.scene.add(directionalLight)

    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.85)
    fillLight.position.set(-100, 60, -80)
    this.scene.add(fillLight)

    this.tilesetRoot.name = 'tileset-root'
    this.markerRoot.name = 'marker-root'
    this.scene.add(this.tilesetRoot)
    this.scene.add(this.markerRoot)

    // 坐标轴辅助线：关闭雾化避免远处被雾吞没，较高 renderOrder 使其叠加在模型之上
    // AxesHelper 内部使用单个 LineBasicMaterial，此处直接断言以访问 fog 属性
    ;(this.axesHelper.material as THREE.LineBasicMaterial).fog = false
    this.axesHelper.renderOrder = 100
    this.axesHelper.name = 'axes-helper'
    this.scene.add(this.axesHelper)

    // GLTF/GLB 模型加载器：维护独立的 gltf-root 容器，复用 DRACO/KTX2 解压
    this.gltfModelLoader = new GltfModelLoader({
      scene: this.scene,
      dracoLoader: this.dracoLoader,
      ktx2Loader: this.ktx2Loader,
      enhanceTextures: (model) => this.enhanceModelTextures(model),
    })

    this.pointMarkerRenderer = new PointMarkerRenderer({
      tilesetRoot: this.tilesetRoot,
      markerRoot: this.markerRoot,
      getTerrainGroup: () => this.findTerrainGroup(),
      getFallbackBounds: () => this.metadataSceneBounds,
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
  }

  /** 创建跟随相机的渐变立方体天空盒（含程序化白云） */
  private createSkyBox(): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(SKY_BACKGROUND.top) },
        horizonColor: { value: new THREE.Color(SKY_BACKGROUND.horizon) },
        bottomColor: { value: new THREE.Color(SKY_BACKGROUND.bottom) },
        cloudColor: { value: new THREE.Color(SKY_BACKGROUND.cloudColor) },
        cloudScale: { value: SKY_BACKGROUND.cloudScale },
        cloudOpacity: { value: SKY_BACKGROUND.cloudOpacity },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          // 立方体以相机为中心，物体空间坐标 position 即为方向向量
          vDirection = position;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        uniform vec3 cloudColor;
        uniform float cloudScale;
        uniform float cloudOpacity;
        varying vec3 vDirection;

        float hash3(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        float valueNoise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(hash3(i + vec3(0.0, 0.0, 0.0)), hash3(i + vec3(1.0, 0.0, 0.0)), u.x),
              mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), u.x),
              u.y
            ),
            mix(
              mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), u.x),
              mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), u.x),
              u.y
            ),
            u.z
          );
        }

        float fbm3(vec3 p) {
          float value = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < 5; i++) {
            value += amplitude * valueNoise3(p);
            p = p * 2.03 + vec3(17.1, 9.7, 5.3);
            amplitude *= 0.5;
          }
          return value;
        }

        void main() {
          vec3 dir = normalize(vDirection);
          float h = dir.y;

          vec3 color = h >= 0.0
            ? mix(horizonColor, topColor, pow(h, 0.6))
            : mix(horizonColor, bottomColor, pow(-h, 0.6));

          if (h > 0.0) {
            float density = fbm3(dir * cloudScale);
            float cloud = smoothstep(0.5, 0.78, density);
            cloud *= smoothstep(0.0, 0.18, h);
            color = mix(color, cloudColor, cloud * cloudOpacity);
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    })

    // 半边长 = 50000 / √3，八个顶点落在旧球体半径处，避免远裁剪面裁掉天空盒
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(57735, 57735, 57735), material)
    mesh.name = 'sky-box'
    mesh.frustumCulled = false
    mesh.renderOrder = -1000
    this.scene.add(mesh)
    return mesh
  }

  // ========== 公共方法 ==========

  /** 挂载 canvas 到容器，启动渲染循环 */
  mount(container: HTMLElement): void {
    this.container = container
    this.container.innerHTML = ''
    this.container.appendChild(this.renderer.domElement)

    this.debugHud = this.createDebugHud(container)
    this.resizeObserver.observe(container)
    this.handleResize()
    this.startLoop()

    ;(window as unknown as { __tilesViewer?: TilesViewerController }).__tilesViewer = this

    this.emitStatus({
      state: 'idle',
      progress: 0,
      message: 'Three.js 场景已就绪，正在准备默认组合场景...',
    })
  }

  /** 加载组合场景：清除旧数据 → 拉元数据 → 先地形后模型 → 初始聚焦 */
  async loadScene(sources: TilesetSourceConfig[]): Promise<void> {
    if (!this.container) {
      throw new Error('Three.js 容器尚未挂载。')
    }

    const sceneSources = sources.filter((source) => source.url)
    if (sceneSources.length === 0) {
      throw new Error('未提供可加载的 3DTiles 数据源。')
    }

    this.clearSceneSources()
    this.clearLonLatPoint()
    this.hasSettledView = false
    this.metadataSceneBounds.makeEmpty()

    await (this.renderer as THREE.WebGLRenderer & { init?: () => Promise<void> }).init?.()
    this.ktx2Loader.detectSupport(this.renderer)

    const metadataEntries = await Promise.all(
      sceneSources.map(async (source) => ({
        config: source,
        metadata: await this.loadSourceMetadata(source.url),
      })),
    )

    this.metadataSceneBounds = this.createCombinedMetadataBounds(metadataEntries)

    // 先地形（提供 transform 与射线检测基础），再加载模型
    for (const entry of metadataEntries.filter((entry) => entry.config.kind === 'terrain')) {
      this.attachTilesetSource(entry.config, entry.metadata)
    }
    for (const entry of metadataEntries.filter((entry) => entry.config.kind !== 'terrain')) {
      this.attachTilesetSource(entry.config, entry.metadata)
    }

    if (!this.metadataSceneBounds.isEmpty()) {
      this.fitCameraToBox(this.metadataSceneBounds)
      this.forceTilesetUpdate()
    }

    this.emitStatus({
      state: 'loading',
      progress: 0,
      message: '正在初始化地形与双模型组合场景...',
    })
  }

  /** 渲染经纬度定位点并飞行到该点 */
  async renderLonLatPoint(longitude: number, latitude: number, height?: number): Promise<void> {
    const pointPosition = await this.pointMarkerRenderer.render(longitude, latitude, height)
    this.flyTo(pointPosition)
    // 相机飞行后会触发目标区域瓦片加载，稍后再用新几何体校正贴地点位。
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
    options: GltfLoadOptions & { fitCamera?: boolean; geo?: GeoReferenceParams } = {},
  ): Promise<THREE.Group> {
    const { geo } = options

    // 提供地理配准时保留模型原始坐标，加载完成后用配准矩阵定位
    const model = geo
      ? await this.gltfModelLoader.load(url, { center: false })
      : await this.gltfModelLoader.load(url, options)

    if (geo) {
      await this.applyGeoReference(model, geo)
    }

    if (options.fitCamera !== false) {
      // 允许自动聚焦，让相机对准包含 GLTF 模型在内的整个场景
      this.hasSettledView = false
      this.scheduleCameraFit()
    }

    return model
  }

  /**
   * 用一个已知公共点自动反算 GLB 的地理配准参数（调试工具）。
   * 输入「模型里某构件的局部坐标（加载后米值）+ 它在地形上的经纬度/高程」，
   * 控制台打印可直接写进配置的 GeoReferenceParams。
   *
   * @param local - 构件在模型里的局部坐标 {x, y, z}（米）
   * @param longitude - 该构件在地形上的经度（度）
   * @param latitude - 纬度（度）
   * @param height - 高程（米）
   * @param verticalScale - 模型高程轴比例（默认 1）
   * @param centralMeridianDeg - 中央子午线（默认 114）
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

  /** 获取地形瓦片集的坐标系变换矩阵（ECEF → 场景局部坐标） */
  private getTilesetTransform(): THREE.Matrix4 | null {
    const group = this.findTerrainGroup()
    if (!group) return null
    group.updateMatrixWorld(true)
    return group.matrixWorld.clone()
  }

  /** 等待地形瓦片集根节点就绪（ReorientationPlugin 已算完场景矩阵）后执行回调 */
  private whenTerrainReady(callback: () => void): Promise<void> {
    const terrainEntry = [...this.tilesetEntries.values()].find((e) => e.config.kind === 'terrain')
    if (!terrainEntry) {
      console.warn('[loadGltf] 未找到地形瓦片集，无法进行地理配准。')
      return Promise.resolve()
    }

    const tilesRenderer = terrainEntry.renderer as unknown as { root: unknown }
    if (tilesRenderer.root) {
      callback()
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const onRootLoaded = () => {
        terrainEntry.renderer.removeEventListener('load-root-tileset', onRootLoaded)
        terrainEntry.renderer.removeEventListener('load-error', onLoadError)
        callback()
        resolve()
      }
      const onLoadError = () => {
        terrainEntry.renderer.removeEventListener('load-root-tileset', onRootLoaded)
        terrainEntry.renderer.removeEventListener('load-error', onLoadError)
        resolve()
      }
      terrainEntry.renderer.addEventListener('load-root-tileset', onRootLoaded)
      terrainEntry.renderer.addEventListener('load-error', onLoadError)
    })
  }

  /** 按地理配准参数把 GLB 定位到场景（等待地形就绪后应用矩阵） */
  private async applyGeoReference(
    model: THREE.Object3D,
    params: GeoReferenceParams,
  ): Promise<void> {
    await this.whenTerrainReady(() => {
      const ecefToScene = this.getTilesetTransform()
      if (!ecefToScene) {
        console.warn('[loadGltf] 场景变换不可用，无法进行地理配准。')
        return
      }
      const matrix = createGeoReferenceMatrix(params, ecefToScene)
      model.matrix.identity()
      model.applyMatrix4(matrix)
    })
  }

  /** 查找地形 tileset 的 group（供 ECEF → 局部坐标变换使用） */
  private findTerrainGroup(): THREE.Group | null {
    const terrainEntry = [...this.tilesetEntries.values()].find((e) => e.config.kind === 'terrain')
    return terrainEntry?.renderer.group ?? null
  }

  /** 设置坐标轴辅助线是否显示 */
  setAxesVisible(visible: boolean): void {
    this.axesVisible = visible
    this.axesHelper.visible = visible
  }

  /** 当前坐标轴辅助线是否显示 */
  getAxesVisible(): boolean {
    return this.axesVisible
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

  /** 打印 LOD 调度参数与瓦片统计，用于排查清晰度问题 */
  debugTilesQuality(): {
    settings: Record<string, number | string | boolean>
    entries: ReturnType<TilesViewerController['buildTileDiagnostics']>
  } {
    const firstRenderer = this.tilesetEntries.values().next().value as
      | ManagedTilesetEntry
      | undefined
    const settings: Record<string, number | string | boolean> = {
      errorTarget: TILE_QUALITY.errorTarget,
      currentErrorTarget: firstRenderer?.renderer.errorTarget ?? TILE_QUALITY.errorTarget,
      maxTilesProcessed: TILE_QUALITY.maxTilesProcessed,
      loadSiblings: TILE_QUALITY.loadSiblings,
      loadAncestors: TILE_QUALITY.loadAncestors,
      maxDepth: TILE_QUALITY.maxDepth,
      pixelRatio: this.renderer.getPixelRatio(),
      drawingBuffer: `${this.renderer.domElement.width} x ${this.renderer.domElement.height}`,
      cameraFov: this.camera.fov,
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      cameraDistance: Math.round(this.camera.position.distanceTo(this.controls.target)),
      cameraPosition: `[${this.camera.position.x.toFixed(0)}, ${this.camera.position.y.toFixed(0)}, ${this.camera.position.z.toFixed(0)}]`,
      tilesetCount: this.tilesetEntries.size,
    }
    const entries = this.buildTileDiagnostics()

    console.log('[3D Tiles 诊断] 调度设置:', settings)
    console.log('[3D Tiles 诊断] 瓦片统计:', entries)
    console.log('[3D Tiles 诊断] 完整 JSON:', JSON.stringify({ settings, entries }, null, 2))

    return { settings, entries }
  }

  /** 汇总每个数据源的可见瓦片深度分布与纹理采样状态 */
  private buildTileDiagnostics(): Array<{
    id: string
    state: string
    loaded: number
    visible: number
    active: number
    inFrustum: number
    inCache: number
    tilesProcessed: number
    maxVisibleDepth: number
    farTiles: number
    depthHistogram: Record<number, number>
    textureSummary: {
      total: number
      noMipmap: number
      compressedNoMipmap: number
      minFilters: Record<string, number>
      colorSpaces: Record<string, number>
      anisotropies: Record<string, number>
    }
  }> {
    this.tilesetRoot.updateMatrixWorld(true)
    const worldPosition = new THREE.Vector3()

    return Array.from(this.tilesetEntries.values()).map((entry) => {
      const stats = (entry.renderer as unknown as { stats: Record<string, number> }).stats

      let maxVisibleDepth = 0
      let farTiles = 0
      const depthHistogram: Record<number, number> = {}
      const textureSummary = {
        total: 0,
        noMipmap: 0,
        compressedNoMipmap: 0,
        minFilters: {} as Record<string, number>,
        colorSpaces: {} as Record<string, number>,
        anisotropies: {} as Record<string, number>,
      }
      const traverse = entry.renderer.traverse.bind(entry.renderer) as unknown as (
        before: (tile: {
          internal: { depth: number }
          traversal?: { visible?: boolean }
          engineData?: { scene?: THREE.Object3D | null }
        }) => boolean,
        after: null,
        ensureFullyProcessed?: boolean,
      ) => void
      traverse(
        (tile) => {
          if (!tile.traversal?.visible) return false

          const depth = tile.internal.depth
          maxVisibleDepth = Math.max(maxVisibleDepth, depth)
          depthHistogram[depth] = (depthHistogram[depth] || 0) + 1

          const scene = tile.engineData?.scene
          if (scene) {
            scene.getWorldPosition(worldPosition)
            // recenter 后正常瓦片应在原点附近，超过 100km 说明被重复 ECEF 变换
            if (worldPosition.length() > 100_000) farTiles++

            scene.traverse((child) => {
              const mesh = child as THREE.Mesh
              if (!mesh.isMesh) return
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
              for (const mat of mats) {
                if (!mat) continue
                for (const key of Object.keys(mat)) {
                  const v = (mat as unknown as Record<string, unknown>)[key]
                  if (!v || !(v as THREE.Texture).isTexture) continue
                  const tex = v as THREE.Texture
                  textureSummary.total++
                  const mipCount = Array.isArray(tex.mipmaps) ? tex.mipmaps.length : 0
                  if (mipCount <= 1) {
                    textureSummary.noMipmap++
                    if (tex instanceof THREE.CompressedTexture) {
                      textureSummary.compressedNoMipmap++
                    }
                  }
                  textureSummary.minFilters[tex.minFilter] =
                    (textureSummary.minFilters[tex.minFilter] || 0) + 1
                  const cs = String(tex.colorSpace)
                  textureSummary.colorSpaces[cs] = (textureSummary.colorSpaces[cs] || 0) + 1
                  const aniso = String(tex.anisotropy)
                  textureSummary.anisotropies[aniso] = (textureSummary.anisotropies[aniso] || 0) + 1
                }
              }
            })
          }
          return false
        },
        null,
        false,
      )

      return {
        id: entry.config.id,
        state: entry.state,
        loaded: stats.loaded,
        visible: stats.visible,
        active: stats.active,
        inFrustum: stats.inFrustum,
        inCache: stats.inCache,
        tilesProcessed: stats.tilesProcessed,
        maxVisibleDepth,
        farTiles,
        depthHistogram,
        textureSummary,
      }
    })
  }

  /** 销毁控制器，释放所有 GPU 资源与 DOM 监听 */
  destroy(): void {
    const debugWindow = window as unknown as { __tilesViewer?: TilesViewerController | null }
    if (debugWindow.__tilesViewer === this) {
      debugWindow.__tilesViewer = null
    }

    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    cancelAnimationFrame(this.animationFrameId)
    this.debugHud?.remove()
    this.debugHud = null
    this.resizeObserver.disconnect()
    this.clearSceneSources()
    this.pointMarkerRenderer.dispose()
    this.controls.dispose()
    this.timer.dispose()
    this.ktx2Loader.dispose()
    this.dracoLoader.dispose()

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
      this.timer.update()

      if (this.flyAnimation.active) {
        this.updateFlyAnimation()
      } else {
        this.controls.update()
      }

      // TilesRenderer.update() 需要本帧最新的相机矩阵（LOD/frustum culling 在此完成）
      this.camera.updateMatrixWorld()

      for (const entry of this.tilesetEntries.values()) {
        this.syncTileResolution(entry)
        entry.renderer.update()
      }

      if (this.tilesetEntries.size > 0 && !this.areAllSourcesSettled()) {
        this.refreshStatus()
      }

      this.updateDebugHud()

      // 天空盒跟随相机，保证任意缩放距离下背景始终环绕视角
      this.skyBox.position.copy(this.camera.position)

      this.renderer.render(this.scene, this.camera)
    }

    renderFrame()
  }

  // ========== 数据源管理 ==========

  private clearSceneSources(): void {
    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    this.fitTimerId = 0
    this.groundingTimerId = 0

    for (const entry of this.tilesetEntries.values()) {
      this.disposeTilesetEntry(entry)
    }

    this.tilesetEntries.clear()
  }

  private attachTilesetSource(source: TilesetSourceConfig, metadata: TilesetRootMetadata | null): void {
    const existingEntry = this.tilesetEntries.get(source.id)
    if (existingEntry) {
      this.disposeTilesetEntry(existingEntry)
      this.tilesetEntries.delete(source.id)
    }

    const tilesRenderer = this.createTilesRenderer(source)
    const entry: ManagedTilesetEntry = {
      config: source,
      renderer: tilesRenderer,
      state: 'loading',
      settled: false,
      hasContent: false,
      metadata,
      listeners: {} as TilesetEntryListeners,
    }

    debugger

    entry.listeners = {
      loadRootTileset: () => {
        this.scheduleCameraFit()
        this.forceTilesetUpdate()
        this.refreshStatus(`已读取${source.name}，正在调度子节点加载...`)
      },
      loadModel: (event) => {
        entry.hasContent = true
        this.enhanceModelTextures(event.scene)
        this.scheduleCameraFit()
        this.schedulePointGrounding()
        this.refreshStatus()
      },
      tilesLoadEnd: () => {
        entry.state = 'ready'
        entry.settled = true
        entry.hasContent = entry.hasContent || entry.renderer.group.children.length > 0
        this.scheduleCameraFit()
        this.schedulePointGrounding()
        this.refreshStatus()

        if (!this.hasAutoLoggedDiagnostics) {
          this.hasAutoLoggedDiagnostics = true
          window.setTimeout(() => this.debugTilesQuality(), 1200)
        }
      },
      loadError: (event) => {
        entry.state = 'error'
        entry.settled = true
        entry.error = `${event.error.message} (${event.url.toString()})`
        this.scheduleCameraFit()
        this.emitStatus({
          state: 'error',
          progress: this.getAggregateProgress(),
          message: `${source.name} 加载失败，其余可用内容将继续展示。`,
          error: entry.error,
        })
        this.refreshStatus()
      },
    }

    tilesRenderer.addEventListener('load-root-tileset', entry.listeners.loadRootTileset)
    tilesRenderer.addEventListener('load-model', entry.listeners.loadModel)
    tilesRenderer.addEventListener('tiles-load-end', entry.listeners.tilesLoadEnd)
    tilesRenderer.addEventListener('load-error', entry.listeners.loadError)

    this.tilesetRoot.add(tilesRenderer.group)
    this.tilesetEntries.set(source.id, entry)
  }

  private createTilesRenderer(source: TilesetSourceConfig): TilesRenderer {
    const tilesRenderer = new TilesRenderer(source.url)
    tilesRenderer.group.name = source.id

    // 高清 LOD 参数
    tilesRenderer.errorTarget = TILE_QUALITY.errorTarget
    tilesRenderer.maxTilesProcessed = TILE_QUALITY.maxTilesProcessed
    tilesRenderer.loadAncestors = TILE_QUALITY.loadAncestors
    tilesRenderer.loadSiblings = TILE_QUALITY.loadSiblings
    tilesRenderer.maxDepth = TILE_QUALITY.maxDepth
    tilesRenderer.displayActiveTiles = false

    // LRU 缓存
    tilesRenderer.lruCache.minSize = TILE_QUALITY.cacheMinSize
    tilesRenderer.lruCache.maxSize = TILE_QUALITY.cacheMaxSize
    tilesRenderer.lruCache.minBytesSize = TILE_QUALITY.cacheMinBytes
    tilesRenderer.lruCache.maxBytesSize = TILE_QUALITY.cacheMaxBytes

    // DRACO / KTX2
    tilesRenderer.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: this.dracoLoader,
        ktxLoader: this.ktx2Loader,
        plugins: [createKtx2MimeTypePlugin(this.ktx2Loader)],
        autoDispose: false,
      }),
    )
    // ECEF 大坐标场景 recenter，避免浮点精度问题
    tilesRenderer.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }))

    // 相机与 SSE 分辨率（用真实绘制缓冲尺寸，含 pixelRatio）
    tilesRenderer.setCamera(this.camera)
    this.renderer.getDrawingBufferSize(this.resolutionSize)
    tilesRenderer.setResolution(this.camera, this.resolutionSize.x, this.resolutionSize.y)

    return tilesRenderer
  }

  private disposeTilesetEntry(entry: ManagedTilesetEntry): void {
    entry.renderer.removeEventListener('load-root-tileset', entry.listeners.loadRootTileset)
    entry.renderer.removeEventListener('load-model', entry.listeners.loadModel)
    entry.renderer.removeEventListener('tiles-load-end', entry.listeners.tilesLoadEnd)
    entry.renderer.removeEventListener('load-error', entry.listeners.loadError)
    entry.renderer.deleteCamera(this.camera)
    this.tilesetRoot.remove(entry.renderer.group)
    entry.renderer.dispose()
  }

  /** 用真实绘制缓冲尺寸（含 DPR）同步 SSE 分辨率，避免高 DPR 屏 LOD 收敛偏慢 */
  private syncTileResolution(entry: ManagedTilesetEntry): void {
    this.renderer.getDrawingBufferSize(this.resolutionSize)
    entry.renderer.setResolution(this.camera, this.resolutionSize.x, this.resolutionSize.y)
  }

  private createDebugHud(container: HTMLElement): HTMLElement {
    const hud = document.createElement('div')
    hud.style.cssText = [
      'position:absolute',
      'top:12px',
      'left:12px',
      'z-index:20',
      'padding:8px 10px',
      'border-radius:6px',
      'background:rgba(2,6,23,0.72)',
      'color:#e2e8f0',
      'font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'pointer-events:none',
      'user-select:none',
      'white-space:pre',
    ].join(';')

    if (container.style.position === '') {
      container.style.position = 'relative'
    }

    container.appendChild(hud)
    return hud
  }

  /** 每帧（节流 ~4Hz）刷新调试 HUD 文本 */
  private updateDebugHud(): void {
    if (!this.debugHud) return

    const now = performance.now()
    if (now - this.debugHudLastUpdate < 250) return
    this.debugHudLastUpdate = now

    const entry = this.tilesetEntries.values().next().value as ManagedTilesetEntry | undefined
    const stats = entry
      ? (entry.renderer as unknown as { stats: Record<string, number> }).stats
      : null

    let maxDepth = 0
    if (entry) {
      const traverse = entry.renderer.traverse.bind(entry.renderer) as unknown as (
        before: (tile: { internal: { depth: number }; traversal?: { visible?: boolean } }) => boolean,
        after: null,
        ensureFullyProcessed?: boolean,
      ) => void
      traverse(
        (tile) => {
          if (tile.traversal?.visible) {
            maxDepth = Math.max(maxDepth, tile.internal.depth)
          }
          return false
        },
        null,
        false,
      )
    }

    const distance = this.camera.position.distanceTo(this.controls.target)
    const errorTarget = entry?.renderer.errorTarget ?? Number.NaN
    const visible = stats?.visible ?? 0

    this.debugHud.textContent =
      `相机距离: ${distance.toFixed(0)}\n` +
      `errorTarget: ${Number.isFinite(errorTarget) ? errorTarget.toFixed(2) : '—'}\n` +
      `可见瓦片: ${visible}\n` +
      `最大深度: ${maxDepth}`
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

    for (const entry of this.tilesetEntries.values()) {
      this.syncTileResolution(entry)
    }
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
      const targetBox = box.isEmpty() ? this.metadataSceneBounds : box
      const didFit = !targetBox.isEmpty() && this.fitCameraToBox(targetBox)

      if (didFit && this.areAllSourcesSettled()) {
        this.hasSettledView = true
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

    // 坐标轴辅助线长度约为场景包围盒最长边的一半，保持与地形/模型的相对尺度一致
    this.axesHelper.scale.setScalar(safeDimension * 0.5)

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

  // ========== 状态查询与聚合 ==========

  private areAllSourcesSettled(): boolean {
    return [...this.tilesetEntries.values()].every((entry) => entry.settled)
  }

  private getRenderableSourceCount(): number {
    return [...this.tilesetEntries.values()].filter(
      (entry) => entry.hasContent || entry.renderer.group.children.length > 0,
    ).length
  }

  private getAggregateProgress(): number {
    const entries = [...this.tilesetEntries.values()]
    if (entries.length === 0) return 0

    const total = entries.reduce((sum, entry) => {
      if (entry.state === 'ready' || entry.state === 'error') return sum + 100
      const progress = Number.isFinite(entry.renderer.loadProgress)
        ? entry.renderer.loadProgress * 100
        : 0
      return sum + Math.min(Math.max(progress, 0), 100)
    }, 0)

    return total / entries.length
  }

  private getCombinedErrorMessage(): string {
    return [...this.tilesetEntries.values()]
      .filter((entry) => entry.error)
      .map((entry) => `${entry.config.name}: ${entry.error}`)
      .join('\n')
  }

  private refreshStatus(message?: string): void {
    const entries = [...this.tilesetEntries.values()]
    if (entries.length === 0) return

    const progress = this.getAggregateProgress()
    const errorCount = entries.filter((entry) => entry.state === 'error').length
    const renderableCount = this.getRenderableSourceCount()

    if (this.areAllSourcesSettled()) {
      if (renderableCount === 0) {
        this.emitStatus({
          state: 'error',
          progress: 100,
          message: '地形与模型均未能成功加载。',
          error: this.getCombinedErrorMessage(),
        })
        return
      }

      this.emitStatus({
        state: 'ready',
        progress: 100,
        message:
          errorCount > 0
            ? `组合场景已加载，${errorCount} 个数据源失败，其余内容可继续浏览。`
            : '地形与双模型加载完成，可自由旋转、平移和缩放。',
      })
      return
    }

    this.emitStatus({
      state: 'loading',
      progress,
      message:
        message ||
        (renderableCount > 0
          ? `正在补充加载组合场景，当前已有 ${renderableCount}/${entries.length} 个数据源可见...`
          : '正在加载地形与双模型组合场景...'),
    })
  }

  // ========== 元数据加载与处理 ==========

  /** 拉取 tileset.json 根节点元数据，失败返回 null */
  private async loadSourceMetadata(url: string): Promise<TilesetRootMetadata | null> {
    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const json = (await response.json()) as TilesetMetadata
      return json.root ?? null
    } catch {
      return null
    }
  }

  private createCombinedMetadataBounds(
    entries: Array<{ config: TilesetSourceConfig; metadata: TilesetRootMetadata | null }>,
  ): THREE.Box3 {
    const combinedBox = new THREE.Box3()

    for (const entry of entries) {
      const entryBox = this.createBoxFromMetadata(entry.metadata)
      if (!entryBox.isEmpty()) combinedBox.union(entryBox)
    }

    return combinedBox
  }

  /** 从 root.boundingVolume.box（12 个数）构建定向包围盒的 AABB */
  private createBoxFromMetadata(metadata: TilesetRootMetadata | null): THREE.Box3 {
    const boxValues = metadata?.boundingVolume?.box
    if (!Array.isArray(boxValues) || boxValues.length !== 12) {
      return EMPTY_BOX.clone()
    }

    const center = new THREE.Vector3(boxValues[0], boxValues[1], boxValues[2])
    const halfAxisX = new THREE.Vector3(boxValues[3], boxValues[4], boxValues[5])
    const halfAxisY = new THREE.Vector3(boxValues[6], boxValues[7], boxValues[8])
    const halfAxisZ = new THREE.Vector3(boxValues[9], boxValues[10], boxValues[11])

    const box = new THREE.Box3()
    for (const signX of [-1, 1]) {
      for (const signY of [-1, 1]) {
        for (const signZ of [-1, 1]) {
          const corner = center
            .clone()
            .addScaledVector(halfAxisX, signX)
            .addScaledVector(halfAxisY, signY)
            .addScaledVector(halfAxisZ, signZ)
          box.expandByPoint(corner)
        }
      }
    }

    return box
  }

  private forceTilesetUpdate(): void {
    this.camera.updateMatrixWorld()
    for (const entry of this.tilesetEntries.values()) {
      this.syncTileResolution(entry)
      entry.renderer.update()
    }
  }

  /** 按真实设备像素比渲染，高分屏上限 2x 保护性能 */
  private getPreferredPixelRatio(): number {
    return THREE.MathUtils.clamp(window.devicePixelRatio || 1, 1, 2)
  }

  // ========== 纹理质量增强 ==========

  /** 提升模型纹理采样质量（各向异性 + 三线性过滤） */
  private enhanceModelTextures(scene: THREE.Object3D): void {
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy?.() ?? 16

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

  // ========== 状态通知 ==========

  /** 发出状态通知（去重，避免频繁触发 Vue 更新） */
  private emitStatus(status: ViewerStatus): void {
    const normalizedStatus = {
      ...status,
      progress: Math.min(Math.max(status.progress, 0), 100),
    }
    const key = [
      normalizedStatus.state,
      Math.round(normalizedStatus.progress),
      normalizedStatus.message,
      normalizedStatus.error || '',
    ].join('|')

    if (key === this.lastStatusKey) return

    this.lastStatusKey = key
    this.callbacks.onStatusChange?.(normalizedStatus)
  }
}
