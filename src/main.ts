/**
 * 应用入口文件
 * 创建 Vue 应用实例并挂载到 #app DOM 节点
 */

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import './style.css'

const app = createApp(App)

// 全局注册 Element Plus UI 组件库
app.use(ElementPlus)

// 挂载根组件到页面 #app 元素
app.mount('#app')
