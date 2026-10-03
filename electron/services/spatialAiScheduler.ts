import { spatialAiService } from './spatialAiService'
import type { SpatialScope } from '../features/spatial/repository'
import type { SpatialDialogueCaptureInput } from './spatialDialogueQueue'

/** 模型调用由独立持久队列执行，主对话只等待登记，不等待提取。 */
export const spatialAiScheduler = {
  prepare: (scope: SpatialScope, input: SpatialDialogueCaptureInput) => spatialAiService.dialogue.capture(scope, input),
  saved: (scope: SpatialScope, generationId: string, messageId: string) => spatialAiService.dialogue.register(scope, generationId, messageId),
  recover: () => spatialAiService.dialogue.recover(),
}
