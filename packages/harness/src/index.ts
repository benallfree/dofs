import { Hono } from 'hono'
import { DurableObjectFs } from 'dofs'

export class MyDurableObject extends DurableObjectFs<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const env = c.env
  const id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName('foo')
  const stub = env.MY_DURABLE_OBJECT.get(id)
  const greeting = await stub.sayHello('world')
  return new Response(greeting)
})

export default app
