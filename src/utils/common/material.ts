import * as THREE from 'three'

// ========== 材质配置类型 ==========

/** 纯色材质定义 */
export interface SolidMaterialDef {
  color: string
  name: string
}

/** 贴图材质定义 */
export interface TexMaterialDef {
  color: string
  name: string
  textureDataURL: string | null
  tileX: number
  tileY: number
}

/** 金属材质定义 */
export interface MetalMaterialDef {
  color: string
  name: string
  metalness: number
  roughness: number
}

/** 半透明材质定义 */
export interface TransMaterialDef {
  color: string
  name: string
  opacity: number
}

/** 其它材质定义（线框等） */
export interface OtherMaterialDef {
  color: string
  name: string
  wireframe?: boolean
}

/** 材质库分类结构 */
export interface MaterialLibrary {
  solid: SolidMaterialDef[]
  tex: TexMaterialDef[]
  metal: MetalMaterialDef[]
  trans: TransMaterialDef[]
  other: OtherMaterialDef[]
}

export type MaterialType = keyof MaterialLibrary

/** material-state.json 中的网格材质分配条目 */
export interface MaterialStateEntry {
  modelName: string
  meshName: string
  matKey: string
}

/** material-state.json 中的 HDR 环境元数据 */
export interface HdrMeta {
  __hdrMeta: true
  envInt: number
  bgInt: number
  exposure: number
}

/** 材质状态文件解析结果 */
export interface ParsedMaterialState {
  entries: MaterialStateEntry[]
  hdrMeta: HdrMeta | null
}

// ========== 预置材质库 ==========

function createDefaultLibrary(): MaterialLibrary {
  const lib: MaterialLibrary = {
    solid: [],
    tex: [],
    metal: [],
    trans: [],
    other: [],
  }

  // 纯色
  lib.solid.push({ color: '#cccccc', name: '默认灰白' })
  lib.solid.push({ color: '#ffffff', name: '纯白' })
  lib.solid.push({ color: '#000000', name: '纯黑' })
  lib.solid.push({ color: '#808080', name: '中灰' })
  lib.solid.push({ color: '#ff2222', name: '红色' })
  lib.solid.push({ color: '#ff8800', name: '橙色' })
  lib.solid.push({ color: '#ffcc00', name: '黄色' })
  lib.solid.push({ color: '#22cc44', name: '绿色' })
  lib.solid.push({ color: '#2288ff', name: '蓝色磨砂' })
  lib.solid.push({ color: '#00bbdd', name: '青色' })
  lib.solid.push({ color: '#8844ff', name: '紫色' })
  lib.solid.push({ color: '#ff44aa', name: '粉色' })
  lib.solid.push({ color: '#8a5a2b', name: '棕色' })
  lib.solid.push({ color: '#44dd88', name: '绿色光泽' })

  // 贴图
  lib.tex.push({ color: '#b0b0b0', name: '水泥地', textureDataURL: './assets/textures/concrete.jpg', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#5a8a42', name: '草皮', textureDataURL: './assets/textures/grass.jpg', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#6e5234', name: '泥巴', textureDataURL: './assets/textures/mud_1.png', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#6e5234', name: '泥巴2', textureDataURL: './assets/textures/mud_2.png', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#c4b282', name: '砂砾石', textureDataURL: './assets/textures/gravel.jpg', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#a0a0a0', name: '碎石', textureDataURL: './assets/textures/crushed_stone_1.jpg', tileX: 2, tileY: 2 })
  lib.tex.push({ color: '#a0a0a0', name: '碎石2', textureDataURL: './assets/textures/crushed_stone_2.png', tileX: 2, tileY: 2 })

  // 金属
  lib.metal.push({ color: '#ff2222', name: '红色金属', metalness: 0.8, roughness: 0.2 })
  lib.metal.push({ color: '#aa44ff', name: '紫色金属', metalness: 0.8, roughness: 0.2 })
  lib.metal.push({ color: '#ff8800', name: '金色金属', metalness: 0.8, roughness: 0.2 })
  lib.metal.push({ color: '#ffd700', name: '黄金', metalness: 1.0, roughness: 0.15 })
  lib.metal.push({ color: '#c0c0c0', name: '白银', metalness: 1.0, roughness: 0.1 })
  lib.metal.push({ color: '#b87333', name: '铜', metalness: 0.95, roughness: 0.3 })
  lib.metal.push({ color: '#d4af37', name: '黄铜', metalness: 0.9, roughness: 0.35 })
  lib.metal.push({ color: '#8c92ac', name: '不锈钢', metalness: 1.0, roughness: 0.2 })
  lib.metal.push({ color: '#a8a8a8', name: '铁', metalness: 0.9, roughness: 0.5 })
  lib.metal.push({ color: '#c8c8d0', name: '铝', metalness: 0.95, roughness: 0.25 })
  lib.metal.push({ color: '#a99f8f', name: '钛', metalness: 0.9, roughness: 0.4 })
  lib.metal.push({ color: '#4d4d4d', name: '深灰金属', metalness: 0.85, roughness: 0.3 })
  lib.metal.push({ color: '#004466', name: '蓝钢', metalness: 0.9, roughness: 0.2 })
  lib.metal.push({ color: '#111111', name: '黑金属', metalness: 0.9, roughness: 0.25 })

  // 半透明
  lib.trans.push({ color: '#ff6644', name: '半透明红', opacity: 0.4 })
  lib.trans.push({ color: '#44aaff', name: '半透明蓝', opacity: 0.4 })
  lib.trans.push({ color: '#44dd88', name: '半透明绿', opacity: 0.4 })
  lib.trans.push({ color: '#ffcc44', name: '半透明黄', opacity: 0.4 })
  lib.trans.push({ color: '#aa88ff', name: '半透明紫', opacity: 0.4 })
  lib.trans.push({ color: '#88ccff', name: '半透明青', opacity: 0.4 })
  lib.trans.push({ color: '#ffffff', name: '半透明白', opacity: 0.4 })
  lib.trans.push({ color: '#888888', name: '半透明灰', opacity: 0.4 })

  // 其它（线框等）
  lib.other.push({ color: '#00ffff', name: '青色线框', wireframe: true })
  lib.other.push({ color: '#ff4444', name: '红色线框', wireframe: true })
  lib.other.push({ color: '#44ff44', name: '绿色线框', wireframe: true })

  return lib
}

// ========== 材质创建函数 ==========

function createSolidMaterial(cfg: SolidMaterialDef): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: cfg.color || '#ff6633',
    metalness: 0,
    roughness: 0.5,
  })
}

function createTexMaterial(
  cfg: TexMaterialDef,
  renderer?: THREE.WebGLRenderer,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.color || '#ffffff',
    metalness: 0,
    roughness: 0.5,
  })
  if (cfg.textureDataURL) {
    const tex = new THREE.TextureLoader().load(cfg.textureDataURL)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(cfg.tileX || 1, cfg.tileY || 1)
    tex.colorSpace = THREE.SRGBColorSpace
    // 各向异性过滤（提升斜角采样质量）
    const maxAniso = renderer?.capabilities.getMaxAnisotropy?.() ?? 16
    tex.anisotropy = maxAniso
    mat.map = tex
    mat.needsUpdate = true
  }
  return mat
}

function createMetalMaterial(cfg: MetalMaterialDef): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: cfg.color || '#ff8800',
    metalness: cfg.metalness ?? 0.8,
    roughness: cfg.roughness ?? 0.2,
  })
}

function createTransMaterial(cfg: TransMaterialDef): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: cfg.color || '#44aaff',
    metalness: 0,
    roughness: 0.3,
    transparent: true,
    opacity: cfg.opacity ?? 0.4,
  })
}

function createOtherMaterial(cfg: OtherMaterialDef): THREE.MeshStandardMaterial {
  if (cfg.wireframe) {
    return new THREE.MeshStandardMaterial({
      color: cfg.color || '#00ffff',
      wireframe: true,
    })
  }
  return new THREE.MeshStandardMaterial({
    color: cfg.color || '#ffffff',
  })
}

// ========== 材质配置器 ==========

/**
 * GLB 模型材质统一配置入口。
 *
 * 维护一份预置材质库（纯色 / 贴图 / 金属 / 半透明 / 线框），
 * 读取 material-state.json 中按 meshName 记录的材质分配，
 * 批量覆盖到已加载的 GLB 模型网格上。
 *
 * 用法：
 * ```ts
 * const configurator = new MaterialConfigurator(renderer)
 * const { hdrMeta } = await configurator.applyFromUrl(
 *   './config/material-state.json',
 *   model,
 *   'test',
 * )
 * ```
 */
export class MaterialConfigurator {
  private readonly lib: MaterialLibrary
  private readonly renderer?: THREE.WebGLRenderer

  constructor(renderer?: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.lib = createDefaultLibrary()
  }

  /**
   * 加载 material-state.json 并把材质覆盖应用到模型网格。
   *
   * @param url    - 材质状态 JSON 文件路径（相对 public 目录）
   * @param model  - 已加载的 GLB 模型根节点
   * @param modelName - 模型逻辑名称，用于匹配 JSON 中的 modelName 字段
   * @returns 解析后的 HDR 环境元数据（如有），可据此同步渲染器曝光等参数
   */
  async applyFromUrl(
    url: string,
    model: THREE.Object3D,
    modelName: string,
  ): Promise<{ hdrMeta: HdrMeta | null; appliedCount: number }> {
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`[MaterialConfigurator] 无法加载材质状态: ${url} (${response.status})`)
      return { hdrMeta: null, appliedCount: 0 }
    }
    const arr: unknown[] = await response.json()
    const { entries, hdrMeta } = this.parseStateArray(arr)
    const appliedCount = this.applyEntries(entries, model, modelName)
    return { hdrMeta, appliedCount }
  }

  /**
   * 解析 material-state.json 数组：分离网格材质条目和 HDR 元数据。
   */
  private parseStateArray(arr: unknown[]): ParsedMaterialState {
    const entries: MaterialStateEntry[] = []
    let hdrMeta: HdrMeta | null = null

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>

      if (obj.__hdrMeta === true) {
        hdrMeta = {
          __hdrMeta: true,
          envInt: (obj.envInt as number) ?? 0,
          bgInt: (obj.bgInt as number) ?? 1,
          exposure: (obj.exposure as number) ?? 1,
        }
        continue
      }

      if (typeof obj.meshName === 'string' && typeof obj.modelName === 'string') {
        entries.push({
          modelName: obj.modelName as string,
          meshName: obj.meshName as string,
          matKey: (obj.matKey as string) ?? '',
        })
      }
    }

    return { entries, hdrMeta }
  }

  /**
   * 遍历模型，按 meshName 匹配并应用 matKey 对应的材质。
   * 仅 matKey 非空的条目才会覆盖网格原始材质。
   */
  private applyEntries(
    entries: MaterialStateEntry[],
    model: THREE.Object3D,
    modelName: string,
  ): number {
    // 过滤当前模型的条目，且 matKey 非空
    const relevant = entries.filter(
      (e) => e.modelName === modelName && e.matKey,
    )
    if (relevant.length === 0) return 0

    // meshName → matKey 快速查找
    const meshMap = new Map<string, string>()
    for (const e of relevant) {
      meshMap.set(e.meshName, e.matKey)
    }

    let appliedCount = 0
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.name) return

      const matKey = meshMap.get(mesh.name.trim())
      if (!matKey) return

      const mat = this.getMaterialByKey(matKey)
      if (!mat) return

      mesh.material = mat
      mesh.userData._matKey = matKey
      appliedCount++
    })

    return appliedCount
  }

  /**
   * 根据 matKey（格式 "type_idx"，如 "tex_0"、"solid_3"）创建材质实例。
   * 返回 null 表示 key 无效或材质库中不存在对应条目。
   */
  getMaterialByKey(matKey: string): THREE.MeshStandardMaterial | null {
    const sepIdx = matKey.lastIndexOf('_')
    if (sepIdx < 0) return null

    const type = matKey.slice(0, sepIdx) as MaterialType
    const idx = parseInt(matKey.slice(sepIdx + 1), 10)
    if (isNaN(idx)) return null

    return this.createMaterial(type, idx)
  }

  /**
   * 按类型和索引创建材质实例。
   * 每次调用返回新实例（clone 语义），可安全赋给不同网格。
   */
  createMaterial(type: MaterialType, idx: number): THREE.MeshStandardMaterial | null {
    const items = this.lib[type]
    if (!items || idx < 0 || idx >= items.length) return null

    switch (type) {
      case 'solid':
        return createSolidMaterial(items[idx] as SolidMaterialDef)
      case 'tex':
        return createTexMaterial(items[idx] as TexMaterialDef, this.renderer)
      case 'metal':
        return createMetalMaterial(items[idx] as MetalMaterialDef)
      case 'trans':
        return createTransMaterial(items[idx] as TransMaterialDef)
      case 'other':
        return createOtherMaterial(items[idx] as OtherMaterialDef)
      default:
        return null
    }
  }

  /** 获取材质库（只读引用，可直接读取各分类列表） */
  getLibrary(): Readonly<MaterialLibrary> {
    return this.lib
  }

  /** 替换整个材质库（用于从外部导入材质定义） */
  setLibrary(lib: MaterialLibrary): void {
    Object.assign(this.lib, lib)
  }
}
