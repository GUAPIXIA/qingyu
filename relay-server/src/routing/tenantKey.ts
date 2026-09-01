export function tenantKey(spaceId: string, suffix: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(spaceId)) throw new Error('invalid space id')
  if (!suffix || suffix.includes('..') || suffix.startsWith(':')) throw new Error('invalid tenant key suffix')
  return `space:{${spaceId}}:${suffix}`
}
