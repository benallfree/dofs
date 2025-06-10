// Define correct callback types for neofuse
export type FuseReaddirCallback = (err: number, files?: string[]) => void
export type FuseGetattrCallback = (err: number, stat?: any) => void
export type FuseCreateCallback = (err: number, fd?: number) => void
export type FuseOpenCallback = (err: number, fd?: number) => void
export type FuseWriteCallback = (err: number, bytesWritten?: number) => void
export type FuseReleaseCallback = (err: number) => void

export interface MountOptions {
  mountPoint: string
  debug?: boolean
}
