import { useEffect, useState } from 'react'
import { TopBar } from '../components/TopBar.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { BoardCanvas } from '../components/BoardCanvas.tsx'
import { Inspector } from '../components/Inspector.tsx'
import { StatusBar } from '../components/StatusBar.tsx'
import { StoryPanel } from '../components/StoryPanel.tsx'
import { useSpatialStore } from '../store/spatialStore.ts'

type RightPanel = 'inspector' | 'story' | null

export function App() {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  const selection = useSpatialStore((s) => s.selection)
  const select = useSpatialStore((s) => s.select)
  const [actorTrayOpen, setActorTrayOpen] = useState(false)
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)

  // 选中对象时才展开属性；清空选中后自动还给画布空间。
  useEffect(() => {
    if (selection.type !== 'none') {
      setRightPanel('inspector')
      return
    }
    setRightPanel((panel) => (panel === 'inspector' ? null : panel))
  }, [selection.id, selection.type])

  return (
    <div className={`app-shell${embedded ? ' embedded' : ''}`}>
      <TopBar />
      <div
        className={`app-main ${rightPanel ? '' : 'right-panel-collapsed'}`}
      >
        <BoardCanvas />
        <Toolbar
          actorTrayOpen={actorTrayOpen}
          onToggleActorTray={() => setActorTrayOpen((open) => !open)}
          onCloseActorTray={() => setActorTrayOpen(false)}
          storyOpen={rightPanel === 'story'}
          onToggleStory={() => embedded ? window.parent.postMessage({ type: 'qingyu:spatial:assistant' }, '*') : setRightPanel((panel) => (panel === 'story' ? null : 'story'))}
        />
        {rightPanel ? (
          <div className="panel-wrap">
            <button
              type="button"
              className="panel-close"
              aria-label={rightPanel === 'story' ? '关闭剧情面板' : '关闭属性面板'}
              onClick={() => {
                if (rightPanel === 'inspector') select({ type: 'none', id: null })
                setRightPanel(null)
              }}
            >×</button>
            {rightPanel === 'story' ? <StoryPanel /> : <Inspector />}
          </div>
        ) : null}
      </div>
      <StatusBar />
    </div>
  )
}
