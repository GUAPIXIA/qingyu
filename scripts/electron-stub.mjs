/**
 * electron ESM 桩注册入口。
 * 用法：pnpm exec tsx --import ./scripts/electron-stub.mjs <script>
 */
import { register } from 'node:module'

register(new URL('./electron-stub-loader.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
})
