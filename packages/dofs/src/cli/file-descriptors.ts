// File descriptor tracking
let nextFd = 1
const openFiles = new Map<number, { path: string; data: Buffer }>()

export function createFileDescriptor(path: string): number {
  const fd = nextFd++
  openFiles.set(fd, { path, data: Buffer.alloc(0) })
  return fd
}

export function getFileInfo(fd: number): { path: string; data: Buffer } | undefined {
  return openFiles.get(fd)
}

export function appendToFile(fd: number, data: Buffer): void {
  const fileInfo = openFiles.get(fd)
  if (fileInfo) {
    fileInfo.data = Buffer.concat([fileInfo.data, data])
  }
}

export function closeFile(fd: number): void {
  openFiles.delete(fd)
}
