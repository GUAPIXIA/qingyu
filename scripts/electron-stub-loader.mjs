/**
 * resolve hook：把 'electron' 指到本地桩模块。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: new URL('./electron-stub-module.mjs', import.meta.url).href,
    }
  }
  return nextResolve(specifier, context)
}
