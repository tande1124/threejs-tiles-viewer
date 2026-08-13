import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import {
  GLTFExtensionsPlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/three/plugins'
import { disposeObject3D } from '@/utils/three-dispose'
import { createKtx2MimeTypePlugin } from '@/utils/ktx2MimeTypePlugin'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import type { TilesetSourceConfig } from '@/utils/tileset'

// ========== 常量 ==========

/** 复用的空包围盒，避免反复创建 */
const EMPTY_BOX = new THREE.Box3()

// ========== 公开接口 ==========

/**
 * 查看器状态描述
 * 用于向外部（如 Vue 组件）报告当前场景的加载进度和健康状态
 */
export interface ViewerStatus {
  /** 当前状态：idle（空闲）、loading（加载中）、ready（就绪）、error（出错） */
  state: 'idle' | 'loading' | 'ready' | 'error'
  /** 加载进度百分比（0-100） */
  progress: number
  /** 人类可读的状态描述消息 */
  message: string
  /** 错误详情字符串，仅在 state === 'error' 时有效 */
  error?: string
}

/** 查看器回调函数集合 */
export interface ViewerCallbacks {
  /** 状态变化回调，控制器在生命周期各阶段通过此方法通知外部 */
  onStatusChange?: (status: ViewerStatus) => void
}

// ========== 内部接口 ==========

/** 单个 TilesRenderer 实例的事件监听器集合 */
interface TilesetEntryListeners {
  loadRootTileset: () => void
  loadModel: (event: { scene: THREE.Object3D }) => void
  tilesLoadEnd: () => void
  loadError: (event: { error: Error; url: string | URL }) => void
}

/** tileset.json 根节点中的包围盒原始数据 */
interface RootBoundingVolume {
  box?: number[]
}

/** tileset.json 根节点的元数据（含变换矩阵和包围盒） */
interface TilesetRootMetadata {
  transform?: number[]
  boundingVolume?: RootBoundingVolume
}

/** tileset.json 顶层结构的最小描述 */
interface TilesetMetadata {
  root?: TilesetRootMetadata
}

/**
 * 受管理的瓦片集条目
 * 将数据源配置、渲染器实例、事件监听器、加载状态等封装在一起
 */
interface ManagedTilesetEntry {
  config: TilesetSourceConfig
  renderer: TilesRenderer
  listeners: TilesetEntryListeners
  /** 当前加载状态 */
  state: 'loading' | 'ready' | 'error'
  /** 是否已结束（成功或失败均视为 settled） */
  settled: boolean
  /** 是否包含任何可见的几何内容 */
  hasContent: boolean
  /** tileset.json 根节点的元数据 */
  metadata: TilesetRootMetadata | null
  /** 加载失败时的错误信息 */
  error?: string
}

// ========== 控制器主类 ==========

/**
 * 3D Tiles 瓦片查看器控制器
 *
 * 集成了 Three.js 渲染管线与 3d-tiles-renderer 瓦片加载器，
 * 提供完整的初始化、渲染循环、相机控制、多数据源管理和生命周期管理。
 *
 * ## 功能概览
 *
 * - **场景初始化**：创建 WebGL 渲染器、透视相机、三级光照系统、ACES 色调映射
 * - **轨道控制**：支持鼠标/触控旋转、平移、缩放（含阻尼惯性）
 * - **多数据源加载**：支持同时加载地形基底 + 多个模型瓦片集
 * - **压缩数据支持**：DRACO 几何体解压 + KTX2 GPU 纹理解码
 * - **自适应视口**：通过 ResizeObserver 监听容器尺寸变化并自动调整
 * - **自动聚焦**：根据包围盒信息自动将相机移动到最佳观察视角
 * - **经纬度点位渲染**：将 WGS84 坐标映射到场景表面并显示标记精灵
 * - **资源管理**：完整的 GPU 资源释放链，防止内存泄漏
 *
 * ## 清晰度策略（对标 Cesium maximumScreenSpaceError=0）
 *
 * - 适度降低 errorTarget：比默认值更积极细化，但避免过度追深导致长期停留在过渡层级
 * - pixelRatio 按设备像素比渲染：保证高分屏清晰，同时控制性能开销
 * - 保留 mipmap 链并开启各向异性过滤：更接近 Cesium 的斜视纹理观感
 * - 关闭 ACES Filmic：避免影调压缩带来的“发灰发糊”观感
 * - 提高缓存和处理预算：减少精细瓦片加载抖动
 */
export class TilesViewerController {
  // ========== Three.js 核心对象 ==========

  /** Three.js 场景容器：所有 3D 对象（光照、地形、模型、标记）的根 */
  private readonly scene = new THREE.Scene()
  /** 透视相机：FOV 45°、近裁面 1m、远裁面 1e7m */
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 1, 1e7)
  /** WebGL 渲染器：抗锯齿、透明背景、高性能 GPU 偏好 */
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })

  // ========== 控制器与辅助工具 ==========

  /** 轨道控制器：实现交互式视角操作（旋转/平移/缩放） */
  private readonly controls = new OrbitControls(this.camera, this.renderer.domElement)
  /** 用户注册的回调函数集合 */
  private readonly callbacks: ViewerCallbacks
  /** Three.js 内置计时器：管理 delta 时间，页面后台时自动暂停 */
  private readonly timer = new THREE.Timer()
  /** 瓦片集的父级容器组：所有 TilesRenderer 的 group 都添加到此节点下 */
  private readonly tilesetRoot = new THREE.Group()
  /** 标记精灵的父级容器组：经纬度点位图标添加到此节点下 */
  private readonly markerRoot = new THREE.Group()
  /** DRACO 解压加载器：解码 DRACO 压缩几何体，显著减小模型文件体积 */
  private readonly dracoLoader = new DRACOLoader()
  /** KTX2 纹理加载器：解码 GPU 压缩纹理（Basis Universal 格式），减小 GPU 内存占用 */
  private readonly ktx2Loader = new KTX2Loader()
  /**
   * 尺寸变化观察器：监听容器 DOM 元素尺寸变化，
   * 自动更新相机宽高比和渲染器分辨率
   */
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())

  // ========== 内部状态 ==========

  /** 渲染器 canvas 所挂载的 DOM 容器 */
  private container: HTMLElement | null = null
  /**
   * 已注册的数据源映射表
   * key: TilesetSourceConfig.id，value: 受管理的瓦片集条目
   */
  private readonly tilesetEntries = new Map<string, ManagedTilesetEntry>()
  /** 当前 requestAnimationFrame 的帧 ID，用于取消渲染循环 */
  private animationFrameId = 0
  /** 延迟聚焦定时器 ID，用于防抖 */
  private fitTimerId = 0
  /** 是否已经完成一次自动聚焦 */
  private hasSettledView = false
  /** 上一次发出的状态 key（去重用） */
  private lastStatusKey = ''
  /** 从元数据中预先计算出的组合包围盒 */
  private metadataSceneBounds = new THREE.Box3()
  /** 经纬度点位渲染器：负责点位精灵的创建、贴合与清理 */
  private readonly pointMarkerRenderer: PointMarkerRenderer
  /** 相机飞行动画状态：从当前位置平滑过渡到目标点位 */
  private readonly flyAnimation = {
    active: false,
    startTime: 0,
    duration: 0,
    fromPosition: new THREE.Vector3(),
    toPosition: new THREE.Vector3(),
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(),
  }

  // ========== 构造函数 ==========

  /**
   * 初始化 Three.js 渲染管线
   *
   * 按顺序完成：场景背景色 → 三级光照（半球光 + 主方向光 + 补光）→
   * 分组容器 → 相机初始位置 → 轨道控制器参数 → 渲染器质量设置
   *
   * @param callbacks - 可选的状态变化回调
   */
  constructor(callbacks: ViewerCallbacks = {}) {
    this.callbacks = callbacks
    // 将计时器连接到 document 以管理 deltaTime，页面后台时自动暂停
    this.timer.connect(document)
    // 配置 DRACO 解码器的 WASM 路径（使用 GLTF 专用配置）
    this.dracoLoader.setDecoderPath(DRACO_GLTF_CONFIG)

    // ---- 场景背景 ----
    this.scene.background = new THREE.Color('#020617') // 深蓝黑色，与 UI 主题一致

    // ---- 光照系统 ----

    // 半球光：模拟天空散射光和地面反射光
    const hemisphereLight = new THREE.HemisphereLight('#dbeafe', '#020617', 1.35)
    hemisphereLight.position.set(0, 1, 0)
    this.scene.add(hemisphereLight)

    // 主方向光：模拟太阳光，从右上方照射产生立体阴影感
    const directionalLight = new THREE.DirectionalLight('#ffffff', 1.65)
    directionalLight.position.set(120, 180, 90)
    this.scene.add(directionalLight)

    // 补光：从左侧打过来，柔化暗面避免死黑
    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.85)
    fillLight.position.set(-100, 60, -80)
    this.scene.add(fillLight)

    // ---- 分组容器 ----
    // 命名便于在 DevTools 中调试
    this.tilesetRoot.name = 'tileset-root'
    this.markerRoot.name = 'marker-root'
    this.scene.add(this.tilesetRoot)
    this.scene.add(this.markerRoot)

    // ---- 点位渲染器 ----
    this.pointMarkerRenderer = new PointMarkerRenderer({
      tilesetRoot: this.tilesetRoot,
      markerRoot: this.markerRoot,
      getTerrainGroup: () => this.findTerrainGroup(),
      getFallbackBounds: () => this.metadataSceneBounds,
    })

    // ---- 相机初始位置 ----
    this.camera.position.set(160, 140, 180)

    // ---- 轨道控制器 ----
    this.controls.enableDamping = true       // 启用阻尼惯性（松开鼠标后逐渐减速）
    this.controls.dampingFactor = 0.08       // 阻尼系数（0 = 立刻停止，越大惯性越强）
    this.controls.minDistance = 1            // 最近缩放距离（单位与场景一致）
    this.controls.maxDistance = 500000       // 最远缩放距离
    this.controls.target.set(0, 0, 0)        // 初始视线焦点：场景原点
    // 用户一旦手动操作相机（旋转/缩放/平移），立刻禁止后续所有自动聚焦
    this.controls.addEventListener('start', () => {
      this.hasSettledView = true
    })

    // ---- 渲染器质量设置 ----
    this.renderer.setPixelRatio(this.getPreferredPixelRatio())
    this.renderer.outputColorSpace = THREE.SRGBColorSpace            // sRGB 色彩空间，保证颜色一致
    this.renderer.toneMapping = THREE.NoToneMapping                   // 更接近 Cesium 的直接色彩输出
    this.renderer.toneMappingExposure = 1
  }

  // ========== 公共方法 ==========

  /**
   * 将渲染器的 canvas 挂载到指定 DOM 容器中
   *
   * 挂载后会自动：
   * 1. 清空容器并添加 canvas
   * 2. 启动 ResizeObserver 监听
   * 3. 启动 requestAnimationFrame 渲染循环
   * 4. 发出 "idle" 状态通知
   *
   * @param container - canvas 的挂载目标 DOM 元素
   */
  mount(container: HTMLElement): void {
    this.container = container
    this.container.innerHTML = ''
    this.container.appendChild(this.renderer.domElement)

    this.resizeObserver.observe(container)
    this.handleResize()
    this.startLoop()
    this.emitStatus({
      state: 'idle',
      progress: 0,
      message: 'Three.js 场景已就绪，正在准备默认组合场景...',
    })
  }

  /**
   * 加载组合场景（地形基底 + 多个模型瓦片集）
   *
   * ## 加载流程
   *
   * 1. 清除之前的数据源
   * 2. 初始化 WebGL 上下文并检测 KTX2 支持
   * 3. 并行拉取所有数据源的 tileset.json 元数据
   * 4. 预计算所有数据源的合并包围盒
   * 5. 先加载 terrain 类型数据源，再加载 tileset 类型数据源
   * 6. 如果包围盒有效，立即聚焦相机
   *
   * @param sources - 待加载的数据源配置列表
   * @throws 如果容器未挂载或无有效数据源
   */
  async loadScene(sources: TilesetSourceConfig[]): Promise<void> {
    if (!this.container) {
      throw new Error('Three.js 容器尚未挂载。')
    }

    const sceneSources = sources.filter((source) => source.url)

    if (sceneSources.length === 0) {
      throw new Error('未提供可加载的 3DTiles 数据源。')
    }

    // 清除旧数据
    this.clearSceneSources()
    this.clearLonLatPoint()
    this.hasSettledView = false
    this.metadataSceneBounds.makeEmpty()

    // 初始化 WebGL 和 KTX2 支持检测
    await (this.renderer as THREE.WebGLRenderer & { init?: () => Promise<void> }).init?.()
    this.ktx2Loader.detectSupport(this.renderer)

    // 并行获取所有数据源的 metadata（tileset.json 的 root 信息）
    const metadataEntries = await Promise.all(
      sceneSources.map(async (source) => ({
        config: source,
        metadata: await this.loadSourceMetadata(source.url),
      })),
    )

    // 预计算所有数据源的合并包围盒（用于初始视角定位）
    this.metadataSceneBounds = this.createCombinedMetadataBounds(metadataEntries)

    // 先加载地形数据源（提供 transform 参考和射线检测基础）
    for (const entry of metadataEntries.filter((entry) => entry.config.kind === 'terrain')) {
      this.attachTilesetSource(entry.config, entry.metadata)
    }

    // 再加载独立的模型数据源
    for (const entry of metadataEntries.filter((entry) => entry.config.kind !== 'terrain')) {
      this.attachTilesetSource(entry.config, entry.metadata)
    }

    // 根据元数据包围盒进行初始聚焦
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

  /**
   * 在场景中渲染一个经纬度定位点，并在完成后自动飞行到该点
   *
   * @param longitude - 经度（-180 ~ 180）
   * @param latitude - 纬度（-90 ~ 90）
   * @param height - 椭球体高度（米）。省略（undefined）时自动贴合模型表面
   * @throws 如果地形数据尚未加载
   */
  async renderLonLatPoint(longitude: number, latitude: number, height?: number): Promise<void> {
    const pointPosition = await this.pointMarkerRenderer.render(longitude, latitude, height)

    // 渲染完成后自动飞行到定位点，方便用户直观查看
    this.flyTo(pointPosition)
  }

  /**
   * 清除当前显示的经纬度点位精灵
   * 安全幂等：如果没有活跃的点位则无操作
   */
  clearLonLatPoint(): void {
    this.pointMarkerRenderer.clear()
  }

  /**
   * 查找地形 tileset 的 group
   * 用于 ECEF → 局部坐标变换与 up 方向推算
   *
   * @returns 地形 tileset 的 group，未找到时返回 null
   */
  private findTerrainGroup(): THREE.Group | null {
    const terrainEntry = [...this.tilesetEntries.values()].find((e) => e.config.kind === 'terrain')
    return terrainEntry?.renderer.group ?? null
  }

  // ========== 相机飞行 ==========

  /**
   * 平滑飞行到指定世界坐标，让相机对准该点
   *
   * 沿当前相机视线方向反向推出相机落点（保持观察角度不变），
   * 观察距离取标记精灵尺寸的 12 倍，使定位点清晰可见。
   *
   * @param target - 目标点世界坐标（通常是渲染出的定位点）
   * @param duration - 飞行时长（毫秒）
   */
  flyTo(target: THREE.Vector3, duration = 900): void {
    // 用户主动飞行后，禁止后续自动聚焦覆盖当前视角
    this.hasSettledView = true

    // 观察距离：精灵尺寸的 12 倍，让定位点约占屏幕 1/10 高度
    const distance = Math.max(this.pointMarkerRenderer.getMarkerScale() * 12, 120)

    // 沿当前相机视线方向反向推出相机落点
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

  /**
   * 每帧推进飞行动画
   *
   * 使用 easeInOutCubic 缓动（两端慢、中间快）插值相机位置与轨道控制器目标点，
   * 完成后同步 OrbitControls 内部球面状态，避免飞行结束后视角跳动。
   */
  private updateFlyAnimation(): void {
    const anim = this.flyAnimation
    const elapsed = performance.now() - anim.startTime
    const t = Math.min(elapsed / anim.duration, 1)

    // easeInOutCubic：观感更顺滑
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    this.camera.position.lerpVectors(anim.fromPosition, anim.toPosition, eased)
    this.controls.target.lerpVectors(anim.fromTarget, anim.toTarget, eased)
    this.camera.lookAt(this.controls.target)

    if (t >= 1) {
      anim.active = false
      // 精确落位并同步 OrbitControls，防止飞行结束瞬间视角跳动
      this.camera.position.copy(anim.toPosition)
      this.controls.target.copy(anim.toTarget)
      this.controls.update()
    }
  }

  /**
   * 销毁控制器，释放所有 GPU 资源和 DOM 监听
   *
   * 释放顺序：
   * 定时器 → 动画帧 → ResizeObserver → 所有瓦片集 → 标记精灵 →
   * 点位纹理 → 轨道控制器 → DRACO/KTX2 加载器 → 场景遍历释放 →
   * WebGL 渲染器 → 强制 WebGL 上下文丢失 → 清空容器
   *
   * 应在组件 beforeUnmount 或页面离开时调用
   */
  destroy(): void {
    window.clearTimeout(this.fitTimerId)
    cancelAnimationFrame(this.animationFrameId)
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

  /**
   * 启动 requestAnimationFrame 渲染循环（~60fps）
   *
   * 每帧执行：
   * 1. 更新全局计时器 delta
   * 2. 更新轨道控制器（处理阻尼惯性）
   * 3. 更新所有已注册的 TilesRenderer 实例
   * 4. 如果仍有数据源在加载中，刷新状态信息
   * 5. 执行 WebGL 渲染
   */
  private startLoop(): void {
    const renderFrame = () => {
      this.animationFrameId = window.requestAnimationFrame(renderFrame)
      this.timer.update()

      // 飞行动画期间接管相机与目标点，结束后恢复 OrbitControls 控制
      if (this.flyAnimation.active) {
        this.updateFlyAnimation()
      } else {
        this.controls.update()
      }

      // 更新所有瓦片渲染器，驱动 LOD 切换和瓦片按需加载
      for (const entry of this.tilesetEntries.values()) {
        entry.renderer.update()
      }

      // 如果有未完成加载的数据源，持续刷新进度信息
      if (this.tilesetEntries.size > 0 && !this.areAllSourcesSettled()) {
        this.refreshStatus()
      }

      this.renderer.render(this.scene, this.camera)
    }

    renderFrame()
  }

  // ========== 数据源管理 ==========

  /**
   * 清除所有已注册的瓦片集数据源
   * 逐个执行 disposeTilesetEntry → 清空 Map
   */
  private clearSceneSources(): void {
    window.clearTimeout(this.fitTimerId)
    this.fitTimerId = 0

    for (const entry of this.tilesetEntries.values()) {
      this.disposeTilesetEntry(entry)
    }

    this.tilesetEntries.clear()
  }

  /**
   * 将瓦片集数据源注册到场景中并启动加载
   *
   * 对每个数据源：
   * 1. 创建 TilesRenderer 实例
   * 2. 注册 GLTFExtensionsPlugin（DRACO + KTX2 支持）
   * 3. 注册 ReorientationPlugin（坐标轴重定向 + 自动居中）
   * 4. 绑定四个核心事件监听器
   * 5. 将 renderer.group 添加到 tilesetRoot 节点下
   *
   * @param source - 数据源配置
   * @param metadata - 预先加载的 tileset.json 根元数据
   */
  private attachTilesetSource(source: TilesetSourceConfig, metadata: TilesetRootMetadata | null): void {
    // 如果已有同 id 条目，先释放旧的再创建新的（支持热重载）
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

    // ---- 绑定事件监听器 ----

    entry.listeners = {
      /** 根 tileset.json 解析完成时触发 */
      loadRootTileset: () => {
        this.scheduleCameraFit()
        this.forceTilesetUpdate()
        this.refreshStatus(`已读取${source.name}，正在调度子节点加载...`)
      },
      /** 单个子瓦片模型加载完成时触发 */
      loadModel: (event) => {
        entry.hasContent = true
        this.enhanceModelTextures(event.scene)
        this.scheduleCameraFit()
        this.refreshStatus()
      },
      /** 所有瓦片加载完成时触发 */
      tilesLoadEnd: () => {
        entry.state = 'ready'
        entry.settled = true
        // 即使没有 load-model 事件，也可以从 children 数量判断是否有内容
        entry.hasContent = entry.hasContent || entry.renderer.group.children.length > 0
        this.scheduleCameraFit()
        this.refreshStatus()
      },
      /** 加载过程中发生错误时触发 */
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

  /**
   * 为单个数据源创建并配置 TilesRenderer 实例
   *
   * 清晰度策略（尽量贴近 Cesium 的稳定观感）：
   * - errorTarget=4: 比默认 16 更积极地细化几何，但不走到 0 那么极端
   * - 保留 mipmap + 开启各向异性: 斜视角纹理更稳、更清楚
   * - 适度提高 LRU 和处理预算: 减少高精细瓦片的加载迟滞
   *
   * @param source - 数据源配置
   * @returns 配置完成的 TilesRenderer 实例
   */
  private createTilesRenderer(source: TilesetSourceConfig): TilesRenderer {
    const tilesRenderer = new TilesRenderer(source.url)

    tilesRenderer.group.name = source.id

    // ---- 清晰度核心：对标 Cesium ----

    // 目标观感接近 Cesium：比默认更愿意细化，但保留稳定的 LOD 过渡。
    tilesRenderer.errorTarget = 4

    // 适度提高缓存，避免细节瓦片刚加载完又被挤出缓存。
    tilesRenderer.lruCache.minSize = 12000
    tilesRenderer.lruCache.maxSize = 20000
    tilesRenderer.lruCache.minBytesSize = 1024 * 1024 * 1024 // 1 GB
    tilesRenderer.lruCache.maxBytesSize = 2 * 1024 * 1024 * 1024 // 2 GB

    // 允许更积极地预处理子瓦片，但避免把主线程压得过重。
    tilesRenderer.maxTilesProcessed = 1000

    // 同级瓦片并行加载 + 精细加载期间显示粗粒度祖先，避免空洞与闪烁
    tilesRenderer.loadSiblings = true
    tilesRenderer.loadAncestors = true

    // 最大深度：覆盖一切可能的瓦片树深度（Cesium 无此限制）
    tilesRenderer.maxDepth = 64

    tilesRenderer.displayActiveTiles = false

    // 注册 GLTF 扩展插件：DRACO 解压 + KTX2 GPU 纹理 + 自定义 MIME 类型
    tilesRenderer.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: this.dracoLoader,
        ktxLoader: this.ktx2Loader,
        plugins: [createKtx2MimeTypePlugin(this.ktx2Loader)],
        autoDispose: false, // 手动管理释放，避免过早销毁共享纹理
      }),
    )
    // 注册坐标重定向插件：确保 Z 轴朝上，并将内容居中到原点附近。
    // recenter 对 GPU 精度至关重要 — ECEF 坐标在 ~6.4M 单位处仅 ~0.5m float 精度，
    // 导致顶点抖动/深度冲突/模糊。居中到原点后精度恢复为亚毫米级。
    tilesRenderer.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }))

    tilesRenderer.setCamera(this.camera)
    // 使用物理像素尺寸而非 CSS 像素，确保 SSE 计算的分辨率正确
    const tBufferSize = new THREE.Vector2()
    this.renderer.getDrawingBufferSize(tBufferSize)
    tilesRenderer.setResolution(this.camera, tBufferSize.x, tBufferSize.y)

    return tilesRenderer
  }

  /**
   * 释放单个瓦片集条目的所有资源
   *
   * 释放步骤：解绑事件 → 移除相机 → 从场景中移除 group → dispose 渲染器
   *
   * @param entry - 待释放的瓦片集条目
   */
  private disposeTilesetEntry(entry: ManagedTilesetEntry): void {
    entry.renderer.removeEventListener('load-root-tileset', entry.listeners.loadRootTileset)
    entry.renderer.removeEventListener('load-model', entry.listeners.loadModel)
    entry.renderer.removeEventListener('tiles-load-end', entry.listeners.tilesLoadEnd)
    entry.renderer.removeEventListener('load-error', entry.listeners.loadError)
    entry.renderer.deleteCamera(this.camera)
    this.tilesetRoot.remove(entry.renderer.group)
    entry.renderer.dispose()
  }

  // ========== 视口自适应 ==========

  /**
   * 处理容器尺寸变化
   * 更新相机宽高比、渲染器分辨率，并同步所有瓦片渲染器的分辨率设置
   */
  private handleResize(): void {
    if (!this.container) {
      return
    }

    const width = Math.max(this.container.clientWidth, 1)
    const height = Math.max(this.container.clientHeight, 1)

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(this.getPreferredPixelRatio())

    // 同步更新所有瓦片渲染器的分辨率感知 —— 必须使用 drawing buffer（物理像素）尺寸！
    // 3d-tiles-renderer 的 SSE 公式 error = geometricError / (distance * sseDenominator)，
    // sseDenominator 正比于 1/resolution.height。如果传入 CSS 像素而非物理像素，
    // sseDenominator 会偏大，error 会被严重缩小，导致系统误判瓦片"已经足够精细"而停止细化。
    const bufferSize = new THREE.Vector2()
    this.renderer.getDrawingBufferSize(bufferSize)
    for (const entry of this.tilesetEntries.values()) {
      entry.renderer.setResolution(this.camera, bufferSize.x, bufferSize.y)
    }
  }

  // ========== 相机聚焦 ==========

  /**
   * 延迟触发相机自动聚焦
   *
   * 使用 setTimeout(fn, 160ms) 防抖：
   * - 160ms 足够让第一批几何体出现在场景中
   * - 多个连续的 load-model 事件只会触发最后一次聚焦
   * - hasSettledView 确保只聚焦一次（除非 loadScene 重新开始）
   */
  private scheduleCameraFit(): void {
    if (this.hasSettledView) {
      return
    }

    window.clearTimeout(this.fitTimerId)
    this.fitTimerId = window.setTimeout(() => {
      if (this.tilesetEntries.size === 0) {
        return
      }

      // 基于实际加载的几何体计算包围盒
      this.tilesetRoot.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(this.tilesetRoot)
      // 如果实际包围盒为空，回退到元数据包围盒
      const targetBox = box.isEmpty() ? this.metadataSceneBounds : box
      const didFit = !targetBox.isEmpty() && this.fitCameraToBox(targetBox)

      if (didFit && this.areAllSourcesSettled()) {
        this.hasSettledView = true
      }
    }, 160)
  }

  /**
   * 根据包围盒调整相机位置和参数
   *
   * ## 算法
   *
   * 1. 根据包围盒的最大尺寸计算合适的观察距离
   *   - 公式: distance = maxDim / (2 × tan(FOV/2))
   *   - 保证包围盒完全在视锥体内
   * 2. 相机定位在包围盒中心的右前上方
   * 3. 同步更新 near/far 裁剪面和轨道控制器 min/max 缩放距离
   *
   * @param box - 目标包围盒
   * @returns 是否成功聚焦（包围盒非空）
   */
  private fitCameraToBox(box: THREE.Box3): boolean {
    if (box.isEmpty()) {
      return false
    }

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z)
    const safeDimension = maxDimension > 0 ? maxDimension : 10

    // 根据 FOV 和包围盒大小计算最佳观察距离
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5)
    const distance = safeDimension / (2 * Math.tan(halfFov))

    // 相机偏移方向：(1.2, 0.9, 1.4) 表示偏向右侧 + 上方 + 前方，
    // 1.65 倍距离确保模型周围有足够的视觉呼吸空间
    const offset = new THREE.Vector3(1.2, 0.9, 1.4).normalize().multiplyScalar(distance * 1.65)

    this.camera.position.copy(center).add(offset)
    // 动态调整裁剪面范围，与场景尺度匹配
    this.camera.near = Math.max(safeDimension / 500, 0.1)
    this.camera.far = Math.max(safeDimension * 50, 5000)
    this.camera.updateProjectionMatrix()

    // 同步更新轨道控制器参数
    this.controls.minDistance = Math.max(safeDimension / 200, 1)
    this.controls.maxDistance = Math.max(safeDimension * 25, 500000)
    this.controls.target.copy(center)
    this.controls.update()

    return true
  }

  // ========== 状态查询与聚合 ==========

  /**
   * 检查所有数据源是否已结束加载（成功或失败）
   */
  private areAllSourcesSettled(): boolean {
    if (this.tilesetEntries.size === 0) {
      return true
    }

    for (const entry of this.tilesetEntries.values()) {
      if (!entry.settled) {
        return false
      }
    }

    return true
  }

  /**
   * 计算已加载至少一个可见模型的数据源数量
   */
  private getRenderableSourceCount(): number {
    let count = 0

    for (const entry of this.tilesetEntries.values()) {
      if (entry.hasContent || entry.renderer.group.children.length > 0) {
        count += 1
      }
    }

    return count
  }

  /**
   * 计算所有数据源的平均加载进度（0-100）
   *
   * 已完成或出错的数据源计为 100，加载中的从 renderer.loadProgress 读取
   */
  private getAggregateProgress(): number {
    const entries = Array.from(this.tilesetEntries.values())

    if (entries.length === 0) {
      return 0
    }

    const totalProgress = entries.reduce((sum, entry) => {
      if (entry.state === 'ready' || entry.state === 'error') {
        return sum + 100
      }

      const progress = Number.isFinite(entry.renderer.loadProgress)
        ? entry.renderer.loadProgress * 100
        : 0

      return sum + Math.min(Math.max(progress, 0), 100)
    }, 0)

    return totalProgress / entries.length
  }

  /**
   * 汇总所有出错数据源的错误信息
   */
  private getCombinedErrorMessage(): string {
    return Array.from(this.tilesetEntries.values())
      .filter((entry) => entry.error)
      .map((entry) => `${entry.config.name}: ${entry.error}`)
      .join('\n')
  }

  /**
   * 刷新状态信息并通知外部
   *
   * 根据当前数据源的加载状态，自动生成对应的状态消息：
   * - 全部完成 + 有内容 → "ready" + 成功消息
   * - 全部完成 + 无内容 → "error" + 错误汇总
   * - 加载中 → "loading" + (用户定义消息 或 默认进度消息)
   *
   * @param message - 可选的状态描述消息
   */
  private refreshStatus(message?: string): void {
    const entries = Array.from(this.tilesetEntries.values())

    if (entries.length === 0) {
      return
    }

    const progress = this.getAggregateProgress()
    const errorCount = entries.filter((entry) => entry.state === 'error').length
    const renderableCount = this.getRenderableSourceCount()

    if (this.areAllSourcesSettled()) {
      if (renderableCount === 0) {
        // 所有数据源加载完成但没有可见内容 → 报告错误
        this.emitStatus({
          state: 'error',
          progress: 100,
          message: '地形与模型均未能成功加载。',
          error: this.getCombinedErrorMessage(),
        })
        return
      }

      // 至少有一个数据源可见 → 报告就绪
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

    // 仍在加载中
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

  /**
   * 通过 HTTP 获取 tileset.json 的根节点元数据
   *
   * 只提取 root.transform 和 root.boundingVolume 两个关键字段，
   * 用于后续的坐标转换和包围盒计算。
   *
   * @param url - tileset.json 的完整 URL
   * @returns 根节点元数据，加载失败返回 null
   */
  private async loadSourceMetadata(url: string): Promise<TilesetRootMetadata | null> {
    try {
      const response = await fetch(url)

      if (!response.ok) {
        return null
      }

      const json = (await response.json()) as TilesetMetadata
      return json.root ?? null
    } catch {
      return null
    }
  }

  /**
   * 计算多个数据源元数据包围盒的并集
   *
   * 用于在数据尚未加载时就能提供一个大致的场景边界，
   * 供 fitCameraToBox 做初始视角定位。
   */
  private createCombinedMetadataBounds(
    entries: Array<{ config: TilesetSourceConfig; metadata: TilesetRootMetadata | null }>,
  ): THREE.Box3 {
    const combinedBox = new THREE.Box3()

    for (const entry of entries) {
      const entryBox = this.createBoxFromMetadata(entry.metadata)

      if (!entryBox.isEmpty()) {
        combinedBox.union(entryBox)
      }
    }

    return combinedBox
  }

  /**
   * 从单个 tileset.json 的 root.boundingVolume.box 创建 THREE.Box3（瓦片局部空间）
   *
   * 3D Tiles 的 boundingVolume.box 包含 12 个数字：
   * [center_x, center_y, center_z,
   *  half_x_x, half_x_y, half_x_z,
   *  half_y_x, half_y_y, half_y_z,
   *  half_z_x, half_z_y, half_z_z]
   *
   * 表示一个定向包围盒（在瓦片局部空间中）。
   *
   * 由于 ReorientationPlugin（recenter: true）会自动将每个 tileset
   * 居中到场景原点，此处的包围盒直接反映瓦片局部空间的范围，
   * 无需再叠加 root.transform（ECEF 变换）。
   *
   * @param metadata - 根节点元数据
   * @returns 有效的 THREE.Box3（瓦片局部空间），数据无效时返回空包围盒
   */
  private createBoxFromMetadata(metadata: TilesetRootMetadata | null): THREE.Box3 {
    const boxValues = metadata?.boundingVolume?.box

    if (!Array.isArray(boxValues) || boxValues.length !== 12) {
      return EMPTY_BOX.clone()
    }

    // 解析包围盒中心点和三个方向的半轴向量
    const center = new THREE.Vector3(boxValues[0], boxValues[1], boxValues[2])
    const halfAxisX = new THREE.Vector3(boxValues[3], boxValues[4], boxValues[5])
    const halfAxisY = new THREE.Vector3(boxValues[6], boxValues[7], boxValues[8])
    const halfAxisZ = new THREE.Vector3(boxValues[9], boxValues[10], boxValues[11])

    const box = new THREE.Box3()

    // 枚举定向包围盒的 8 个角点 → 扩展 AABB
    // recenter: true 时坐标保持在瓦片局部空间，无需 ECEF 变换
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

  /**
   * 强制更新所有瓦片渲染器的分辨率和渲染状态
   * 用于在场景切换或初始聚焦后立即刷新显示
   */
  private forceTilesetUpdate(): void {
    const fbSize = new THREE.Vector2()
    this.renderer.getDrawingBufferSize(fbSize)
    for (const entry of this.tilesetEntries.values()) {
      entry.renderer.setResolution(this.camera, fbSize.x, fbSize.y)
      entry.renderer.update()
    }
  }

  /**
   * 返回用于渲染的目标像素比
   *
   * 不强制所有设备至少 2x，而是按真实设备像素比渲染，并在高分屏上做上限保护，
   * 这样既能保持清晰，也不会因为离屏缓冲过大拖慢高精细瓦片的收敛速度。
   */
  private getPreferredPixelRatio(): number {
    return THREE.MathUtils.clamp(window.devicePixelRatio || 1, 1, 2)
  }

  // ========== 纹理质量增强 ==========

  /**
   * 对刚加载的模型递归遍历，提升所有材质纹理的采样质量
   *
   * - anisotropy → GPU 最大，改善斜角观察时的纹理清晰度
   * - 保留原始 mipmap / filter 策略，避免把带 mip 的纹理强行改成单层采样后发花
   *
   * @param scene - 已加载的模型根节点
   */
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
          if (value && (value as THREE.Texture).isTexture) {
            const texture = value as THREE.Texture
            texture.anisotropy = maxAnisotropy
            texture.needsUpdate = true
          }
        }
      }
    })
  }

  // ========== 状态通知 ==========

  /**
   * 发出状态变化通知（含去重逻辑）
   *
   * 将状态对象序列化为唯一 key，若与上一次相同则跳过通知，
   * 避免频繁触发 Vue 响应式更新。
   *
   * @param status - 当前状态对象
   */
  private emitStatus(status: ViewerStatus): void {
    const normalizedStatus = {
      ...status,
      progress: Math.min(Math.max(status.progress, 0), 100),
    }
    // 生成唯一 key 用于去重
    const key = [
      normalizedStatus.state,
      Math.round(normalizedStatus.progress),
      normalizedStatus.message,
      normalizedStatus.error || '',
    ].join('|')

    if (key === this.lastStatusKey) {
      return
    }

    this.lastStatusKey = key
    this.callbacks.onStatusChange?.(normalizedStatus)
  }
}
