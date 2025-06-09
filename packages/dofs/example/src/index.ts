import { DurableObject } from 'cloudflare:workers'
import { withDofs } from 'dofs'
import { dofs } from 'dofs/hono'
import { Hono } from 'hono'

export class MyDurableObject extends withDofs(DurableObject<Env>, { chunkSize: 4 * 1024 }) {}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route(
  '/',
  dofs({
    MY_DURABLE_OBJECT: {
      classRef: MyDurableObject,
      getInstances: async () => {
        return [
          {
            slug: 'my-durable-object',
            name: 'My Durable Object',
          },
        ]
      },
      name: 'My Durable Object',
    },
  }) as any
)

export default app
