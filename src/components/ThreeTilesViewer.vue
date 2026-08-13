<template>
  <div class="viewer-panel">
    <div class="viewer-stage">
      <div ref="viewerRoot" class="viewer-canvas"></div>
    </div>

    <el-card class="tool-dialog" shadow="always">
      <el-form
        class="tool-form"
        label-position="top"
        @submit.prevent="submitPoint"
      >
        <el-form-item label="经度（Longitude）">
          <el-input
            v-model="longitudeInput"
            size="large"
          />
        </el-form-item>

        <el-form-item label="纬度（Latitude）">
          <el-input
            v-model="latitudeInput"
            size="large"
          />
        </el-form-item>

        <el-form-item label="高程（Height / 米，可选）">
          <el-input
            v-model="heightInput"
            size="large"
          />
        </el-form-item>

        <el-alert
          v-if="formError"
          :title="formError"
          type="error"
          show-icon
          :closable="false"
        />

        <div class="tool-actions">
          <el-button
            type="primary"
            size="large"
            :loading="isSubmittingPoint"
            @click="submitPoint"
          >
            {{ isSubmittingPoint ? '渲染中...' : '渲染点位' }}
          </el-button>
          <el-button size="large" @click="clearPoint">
            清除点位
          </el-button>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import {
  TilesViewerController,
  type ViewerStatus,
} from '@/utils/TilesViewerController'
import { getDefaultSceneConfig } from '@/utils/tileset'

export default defineComponent({
  name: 'ThreeTilesViewer',
  data() {
    return {
      controller: null as TilesViewerController | null,
      defaultSceneConfig: getDefaultSceneConfig(),
      longitudeInput: '98.348344',
      latitudeInput: '29.65326',
      heightInput: '2740',
      formError: '',
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

    /** 提交经纬度，转换为场景坐标并渲染点位精灵 */
    async submitPoint() {
      if (!this.controller) {
        this.formError = '场景控制器尚未初始化。'
        return
      }

      const longitude = Number(this.longitudeInput)
      const latitude = Number(this.latitudeInput)
      // 高程留空时传 undefined，由控制器自动贴合到模型表面
      const heightRaw = this.heightInput.trim()
      const hasHeight = heightRaw !== ''
      const height = hasHeight ? Number(heightRaw) : undefined

      if (!this.longitudeInput || !this.latitudeInput) {
        this.formError = '请先输入经度和纬度。'
        return
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        this.formError = '经度必须是 -180 到 180 之间的有效数值。'
        return
      }
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        this.formError = '纬度必须是 -90 到 90 之间的有效数值。'
        return
      }
      if (hasHeight && !Number.isFinite(height)) {
        this.formError = '高程必须是有效数值，也可以留空自动贴合模型表面。'
        return
      }

      this.formError = ''
      this.isSubmittingPoint = true

      try {
        await this.controller.renderLonLatPoint(longitude, latitude, height)
      } catch (error) {
        this.formError = error instanceof Error ? error.message : '点位渲染失败，请稍后重试。'
      } finally {
        this.isSubmittingPoint = false
      }
    },

    clearPoint() {
      this.formError = ''
      this.controller?.clearLonLatPoint()
    },
  },
})
</script>