import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { LocalModelTaskCenter } from './LocalModelTaskCenter'
import { LocalModelUpdateAgent } from './LocalModelUpdateAgent'
import { ToastHost } from '../common/ToastHost'
import { ConfirmHost } from '../common/ConfirmHost'

export function MainLayout() {
  const { pathname } = useLocation()
  // UEX-P2-12（最小修）：key 按「页面族」稳定——同族路由（如 chat 详情）切换不再整棵重挂载丢滚动；
  // 跨页面族仍换 key 以保留 route-enter 入场动画。会话级滚动恢复由 utils/scrollMemory（UEX-P2-12）负责。
  const routeFamily = pathname.split('/')[1] ?? ''

  return (
    <div className="flex h-screen bg-tavern-bg text-tavern-text">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div key={routeFamily} className={`${pathname === '/characters' ? '' : 'route-enter'} flex-1 min-h-0 flex flex-col overflow-hidden`}>
          <Outlet />
        </div>
      </main>
      <LocalModelUpdateAgent />
      <LocalModelTaskCenter />
      <ToastHost />
      {/* UEX-P1-04：全局确认宿主（与 ToastHost 同级，Modal 层级） */}
      <ConfirmHost />
    </div>
  )
}
