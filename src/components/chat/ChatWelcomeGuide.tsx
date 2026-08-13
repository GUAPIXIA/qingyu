import { useNavigate } from 'react-router-dom'
import { MessageSquare, Settings as SettingsIcon } from 'lucide-react'

/** 首次使用引导（从 ChatPage 拆出）：未配置 AI 连接时的欢迎页与三步指引 */
export function ChatWelcomeGuide() {
  const navigate = useNavigate()
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-tavern-accent-soft flex items-center justify-center mb-6">
          <MessageSquare className="w-10 h-10 text-tavern-accent" />
        </div>
        <h2 className="text-xl font-display font-bold mb-2">欢迎使用轻语</h2>
        <p className="text-tavern-text-soft mb-6">
          开始你的 AI 角色扮演之旅。只需 3 步即可开启对话：
        </p>
        <div className="text-left space-y-3 mb-6">
          <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
            <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">1</span>
            <div>
              <div className="font-medium text-tavern-text">配置 AI 连接</div>
              <div className="text-sm text-tavern-text-muted">选择 AI 服务商并填入 API 密钥</div>
            </div>
          </div>
          <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
            <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">2</span>
            <div>
              <div className="font-medium text-tavern-text">选择或创建角色</div>
              <div className="text-sm text-tavern-text-muted">从角色库选择，或创建你的专属角色</div>
            </div>
          </div>
          <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
            <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">3</span>
            <div>
              <div className="font-medium text-tavern-text">开始对话</div>
              <div className="text-sm text-tavern-text-muted">输入消息，享受沉浸式角色扮演</div>
            </div>
          </div>
        </div>
        <button className="btn-primary w-full" onClick={() => navigate('/settings')}>
          <SettingsIcon className="w-4 h-4" />
          开始配置
        </button>
      </div>
    </div>
  )
}
