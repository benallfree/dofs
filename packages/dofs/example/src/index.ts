import { DurableObject } from 'cloudflare:workers'
import { withDofs } from 'dofs'
import { dofs } from 'dofs/hono'
import { Hono } from 'hono'

export class MyDurableObject1 extends withDofs(DurableObject<Env>, { chunkSize: 4 * 1024 }) {}
export class MyDurableObject2 extends withDofs(DurableObject<Env>, { chunkSize: 4 * 1024 }) {}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route(
  '/',
  dofs<Env>({
    MY_DURABLE_OBJECT: {
      classRef: MyDurableObject1,
      getInstances: async () => {
        return [
          {
            slug: 'instance-1',
            name: 'Instance 1',
          },
          {
            slug: 'instance-2',
            name: 'Instance 2',
          },
        ]
      },
      name: 'My Durable Object',
    },
    MY_DURABLE_OBJECT_1: {
      classRef: MyDurableObject2,
      getInstances: async () => {
        return [{ slug: 'instance-1', name: 'Instance 1' }]
      },
      name: 'My Durable Object 1',
    },
  }) as any
)

export default app
