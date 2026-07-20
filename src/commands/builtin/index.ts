import { registerCommand } from '../registry'
import { clearCommand } from './clear'
import { regenerateCommand } from './regenerate'
import { continueCommand } from './continue'
import { summaryCommand } from './summary'
import { exportCommand } from './export'
import { helpCommand } from './help'
import { personaCommand } from './persona'
import { characterCommand } from './character'
import { presetCommand } from './preset'
import { lorebookCommand } from './lorebook'
import { swipeCommand } from './swipe'
import { tokenCommand } from './token'
import { planCommand } from './plan'

/** 注册所有内置斜杠命令 */
export function registerBuiltinCommands(): void {
  registerCommand(clearCommand)
  registerCommand(regenerateCommand)
  registerCommand(continueCommand)
  registerCommand(summaryCommand)
  registerCommand(exportCommand)
  registerCommand(helpCommand)
  registerCommand(personaCommand)
  registerCommand(characterCommand)
  registerCommand(presetCommand)
  registerCommand(lorebookCommand)
  registerCommand(swipeCommand)
  registerCommand(tokenCommand)
  registerCommand(planCommand)
}
