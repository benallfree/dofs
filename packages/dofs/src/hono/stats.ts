import { DurableObjectConfig, FsStat } from './types.js'

export const getDefaultStat = (): FsStat => {
  // Use sentinel values for uid/gid - CLI will map to current user
  const uid = -1
  const gid = -1
  const now = new Date('1976-12-14T06:23:00.000Z')

  return {
    mtime: now,
    atime: now,
    ctime: now,
    size: 4096,
    mode: 16877, // Directory mode
    uid,
    gid,
    nlink: 1,
  }
}

export const getNamespaceStat = async (config: DurableObjectConfig, namespaceName: string): Promise<FsStat> => {
  const doConfig = config.dos[namespaceName]
  if (doConfig?.resolveNamespaceStat) {
    return await doConfig.resolveNamespaceStat(config)
  } else {
    // Default: try to aggregate instance stats, fallback to current time
    try {
      const instances = await doConfig.getInstances()
      if (instances.length > 0) {
        // Try to get stats from instances and aggregate
        const instanceStatPromises = instances
          .slice(0, 10) // Limit to first 10 instances for performance
          .map(async (instance) => {
            try {
              return await getInstanceStat(config, namespaceName, instance.slug)
            } catch {
              return null
            }
          })

        const instanceStats = (await Promise.all(instanceStatPromises)).filter(Boolean) as FsStat[]

        if (instanceStats.length > 0) {
          const uid = -1 // Sentinel value: CLI will map to current user
          const gid = -1 // Sentinel value: CLI will map to current user

          return {
            mtime: new Date(Math.max(...instanceStats.map((s) => s.mtime.getTime()))),
            atime: new Date(Math.max(...instanceStats.map((s) => s.atime.getTime()))),
            ctime: new Date(Math.max(...instanceStats.map((s) => s.ctime.getTime()))),
            size: 4096,
            mode: 16877, // Directory mode
            uid,
            gid,
            nlink: 1,
          }
        }
      }
    } catch {
      // Fall through to default
    }

    return getDefaultStat()
  }
}

export const getInstanceStat = async (
  config: DurableObjectConfig,
  namespaceName: string,
  instanceId: string
): Promise<FsStat> => {
  const doConfig = config.dos[namespaceName]
  if (doConfig?.resolveInstanceStat) {
    return await doConfig.resolveInstanceStat(config, instanceId)
  } else {
    // Default: return current time with user's uid/gid
    return getDefaultStat()
  }
}

export const getRootStat = async (config: DurableObjectConfig): Promise<FsStat> => {
  if (config.resolveRootStat) {
    return await config.resolveRootStat(config)
  } else {
    const statPromises = Object.keys(config.dos).map(async (namespaceName) => {
      try {
        return await getNamespaceStat(config, namespaceName)
      } catch {
        return null
      }
    })

    const stats = (await Promise.all(statPromises)).filter(Boolean) as FsStat[]

    if (stats.length > 0) {
      const uid = -1 // Sentinel value: CLI will map to current user
      const gid = -1 // Sentinel value: CLI will map to current user

      return {
        mtime: new Date(Math.max(...stats.map((s) => s.mtime.getTime()))),
        atime: new Date(Math.max(...stats.map((s) => s.atime.getTime()))),
        ctime: new Date(Math.max(...stats.map((s) => s.ctime.getTime()))),
        size: 4096,
        mode: 16877, // Directory mode
        uid,
        gid,
        nlink: 1,
      }
    } else {
      return getDefaultStat()
    }
  }
}
