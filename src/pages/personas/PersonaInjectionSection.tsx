import { UserRound } from 'lucide-react'
import type { Settings } from '../../../shared/types'
import { SectionCard, Toggle } from '../../components/common/SettingsShared'

interface Props {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
}

/** 控制身份内容如何注入模型上下文。 */
export function PersonaInjectionSection({ settings, updateSettings }: Props) {
  return (
    <SectionCard title="用户人设注入" icon={<UserRound className="w-4 h-4" />} storageKey="persona-injection">
      <div className="mt-3 space-y-4">
        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <p className="text-sm">注入用户人设</p>
            <p className="text-xs text-tavern-text-muted">将用户名、描述和性格注入模型上下文；关闭后仅保留 {'{{user}}'} 变量替换</p>
          </div>
          <Toggle
            label="注入用户人设"
            checked={settings.personaInjection?.enabled ?? true}
            onChange={(enabled) => updateSettings({
              personaInjection: {
                ...(settings.personaInjection ?? { position: 'system', includeDescription: true, includePersona: true }),
                enabled,
              },
            })}
          />
        </div>

        {(settings.personaInjection?.enabled ?? true) && (
          <>
            <div className="flex items-center justify-between gap-4 py-1">
              <div>
                <p className="text-sm">注入位置</p>
                <p className="text-xs text-tavern-text-muted">默认拼入系统提示，也可作为独立系统消息发送</p>
              </div>
              <select
                className="input w-36 px-2 py-1 text-sm"
                value={settings.personaInjection?.position ?? 'system'}
                onChange={(event) => updateSettings({
                  personaInjection: {
                    ...(settings.personaInjection ?? { enabled: true, includeDescription: true, includePersona: true }),
                    position: event.target.value as 'system' | 'separate',
                  },
                })}
              >
                <option value="system">系统提示内</option>
                <option value="separate">独立系统消息</option>
              </select>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={settings.personaInjection?.includeDescription ?? true}
                  onChange={(event) => updateSettings({
                    personaInjection: {
                      ...(settings.personaInjection ?? { enabled: true, position: 'system', includePersona: true }),
                      includeDescription: event.target.checked,
                    },
                  })}
                />
                注入用户描述
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={settings.personaInjection?.includePersona ?? true}
                  onChange={(event) => updateSettings({
                    personaInjection: {
                      ...(settings.personaInjection ?? { enabled: true, position: 'system', includeDescription: true }),
                      includePersona: event.target.checked,
                    },
                  })}
                />
                注入用户性格
              </label>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
