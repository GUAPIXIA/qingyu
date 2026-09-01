import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance, options: { ready?: () => Promise<void> }): Promise<void> {
  app.get('/relay/v1/health/live', async () => ({ ok: true }))
  app.get('/relay/v1/health/ready', async (_request, reply) => {
    try { await options.ready?.(); return { ok: true } }
    catch { return reply.code(503).send({ ok: false }) }
  })
}
