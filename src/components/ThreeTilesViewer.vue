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

      try {
        await this.loadDefaultScene()
      } catch (error) {
        console.error('默认 3DTiles 场景加载失败。', error)
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
