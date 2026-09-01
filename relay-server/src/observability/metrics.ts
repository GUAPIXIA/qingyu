type Labels = Record<string, string>

function key(name: string, labels: Labels): string {
  const suffix = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => `${label}="${value.replace(/["\\\n]/g, '_')}"`).join(',')
  return suffix ? `${name}{${suffix}}` : name
}

/** 无依赖 Prometheus 文本注册表；只接受低基数、无用户内容标签。 */
export class MetricsRegistry {
  private readonly values = new Map<string, number>()
  inc(name: string, labels: Labels = {}, by = 1): void { const id = key(name, labels); this.values.set(id, (this.values.get(id) ?? 0) + by) }
  set(name: string, value: number, labels: Labels = {}): void { this.values.set(key(name, labels), value) }
  observe(name: string, seconds: number, labels: Labels = {}): void {
    this.inc(`${name}_count`, labels)
    this.inc(`${name}_sum`, labels, Math.max(0, seconds))
  }
  render(): string { return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id} ${value}`).join('\n') + '\n' }
}
