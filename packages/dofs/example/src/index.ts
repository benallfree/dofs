import { DurableObject } from 'cloudflare:workers'
import { Dofs, withDofs } from 'dofs'
import { dofs } from 'dofs/hono'
import { Hono } from 'hono'

export class MyDurableObjectBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}

export class MyDurableObjectWithDofsMixin extends withDofs(MyDurableObjectBase, { chunkSize: 4 * 1024 }) {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  test() {
    this.getFs().readFile('test.txt')
  }
}

@Dofs({ chunkSize: 4 * 1024 })
export class MyDurableObjectWithDofsAttribute extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route(
  '/',
  dofs<Env>({
    dos: {
      MY_DURABLE_OBJECT_WITH_DOFS_MIXIN: {
        classRef: MyDurableObjectWithDofsMixin,
        getInstances: async () => {
          return [
            {
              slug: 'my-durable-object-with-dofs-mixin',
              name: 'My Durable Object with Dofs Mixin',
            },
          ]
        },
        name: 'My Durable Object with Dofs Mixin',
      },
      MY_DURABLE_OBJECT_WITH_DOFS_ATTRIBUTE: {
        classRef: MyDurableObjectWithDofsAttribute,
        getInstances: async () => {
          return [
            {
              slug: 'my-durable-object-with-dofs-attribute',
              name: 'My Durable Object with Dofs Attribute',
            },
          ]
        },
        name: 'My Durable Object with Dofs Attribute',
      },
    },
  }) as any
)

export default app
