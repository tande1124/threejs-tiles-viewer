import * as THREE from 'three'

// ========== WGS84 椭球体常量 ==========

/** WGS84 椭球体长半轴（赤道半径），单位：米 */
const WGS84_A = 6378137.0
/** WGS84 椭球体扁率 */
const WGS84_F = 1 / 298.257223563
/** WGS84 第一偏心率平方 e² = f × (2 - f) */
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

// ========== 场景变换参考 ==========

/**
 * 根据 tileset.json 的 root.transform 矩阵创建场景变换参考对象
 *
 * 3D Tiles 的 root.transform 是一个 4×4 矩阵，定义了从瓦片局部空间到
 * ECEF 坐标系的变换。因此需要使用它的逆矩阵完成 ECEF → 场景局部坐标转换。
 *
 * @param {number[]} [transform] - tileset.json 中 root.transform 的 16 个元素数组（列主序）
 * @returns {{ matrix: THREE.Matrix4, inverseMatrix: THREE.Matrix4 }}
 */
export function createSceneTransformReference(transform) {
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
 * @param {number} longitude - 经度（度）
 * @param {number} latitude - 纬度（度）
 * @param {number} [height=0] - 椭球体高度（米）
 * @returns {THREE.Vector3} ECEF 坐标向量，单位：米
 */
export function lonLatHeightToEcef(longitude, latitude, height = 0) {
  const longitudeRad = THREE.MathUtils.degToRad(longitude)
  const latitudeRad = THREE.MathUtils.degToRad(latitude)
  const sinLatitude = Math.sin(latitudeRad)
  const cosLatitude = Math.cos(latitudeRad)
  const cosLongitude = Math.cos(longitudeRad)
  const sinLongitude = Math.sin(longitudeRad)

  // 卯酉圈曲率半径（prime vertical radius of curvature）
  const primeVerticalRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude)

  const x = (primeVerticalRadius + height) * cosLatitude * cosLongitude
  const y = (primeVerticalRadius + height) * cosLatitude * sinLongitude
  const z = (primeVerticalRadius * (1 - WGS84_E2) + height) * sinLatitude

  return new THREE.Vector3(x, y, z)
}

// ========== ECEF → 场景局部坐标 ==========

/**
 * 将 ECEF 坐标转换为场景局部空间坐标
 *
 * @param {THREE.Vector3} ecef - ECEF 坐标向量
 * @param {{ matrix: THREE.Matrix4 }} reference - 场景变换参考对象
 * @returns {THREE.Vector3} 场景局部空间中的坐标向量
 */
export function ecefToScenePosition(ecef, reference) {
  return ecef.clone().applyMatrix4(reference.matrix)
}

/**
 * 将 ECEF 坐标系中的方向转换到场景局部坐标系。
 *
 * @param {THREE.Vector3} direction
 * @param {THREE.Matrix4} ecefToSceneMatrix
 * @returns {THREE.Vector3}
 */
export function ecefDirectionToScene(direction, ecefToSceneMatrix) {
  return direction.clone().transformDirection(ecefToSceneMatrix)
}

/**
 * 获取 WGS84 椭球面在指定经纬度处的外法线方向（ECEF 坐标系）。
 *
 * @param {number} longitude
 * @param {number} latitude
 * @returns {THREE.Vector3}
 */
export function lonLatToEcefUp(longitude, latitude) {
  const longitudeRad = THREE.MathUtils.degToRad(longitude)
  const latitudeRad = THREE.MathUtils.degToRad(latitude)
  const cosLatitude = Math.cos(latitudeRad)

  return new THREE.Vector3(
    cosLatitude * Math.cos(longitudeRad),
    cosLatitude * Math.sin(longitudeRad),
    Math.sin(latitudeRad),
  ).normalize()
}

// ========== 经纬度 → 场景局部坐标（组合转换）==========

/**
 * 将经纬度坐标直接转换为场景局部空间坐标
 *
 * @param {{ longitude: number, latitude: number, height?: number }} coordinate
 * @param {{ matrix: THREE.Matrix4 }} reference
 * @returns {THREE.Vector3}
 */
export function lonLatToScenePosition(coordinate, reference) {
  const ecef = lonLatHeightToEcef(coordinate.longitude, coordinate.latitude, coordinate.height ?? 0)
  return ecefToScenePosition(ecef, reference)
}

// ========== CGCS2000 高斯-克吕格投影 ==========

/**
 * 高斯-克吕格投影反算：CGCS2000（GRS80 椭球）平面坐标 → 经纬度（度）。
 *
 * @param {number} easting - 东坐标（米，含 500000 假东）
 * @param {number} northing - 北坐标（米）
 * @param {number} centralMeridianDeg - 中央子午线经度（度）
 * @returns {{ longitude: number, latitude: number }}
 */
export function gaussKrugerInverse(easting, northing, centralMeridianDeg) {
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
 *
 * @param {number} longitude - 经度（度）
 * @param {number} latitude - 纬度（度）
 * @param {number} centralMeridianDeg - 中央子午线经度（度）
 * @returns {{ easting: number, northing: number }}
 */
export function gaussKrugerForward(longitude, latitude, centralMeridianDeg) {
  const a = 6378137
  const f = 1 / 298.257222101
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

// ========== 模型地理配准（georeferencing）==========

/**
 * 构建「GLB 局部坐标 → 场景局部坐标」的地理配准矩阵。
 *
 * 约定（本项目已确认）：模型 x→东、y→高程、z→南（右手系），
 * 高程轴按 verticalScale 缩放。
 *
 * @param {Object} params - 地理配准参数
 * @param {number} params.centralMeridianDeg - 高斯-克吕格中央子午线经度（度）
 * @param {number} params.offsetX - 模型原点对应的平面东坐标（米）
 * @param {number} params.offsetY - 模型原点对应的平面北坐标（米）
 * @param {number} params.offsetZ - 模型原点对应的高程（米）
 * @param {number} [params.verticalScale=1] - 模型 Y 轴单位比例
 * @param {THREE.Matrix4} ecefToScene - 场景变换矩阵（ECEF → 场景局部坐标）
 * @returns {THREE.Matrix4}
 */
export function createGeoReferenceMatrix(params, ecefToScene) {
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

  // GLB 局部 (x, y, z) → ECEF：列 = [东, 上, 南]（右手系），高程轴 × verticalScale
  const south = north.clone().negate()
  up.multiplyScalar(params.verticalScale ?? 1)
  const localToEcef = new THREE.Matrix4().makeBasis(east, up, south)
  localToEcef.setPosition(originEcef)

  return new THREE.Matrix4().multiplyMatrices(ecefToScene, localToEcef)
}

/**
 * 用一个已知公共点自动反算地理配准参数。
 *
 * @param {{ x: number, y: number, z: number }} local - 已知构件在模型里的局部坐标
 * @param {{ longitude: number, latitude: number, height: number }} real - 真实经纬度 + 高程
 * @param {number} centralMeridianDeg - 高斯-克吕格中央子午线（度）
 * @param {number} [verticalScale=1] - 模型高程轴比例
 * @returns {Object} 可直接用于 createGeoReferenceMatrix 的配准参数
 */
export function calibrateGeoReferenceFromAnchor(
  local,
  real,
  centralMeridianDeg,
  verticalScale = 1,
) {
  const { easting, northing } = gaussKrugerForward(
    real.longitude,
    real.latitude,
    centralMeridianDeg,
  )
  return {
    centralMeridianDeg,
    offsetX: easting - local.x,
    // 约定 z→南：N = offsetY - z → offsetY = N + z
    offsetY: northing + local.z,
    offsetZ: real.height - local.y * verticalScale,
    verticalScale,
  }
}
