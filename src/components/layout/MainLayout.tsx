import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { LocalModelTaskCenter } from './LocalModelTaskCenter'
import { LocalModelUpdateAgent } from './LocalModelUpdateAgent'

export function MainLayout() {
  return (
    <div className="flex h-screen bg-tavern-bg text-tavern-text">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </main>
      <LocalModelUpdateAgent />
      <LocalModelTaskCenter />
    </div>
  )
}
