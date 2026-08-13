import * as THREE from 'three'
import { lonLatHeightToEcef } from '@/utils/geo-coordinate'

/** 经纬度点位精灵图标资源路径 */
const POINT_ICON_URL = '/img/boxCamera.svg'

/**
 * 点位渲染器依赖项
 *
 * 通过注入场景中的关键节点和查询函数，将「经纬度 → 场景坐标 → 标记精灵」
 * 的渲染逻辑从控制器中解耦出来，便于独立复用和测试。
 */
export interface PointMarkerRendererOptions {
  /** 所有瓦片集的根容器：用于射线检测贴合与场景尺度估算 */
  tilesetRoot: THREE.Group
  /** 标记精灵挂载的容器 */
  markerRoot: THREE.Group
  /** 获取地形 tileset 的 group：用于 ECEF → 局部坐标变换与 up 方向推算 */
  getTerrainGroup: () => THREE.Group | null
  /** 获取场景元数据包围盒：当实际几何尚未加载时作为尺度估算回退 */
  getFallbackBounds: () => THREE.Box3
}

/**
 * 经纬度点位渲染器
 *
 * 负责将 WGS84 坐标映射到场景表面并显示标记精灵，包含：
 * - ECEF → 场景局部坐标变换
 * - 射线检测自动贴合模型/地形表面（未提供高程时）
 * - 点位精灵的创建、缩放与纹理管理
 *
 * 同一时间只保留一个活跃点位，重复渲染会先清除上一个。
 */
export class PointMarkerRenderer {
  /** 瓦片集根容器引用 */
  private readonly tilesetRoot: THREE.Group
  /** 标记精灵挂载容器引用 */
  private readonly markerRoot: THREE.Group
  /** 地形 group 查询函数 */
  private readonly getTerrainGroup: () => THREE.Group | null
  /** 元数据包围盒查询函数 */
  private readonly getFallbackBounds: () => THREE.Box3
  /** 射线投射器：用于将经纬度点位精确贴合到地形表面 */
  private readonly raycaster = new THREE.Raycaster()
  /** 纹理加载器：用于异步加载点位精灵图标 */
  private readonly textureLoader = new THREE.TextureLoader()

  /** 当前活跃的经纬度点位精灵 */
  private pointSprite: THREE.Sprite | null = null
  /** 点位精灵的纹理对象（缓存） */
  private pointTexture: THREE.Texture | null = null
  /** 点位纹理的加载 Promise（防止重复加载） */
  private pointTexturePromise: Promise<THREE.Texture> | null = null

  constructor(options: PointMarkerRendererOptions) {
    this.tilesetRoot = options.tilesetRoot
    this.markerRoot = options.markerRoot
    this.getTerrainGroup = options.getTerrainGroup
    this.getFallbackBounds = options.getFallbackBounds
  }

  /**
   * 在场景中渲染一个经纬度定位点
   *
   * ## 渲染流程
   *
   * 1. 将 (lon, lat, height) 转换为 ECEF，再通过地形 group 的 worldMatrix 映射到场景世界坐标
   * 2. 计算标记图标的缩放比例（像素 → 世界单位）
   * 3. 若未提供高程，用射线检测将位置贴合到 3DTiles 模型/地形表面（自动贴地）
   * 4. 创建 Sprite 精灵并添加到 markerRoot 中
   *
   * @param longitude - 经度（-180 ~ 180）
   * @param latitude - 纬度（-90 ~ 90）
   * @param height - 椭球体高度（米）。省略（undefined）时自动贴合模型表面
   * @returns 最终点位在场景中的世界坐标
   * @throws 如果地形数据尚未加载
   */
  async render(longitude: number, latitude: number, height?: number): Promise<THREE.Vector3> {
    const terrainGroup = this.getTerrainGroup()
    if (!terrainGroup) {
      throw new Error('地形数据尚未加载，请等待场景完成初始化后再渲染点位。')
    }

    // 确保世界矩阵最新，再读取地形 group 的变换
    this.tilesetRoot.updateMatrixWorld(true)

    // 步骤 1: WGS84 → ECEF → 世界坐标（通过 terrain group 的实际 worldMatrix）。
    // 未提供高程时先按椭球面（height=0）计算近似位置，后续再通过射线检测贴到模型表面。
    const ecef = lonLatHeightToEcef(longitude, latitude, height ?? 0)
    const approximatePosition = ecef.clone().applyMatrix4(terrainGroup.matrixWorld)

    const markerScale = this.getMarkerScale()

    // 步骤 2: 确定最终点位坐标
    // - 未提供高程：从高空向下射线检测，贴合到 3DTiles 模型/地形表面
    // - 提供了高程：直接使用该高程对应的位置
    const pointPosition =
      height === undefined
        ? this.resolveGroundedPosition(approximatePosition, markerScale, terrainGroup)
        : approximatePosition.clone()

    const pointTexture = await this.ensurePointTexture()

    // 步骤 3: 创建标记精灵
    const pointMaterial = new THREE.SpriteMaterial({
      map: pointTexture,
      transparent: true,
      depthWrite: false, // 不写入深度缓冲，避免透明矩形遮挡后方内容
      depthTest: false,  // 始终显示在模型之上，保证定位点清晰可见
    })

    // 先清除上一个点位，保持同一时间只显示一个标记
    this.clear()

    const pointSprite = new THREE.Sprite(pointMaterial)
    pointSprite.name = 'lon-lat-point'
    // center.set(0.5, 0.08)：x 水平居中，y 将图标尖端对齐到精灵底部附近
    pointSprite.center.set(0.5, 0.08)
    pointSprite.scale.set(markerScale, markerScale, 1)
    pointSprite.position.copy(pointPosition)
    pointSprite.renderOrder = 8 // 较高的渲染顺序，确保在其他内容之上显示

    this.markerRoot.add(pointSprite)
    this.pointSprite = pointSprite

    return pointPosition.clone()
  }

  /**
   * 清除当前显示的经纬度点位精灵
   * 安全幂等：如果没有活跃的点位则无操作
   */
  clear(): void {
    if (!this.pointSprite) {
      return
    }

    this.markerRoot.remove(this.pointSprite)
    this.pointSprite.material.dispose()
    this.pointSprite = null
  }

  /**
   * 释放点位精灵及其纹理资源
   * 应在控制器销毁时调用
   */
  dispose(): void {
    this.clear()

    if (this.pointTexture) {
      this.pointTexture.dispose()
      this.pointTexture = null
      this.pointTexturePromise = null
    }
  }

  /**
   * 计算经纬度标记精灵的世界空间缩放比例
   *
   * 比例与场景最大尺寸成正比（scaleHint × 0.02），
   * 并限制在 80 ~ 360 的范围内，确保标记在任何尺度下都保持合理可见性。
   *
   * @returns 标记精灵的像素/世界单位缩放值
   */
  getMarkerScale(): number {
    const scaleHint = this.getSceneScaleHint() * 0.02
    return THREE.MathUtils.clamp(scaleHint, 80, 360)
  }

  /**
   * 通过射线检测将近似位置修正到 3DTiles 模型/地形表面（自动贴地）
   *
   * 从目标点正上方沿 up 轴向下发射射线，与 tilesetRoot 中所有子物体求交，
   * 取第一个有效交点后向上偏移一小段距离（避免和表面发生 z-fighting）。
   *
   * 射线起点会抬到足够高的位置，确保始终高于任何地形/模型，避免因起点
   * 埋在地下（椭球面高程低于实际地表）而导致射线向下穿透、无法命中表面。
   *
   * @param approximatePosition - 经纬度转换后的近似世界坐标（椭球面附近）
   * @param markerScale - 标记精灵的世界单位尺寸
   * @param terrainGroup - 地形 tileset 的 group，用于推算 up 方向
   * @returns 修正后的精确贴合坐标；未命中时回退到近似位置
   */
  private resolveGroundedPosition(
    approximatePosition: THREE.Vector3,
    markerScale: number,
    terrainGroup: THREE.Group,
  ): THREE.Vector3 {
    // 更新世界矩阵，确保射线检测基于最新的几何体位置
    this.tilesetRoot.updateMatrixWorld(true)

    // ReorientationPlugin(+z, OBJECT_FRAME) 会将 +Z 旋转为 +Y（Three.js 标准 up 轴）。
    // 地形 group 的局部 up 轴在 worldSpace 中对应其 local +Y 方向。
    const worldUp = new THREE.Vector3(0, 1, 0).applyQuaternion(terrainGroup.quaternion)

    // 射线起点：目标点上方 rayHeight 处（沿 up 方向移动）。
    // 高度取「场景尺度的 1.5 倍 / 精灵尺寸的 20 倍 / 5km」三者最大，
    // 保证起点高于任何地表，射线能自上而下稳定命中模型表面。
    const rayHeight = Math.max(this.getSceneScaleHint() * 1.5, markerScale * 20, 5000)
    const rayOrigin = approximatePosition.clone().addScaledVector(worldUp, rayHeight)
    // 射线方向：沿 up 的反方向向下
    const rayDirection = worldUp.clone().negate()

    this.raycaster.set(rayOrigin, rayDirection)
    this.raycaster.far = rayHeight * 2 // 射程上限为起点的两倍高度

    // 与 tilesetRoot 下所有子对象（递归）进行交叉检测
    const intersections = this.raycaster.intersectObjects(this.tilesetRoot.children, true)
    const hit = intersections.find((intersection) => intersection.distance >= 0)

    if (!hit) {
      // 没有命中任何表面（例如该经纬度处的瓦片尚未加载），使用近似位置作为回退
      return approximatePosition
    }

    // 命中后在交点上沿 up 方向添加微小偏移（精灵高度的 12%），
    // 避免精灵与表面重叠导致 z-fighting
    return hit.point.clone().addScaledVector(worldUp, markerScale * 0.12)
  }

  /**
   * 估算当前场景的尺度
   *
   * 优先基于 tilesetRoot 中实际加载的几何体包围盒计算，
   * 如果为空则回退到元数据包围盒，再回退到默认值 1000。
   *
   * @returns 场景最大维度的长度，用于后续的标记缩放和射线高度计算
   */
  private getSceneScaleHint(): number {
    const sceneBox = new THREE.Box3().setFromObject(this.tilesetRoot)
    const targetBox = sceneBox.isEmpty() ? this.getFallbackBounds() : sceneBox

    if (targetBox.isEmpty()) {
      return 1000
    }

    const size = targetBox.getSize(new THREE.Vector3())
    return Math.max(size.x, size.y, size.z, 1000)
  }

  /**
   * 确保点位纹理已加载（懒加载 + 缓存）
   *
   * 使用 Promise 缓存防止并发调用时重复发起网络请求，
   * 加载完成后将纹理引用缓存到 this.pointTexture 中。
   *
   * @returns 已加载的点位纹理对象
   */
  private async ensurePointTexture(): Promise<THREE.Texture> {
    if (this.pointTexture) {
      return this.pointTexture
    }

    if (!this.pointTexturePromise) {
      this.pointTexturePromise = this.textureLoader.loadAsync(POINT_ICON_URL).then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
        this.pointTexture = texture
        return texture
      })
    }

    return this.pointTexturePromise
  }
}
