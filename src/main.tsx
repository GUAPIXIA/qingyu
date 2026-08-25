import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { installPreviewMock } from './lib/preview'

// E-01：Vite 纯前端预览（无 Electron preload）时注入 mock，避免直接进错误页
installPreviewMock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
)
