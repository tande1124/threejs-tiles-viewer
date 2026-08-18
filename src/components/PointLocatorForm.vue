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
        v-if="displayedError"
        :title="displayedError"
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
import { defineComponent } from 'vue'

/** 表单提交的经纬度点位数据 */
export interface PointSubmitPayload {
  longitude: number
  latitude: number
  height: number | undefined
}

export default defineComponent({
  name: 'PointLocatorForm',
  props: {
    /** 渲染中状态，控制按钮 loading 效果 */
    submitting: {
      type: Boolean,
      default: false,
    },
    /** 由父组件传入的外部错误信息（如控制器调用失败） */
    error: {
      type: String,
      default: '',
    },
  },
  emits: ['submit', 'clear'],
  data() {
    return {
      longitudeInput: '113.63908',
      latitudeInput: '35.611931',
      heightInput: '1505.4',
      validationError: '',
    }
  },
  computed: {
    /** 优先展示本地校验错误，其次展示父组件传入的错误 */
    displayedError(): string {
      return this.validationError || this.error
    },
  },
  methods: {
    /** 校验并提交经纬度，通过 submit 事件向父组件抛送合法数据 */
    submitPoint(): void {
      const longitude = Number(this.longitudeInput)
      const latitude = Number(this.latitudeInput)
      // 高程留空时传 undefined，由控制器自动贴合到模型表面
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

      this.validationError = ''
      this.$emit('submit', { longitude, latitude, height } satisfies PointSubmitPayload)
    },

    /** 清除点位，通过 clear 事件通知父组件 */
    clearPoint(): void {
      this.validationError = ''
      this.$emit('clear')
    },
  },
})
</script>
