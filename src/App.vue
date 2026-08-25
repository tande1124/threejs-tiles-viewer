<template>
  <main class="app-shell">
    <ThreeViewer />
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import ThreeViewer from '@/components/index.vue'

export default defineComponent({
  name: 'App',
  components: {
    ThreeViewer,
  },
})
</script>
