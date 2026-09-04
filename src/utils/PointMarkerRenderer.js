import * as THREE from 'three'
import {
  ecefDirectionToScene,
  ecefToScenePosition,
  lonLatHeightToEcef,
  lonLatToEcefUp,
} from '@/utils/common/geo-coordinate'

/** 经纬度点位精灵图标资源路径 */
const POINT_ICON_URL = './assets/img/boxCamera.svg'

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
  tilesetRoot
  markerRoot
  getTerrainGroup
  getFallbackBounds
  flyTo
  onScheduleGrounding
  raycaster = new THREE.Raycaster()
  textureLoader = new THREE.TextureLoader()

  /** 当前活跃的经纬度点位精灵 */
  pointSprite = null
  /** 点位精灵的纹理对象（缓存） */
  pointTexture = null
  /** 点位纹理的加载 Promise（防止重复加载） */
  pointTexturePromise = null
  /** 当前点位坐标，用于瓦片加载后重新贴地 */
  activeCoordinate = null

  /**
   * @param {Object} options
   * @param {THREE.Group} options.tilesetRoot - 所有瓦片集的根容器
   * @param {THREE.Group} options.markerRoot - 标记精灵挂载的容器
   * @param {Function} options.getTerrainGroup - 获取地形 tileset 的 group
   * @param {Function} options.getFallbackBounds - 获取场景元数据包围盒
   * @param {Function} [options.flyTo] - 飞行到目标点的回调
   * @param {Function} [options.onScheduleGrounding] - 延迟重新贴地的回调
   */
  constructor(options) {
    this.tilesetRoot = options.tilesetRoot
    this.markerRoot = options.markerRoot
    this.getTerrainGroup = options.getTerrainGroup
    this.getFallbackBounds = options.getFallbackBounds
    this.flyTo = options.flyTo
    this.onScheduleGrounding = options.onScheduleGrounding
  }

  /**
   * 在场景中渲染一个经纬度定位点
   *
   * @param {number} longitude - 经度（-180 ~ 180）
   * @param {number} latitude - 纬度（-90 ~ 90）
   * @param {number} [height] - 椭球体高度（米）。省略时自动贴合模型表面
   * @returns {Promise<THREE.Vector3>} 最终点位在场景中的世界坐标
   */
  async render(longitude, latitude, height) {
    const terrainGroup = this.getTerrainGroup()
    if (!terrainGroup) {
      throw new Error('地形数据尚未加载，请等待场景完成初始化后再渲染点位。')
    }

    // 确保世界矩阵最新，再读取地形 group 的变换
    this.tilesetRoot.updateMatrixWorld(true)

    // 步骤 1: WGS84 → ECEF → 场景坐标
    const { approximatePosition, worldUp } = this.getApproximateScenePoint(
      longitude,
      latitude,
      height,
      terrainGroup,
    )

    const markerScale = this.getMarkerScale()

    // 步骤 2: 确定最终点位坐标
    const pointPosition =
      height === undefined
        ? this.resolveGroundedPosition(
            approximatePosition,
            markerScale,
            worldUp,
            terrainGroup,
          ) ?? approximatePosition.clone()
        : approximatePosition.clone()

    const pointTexture = await this.ensurePointTexture()

    // 步骤 3: 创建标记精灵
    const pointMaterial = new THREE.SpriteMaterial({
      map: pointTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })

    // 先清除上一个点位
    this.clear()

    const pointSprite = new THREE.Sprite(pointMaterial)
    pointSprite.name = 'lon-lat-point'
    pointSprite.center.set(0.5, 0.08)
    pointSprite.scale.set(markerScale, markerScale, 1)
    pointSprite.position.copy(pointPosition)
    pointSprite.renderOrder = 8
    pointSprite.layers.enable(1)

    this.markerRoot.add(pointSprite)
    this.pointSprite = pointSprite
    this.activeCoordinate = { longitude, latitude, height }

    return pointPosition.clone()
  }

  /**
   * 渲染经纬度定位点并飞行到该点
   *
   * @param {number} longitude
   * @param {number} latitude
   * @param {number} [height]
   */
  async renderLonLatPoint(longitude, latitude, height) {
    const pointPosition = await this.render(longitude, latitude, height)
    this.flyTo?.(pointPosition)
    this.onScheduleGrounding?.(1000)
  }

  /** 清除当前显示的经纬度点位精灵 */
  clear() {
    if (!this.pointSprite) {
      return
    }

    this.markerRoot.remove(this.pointSprite)
    this.pointSprite.material.dispose()
    this.pointSprite = null
    this.activeCoordinate = null
  }

  /** 释放点位精灵及其纹理资源 */
  dispose() {
    this.clear()

    if (this.pointTexture) {
      this.pointTexture.dispose()
      this.pointTexture = null
      this.pointTexturePromise = null
    }
  }

  /** 使用当前已加载的地形重新贴地点位。 */
  refreshGrounding() {
    const sprite = this.pointSprite
    const coordinate = this.activeCoordinate
    const terrainGroup = this.getTerrainGroup()

    if (!sprite || !coordinate || coordinate.height !== undefined || !terrainGroup) {
      return
    }

    this.tilesetRoot.updateMatrixWorld(true)
    const { approximatePosition, worldUp } = this.getApproximateScenePoint(
      coordinate.longitude,
      coordinate.latitude,
      undefined,
      terrainGroup,
    )
    const groundedPosition = this.resolveGroundedPosition(
      approximatePosition,
      this.getMarkerScale(),
      worldUp,
      terrainGroup,
    )

    if (groundedPosition) {
      sprite.position.copy(groundedPosition)
    }
  }

  /** 计算经纬度对应的 ECEF → 场景位置和局部向上方向。 */
  getApproximateScenePoint(longitude, latitude, height, terrainGroup) {
    const ecef = lonLatHeightToEcef(longitude, latitude, height ?? 0)
    const ecefToSceneMatrix = terrainGroup.matrixWorld
    const approximatePosition = ecefToScenePosition(ecef, {
      matrix: ecefToSceneMatrix,
      inverseMatrix: ecefToSceneMatrix.clone().invert(),
    })
    const worldUp = ecefDirectionToScene(
      lonLatToEcefUp(longitude, latitude),
      ecefToSceneMatrix,
    )

    return { approximatePosition, worldUp }
  }

  /**
   * 计算经纬度标记精灵的世界空间缩放比例
   * @returns {number}
   */
  getMarkerScale() {
    const scaleHint = this.getSceneScaleHint() * 0.02
    return THREE.MathUtils.clamp(scaleHint, 80, 360)
  }

  /**
   * 通过射线检测将近似位置修正到 3DTiles 模型/地形表面（自动贴地）
   *
   * @param {THREE.Vector3} approximatePosition
   * @param {number} markerScale
   * @param {THREE.Vector3} worldUp
   * @param {THREE.Group} terrainGroup
   * @returns {THREE.Vector3|null}
   */
  resolveGroundedPosition(approximatePosition, markerScale, worldUp, terrainGroup) {
    this.tilesetRoot.updateMatrixWorld(true)

    const terrainBounds = new THREE.Box3().setFromObject(terrainGroup)
    const terrainCenter = terrainBounds.getCenter(new THREE.Vector3())
    const terrainHalfSize = terrainBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    const terrainMaxProjection = terrainCenter.dot(worldUp) +
      Math.abs(terrainHalfSize.x * worldUp.x) +
      Math.abs(terrainHalfSize.y * worldUp.y) +
      Math.abs(terrainHalfSize.z * worldUp.z)
    const pointProjection = approximatePosition.dot(worldUp)
    const boundsClearance = terrainBounds.isEmpty()
      ? 0
      : Math.max(0, terrainMaxProjection - pointProjection)
    const rayHeight = Math.max(
      boundsClearance + markerScale * 20,
      this.getSceneScaleHint() * 1.5,
      5000,
    )
    const rayOrigin = approximatePosition.clone().addScaledVector(worldUp, rayHeight)
    const rayDirection = worldUp.clone().negate()

    this.raycaster.set(rayOrigin, rayDirection)
    this.raycaster.near = 0
    this.raycaster.far = rayHeight + Math.max(this.getSceneScaleHint(), 5000)

    const intersections = this.raycaster.intersectObject(terrainGroup, true)
    const hit = intersections[0]

    if (!hit) {
      return null
    }

    return hit.point.clone().addScaledVector(worldUp, markerScale * 0.12)
  }

  /** 估算当前场景的尺度 */
  getSceneScaleHint() {
    const sceneBox = new THREE.Box3().setFromObject(this.tilesetRoot)
    const targetBox = sceneBox.isEmpty() ? this.getFallbackBounds() : sceneBox

    if (targetBox.isEmpty()) {
      return 1000
    }

    const size = targetBox.getSize(new THREE.Vector3())
    return Math.max(size.x, size.y, size.z, 1000)
  }

  /** 确保点位纹理已加载（懒加载 + 缓存） */
  async ensurePointTexture() {
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
