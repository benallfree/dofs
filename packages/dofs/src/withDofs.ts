import { DurableObject } from 'cloudflare:workers'
import { Fs, FsOptions } from './Fs.js'

export type WithDofs<TEnv extends Cloudflare.Env> = DurableObject<TEnv> & {
  getFs: () => Fs
}

// Utility to create the extended class
export const withDofs = <TEnv extends Cloudflare.Env>(
  cls: new (ctx: DurableObjectState, env: TEnv) => DurableObject<TEnv>,
  options: FsOptions = {}
): new (ctx: DurableObjectState, env: TEnv) => WithDofs<TEnv> => {
  return class DurableObjectWithDofs extends cls {
    fs: Fs
    constructor(ctx: DurableObjectState, env: TEnv) {
      super(ctx, env)
      this.fs = new Fs(ctx, env, options)
    }
    getFs(): Fs {
      return this.fs
    }
  }
}

export function Dofs<TEnv extends Cloudflare.Env>(options: FsOptions = {}) {
  return function <T extends new (ctx: DurableObjectState, env: TEnv) => DurableObject<TEnv>>(
    target: new (ctx: DurableObjectState, env: TEnv) => DurableObject<TEnv>
  ): new (ctx: DurableObjectState, env: TEnv) => WithDofs<TEnv> {
    return class extends target {
      fs: Fs
      constructor(ctx: DurableObjectState, env: TEnv) {
        super(ctx, env)
        this.fs = new Fs(ctx, env, options)
      }
      getFs(): Fs {
        return this.fs
      }
    }
  }
}

// Testing

class MyDurableObjectBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}

class MyDurableObject2 extends withDofs(MyDurableObjectBase, { chunkSize: 4 * 1024 }) {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  test() {
    this.getFs().readFile('test.txt')
  }
}

@Dofs({ chunkSize: 4 * 1024 })
class MyAttributeObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}
