import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { startAutoSave, restoreDraft } from './persistence/autoSave.ts'
import './styles.css'
import { startEmbeddedBoard } from './embedded/bridge.ts'

async function boot() {
  if (new URLSearchParams(window.location.search).get('embedded') === '1' && window.parent !== window) {
    await startEmbeddedBoard()
  } else {
    startAutoSave()
    await restoreDraft()
  }
  const el = document.getElementById('root')
  if (!el) throw new Error('#root missing')
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
