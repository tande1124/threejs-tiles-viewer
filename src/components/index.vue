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
      <el-divider style="margin: 10px 0" />
      <div class="layer-row">
        <span class="layer-name">双透视渲染</span>
        <el-switch
          :model-value="dualPass"
          size="small"
          @update:model-value="handleDualPassToggle"
        />
      </div>
    </el-card>

    <!-- 点位定位浮动按钮 -->
    <button
      class="fab-btn"
      :class="{ active: showPointForm }"
      title="经纬度定位"
      @click="showPointForm = !showPointForm"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/>
      </svg>
    </button>

    <!-- 点位定位弹窗（点击按钮切换显隐，带滑入动画） -->
    <Transition name="slide-panel">
      <PointLocatorForm
        v-if="showPointForm"
        :renderer="controller?.getPointMarkerRenderer() ?? null"
      />
    </Transition>

    <DetailPop
      :info="pickInfo"
      :geo-params="defaultGltfGeo"
      @close="closePick"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import { TilesViewerController } from '@/utils/TilesViewerController'
import { getDefaultSceneConfig } from '@/utils/common/tileset'
import { MaterialConfigurator } from '@/utils/common/material'
import type { GltfPickInfo } from '@/utils/GltfModelLoader'
import PointLocatorForm from '@/components/PointLocatorForm.vue'
import DetailPop from '@/components/DetailPop.vue'

/** GLB 地理配准参数结构（来自 public/config/config.js） */
interface GltfGeoConfig {
  centralMeridianDeg: number
  offsetX: number
  offsetY: number
  offsetZ: number
  verticalScale: number
}

declare global {
  interface Window {
    __GLTF_GEO_CONFIG__?: GltfGeoConfig
  }
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
      /** 点位定位表单是否展开 */
      showPointForm: false,
      /** 点击 GLB 部件拾取的详情（null 表示未选中/弹窗关闭） */
      pickInfo: null as GltfPickInfo | null,
      /** 3D Tiles 图层列表（含显隐状态） */
      layers: [] as LayerItem[],
      /** 双相机透视渲染开关 */
      dualPass: true,
    }
  },
  computed: {
    /** 当前 GLB 模型的地理配准参数（来自 public/config/config.js） */
    defaultGltfGeo(): GltfGeoConfig | undefined {
      return window.__GLTF_GEO_CONFIG__
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
          onGltfPick: this.handleGltfPick,
        }),
      )
      await this.controller.mount(viewerRoot)

      // 加载 3D Tiles 地形（无数据源或加载失败时跳过，不影响 GLB 加载）
      const hasTiles = this.defaultSceneConfig.sources.some((s) => s.url)
      if (hasTiles) {
        try {
          await this.loadDefaultScene()
        } catch (error) {
          console.warn('默认 3DTiles 场景加载失败，将仅加载 GLB 模型。', error)
        }
      }
      this.refreshLayers()

      // 加载 GLB 模型（无 3D Tiles 时自动飞行聚焦到模型上）
      try {
        await this.loadDefaultGltf()
      } catch (error) {
        console.error('GLTF 模型加载失败。', error)
      }
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
      const loader = this.controller.getGltfModelLoader()
      const geoConfig = window.__GLTF_GEO_CONFIG__
      if (!geoConfig) {
        console.warn('[GLTF] 未找到地理配准配置 (public/config/config.js)，跳过 geo 定位。')
      }
      const model = await loader.loadGltf('./data/gltf/jfs-bim.glb', {
        geo: geoConfig,
      })

      // 材质配置：加载 material-state.json 并按 meshName 覆盖材质
      const matCfg = new MaterialConfigurator()
      const { hdrMeta, appliedCount } = await matCfg.applyFromUrl(
        './config/material-config.json',
        model,
        'test',
      )
      console.log(`[材质配置] 已应用 ${appliedCount} 个网格材质`, hdrMeta ? `| HDR: envInt=${hdrMeta.envInt}, bgInt=${hdrMeta.bgInt}, exposure=${hdrMeta.exposure}` : '')
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

    /** 切换双相机透视渲染模式 */
    handleDualPassToggle(value: string | number | boolean) {
      const enabled = Boolean(value)
      this.dualPass = enabled
      this.controller?.setDualPass(enabled)
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

/* ========== 点位定位浮动按钮 ========== */

.fab-btn {
  position: absolute;
  bottom: 28px;
  right: 28px;
  z-index: 110;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.88);
  color: #94a3b8;
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px rgba(2, 6, 23, 0.4);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.fab-btn:hover {
  color: #e2e8f0;
  background: rgba(30, 41, 59, 0.95);
  box-shadow: 0 6px 28px rgba(2, 6, 23, 0.55);
  transform: scale(1.08);
}

.fab-btn.active {
  color: #38bdf8;
  background: rgba(15, 23, 42, 0.95);
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.35), 0 6px 28px rgba(2, 6, 23, 0.55);
}

/* ========== 弹窗滑入/滑出动画 ========== */

.slide-panel-enter-active,
.slide-panel-leave-active {
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.slide-panel-enter-from,
.slide-panel-leave-to {
  transform: translateX(30px);
  opacity: 0;
}
</style>
