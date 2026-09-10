import { describe, expect, it } from 'vitest'
import { convertComfyCanvasWorkflow } from '../comfyWorkflow'

describe('ComfyUI Desktop workflow conversion', () => {
  it('converts a classic canvas workflow and handles the legacy seed control widget', () => {
    const workflow = convertComfyCanvasWorkflow({
      nodes: [
        {
          id: 1,
          type: 'KSampler',
          inputs: [
            { name: 'seed', link: null, widget: { name: 'seed' } },
            { name: 'steps', link: null, widget: { name: 'steps' } },
            { name: 'cfg', link: null, widget: { name: 'cfg' } },
            { name: 'sampler_name', link: null, widget: { name: 'sampler_name' } },
            { name: 'scheduler', link: null, widget: { name: 'scheduler' } },
          ],
          widgets_values: [123, 'randomize', 8, 1, 'res_multistep', 'simple'],
        },
        {
          id: 2,
          type: 'SaveImage',
          inputs: [
            { name: 'images', link: null },
            { name: 'filename_prefix', link: null, widget: { name: 'filename_prefix' } },
          ],
          widgets_values_named: { filename_prefix: 'Qingyu' },
        },
      ],
      links: [],
    })

    expect(workflow['1']).toMatchObject({
      class_type: 'KSampler',
      inputs: {
        seed: 123,
        steps: 8,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
      },
    })
    expect(workflow['2'].inputs.filename_prefix).toBe('Qingyu')
  })

  it('flattens a Desktop subgraph and reconnects its output', () => {
    const workflow = convertComfyCanvasWorkflow({
      nodes: [
        {
          id: 57,
          type: 'subgraph-z',
          inputs: [{ name: 'text', link: null, widget: { name: 'text' } }],
          widgets_values_named: { text: 'original prompt' },
        },
        {
          id: 9,
          type: 'SaveImage',
          inputs: [{ name: 'images', link: 62 }],
        },
      ],
      links: [[62, 57, 0, 9, 0, 'IMAGE']],
      definitions: {
        subgraphs: [{
          id: 'subgraph-z',
          nodes: [{
            id: 27,
            type: 'CLIPTextEncode',
            inputs: [{ name: 'text', link: 34, widget: { name: 'text' } }],
          }],
          links: [
            { id: 34, origin_id: -10, origin_slot: 0, target_id: 27, target_slot: 0 },
            { id: 16, origin_id: 27, origin_slot: 0, target_id: -20, target_slot: 0 },
          ],
        }],
      },
    })

    expect(workflow['57:27']).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: { text: 'original prompt' },
    })
    expect(workflow['9'].inputs.images).toEqual(['57:27', 0])
  })
})
