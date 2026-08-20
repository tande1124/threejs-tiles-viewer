<template>
  <div v-if="info" class="detail-pop">
    <div class="detail-head">
      <span class="detail-title">部件信息</span>
      <button
        class="detail-close"
        type="button"
        title="关闭"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>
    <div class="detail-body">
      <div class="detail-row">
        <span class="detail-label">部件名称</span>
        <span class="detail-value">{{ info.name }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">节点路径</span>
        <span class="detail-value detail-path">{{ info.path }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">场景坐标（米）</span>
        <span class="detail-value detail-mono">{{ fmtVec(info.worldPosition) }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">模型局部坐标（米）</span>
        <span class="detail-value detail-mono">{{ fmtVec(info.localPosition) }}</span>
      </div>
      <template v-if="pickGeo">
        <div class="detail-row">
          <span class="detail-label">CGCS2000 平面坐标</span>
          <span class="detail-value detail-mono">{{ fmtPlane(pickGeo) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">经纬度 / 高程</span>
          <span class="detail-value detail-mono">{{ fmtLonLat(pickGeo) }}</span>
        </div>
      </template>
      <div class="detail-row">
        <span class="detail-label">相机距离</span>
        <span class="detail-value detail-mono">{{ info.distance.toFixed(1) }} m</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { gaussKrugerInverse, type GeoReferenceParams } from '@/utils/geo-coordinate'
import type { GltfPickInfo } from '@/utils/GltfModelLoader'

/** 由模型局部坐标 + 配准参数换算出的地理坐标 */
interface PickGeoInfo {
  easting: number
  northing: number
  height: number
  longitude: number
  latitude: number
}

/**
 * GLB 部件信息弹窗。
 *
 * 固定显示在界面左侧的浮层（非居中模态、不跟随点击位置），
 * 纯文本展示部件位置详情，不展示模型。
 */
export default defineComponent({
  name: 'DetailPop',
  props: {
    /** 点击拾取的部件详情（null 时不显示） */
    info: {
      type: Object as () => GltfPickInfo | null,
      default: null,
    },
    /** 模型地理配准参数（用于换算 CGCS2000 平面坐标与经纬度） */
    geoParams: {
      type: Object as () => GeoReferenceParams | null,
      default: null,
    },
  },
  emits: ['close'],
  computed: {
    /** 由模型局部坐标 + 配准参数换算 CGCS2000 平面坐标与经纬度 */
    pickGeo(): PickGeoInfo | null {
      if (!this.info || !this.geoParams) return null
      const { localPosition } = this.info
      const { centralMeridianDeg, offsetX, offsetY, offsetZ, verticalScale = 1 } =
        this.geoParams
      // 约定：模型 x→东、y→高程（×verticalScale）、z→南
      const easting = offsetX + localPosition.x
      const northing = offsetY - localPosition.z
      const height = offsetZ + localPosition.y * verticalScale
      const { longitude, latitude } = gaussKrugerInverse(easting, northing, centralMeridianDeg)
      return { easting, northing, height, longitude, latitude }
    },
  },
  methods: {
    /** 三维坐标格式化 */
    fmtVec(v: { x: number; y: number; z: number }): string {
      return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`
    },

    /** CGCS2000 平面坐标格式化 */
    fmtPlane(geo: PickGeoInfo): string {
      return `东 ${geo.easting.toFixed(2)} m，北 ${geo.northing.toFixed(2)} m，高 ${geo.height.toFixed(2)} m`
    },

    /** 经纬度 / 高程格式化 */
    fmtLonLat(geo: PickGeoInfo): string {
      return `${geo.longitude.toFixed(6)}°, ${geo.latitude.toFixed(6)}°，高 ${geo.height.toFixed(2)} m`
    },
  },
})
</script>

<style scoped>
.detail-pop {
  position: absolute;
  top: 150px; /* 让出顶部区域 */
  left: 20px;
  width: 300px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 48px rgba(2, 6, 23, 0.5);
  color: #e2e8f0;
  font-size: 13px;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 0;
}

.detail-title {
  font-weight: 600;
  color: #f1f5f9;
}

.detail-close {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 6px;
}

.detail-close:hover {
  color: #f1f5f9;
  background: rgba(148, 163, 184, 0.18);
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
}

.detail-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.detail-label {
  flex: 0 0 120px;
  color: #94a3b8;
  font-size: 12px;
}

.detail-value {
  flex: 1;
  color: #e2e8f0;
  word-break: break-all;
}

.detail-path {
  font-size: 11px;
  line-height: 1.5;
}

.detail-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
</style>
