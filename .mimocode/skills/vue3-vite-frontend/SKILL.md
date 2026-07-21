---
name: vue3-vite-frontend
description: Vue 3 + Vite 前端项目开发工作流。适用于 Vue 3 Composition API + Vite 构建的前端项目，包含组件开发、路由配置、状态管理、API 调用等常见模式。
---

# Vue 3 + Vite 前端开发

## 适用场景

当用户需要开发或维护基于以下技术栈的前端项目时使用：
- **框架**: Vue 3 (Composition API, `<script setup>`)
- **构建工具**: Vite 5/6
- **路由**: Vue Router 4
- **状态管理**: Pinia / Vuex 4/5
- **UI 库**: Element Plus, Ant Design Vue, Vant
- **HTTP 客户端**: Axios
- **CSS**: TailwindCSS, SCSS, CSS Modules

## 典型项目结构

```
project/
├── src/
│   ├── api/              # API 接口定义
│   ├── assets/           # 静态资源
│   ├── components/       # 公共组件
│   │   ├── common/       # 通用组件
│   │   └── layout/       # 布局组件
│   ├── composables/      # 组合式函数
│   ├── pages/            # 页面组件
│   ├── router/           # 路由配置
│   ├── stores/           # 状态管理
│   ├── styles/           # 全局样式
│   ├── utils/            # 工具函数
│   ├── App.vue           # 根组件
│   └── main.ts           # 入口文件
├── public/               # 公共静态资源
├── index.html            # HTML 模板
├── vite.config.ts        # Vite 配置
├── tsconfig.json         # TypeScript 配置
└── package.json          # 项目配置
```

## 开发工作流

### 1. 项目初始化

```bash
# 创建项目
npm create vite@latest my-vue-app -- --template vue-ts

# 安装依赖
cd my-vue-app
npm install

# 添加常用依赖
npm install vue-router@4 pinia axios element-plus
npm install -D tailwindcss postcss autoprefixer
```

### 2. Vite 配置

**vite.config.ts 常见配置:**
```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})
```

### 3. 组件开发模式

**Composition API 组件:**
```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

// Props
const props = defineProps<{
  title: string
  items?: string[]
}>()

// Emits
const emit = defineEmits<{
  (e: 'update', value: string): void
}>()

// 状态
const count = ref(0)
const doubleCount = computed(() => count.value * 2)

// 方法
function increment() {
  count.value++
  emit('update', count.value.toString())
}

// 生命周期
onMounted(() => {
  console.log('Component mounted')
})
</script>

<template>
  <div>
    <h1>{{ title }}</h1>
    <p>Count: {{ count }}, Double: {{ doubleCount }}</p>
    <button @click="increment">Increment</button>
  </div>
</template>
```

### 4. 路由配置

**router/index.ts:**
```typescript
import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        name: 'Home',
        component: () => import('@/pages/Home.vue')
      },
      {
        path: 'about',
        name: 'About',
        component: () => import('@/pages/About.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
```

### 5. 状态管理 (Pinia)

**stores/counter.ts:**
```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const doubleCount = computed(() => count.value * 2)
  
  function increment() {
    count.value++
  }
  
  return { count, doubleCount, increment }
})
```

### 6. API 调用

**api/request.ts:**
```typescript
import axios from 'axios'

const request = axios.create({
  baseURL: '/api',
  timeout: 10000
})

// 请求拦截器
request.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器
request.interceptors.response.use(
  response => response.data,
  error => {
    console.error('API Error:', error)
    return Promise.reject(error)
  }
)

export default request
```

**api/user.ts:**
```typescript
import request from './request'

export function getUserList(params: any) {
  return request.get('/user/list', { params })
}

export function getUserById(id: number) {
  return request.get(`/user/${id}`)
}
```

### 7. 组合式函数 (Composables)

**composables/useFetch.ts:**
```typescript
import { ref, watchEffect } from 'vue'

export function useFetch(url: string) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(true)

  watchEffect(async () => {
    loading.value = true
    try {
      const response = await fetch(url)
      data.value = await response.json()
    } catch (e) {
      error.value = e
    } finally {
      loading.value = false
    }
  })

  return { data, error, loading }
}
```

## 常见问题排查

### 1. 路由不生效
- 检查 `main.ts` 是否正确注册路由: `app.use(router)`
- 检查 `<router-view>` 是否在 `App.vue` 中
- 检查路由配置的 `path` 是否正确

### 2. 组件不渲染
- 检查组件是否正确导入和注册
- 检查模板语法是否正确
- 检查是否有控制台错误

### 3. API 调用失败
- 检查 Vite 代理配置
- 检查 API 路径是否正确
- 检查 CORS 配置

### 4. 样式不生效
- 检查 CSS 选择器优先级
- 检查是否使用了 `scoped`
- 检查 TailwindCSS 配置

## 快速定位文件

```bash
# 查找页面组件
find src -name "*.vue" -path "*/pages/*"

# 查找 API 文件
find src -name "*.ts" -path "*/api/*"

# 查找状态管理文件
find src -name "*.ts" -path "*/stores/*"
```

## 构建和部署

```bash
# 开发环境
npm run dev

# 构建生产版本
npm run build

# 预览生产版本
npm run preview

# 类型检查
npm run type-check

# 代码检查
npm run lint
```
