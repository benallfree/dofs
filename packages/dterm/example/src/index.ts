import { DurableObject } from 'cloudflare:workers'
import { Fs } from 'dofs'
import { dofs } from 'dofs/hono'
import { Hono } from 'hono'

export class MyDurableObject extends DurableObject<Env> {
  private fs: Fs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.fs = new Fs(ctx, env, { chunkSize: 4 * 1024 })
  }

  public getFs() {
    return this.fs
  }
}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route('/api/dofs', dofs() as any)

export default app
