import { DurableObject } from 'cloudflare:workers'
import { withDofs } from 'dofs'
import { dofs } from 'dofs/hono'
import { Hono } from 'hono'

export class MyDurableObject extends withDofs(DurableObject<Env>, { chunkSize: 4 * 1024 }) {}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route('/api/dofs', dofs() as any)

export default app
