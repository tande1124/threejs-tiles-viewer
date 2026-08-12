/**
 * 3D Tiles 数据源类型
 * - terrain: 地形基底（带 transform 参考、射线检测等）
 * - tileset: 独立的模型瓦片集
 */
export type SceneSourceKind = 'terrain' | 'tileset'

/**
 * 单个 3D Tiles 数据源的配置描述
 * 包含标识信息、种类以及远程或本地的 tileset.json 地址
 */
export interface TilesetSourceConfig {
  /** 唯一标识符，用于 Map 索引和日志追踪 */
  id: string
  /** 可读名称，用于 UI 提示和错误消息 */
  name: string
  /** 数据源种类：地形基底或独立模型瓦片集 */
  kind: SceneSourceKind
  /** tileset.json 的资源地址（可以是相对路径或远程 URL） */
  url: string
}

/** 默认场景配置：包含一组预定义的数据源列表 */
export interface DefaultSceneConfig {
  sources: TilesetSourceConfig[]
}

/**
 * 默认地形瓦片集地址
 * 优先读取环境变量 VITE_DEFAULT_TILESET，未配置时回退到 public 目录下的本地数据
 */
export const DEFAULT_TERRAIN_URL =
  import.meta.env.VITE_DEFAULT_TILESET || '/data/3dtiles/tileset.json'

/**
 * 默认组合场景的数据源列表
 *
 * 约定：先加载 terrain 类型的地形基底（提供 transform 参考和射线检测能力），
 * 再加载独立的模型瓦片集（如施工辅助模型、枢纽工程结构模型）。
 * 每种数据源都有独立的 id、name、kind 和 url 字段。
 */
const DEFAULT_SCENE_SOURCES: TilesetSourceConfig[] = [
  {
    id: 'terrain-base',
    name: '地形基底',
    kind: 'terrain',
    url: DEFAULT_TERRAIN_URL,
  }
]

/**
 * 获取默认地形瓦片集的资源地址
 * @returns 地形 tileset.json 的 URL
 */
export function getDefaultTerrainUrl(): string {
  return DEFAULT_TERRAIN_URL
}

/**
 * 获取默认组合场景的完整配置
 * 返回一份浅拷贝，避免外部修改污染内部默认数据
 * @returns 包含所有预定义数据源的场景配置对象
 */
export function getDefaultSceneConfig(): DefaultSceneConfig {
  return {
    sources: DEFAULT_SCENE_SOURCES.map((source) => ({ ...source })),
  }
}

/**
 * 获取默认场景中地形基底数据源的配置
 * @returns 第一个 kind === 'terrain' 的数据源配置，若无则返回 undefined
 */
export function getTerrainSourceConfig(): TilesetSourceConfig | undefined {
  return DEFAULT_SCENE_SOURCES.find((source) => source.kind === 'terrain')
}