// Helper function to create stat objects
export function createStat(options: { mode: 'file' | 'dir'; size?: number }) {
  return {
    mtime: new Date(),
    atime: new Date(),
    ctime: new Date(),
    nlink: 1,
    size: options.size || 0,
    mode: options.mode === 'dir' ? 16877 : 33188, // 0o40755 for dir, 0o100644 for file
    uid: process.getuid ? process.getuid() : 0,
    gid: process.getgid ? process.getgid() : 0,
  }
}

// Helper function to process stat data from server
export function processStatData(statData: any) {
  // Convert date strings back to Date objects (JSON serialization converts Dates to strings)
  if (statData.mtime && typeof statData.mtime === 'string') {
    statData.mtime = new Date(statData.mtime)
  }
  if (statData.atime && typeof statData.atime === 'string') {
    statData.atime = new Date(statData.atime)
  }
  if (statData.ctime && typeof statData.ctime === 'string') {
    statData.ctime = new Date(statData.ctime)
  }

  // Map sentinel values to current user's uid/gid
  if (statData.uid === -1) {
    statData.uid = process.getuid ? process.getuid() : 0
  }
  if (statData.gid === -1) {
    statData.gid = process.getgid ? process.getgid() : 0
  }

  return statData
}
