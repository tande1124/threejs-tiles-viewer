<template>
  <main class="app-shell">
    <ThreeTilesViewer />
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import ThreeTilesViewer from '@/components/ThreeTilesViewer.vue'

export default defineComponent({
  name: 'App',
  components: {
    ThreeTilesViewer,
  },
})
</script>
