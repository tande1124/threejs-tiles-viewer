import * as THREE from 'three'

// ========== WGS84 椭球体常量 ==========

/** WGS84 椭球体长半轴（赤道半径），单位：米 */
const WGS84_A = 6378137.0
/** WGS84 椭球体扁率 */
const WGS84_F = 1 / 298.257223563
/** WGS84 第一偏心率平方 e² = f × (2 - f) */
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

// ========== 坐标转换相关接口 ==========

/**
 * 场景变换参考对象
 * 用于在 ECEF（地心地固坐标系）与场景局部坐标系之间做转换
 */
export interface SceneTransformReference {
  /** ECEF → 场景局部空间的变换矩阵（通常来自地形 tileset 的 root.transform） */
  matrix: THREE.Matrix4
  /** 场景局部空间 → ECEF 的逆变换矩阵 */
  inverseMatrix: THREE.Matrix4
}

/** 经纬度坐标描述 */
export interface LonLatCoordinate {
  /** 经度（-180 ~ 180） */
  longitude: number
  /** 纬度（-90 ~ 90） */
  latitude: number
  /** 椭球体高度（米），默认为 0（贴地表面） */
  height?: number
}

// ========== 场景变换参考 ==========

/**
 * 根据 tileset.json 的 root.transform 矩阵创建场景变换参考对象
 *
 * 3D Tiles 的 root.transform 是一个 4×4 矩阵，定义了从瓦片局部空间到
 * ECEF 坐标系的变换。此函数将其封装为矩阵 + 逆矩阵，供后续坐标转换使用。
 *
 * @param transform - tileset.json 中 root.transform 的 16 个元素数组（列主序）
 * @returns 包含正向和逆向矩阵的引用对象
 */
export function createSceneTransformReference(transform?: number[]): SceneTransformReference {
  const matrix = new THREE.Matrix4()

  if (Array.isArray(transform) && transform.length === 16) {
    matrix.fromArray(transform)
  } else {
    matrix.identity()
  }

  return {
    matrix,
    inverseMatrix: matrix.clone().invert(),
  }
}

// ========== 经纬度 → ECEF 转换 ==========

/**
 * 将经纬度（WGS84）转换为 ECEF 地心地固坐标
 *
 * ECEF（Earth-Centered, Earth-Fixed）是以地球质心为原点的笛卡尔坐标系：
 * - X 轴指向本初子午线与赤道的交点
 * - Y 轴指向东经 90° 与赤道的交点
 * - Z 轴指向北极
 *
 * 公式基于 WGS84 参考椭球体，使用卯酉圈曲率半径（prime vertical radius）
 * 来计算给定纬度处的椭球面曲率。
 *
 * @param longitude - 经度（度）
 * @param latitude - 纬度（度）
 * @param height - 椭球体高度（米），默认为 0
 * @returns ECEF 坐标向量，单位：米
 */
export function lonLatHeightToEcef(
  longitude: number,
  latitude: number,
  height = 0,
): THREE.Vector3 {
  // 将角度转换为弧度
  const longitudeRad = THREE.MathUtils.degToRad(longitude)
  const latitudeRad = THREE.MathUtils.degToRad(latitude)
  const sinLatitude = Math.sin(latitudeRad)
  const cosLatitude = Math.cos(latitudeRad)
  const cosLongitude = Math.cos(longitudeRad)
  const sinLongitude = Math.sin(longitudeRad)

  // 卯酉圈曲率半径（prime vertical radius of curvature）
  // N = a / √(1 - e²·sin²φ)
  const primeVerticalRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude)

  // ECEF 坐标计算
  // X = (N + h) · cosφ · cosλ
  const x = (primeVerticalRadius + height) * cosLatitude * cosLongitude
  // Y = (N + h) · cosφ · sinλ
  const y = (primeVerticalRadius + height) * cosLatitude * sinLongitude
  // Z = (N·(1 - e²) + h) · sinφ
  const z = (primeVerticalRadius * (1 - WGS84_E2) + height) * sinLatitude

  return new THREE.Vector3(x, y, z)
}

// ========== ECEF → 场景局部坐标 ==========

/**
 * 将 ECEF 坐标转换为场景局部空间坐标
 *
 * 通过地形变换矩阵的逆矩阵，将 ECEF 全局坐标映射到
 * 场景原点附近的局部坐标空间。
 *
 * @param ecef - ECEF 坐标向量
 * @param reference - 场景变换参考对象（来自地形基底的数据）
 * @returns 场景局部空间中的坐标向量
 */
export function ecefToScenePosition(
  ecef: THREE.Vector3,
  reference: SceneTransformReference,
): THREE.Vector3 {
  return ecef.clone().applyMatrix4(reference.inverseMatrix)
}

// ========== 经纬度 → 场景局部坐标（组合转换）==========

/**
 * 将经纬度坐标直接转换为场景局部空间坐标
 *
 * 这是经纬度点位渲染的核心转换流程：
 *   WGS84(经度, 纬度, 高度) → ECEF → 场景局部坐标
 *
 * @param coordinate - 经纬度坐标对象
 * @param reference - 场景变换参考对象
 * @returns 场景局部空间中对应的三维坐标
 */
export function lonLatToScenePosition(
  coordinate: LonLatCoordinate,
  reference: SceneTransformReference,
): THREE.Vector3 {
  const ecef = lonLatHeightToEcef(coordinate.longitude, coordinate.latitude, coordinate.height ?? 0)
  return ecefToScenePosition(ecef, reference)
}