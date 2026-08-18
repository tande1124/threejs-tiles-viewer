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
  /** ECEF → 场景局部空间的变换矩阵 */
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
 * ECEF 坐标系的变换。因此需要使用它的逆矩阵完成 ECEF → 场景局部坐标转换。
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

  const ecefToSceneMatrix = matrix.clone().invert()

  return {
    matrix: ecefToSceneMatrix,
    inverseMatrix: matrix,
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
 * 通过 ECEF → 场景矩阵（root.transform 的逆矩阵），将 ECEF 全局坐标
 * 映射到场景原点附近的局部坐标空间。
 *
 * @param ecef - ECEF 坐标向量
 * @param reference - 场景变换参考对象（来自地形基底的数据）
 * @returns 场景局部空间中的坐标向量
 */
export function ecefToScenePosition(
  ecef: THREE.Vector3,
  reference: SceneTransformReference,
): THREE.Vector3 {
  return ecef.clone().applyMatrix4(reference.matrix)
}

/**
 * 将 ECEF 坐标系中的方向转换到场景局部坐标系。
 *
 * 与点坐标转换不同，方向向量不会应用平移，因此使用 transformDirection。
 */
export function ecefDirectionToScene(
  direction: THREE.Vector3,
  ecefToSceneMatrix: THREE.Matrix4,
): THREE.Vector3 {
  return direction.clone().transformDirection(ecefToSceneMatrix)
}

/**
 * 获取 WGS84 椭球面在指定经纬度处的外法线方向（ECEF 坐标系）。
 *
 * 该方向用于在使用 ReorientationPlugin 后计算场景中的“向上”方向，
 * 不应直接使用 ECEF 的固定坐标轴作为局部地表法线。
 */
export function lonLatToEcefUp(longitude: number, latitude: number): THREE.Vector3 {
  const longitudeRad = THREE.MathUtils.degToRad(longitude)
  const latitudeRad = THREE.MathUtils.degToRad(latitude)
  const cosLatitude = Math.cos(latitudeRad)

  return new THREE.Vector3(
    cosLatitude * Math.cos(longitudeRad),
    cosLatitude * Math.sin(longitudeRad),
    Math.sin(latitudeRad),
  ).normalize()
}

// ========== CGCS2000 高斯-克吕格投影 ==========

/**
 * 高斯-克吕格投影反算：CGCS2000（GRS80 椭球）平面坐标 → 经纬度（度）。
 *
 * 用于把建模初期提供的 CGCS2000 平面偏移参数（如 offsetX/offsetY）换算成
 * 经纬度，再交给 lonLatHeightToEcef 转 ECEF。
 *
 * @param easting - 东坐标（米，含 500000 假东）
 * @param northing - 北坐标（米）
 * @param centralMeridianDeg - 中央子午线经度（度），如 3° 带 114°E
 * @returns 经纬度（度）
 */
export function gaussKrugerInverse(
  easting: number,
  northing: number,
  centralMeridianDeg: number,
): { longitude: number; latitude: number } {
  const a = 6378137 // CGCS2000 / GRS80 长半轴
  const f = 1 / 298.257222101 // GRS80 扁率
  const e2 = f * (2 - f)
  const e4 = e2 * e2
  const e6 = e2 * e2 * e2
  const ep2 = e2 / (1 - e2)

  const x = easting - 500000 // 假东 500000
  const y = northing // 假北 0
  const k0 = 1

  // 底点纬度（footprint latitude）
  const m = y / k0
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const mu = m / (a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256))
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

  const sinPhi1 = Math.sin(phi1)
  const cosPhi1 = Math.cos(phi1)
  const tanPhi1 = Math.tan(phi1)
  const c1 = ep2 * cosPhi1 * cosPhi1
  const t1 = tanPhi1 * tanPhi1
  const n1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1)
  const r1 = (a * (1 - e2)) / (1 - e2 * sinPhi1 * sinPhi1) ** 1.5
  const d = x / (n1 * k0)

  const latitude =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720)

  const longitude =
    THREE.MathUtils.degToRad(centralMeridianDeg) +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
      cosPhi1

  return {
    longitude: THREE.MathUtils.radToDeg(longitude),
    latitude: THREE.MathUtils.radToDeg(latitude),
  }
}

/**
 * 高斯-克吕格投影正算：CGCS2000（GRS80 椭球）经纬度 → 平面坐标（含 500000 假东）。
 * 与 gaussKrugerInverse 互逆，用于把场景点击位置换算成 CGCS2000 大坐标。
 *
 * @param longitude - 经度（度）
 * @param latitude - 纬度（度）
 * @param centralMeridianDeg - 中央子午线经度（度）
 * @returns 平面坐标（米）
 */
export function gaussKrugerForward(
  longitude: number,
  latitude: number,
  centralMeridianDeg: number,
): { easting: number; northing: number } {
  const a = 6378137
  const f = 1 / 298.257222101 // CGCS2000 / GRS80
  const e2 = f * (2 - f)
  const e4 = e2 * e2
  const e6 = e2 * e2 * e2
  const ep2 = e2 / (1 - e2)

  const lon0 = THREE.MathUtils.degToRad(centralMeridianDeg)
  const lon = THREE.MathUtils.degToRad(longitude)
  const lat = THREE.MathUtils.degToRad(latitude)

  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const tanLat = Math.tan(lat)
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat)
  const t = tanLat * tanLat
  const c = ep2 * cosLat * cosLat
  const dl = lon - lon0
  const aCoeff = dl * cosLat

  // 子午线弧长
  const m =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * lat -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * lat) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * lat) -
      ((35 * e6) / 3072) * Math.sin(6 * lat))

  const easting =
    500000 +
    n *
      (aCoeff +
        ((1 - t + c) * aCoeff ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * aCoeff ** 5) / 120)
  const northing =
    m +
    n *
      tanLat *
      (aCoeff ** 2 / 2 +
        ((5 - t + 9 * c + 4 * c * c) * aCoeff ** 4) / 24 +
        ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * aCoeff ** 6) / 720)

  return { easting, northing }
}

/**
 * ECEF 地心坐标 → 经纬度 + 椭球高（CGCS2000 / GRS80）。
 * 用于把场景点击位置换算成经纬度/高程。
 */
export function ecefToLonLatHeight(ecef: THREE.Vector3): {
  longitude: number
  latitude: number
  height: number
} {
  const a = 6378137
  const f = 1 / 298.257222101
  const e2 = f * (2 - f)

  const x = ecef.x
  const y = ecef.y
  const z = ecef.z
  const p = Math.sqrt(x * x + y * y)
  const longitude = Math.atan2(y, x)

  // 迭代求地心纬度 → 大地纬度（鲍林公式）
  let lat = Math.atan2(z, p * (1 - e2))
  let height = 0
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat))
    height = p / Math.cos(lat) - n
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + height)))
  }

  return {
    longitude: THREE.MathUtils.radToDeg(longitude),
    latitude: THREE.MathUtils.radToDeg(lat),
    height,
  }
}

/** 建模初期提供的 CGCS2000（EPSG:4490）偏移参数 */
export interface GeoOffsetParams {
  /** 东偏移（米），如 466748.787 */
  offsetX: number
  /** 北偏移（米），如 3942467.775 */
  offsetY: number
  /** 高程偏移（米），如 2000 */
  offsetZ: number
  /** 高斯-克吕格中央子午线经度（度），如 114 */
  centralMeridianDeg: number
}

/**
 * 由建模偏移参数构建「GLB 局部坐标 → 场景局部坐标」矩阵。
 *
 * 算法：
 * 1. 局部原点 (0,0,0) 的真实位置 = 高斯-克吕格反算(offsetX, offsetY) 的经纬度 + offsetZ 高程；
 * 2. 以该点为原点建立 ENU 切平面，GLB 的 x→东、y→高程、z→南；
 *    （glTF 是右手系：x=东、y=上 时 z 必须朝南，否则矩阵是镜像）
 * 3. 局部 → ECEF（ENU 基向量 + 原点 ECEF），再经 ecefToScene 进入场景坐标系。
 *
 * @param params - 建模偏移参数
 * @param ecefToScene - 场景变换矩阵（ECEF → 场景局部坐标，取自地形瓦片集）
 * @returns GLB 局部坐标 → 场景局部坐标的 4×4 矩阵
 */
export function createGeoOffsetMatrix(
  params: GeoOffsetParams,
  ecefToScene: THREE.Matrix4,
): THREE.Matrix4 {
  const { longitude, latitude } = gaussKrugerInverse(
    params.offsetX,
    params.offsetY,
    params.centralMeridianDeg,
  )
  const originEcef = lonLatHeightToEcef(longitude, latitude, params.offsetZ)

  // ENU 基向量（ECEF 系）
  const lonRad = THREE.MathUtils.degToRad(longitude)
  const latRad = THREE.MathUtils.degToRad(latitude)
  const east = new THREE.Vector3(-Math.sin(lonRad), Math.cos(lonRad), 0)
  const north = new THREE.Vector3(
    -Math.sin(latRad) * Math.cos(lonRad),
    -Math.sin(latRad) * Math.sin(lonRad),
    Math.cos(latRad),
  )
  const up = new THREE.Vector3(
    Math.cos(latRad) * Math.cos(lonRad),
    Math.cos(latRad) * Math.sin(lonRad),
    Math.sin(latRad),
  )

  // GLB 局部 (x, y, z) → ECEF：列 = [东, 上, 南]（右手系，避免镜像）
  const south = north.clone().negate()
  const localToEcef = new THREE.Matrix4().makeBasis(east, up, south)
  localToEcef.setPosition(originEcef)

  return new THREE.Matrix4().multiplyMatrices(ecefToScene, localToEcef)
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