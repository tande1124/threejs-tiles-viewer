import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { disposeObject3D } from '@/utils/three-dispose'
import { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'
import {
  GltfModelLoader,
  type GltfLoadOptions,
  type GltfPickInfo,
} from '@/utils/GltfModelLoader'
import {
  calibrateGeoReferenceFromAnchor,
  createGeoReferenceMatrix,
  type GeoReferenceParams,
} from '@/utils/geo-coordinate'
import type { SceneSourceKind, TilesetSourceConfig } from '@/utils/tileset'

// ========== 配置常量 ==========

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
 * 加载方式与 demo 一致，简单直接：
 * - new TilesRenderer(url) → setCamera/setResolution → 挂到 scene → 每帧 update()
 * - 无任何事件监听/调整；root 就绪后由渲染循环做一次纯状态检查，记录场景范围并聚焦相机
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
  private readonly skyBox: THREE.Mesh
  private readonly dracoLoader = new DRACOLoader()
  private readonly ktx2Loader = new KTX2Loader()
  private readonly resizeObserver = new ResizeObserver(() => this.handleResize())
  private readonly pointMarkerRenderer: PointMarkerRenderer
  /** 坐标轴辅助线（X 红 / Y 绿 / Z 蓝），单位尺寸创建、按场景包围盒缩放 */
  private readonly axesHelper = new THREE.AxesHelper(1)
  private axesVisible = true

  // ---- 后处理（X光透视 + 选中部件白色轮廓） ----
  private composer: EffectComposer | null = null
  private outlinePass: OutlinePass | null = null
  /** 是否启用 X光透视合成（默认关闭，相关 pass/纹理由调用方按需构建） */
  private xrayEnabled = false
  /** GLB 单独渲染的透明纹理（透视叠加层） */
  private gltfLayerTarget: THREE.WebGLRenderTarget | null = null
  /** 把 GLB 层纹理合成到主画面的 pass */
  private xrayPass: ShaderPass | null = null

  // ---- 3D Tiles 状态 ----
  private container: HTMLElement | null = null
  private tilesRenderer: TilesRenderer | null = null
  private tilesetSource: TilesetSourceConfig | null = null
  private tilesetReady = false
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
      onPick: (info, position) => {
        callbacks.onGltfPick?.(info, position)
        this.updateOutlineSelection()
      },
    })

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

    if (container.style.position === '') {
      container.style.position = 'relative'
    }

    this.resizeObserver.observe(container)
    this.handleResize()
    this.startLoop()

    ;(window as unknown as { __tilesViewer?: TilesViewerController }).__tilesViewer = this
  }

  /** 加载 3D Tiles（demo 同款：创建 → setCamera/setResolution → 挂 group） */
  async loadScene(sources: TilesetSourceConfig[]): Promise<void> {
    if (!this.container) {
      throw new Error('Three.js 容器尚未挂载。')
    }

    const source = sources.find((item) => item.url)
    if (!source) {
      throw new Error('未提供可加载的 3DTiles 数据源。')
    }

    this.clearTileset()
    this.clearLonLatPoint()
    this.sceneBounds.makeEmpty()

    await (this.renderer as THREE.WebGLRenderer & { init?: () => Promise<void> }).init?.()
    this.ktx2Loader.detectSupport(this.renderer)

    // ---- 加载 3D Tiles 作为外壳（demo 同款）----
    this.tilesetSource = source
    this.tilesRenderer = new TilesRenderer(source.url)
    this.tilesRenderer.setCamera(this.camera)
    this.tilesRenderer.setResolutionFromRenderer(this.camera, this.renderer)

    // 坐标 recenter（大坐标 ECEF 场景归到原点附近）
    this.tilesRenderer.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }))
    // Vite 静态服务器不解析 %2B：瓦片路径里的 %2B 会拿到 SPA 回退页，必须解码回 '+'
    this.tilesRenderer.registerPlugin({
      preprocessURL: (url: string) => url.replace(/%2B/gi, '+'),
    })

    // tileset 加载完成后，ReorientationPlugin 已把瓦片集居中到原点并调整为 +Y 上，
    // 这里只记录场景范围并聚焦相机（v0.5.1 事件名为 load-root-tileset）
    const boundingSphere = new THREE.Sphere()
    this.tilesRenderer.addEventListener('load-root-tileset', () => {
      const renderer = this.tilesRenderer
      if (!renderer) return
      // 包围球在 ECEF 空间，经 group.matrixWorld 转到场景坐标后才是可用的场景范围
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
      this.hasSettledView = false
      this.scheduleCameraFit()
    }

    return model
  }

  /**
   * 用一个已知公共点自动反算 GLB 的地理配准参数（调试工具）。
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

  /** 用 NDC 坐标（-1 ~ 1，原点在画布中心）手动拾取 GLB 部件（调试工具） */
  pickGltfAt(ndcX: number, ndcY: number): GltfPickInfo | null {
    return this.gltfModelLoader.pick(this.camera, new THREE.Vector2(ndcX, ndcY))
  }

  /** 高亮指定 GLB 部件（或其子树），传 null 清除当前高亮（调试工具） */
  highlightGltf(object: THREE.Object3D | null): void {
    this.gltfModelLoader.highlight(object)
    this.updateOutlineSelection()
  }

  /** 清除 GLB 部件高亮 */
  clearGltfHighlight(): void {
    this.gltfModelLoader.clearHighlight()
    this.updateOutlineSelection()
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
    this.outlinePass?.dispose()
    this.xrayPass?.dispose()
    this.gltfLayerTarget?.dispose()
    this.composer?.dispose()
    this.outlinePass = null
    this.xrayPass = null
    this.gltfLayerTarget = null
    this.composer = null
    this.controls.dispose()
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

      if (this.flyAnimation.active) {
        this.updateFlyAnimation()
      } else {
        this.controls.update()
      }

      // TilesRenderer.update() 需要本帧最新的相机矩阵（LOD/frustum culling 在此完成）
      this.camera.updateMatrixWorld()
      if (this.tilesRenderer) {
        // 图层隐藏时不调度瓦片加载，恢复显示后继续
        if (this.tilesRenderer.group.visible) {
          this.tilesRenderer.update()
        }
      }

      // 天空盒跟随相机，保证任意缩放距离下背景始终环绕视角
      this.skyBox.position.copy(this.camera.position)

      // X光透视：先把 GLB 单独渲染到透明纹理，供合成 pass 采样
      if (this.xrayEnabled) {
        this.renderGltfLayer()
      }

      if (this.composer) {
        this.composer.render()
      } else {
        this.renderer.render(this.scene, this.camera)
      }
    }

    renderFrame()
  }

  // ========== 3D Tiles 管理 ==========

  /** 释放并移除当前瓦片渲染器 */
  private clearTileset(): void {
    window.clearTimeout(this.fitTimerId)
    window.clearTimeout(this.groundingTimerId)
    this.fitTimerId = 0
    this.groundingTimerId = 0

    if (this.tilesRenderer) {
      this.tilesRenderer.deleteCamera(this.camera)
      this.tilesetRoot.remove(this.tilesRenderer.group)
      this.tilesRenderer.dispose()
      this.tilesRenderer = null
    }
    this.tilesetSource = null
    this.tilesetReady = false
  }

  // ========== GLB 地理配准 ==========

  /** 获取地形瓦片集的坐标系变换矩阵（ECEF → 场景局部坐标） */
  private getTilesetTransform(): THREE.Matrix4 | null {
    const group = this.tilesRenderer?.group
    if (!group) return null
    group.updateMatrixWorld(true)
    return group.matrixWorld.clone()
  }

  /**
   * 等待地形瓦片集根节点就绪（ReorientationPlugin 已算完场景矩阵）后执行回调。
   * 无事件监听：每 100ms 轮询检测 root 是否就绪。
   */
  private whenTerrainReady(callback: () => void): Promise<void> {
    const tilesRenderer = this.tilesRenderer
    if (!tilesRenderer) {
      console.warn('[loadGltf] 未加载地形瓦片集，无法进行地理配准。')
      return Promise.resolve()
    }

    const isReady = () =>
      this.tilesetReady || Boolean((tilesRenderer as unknown as { root?: unknown }).root)
    if (isReady()) {
      callback()
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const timerId = window.setInterval(() => {
        if (isReady()) {
          window.clearInterval(timerId)
          callback()
          resolve()
        }
      }, 100)
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

    // 同步后处理合成器与轮廓 pass 的尺寸（内部会按 pixelRatio 换算）
    this.composer?.setSize(width, height)
    this.composer?.setPixelRatio(this.getPreferredPixelRatio())

    // 同步 X光透视 GLB 层纹理尺寸（与合成器有效尺寸一致）
    const layerDpr = this.getPreferredPixelRatio()
    this.gltfLayerTarget?.setSize(
      Math.max(Math.round(width * layerDpr), 1),
      Math.max(Math.round(height * layerDpr), 1),
    )

    // 与 demo 一致：窗口变化时重新同步瓦片 SSE 分辨率
    this.tilesRenderer?.setResolutionFromRenderer(this.camera, this.renderer)
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

  /** 按真实设备像素比渲染，高分屏上限 2x 保护性能 */
  private getPreferredPixelRatio(): number {
    return THREE.MathUtils.clamp(window.devicePixelRatio || 1, 1, 2)
  }

  /** 把 GLB（gltf-root）单独渲染到透明纹理，作为透视叠加层（保留 GLB 内部深度） */
  private renderGltfLayer(): void {
    const target = this.gltfLayerTarget
    if (!target) return

    const prevBackground = this.scene.background
    const prevClearColor = this.renderer.getClearColor(new THREE.Color())
    const prevClearAlpha = this.renderer.getClearAlpha()

    // 隐藏非 GLB 内容（含天空盒/背景），只渲染 gltf-root；光照保持可见
    const hidden: Array<{ object: THREE.Object3D; visible: boolean }> = []
    const hide = (object: THREE.Object3D | null) => {
      if (!object) return
      hidden.push({ object, visible: object.visible })
      object.visible = false
    }
    hide(this.tilesetRoot)
    hide(this.markerRoot)
    hide(this.skyBox)
    hide(this.axesHelper)

    this.scene.background = null
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setRenderTarget(target)
    this.renderer.clear(true, true, true)
    this.renderer.render(this.scene, this.camera)

    for (const item of hidden) {
      item.object.visible = item.visible
    }
    this.scene.background = prevBackground
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    this.renderer.setRenderTarget(null)
  }

  /** 同步 OutlinePass 的选中对象（白色轮廓跟随当前选中的 GLB 部件） */
  private updateOutlineSelection(): void {
    if (!this.outlinePass) return
    const object = this.gltfModelLoader.getHighlightedObject()
    this.outlinePass.selectedObjects = object ? [object] : []
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
}
