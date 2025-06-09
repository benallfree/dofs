import { DurableObject } from 'cloudflare:workers'
import { Fs, FsOptions } from './Fs'

export const withDofs = <TEnv extends Cloudflare.Env>(
  cls: typeof DurableObject<TEnv>,
  options: FsOptions = {}
): typeof DurableObject<TEnv> => {
  return class extends cls {
    fs: Fs
    constructor(
      public ctx: DurableObjectState,
      public env: TEnv
    ) {
      super(ctx, env)
      this.fs = new Fs(ctx, env, options)
    }
    getFs() {
      return this.fs
    }
  }
}
