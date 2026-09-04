import * as THREE from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'

// ========== 环境配置 ==========

/** 背景默认底色（无 HDR 且 bgInt=0 时使用） */
const BG_COLOR = 0x1a1a2e

/** 渐变背景颜色（环境贴图关闭时的回退背景，与 environment.js 一致） */
const GRADIENT_COLORS = [
  { stop: 0, color: '#46557a' },
  { stop: 0.55, color: '#232e47' },
  { stop: 1, color: '#0e1422' },
]

/** 默认 HDR 路径 */
const DEFAULT_HDR_PATH = './assets/studio.exr'

// ========== 环境管理器 ==========

/**
 * 场景环境统一配置入口（v2，对齐 environment.js）。
 *
 * 管理 HDR 环境贴图、主方向光（含阴影）、环境/背景强度、
 * 渐变背景回退、色调映射曝光和泛光参数。
 *
 * 用法：
 * ```js
 * const env = new EnvironmentManager(scene, renderer)
 * await env.applyFromUrl('./config/env-config.json')
 * ```
 */
export class EnvironmentManager {
  scene
  renderer

  /** HDR 环境贴图（EXR），为 PBR 材质提供环境反射与背景 */
  hdrTexture = null
  /** 渐变背景纹理（envMap 关闭时的回退背景） */
  gradientBgTexture = null

  /** 主方向光引用（供外部读取位置/阴影状态） */
  dirLight = null

  /** 当前配置缓存（applyAllParams 后保留，供后续局部更新使用） */
  config = null

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene
    this.renderer = renderer
  }

  // ========== 公共方法 ==========

  /**
   * 从 URL 加载 env-config.json 并应用全部环境配置。
   *
   * 执行顺序（对齐 environment.js applyAllParams）：
   * 1. 主方向光 + 阴影  2. 环境/背景强度  3. 曝光
   * @param {string} url
   */
  async applyFromUrl(url) {
    const cfg = await this.loadConfig(url)
    this.config = cfg

    // HDR 环境贴图（始终加载，显隐由 envMapEnabled / 强度控制）
    const hdrPath = cfg.envLight.hdrPath ?? DEFAULT_HDR_PATH
    await this.loadHdrEnvironment(hdrPath)

    this.applyAllParams()
  }

  /**
   * 应用全部参数（可反复调用，对齐 environment.js applyAllParams）。
   * 必须先调用 applyFromUrl 完成初始化。
   */
  applyAllParams() {
    const cfg = this.config
    if (!cfg) return

    // ---- 1. 主方向光 ----
    this.setupDirLight(cfg)

    // ---- 2. 环境照明(IBL) ----
    const envInt = cfg.envLight.intensity
    if (envInt > 0 && this.hdrTexture) {
      this.scene.environment = this.hdrTexture
      this.scene.environmentIntensity = envInt
    } else if (envInt > 0) {
      this.scene.environment = null
      this.scene.environmentIntensity = envInt
    } else {
      this.scene.environment = null
      this.scene.environmentIntensity = 0
    }

    // ---- 3. 背景 ----
    // envMapEnabled 开关仅控制背景显隐，停用时换渐变底
    const bgInt = cfg.envLight.bgIntensity
    if (!cfg.envMapEnabled) {
      this.scene.background = this.getGradientBackground()
      this.scene.backgroundIntensity = 1
    } else if (envInt === 0 && bgInt === 0) {
      this.scene.background = this.getGradientBackground()
      this.scene.backgroundIntensity = 1
    } else if (bgInt > 0 && this.hdrTexture) {
      this.scene.background = this.hdrTexture
      this.scene.backgroundIntensity = bgInt
    } else if (bgInt > 0) {
      this.scene.background = new THREE.Color(0x000000)
      this.scene.backgroundIntensity = bgInt
    } else {
      this.scene.background = new THREE.Color(BG_COLOR)
      this.scene.backgroundIntensity = 0
    }

    // ---- 4. 曝光 ----
    this.renderer.toneMappingExposure = cfg.envLight.exposure
  }

  /** 获取主方向光引用（可能为 null，applyFromUrl 后才有值） */
  getDirLight() {
    return this.dirLight
  }

  /** 获取当前环境配置快照 */
  getConfig() {
    return this.config
  }

  /** 获取泛光配置（供后期管线使用） */
  getBloomConfig() {
    return this.config?.bloom ?? null
  }

  /** 释放环境相关 GPU 资源 */
  dispose() {
    if (this.scene.environment) {
      this.scene.environment.dispose()
      this.scene.environment = null
    }
    if (this.hdrTexture) {
      this.hdrTexture.dispose()
      this.hdrTexture = null
    }
    if (this.gradientBgTexture) {
      this.gradientBgTexture.dispose()
      this.gradientBgTexture = null
    }
  }

  // ========== 内部方法 ==========

  /** 设置主方向光 + 阴影（移除旧灯光后重建，保留半球光和补光） */
  setupDirLight(cfg) {
    // 移除场景中的旧灯光
    const toRemove = []
    this.scene.traverse((obj) => {
      if (obj.isLight) toRemove.push(obj)
    })
    toRemove.forEach((obj) => {
      obj.parent?.remove(obj)
    })

    const dl = cfg.dirLight

    // ---- 主方向光 ----
    const mainLight = new THREE.DirectionalLight(dl.color, dl.intensity)
    const yaw = THREE.MathUtils.degToRad(dl.yaw)
    const pitch = THREE.MathUtils.degToRad(dl.pitch)
    mainLight.position.setFromSphericalCoords(200, Math.PI / 2 - pitch, yaw)
    mainLight.layers.enableAll()
    this.scene.add(mainLight)
    this.dirLight = mainLight

    // ---- 阴影 ----
    const sh = dl.shadow
    if (sh.enabled) {
      mainLight.castShadow = true
      this.renderer.shadowMap.enabled = true
      mainLight.shadow.mapSize.set(sh.resolution, sh.resolution)
      mainLight.shadow.camera.left = -sh.range + sh.offsetX
      mainLight.shadow.camera.right = sh.range + sh.offsetX
      mainLight.shadow.camera.top = sh.range + sh.offsetY
      mainLight.shadow.camera.bottom = -sh.range + sh.offsetY
      mainLight.shadow.bias = sh.bias
      mainLight.shadow.camera.updateProjectionMatrix()
    }

    // ---- 半球光（环境补光） ----
    const hemiLight = new THREE.HemisphereLight('#dbeafe', '#020617', 0.6)
    hemiLight.position.set(0, 1, 0)
    hemiLight.layers.enableAll()
    this.scene.add(hemiLight)

    // ---- 补光（对侧柔光） ----
    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.4)
    fillLight.position.set(-100, 60, -80)
    fillLight.layers.enableAll()
    this.scene.add(fillLight)
  }

  /** 生成渐变背景纹理（与 environment.js getGradientBackground 一致） */
  getGradientBackground() {
    if (this.gradientBgTexture) return this.gradientBgTexture
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 512
    const ctx2d = canvas.getContext('2d')
    const grad = ctx2d.createLinearGradient(0, 0, 0, 512)
    for (const { stop, color } of GRADIENT_COLORS) {
      grad.addColorStop(stop, color)
    }
    ctx2d.fillStyle = grad
    ctx2d.fillRect(0, 0, 16, 512)
    this.gradientBgTexture = new THREE.CanvasTexture(canvas)
    this.gradientBgTexture.colorSpace = THREE.SRGBColorSpace
    return this.gradientBgTexture
  }

  /** 加载 HDR 环境贴图（EXR 格式） */
  loadHdrEnvironment(path) {
    if (!path) return Promise.resolve()
    return new Promise((resolve) => {
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

  /** 从 URL 加载 env-config.json */
  async loadConfig(url) {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`环境配置加载失败: ${res.status} ${res.statusText}`)
    }
    return res.json()
  }
}
