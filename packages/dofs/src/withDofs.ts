import { DurableObject } from 'cloudflare:workers'
import { Fs, FsOptions } from './Fs'

export const withDofs = (cls: typeof DurableObject<any>, options: FsOptions = {}) => {
  return class extends cls {
    fs: Fs
    constructor(
      public ctx: DurableObjectState,
      public env: Env
    ) {
      super(ctx, env)
      this.fs = new Fs(ctx, env, options)
    }
    getFs() {
      return this.fs
    }
  }
}
