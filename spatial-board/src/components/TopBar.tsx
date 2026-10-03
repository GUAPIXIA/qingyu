import { useEffect, useRef, useState } from 'react'
import { useSpatialStore } from '../store/spatialStore.ts'
import { IMPORT_LIMITS } from '@qingyu/spatial-core'
import { parseImportJson } from '@qingyu/spatial-core'

export function TopBar() {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  const assistantEnabled = useSpatialStore((s) => s.assistantEnabled)
  const worldName = useSpatialStore((s) => s.core.world.name)
  const setWorldName = useSpatialStore((s) => s.setWorldName)
  const exportPackage = useSpatialStore((s) => s.exportPackage)
  const importPackage = useSpatialStore((s) => s.importPackage)
  const newWorld = useSpatialStore((s) => s.newWorld)
  const [menuOpen, setMenuOpen] = useState(false)
  const [featurePending, setFeaturePending] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!embedded) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const sameOrigin = window.location.protocol === 'file:'
        ? event.origin === 'null' || event.origin === 'file://'
        : event.origin === window.location.origin
      if (sameOrigin && event.data?.type === 'qingyu:spatial:feature-toggle-result') setFeaturePending(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [embedded])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as HTMLElement)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // 世界改名走指令：输入期间只改本地草稿，失焦/回车才提交一条 update_world
  const [nameDraft, setNameDraft] = useState(worldName)
  useEffect(() => {
    setNameDraft(worldName)
  }, [worldName])

  function commitWorldName() {
    const next = nameDraft.trim()
    if (next.length === 0 || next === worldName) {
      setNameDraft(worldName)
      return
    }
    setWorldName(next)
  }

  function onExport() {
    const pkg = exportPackage()
    const worldBlob = new Blob([JSON.stringify(pkg.world, null, 2)], {
      type: 'application/json',
    })
    const runtimeBlob = new Blob([JSON.stringify(pkg.runtime, null, 2)], {
      type: 'application/json',
    })
    download(worldBlob, `${pkg.world.id}.world.json`)
    download(runtimeBlob, `${pkg.world.id}.runtime.json`)
  }

  async function onImport() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.multiple = true
    input.onchange = async () => {
      try {
        const files = [...(input.files ?? [])]
        if (files.length === 0) return
        let world: unknown
        let runtime: unknown
        for (const f of files) {
          if (f.size > IMPORT_LIMITS.maxFileBytes) {
            useSpatialStore.setState({
              statusMessage: `导入失败：文件 ${f.name} 超过 5 MiB 上限`,
            })
            return
          }
          const parsed = parseImportJson(await f.text())
          if (!parsed.ok) {
            const issue = parsed.issues[0]
            useSpatialStore.setState({
              statusMessage: `导入失败：${issue.code} ${issue.message}`,
            })
            return
          }
          if (
            !parsed.value ||
            typeof parsed.value !== 'object' ||
            Array.isArray(parsed.value)
          ) {
            useSpatialStore.setState({
              statusMessage: `导入失败：${f.name} 的顶层必须是对象`,
            })
            return
          }
          const data = parsed.value as Record<string, unknown>
          if (data.schemaVersion === 1 && 'rootBoardId' in data) world = data
          else if (data.schemaVersion === 1 && 'placements' in data) runtime = data
          else if (!world) world = data
        }
        if (!world) {
          useSpatialStore.setState({ statusMessage: '未识别世界定义文件' })
          return
        }
        const result = importPackage({ world, runtime })
        useSpatialStore.setState({
          statusMessage: result.ok ? '导入成功' : `导入失败：${result.message}`,
        })
      } catch (error) {
        useSpatialStore.setState({
          statusMessage: `导入失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    input.click()
  }

  return (
    <header className="top-bar">
      {embedded ? <>
        <button
          type="button"
          className="back-to-chat"
          onClick={() => window.parent.postMessage({ type: 'qingyu:spatial:close' }, '*')}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 5l-5 5 5 5M7 10h10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          返回对话
        </button>
        <span className="header-divider" aria-hidden="true" />
      </> : <div className="top-brand" aria-label="空间画板">
        <span className="brand-compass" aria-hidden="true" />
        <span>空间画板</span>
      </div>}
      <input
        className="world-name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitWorldName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitWorldName()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setNameDraft(worldName)
            e.currentTarget.blur()
          }
        }}
        aria-label="世界名称"
        title="点击修改世界名称"
      />
      {embedded && assistantEnabled && <button type="button" className="spatial-assistant-entry" onClick={() => window.parent.postMessage({ type: 'qingyu:spatial:assistant' }, '*')}>
        <span aria-hidden="true">✧</span>AI 助手
      </button>}
      {embedded && <div className="spatial-feature-control" title="仅控制当前会话的画布、位置读取与剧情同步">
        <span>启用空间画布</span>
        <button type="button" role="switch" aria-label="启用空间画布" aria-checked="true" disabled={featurePending}
          className="spatial-feature-switch" onClick={() => {
            setFeaturePending(true)
            window.parent.postMessage({ type: 'qingyu:spatial:set-enabled', enabled: false }, '*')
          }}><span /></button>
      </div>}
      {!embedded && <div className="top-actions" ref={menuRef}>
        <button
          type="button"
          className="top-menu-trigger"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="文件与画板操作"
          aria-expanded={menuOpen}
          title="文件与画板操作"
        >
          <svg aria-hidden="true" viewBox="0 0 18 18" fill="currentColor">
            <circle cx="3" cy="9" r="1.5" />
            <circle cx="9" cy="9" r="1.5" />
            <circle cx="15" cy="9" r="1.5" />
          </svg>
        </button>
        {menuOpen ? (
          <div className="top-file-menu">
            <div className="menu-heading">画板文件</div>
            <button type="button" onClick={() => { setMenuOpen(false); void onImport() }}>导入 JSON</button>
            <button type="button" onClick={() => { setMenuOpen(false); onExport() }}>导出世界与角色位置</button>
            <div className="menu-divider" />
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                if (confirm('新建世界将覆盖当前草稿，确定？')) newWorld()
              }}
            >
              新建世界
            </button>
          </div>
        ) : null}
      </div>}
    </header>
  )
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
