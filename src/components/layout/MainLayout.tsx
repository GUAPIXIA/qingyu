import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { LocalModelTaskCenter } from './LocalModelTaskCenter'
import { LocalModelUpdateAgent } from './LocalModelUpdateAgent'

export function MainLayout() {
  const { pathname } = useLocation()

  return (
    <div className="flex h-screen bg-tavern-bg text-tavern-text">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div key={pathname} className={`${pathname === '/characters' ? '' : 'route-enter'} flex-1 min-h-0 flex flex-col overflow-hidden`}>
          <Outlet />
        </div>
      </main>
      <LocalModelUpdateAgent />
      <LocalModelTaskCenter />
    </div>
  )
}
