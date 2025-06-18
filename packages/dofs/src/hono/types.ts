import { DurableObject } from 'cloudflare:workers'
import { Fs } from '../Fs.js'

// Extend the context type to include our fs property
export type DofsContext = {
  Variables: {
    fs: Rpc.Stub<Fs> // The filesystem stub
  }
}

/**
 * Represents an instance of a Durable Object
 */
export interface DurableObjectInstance {
  /** The unique slug identifier for the instance */
  slug: string
  /** The display name of the instance */
  name: string
}

export type FsStat = {
  mtime: Date
  atime: Date
  ctime: Date
  size: number
  mode: number
  uid: number
  gid: number
  nlink: number
}

/**
 * Configuration for a single Durable Object
 */
export interface DurableObjectConfigItem {
  /** The name of the Durable Object */
  name: string
  /** Reference to the Durable Object class for compatibility checking */
  classRef: typeof DurableObject<any>
  /** Function to get instances, optionally paginated */
  getInstances: (page?: number) => Promise<DurableObjectInstance[]>
  /** Function to get the stat for the namespace directory */
  resolveNamespaceStat?: (cfg: DurableObjectConfig) => Promise<FsStat>
  /** Function to get the stat for the instance directory */
  resolveInstanceStat?: (cfg: DurableObjectConfig, instanceId: string) => Promise<FsStat>
}

/**
 * Configuration object for Durable Objects
 */
export type DurableObjectConfig = {
  resolveRootStat?: (cfg: DurableObjectConfig) => Promise<FsStat>
  dos: Record<string, DurableObjectConfigItem>
}
