<template>
  <div class="viewer-panel">
    <div class="viewer-stage">
      <div ref="viewerRoot" class="viewer-canvas"></div>
    </div>

    <PointLocatorForm
      :submitting="isSubmittingPoint"
      :error="pointError"
      @submit="handlePointSubmit"
      @clear="clearPoint"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import {
  TilesViewerController,
  type ViewerStatus,
} from '@/utils/TilesViewerController'
import { getDefaultSceneConfig } from '@/utils/tileset'
import PointLocatorForm, {
  type PointSubmitPayload,
} from '@/components/PointLocatorForm.vue'

/**
 * 建模初期提供的 CGCS2000（EPSG:4490）偏移参数：GLB 局部坐标 + 偏移 = 真实平面坐标。
 * offsetX 为东偏移、offsetY 为北偏移、offsetZ 为高程偏移（单位：米）。
 */
const DEFAULT_GLTF_GEO_OFFSET = {
  offsetX: 466748.787,
  offsetY: 3942467.775,
  offsetZ: 1500,
  /** 高斯-克吕格中央子午线经度（度），3° 带常用 114；若偏差较大请核对实际带号 */
  centralMeridianDeg: 114,
}

/**
 * GLB 相对场景的手动校准偏移（场景单位，米）。
 * 若坐标转换后仍有偏差，在这里按实际看到的方向微调：
 * 例如模型偏东 +200 米 → 把 [0,0,0] 改成 [200,0,0]。
 * 提示：也可在页面里用快捷键实时校准（A/D/W/S/R/F 平移、Q/E 绕 Y 旋转，
 * 按住 Shift 步长 ×10），控制台会打印可直接填入这里的数值。
 */
const DEFAULT_GLTF_OFFSET: [number, number, number] = [0, 0, 0]

/** GLB 手动旋转（度，欧拉角 [rx, ry, rz]，绕模型中心），用于校正朝向偏差 */
const DEFAULT_GLTF_ROTATION: [number, number, number] = [0, 0, 0]

export default defineComponent({
  name: 'ThreeTilesViewer',
  components: {
    PointLocatorForm,
  },
  data() {
    return {
      controller: null as TilesViewerController | null,
      defaultSceneConfig: getDefaultSceneConfig(),
      pointError: '',
      isSubmittingPoint: false,
    }
  },
  async mounted() {
    await this.bootstrap()
  },
  beforeUnmount() {
    this.controller?.destroy()
    this.controller = null
  },
  methods: {
    /** 初始化 Three.js 场景并加载默认地形与模型 */
    async bootstrap() {
      const viewerRoot = this.$refs.viewerRoot as HTMLElement | undefined

      if (!viewerRoot) {
        return
      }

      this.controller = markRaw(
        new TilesViewerController({
          onStatusChange: this.handleStatusChange,
        }),
      )
      this.controller.mount(viewerRoot)
      this.controller.enableGltfCalibration()

      try {
        await this.loadDefaultScene()
      } catch (error) {
        console.error('默认 3DTiles 场景加载失败。', error)
      }

      try {
        await this.loadDefaultGltf()
      } catch (error) {
        console.error('GLTF 模型加载失败。', error)
      }
    },

    handleStatusChange(status: ViewerStatus) {
      if (status.state !== 'error') {
        return
      }
      console.error('3DTiles 资源加载失败。', status.error || status.message)
    },

    async loadDefaultScene() {
      if (!this.controller) return
      await this.controller.loadScene(this.defaultSceneConfig.sources)
    },

    /** 直接加载默认 GLTF 模型到场景，并按 CGCS2000 偏移参数定位 */
    async loadDefaultGltf() {
      if (!this.controller) return
      await this.controller.loadGltf('./data/gltf/jfs-bim.glb', {
        geoOffset: DEFAULT_GLTF_GEO_OFFSET,
        rotation: DEFAULT_GLTF_ROTATION,
        offset: DEFAULT_GLTF_OFFSET,
      })
    },

    /** 处理表单提交的经纬度，渲染点位并自动飞行定位 */
    async handlePointSubmit(payload: PointSubmitPayload) {
      if (!this.controller) {
        this.pointError = '场景控制器尚未初始化。'
        return
      }

      this.pointError = ''
      this.isSubmittingPoint = true

      try {
        await this.controller.renderLonLatPoint(
          payload.longitude,
          payload.latitude,
          payload.height,
        )
      } catch (error) {
        this.pointError =
          error instanceof Error ? error.message : '点位渲染失败，请稍后重试。'
      } finally {
        this.isSubmittingPoint = false
      }
    },

    clearPoint() {
      this.pointError = ''
      this.controller?.clearLonLatPoint()
    },
  },
})
</script>
