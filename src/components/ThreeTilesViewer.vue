<template>
  <div class="viewer-panel">
    <div class="viewer-stage">
      <div ref="viewerRoot" class="viewer-canvas"></div>
    </div>

    <el-card class="layer-control" shadow="always">
      <div class="layer-heading">图层控制</div>
      <div v-if="layers.length === 0" class="layer-empty">暂无图层数据</div>
      <div v-for="layer in layers" :key="layer.id" class="layer-row">
        <span class="layer-name" :title="layer.name">{{ layer.name }}</span>
        <el-switch
          :model-value="layer.visible"
          size="small"
          @update:model-value="handleLayerToggle(layer.id, $event)"
        />
      </div>
    </el-card>

    <PointLocatorForm
      :submitting="isSubmittingPoint"
      :error="pointError"
      @submit="handlePointSubmit"
      @clear="clearPoint"
    />

    <DetailPop
      :info="pickInfo"
      :geo-params="defaultGltfGeo"
      @close="closePick"
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
import type { GltfPickInfo } from '@/utils/GltfModelLoader'
import PointLocatorForm, {
  type PointSubmitPayload,
} from '@/components/PointLocatorForm.vue'
import DetailPop from '@/components/DetailPop.vue'

/**
 * jfs-bim.glb 的地理配准参数：已用「上水库库盆的实测位置
 * (113.632328°E, 35.614638°N, 1170m)」反算（对应模型中上水库库盆包围盒中心，
 * 非几何中心，坐标由现场实测提供）。
 * 每个 GLB 模型一份自己的配准参数，加载时自动定位。
 * 新模型可用控制台 __tilesViewer.calibrateFromAnchor(...) 反算。
 */
const DEFAULT_GLTF_GEO = {
  centralMeridianDeg: 114,
  offsetX: 460019.023,
  offsetY: 3939980.213,
  offsetZ: 0,  // offsetZ 每 +1 → 模型整体抬高 1 米。当前是 -49.154：
  verticalScale: 1,
}

/** 图层列表项（来自控制器 getLayerList） */
interface LayerItem {
  id: string
  name: string
  kind: string
  visible: boolean
}

export default defineComponent({
  name: 'ThreeTilesViewer',
  components: {
    PointLocatorForm,
    DetailPop,
  },
  data() {
    return {
      controller: null as TilesViewerController | null,
      defaultSceneConfig: getDefaultSceneConfig(),
      pointError: '',
      isSubmittingPoint: false,
      /** 点击 GLB 部件拾取的详情（null 表示未选中/弹窗关闭） */
      pickInfo: null as GltfPickInfo | null,
      /** 3D Tiles 图层列表（含显隐状态） */
      layers: [] as LayerItem[],
    }
  },
  computed: {
    /** 当前 GLB 模型的地理配准参数（传给详情弹窗换算经纬度） */
    defaultGltfGeo(): typeof DEFAULT_GLTF_GEO {
      return DEFAULT_GLTF_GEO
    },
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
          onGltfPick: this.handleGltfPick,
        }),
      )
      this.controller.mount(viewerRoot)

      try {
        await this.loadDefaultScene()
        this.refreshLayers()
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

    /**
     * 点击 GLB 部件：更新弹窗详情。
     * info 为 null 表示点击空白，关闭弹窗。
     */
    handleGltfPick(info: GltfPickInfo | null) {
      this.pickInfo = info ? markRaw(info) : null
      if (info) {
        console.log(
          '[GLB 拾取] 部件:', info.name,
          '| 路径:', info.path,
          '| 场景坐标:', this.fmtVec(info.worldPosition),
        )
      }
    },

    /** 关闭详情弹窗并取消部件高亮 */
    closePick() {
      this.pickInfo = null
      this.controller?.clearGltfHighlight()
    },

    async loadDefaultScene() {
      if (!this.controller) return
      await this.controller.loadScene(this.defaultSceneConfig.sources)
    },

    /** 直接加载默认 GLTF 模型到场景，并按地理配准参数自动定位 */
    async loadDefaultGltf() {
      if (!this.controller) return
      await this.controller.loadGltf('./data/gltf/jfs-bim.glb', { geo: DEFAULT_GLTF_GEO })
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

    /** 从控制器刷新图层列表（控制器是显隐状态的唯一来源） */
    refreshLayers() {
      if (!this.controller) {
        this.layers = []
        return
      }
      this.layers = this.controller.getLayerList()
    },

    /** 切换图层显隐 */
    handleLayerToggle(id: string, value: string | number | boolean) {
      const visible = Boolean(value)
      this.controller?.setLayerVisible(id, visible)
      this.refreshLayers()
    },

    /** 三维坐标格式化（控制台调试用） */
    fmtVec(v: { x: number; y: number; z: number }): string {
      return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`
    },
  },
})
</script>

<style scoped>
.layer-heading {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 10px;
}

.layer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}

.layer-name {
  color: #cbd5e1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-empty {
  color: #64748b;
  font-size: 12px;
  padding: 4px 0;
}
</style>
