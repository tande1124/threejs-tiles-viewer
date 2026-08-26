import * as THREE from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { Sky } from 'three/addons/objects/Sky.js'

// ========== 环境配置类型 ==========

/** env-config.json 完整结构 */
export interface EnvConfig {
  version: number
  sky: {
    enabled: boolean
    turbidity: number
    rayleigh: number
    mieCoefficient: number
    mieDirectionalG: number
  }
  sun: {
    elevation: number
    azimuth: number
    syncSunToLight: boolean
  }
  directionalLight: {
    intensity: number
    color: string
    yaw: number
    pitch: number
  }
  shadow: {
    enabled: boolean
    resolution: number
    range: number
    offsetX: number
    offsetY: number
    bias: number
  }
  environment: {
    hdrPath: string
    envIntensity: number
    bgIntensity: number
    exposure: number
  }
  bloom: {
    enabled: boolean
    strength: number
    radius: number
    threshold: number
  }
}

/** 背景默认底色（无 HDR 且 bgInt=0 时使用） */
const BG_COLOR = 0x1a1a2e

// ========== 环境管理器 ==========

/**
 * 场景环境统一配置入口。
 *
 * 管理天空（Sky.js）、HDR 环境贴图、光照（方向光 / 半球光 / 补光）、
 * 阴影、色调映射和环境/背景强度。
 * 读取 env-config.json，按标准顺序应用：
 * 天空参数 → 太阳位置 → 曝光 → PMREM 烘焙 → HDR 加载 → 天空可见性 →
 * 环境/背景强度 → 光照阴影。
 *
 * 用法：
 * ```ts
 * const env = new EnvironmentManager(scene, renderer)
 * scene.add(env.getSky())                       // 构造函数已创建 Sky
 * await env.applyFromUrl('./config/env-config.json')
 * ```
 */
export class EnvironmentManager {
  // ---- 天空与太阳 ----
  private readonly sky: Sky
  private readonly sunPosition = new THREE.Vector3()
  /** HDR 环境贴图（EXR），为 PBR 材质提供环境反射与背景 */
  private hdrTexture: THREE.Texture | null = null

  private readonly scene: THREE.Scene
  private readonly renderer: THREE.WebGLRenderer

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene
    this.renderer = renderer

    // 天空：Preetham 物理大气散射模型
    this.sky = new Sky()
    this.sky.scale.setScalar(45000)

    // 默认天空参数（后续由 applyFromUrl 覆盖）
    const u = this.sky.material.uniforms
    u['turbidity'].value = 10
    u['rayleigh'].value = 2
    u['mieCoefficient'].value = 0.005
    u['mieDirectionalG'].value = 0.8

    this.sunPosition.set(0, 1, 0)
    u['sunPosition'].value.copy(this.sunPosition)

    // 初始 PMREM 烘焙（让场景立即有环境反射）
    this.bakeSkyEnvMap()
  }

  // ========== 公共方法 ==========

  /**
   * 从 URL 加载 env-config.json 并应用全部环境配置。
   *
   * 执行顺序（对齐 environment.js importConfig）：
   * 1. 天空参数  2. 太阳位置  3. 色调映射 & 曝光
   * 4. PMREM 烘焙  5. 天空可见性 & HDR 加载
   * 6. 环境/背景强度  7. 光照 & 阴影
   */
  async applyFromUrl(url: string): Promise<void> {
    const cfg = await this.loadConfig(url)

    // ---- 1. 天空参数 ----
    const u = this.sky.material.uniforms
    u['turbidity'].value = cfg.sky.turbidity
    u['rayleigh'].value = cfg.sky.rayleigh
    u['mieCoefficient'].value = cfg.sky.mieCoefficient
    u['mieDirectionalG'].value = cfg.sky.mieDirectionalG

    // ---- 2. 太阳位置 ----
    const phi = THREE.MathUtils.degToRad(90 - cfg.sun.elevation)
    const theta = THREE.MathUtils.degToRad(cfg.sun.azimuth)
    this.sunPosition.setFromSphericalCoords(1, phi, theta)
    u['sunPosition'].value.copy(this.sunPosition)

    // ---- 3. 色调映射与曝光 ----
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = cfg.environment.exposure

    // ---- 4. 从天空烘焙 PMREM 环境贴图 ----
    this.bakeSkyEnvMap()

    // ---- 5. 天空可见性 ----
    this.sky.visible = cfg.sky.enabled

    if (!cfg.sky.enabled) {
      await this.loadHdrEnvironment(cfg.environment.hdrPath)
    }

    // ---- 6. 环境强度 & 背景强度 ----
    const envInt = cfg.environment.envIntensity
    if (envInt > 0 && this.hdrTexture) {
      this.scene.environment = this.hdrTexture
      this.scene.environmentIntensity = envInt
    } else if (envInt > 0) {
      this.scene.environment = null
      this.scene.environmentIntensity = envInt
    } else {
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
      this.scene.background = new THREE.Color(BG_COLOR)
      this.scene.backgroundIntensity = 0
    }

    // ---- 7. 光照 & 阴影 ----
    this.setupLights(cfg)
  }

  /** 获取 Sky 实例（调用方需将其 add 到场景中） */
  getSky(): Sky {
    return this.sky
  }

  /** 当前太阳方向向量（供太阳同步方向光使用） */
  getSunPosition(): THREE.Vector3 {
    return this.sunPosition
  }

  /** 释放环境相关 GPU 资源（HDR 纹理、环境贴图） */
  dispose(): void {
    if (this.scene.environment) {
      this.scene.environment.dispose()
      this.scene.environment = null
    }
    if (this.hdrTexture) {
      this.hdrTexture.dispose()
      this.hdrTexture = null
    }
  }

  // ========== 内部方法 ==========

  /** 设置光照和阴影（移除旧灯光后重建） */
  private setupLights(cfg: EnvConfig): void {
    // 移除场景中的旧灯光
    const toRemove: THREE.Object3D[] = []
    this.scene.traverse((obj) => {
      if ((obj as THREE.Light).isLight) toRemove.push(obj)
    })
    toRemove.forEach((obj) => {
      obj.parent?.remove(obj)
    })

    // 主方向光
    const mainLight = new THREE.DirectionalLight(
      cfg.directionalLight.color,
      cfg.directionalLight.intensity,
    )
    const yaw = THREE.MathUtils.degToRad(cfg.directionalLight.yaw)
    const pitch = THREE.MathUtils.degToRad(cfg.directionalLight.pitch)
    mainLight.position.setFromSphericalCoords(200, Math.PI / 2 - pitch, yaw)
    mainLight.layers.enableAll()
    this.scene.add(mainLight)

    // 太阳同步：方向光跟随太阳方向
    if (cfg.sun.syncSunToLight) {
      mainLight.position.copy(this.sunPosition).multiplyScalar(200)
    }

    // 阴影
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

  /** 加载 HDR 环境贴图（EXR 格式） */
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
          console.warn('[EnvironmentManager] HDR 加载失败', err)
          resolve()
        },
      )
    })
  }

  /** 从当前天空参数烘焙 PMREM 环境贴图，为 PBR 材质提供环境反射 */
  private bakeSkyEnvMap(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()

    const skyScene = new THREE.Scene()
    const skyCopy = new Sky()
    const src = this.sky.material.uniforms
    const dst = skyCopy.material.uniforms
    dst['turbidity'].value = src['turbidity'].value
    dst['rayleigh'].value = src['rayleigh'].value
    dst['mieCoefficient'].value = src['mieCoefficient'].value
    dst['mieDirectionalG'].value = src['mieDirectionalG'].value
    dst['sunPosition'].value.copy(this.sunPosition)
    skyScene.add(skyCopy)

    const envMap = pmrem.fromScene(skyScene).texture

    if (this.scene.environment) {
      this.scene.environment.dispose()
    }
    this.scene.environment = envMap

    pmrem.dispose()
  }

  /** 从 URL 加载 env-config.json */
  private async loadConfig(url: string): Promise<EnvConfig> {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`环境配置加载失败: ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<EnvConfig>
  }
}
