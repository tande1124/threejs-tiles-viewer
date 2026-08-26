<template>
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
        v-if="validationError"
        :title="validationError"
        type="error"
        show-icon
        :closable="false"
      />

      <div class="tool-actions">
        <el-button
          type="primary"
          size="large"
          :loading="submitting"
          @click="submitPoint"
        >
          {{ submitting ? '渲染中...' : '渲染点位' }}
        </el-button>
        <el-button size="large" @click="clearPoint">
          清除点位
        </el-button>
      </div>
    </el-form>
  </el-card>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { PointMarkerRenderer } from '@/utils/PointMarkerRenderer'

export default defineComponent({
  name: 'PointLocatorForm',
  props: {
    /** 经纬度点位渲染器实例，由父组件通过 controller.getPointMarkerRenderer() 传入 */
    renderer: {
      type: Object as PropType<PointMarkerRenderer | null>,
      default: null,
    },
  },
  data() {
    return {
      longitudeInput: '113.63908',
      latitudeInput: '35.611931',
      heightInput: '1505.4',
      validationError: '',
      submitting: false,
    }
  },
  methods: {
    /** 校验输入并直接调用 PointMarkerRenderer 渲染点位、飞行定位 */
    async submitPoint(): Promise<void> {
      const longitude = Number(this.longitudeInput)
      const latitude = Number(this.latitudeInput)
      const heightRaw = this.heightInput.trim()
      const hasHeight = heightRaw !== ''
      const height = hasHeight ? Number(heightRaw) : undefined

      if (!this.longitudeInput || !this.latitudeInput) {
        this.validationError = '请先输入经度和纬度。'
        return
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        this.validationError = '经度必须是 -180 到 180 之间的有效数值。'
        return
      }
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        this.validationError = '纬度必须是 -90 到 90 之间的有效数值。'
        return
      }
      if (hasHeight && !Number.isFinite(height)) {
        this.validationError = '高程必须是有效数值，也可以留空自动贴合模型表面。'
        return
      }

      if (!this.renderer) {
        this.validationError = '场景控制器尚未初始化。'
        return
      }

      this.validationError = ''
      this.submitting = true

      try {
        await this.renderer.renderLonLatPoint(longitude, latitude, height)
      } catch (error) {
        this.validationError =
          error instanceof Error ? error.message : '点位渲染失败，请稍后重试。'
      } finally {
        this.submitting = false
      }
    },

    /** 清除当前点位 */
    clearPoint(): void {
      this.validationError = ''
      this.renderer?.clear()
    },
  },
})
</script>
