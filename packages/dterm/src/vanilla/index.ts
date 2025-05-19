import { Terminal } from '@xterm/xterm'

export interface StatEntry {
  name: string
  isDirectory: boolean
  mode?: number
  nlink?: number
  uid?: string | number
  gid?: string | number
  size?: number
  mtime?: number | string
  error?: string
}

export interface FSStat {
  isDirectory: boolean
  mode?: number
  nlink?: number
  uid?: string | number
  gid?: string | number
  size?: number
  mtime?: number | string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any // Allow other properties
}

interface AutocompleteState {
  candidates: string[]
  prefix: string
  insertPos: number
  cycleIndex: number
  lastBuffer: string
}

type CommandFunction = (args: string[]) => string | Promise<string | undefined | void> | void

interface AllowedCommands {
  [key: string]: CommandFunction
}

export type Options = {
  extraCommands?: {
    [key: string]: CommandFunction
  }
  initialMessage?: string
  prompt?: string
  wsUrl?: string
}

export const dterm = (term: Terminal, options?: Options): void => {
  const {
    extraCommands,
    initialMessage = 'Connected to Durable Object File System! Type "help" for commands.',
    prompt = '$ ',
    wsUrl = '/api/dterm',
  } = options || {}
  term.writeln(initialMessage)
  let cwd = '/'
  term.write(`${cwd} ${prompt}`)
  let buffer = ''
  let history: string[] = []
  let historyIndex = -1
  let autocompleteState: AutocompleteState | null = null // {candidates, prefix, insertPos, cycleIndex, lastBuffer}

  function resolvePath(inputPath?: string): string {
    if (!inputPath || inputPath === '.') return cwd
    if (inputPath.startsWith('/')) return inputPath.replace(/\/+/g, '/')
    const parts = (cwd + '/' + inputPath).split('/').filter(Boolean)
    const stack: string[] = []
    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') stack.pop()
      else stack.push(part)
    }
    return '/' + stack.join('/')
  }

  const allowedCommands: AllowedCommands = {
    ...extraCommands,
    help: () => 'Allowed commands: help, ls, open, upload, rm, cd, pwd, cat, mkdir, rmdir, mv, ln -s, stat, df',
    pwd: () => cwd,
    cd: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) {
        cwd = '/'
        return
      }
      const res = await fetch(`${wsUrl}/stat?path=${encodeURIComponent(path)}`)
      if (!res.ok) return `cd: ${args[0]}: No such file or directory`
      const stat = (await res.json()) as FSStat
      if (!stat || typeof stat !== 'object') {
        return `cd: ${args[0]}: stat error`
      }
      if (!stat.isDirectory) return `cd: ${args[0]}: Not a directory`
      cwd = path
      return
    },
    ls: async (args: string[]) => {
      const path = resolvePath(args[0] || '.')
      try {
        const res = await fetch(`${wsUrl}/ls?path=${encodeURIComponent(path)}`)
        if (!res.ok) return 'Error: could not list directory'
        const stats = (await res.json()) as StatEntry[]
        function modeStr(mode: number | undefined, isDir: boolean | undefined): string {
          if (mode == null) return '??????????'
          const types = isDir ? 'd' : '-'
          const perms = [
            mode & 0o400 ? 'r' : '-',
            mode & 0o200 ? 'w' : '-',
            mode & 0o100 ? 'x' : '-',
            mode & 0o040 ? 'r' : '-',
            mode & 0o020 ? 'w' : '-',
            mode & 0o010 ? 'x' : '-',
            mode & 0o004 ? 'r' : '-',
            mode & 0o002 ? 'w' : '-',
            mode & 0o001 ? 'x' : '-',
          ].join('')
          return types + perms
        }
        function humanSize(size: number | undefined): string {
          if (size == null) return '?'
          if (size < 1024) return size + 'B'
          if (size < 1024 * 1024) return (size / 1024).toFixed(1).replace(/\.0$/, '') + 'K'
          if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M'
          return (size / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'G'
        }
        function mtimeStr(mtime: number | string | undefined): string {
          if (!mtime) return '?'
          const d = new Date(mtime)
          const mon = d.toLocaleString('en-US', { month: 'short' })
          const day = d.getDate().toString().padStart(2, ' ')
          const time = d.toTimeString().slice(0, 5)
          return `${mon} ${day} ${time}`
        }
        let maxMode = 10,
          maxNlink = 1,
          maxUid = 1,
          maxGid = 1,
          maxSize = 1,
          maxMtime = 12
        stats.forEach((f: StatEntry) => {
          if (!f.error) {
            maxMode = Math.max(maxMode, modeStr(f.mode, f.isDirectory).length)
            maxNlink = Math.max(maxNlink, (f.nlink ?? 1).toString().length)
            maxUid = Math.max(maxUid, (f.uid ?? '?').toString().length)
            maxGid = Math.max(maxGid, (f.gid ?? '?').toString().length)
            maxSize = Math.max(maxSize, humanSize(f.size).length)
            maxMtime = Math.max(maxMtime, mtimeStr(f.mtime).length)
          }
        })
        const rows = stats.map((f: StatEntry) => {
          if (f.error) return ['?', '?', '?', '?', '?', '?', f.name + ' (error)']
          return [
            modeStr(f.mode, f.isDirectory),
            (f.nlink ?? 1).toString(),
            (f.uid ?? '?').toString(),
            (f.gid ?? '?').toString(),
            humanSize(f.size),
            mtimeStr(f.mtime),
            f.name + (f.isDirectory ? '/' : ''),
          ]
        })
        const header = ['Mode', 'Nlink', 'Uid', 'Gid', 'Size', 'Mtime', 'Name']
        return formatColumns([header, ...rows])
      } catch (e: unknown) {
        return 'Error: ' + (e as Error).message
      }
    },
    cat: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: cat <file>'
      const res = await fetch(`${wsUrl}/file?path=${encodeURIComponent(path)}`)
      if (!res.ok) return `cat: ${args[0]}: No such file`
      const text = await res.text()
      return text
    },
    open: (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: open <file>'
      const url = `${wsUrl}/file?path=${encodeURIComponent(path)}`
      window.open(url, '_blank')
      return `Opened ${path} in new window.`
    },
    upload: () => {
      return new Promise<string>((resolve) => {
        term.writeln('Uploading...')
        const input = document.createElement('input')
        input.type = 'file'
        input.style.display = 'none'
        document.body.appendChild(input)
        input.addEventListener('change', () => {
          const file = input.files && input.files[0]
          if (!file) {
            document.body.removeChild(input)
            term.writeln('Upload cancelled.')
            resolve('No file selected.')
            return
          }
          const formData = new FormData()
          formData.append('file', file)
          const xhr = new XMLHttpRequest()
          xhr.open('POST', `${wsUrl}/upload?path=${encodeURIComponent(cwd)}`)
          let lastPercent = -1
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.floor((e.loaded / e.total) * 100)
              if (percent !== lastPercent) {
                term.write(`\rUploading... ${percent}%   `)
                lastPercent = percent
              }
            }
          }
          xhr.onload = () => {
            document.body.removeChild(input)
            term.writeln('\rUpload complete.         ')
            if (xhr.status === 200) {
              resolve(`Uploaded: ${file.name}`)
            } else {
              resolve(`Upload failed: ${xhr.statusText}`)
            }
          }
          xhr.onerror = () => {
            document.body.removeChild(input)
            term.writeln('\rUpload failed.          ')
            resolve('Upload failed: network error')
          }
          xhr.send(formData)
        })
        input.click()
      })
    },
    rm: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: rm <file>'
      const res = await fetch(`${wsUrl}/rm?path=${encodeURIComponent(path)}`, { method: 'POST' })
      if (!res.ok) return `Error: could not remove ${args[0]}`
      return `Removed ${args[0]}`
    },
    mkdir: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: mkdir <dir>'
      const res = await fetch(`${wsUrl}/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' })
      if (!res.ok) return `Error: could not create directory ${args[0]}`
      return `Created directory ${args[0]}`
    },
    rmdir: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: rmdir <dir>'
      const res = await fetch(`${wsUrl}/rmdir?path=${encodeURIComponent(path)}`, { method: 'POST' })
      if (!res.ok) return `Error: could not remove directory ${args[0]}`
      return `Removed directory ${args[0]}`
    },
    mv: async (args: string[]) => {
      if (args.length < 2) return 'Usage: mv <src> <dest>'
      const src = resolvePath(args[0])
      const dest = resolvePath(args[1])
      const res = await fetch(`${wsUrl}/mv?src=${encodeURIComponent(src)}&dest=${encodeURIComponent(dest)}`, {
        method: 'POST',
      })
      if (!res.ok) return `Error: could not move ${args[0]}`
      return `Moved ${args[0]} to ${args[1]}`
    },
    'ln -s': async (args: string[]) => {
      if (args.length < 2) return 'Usage: ln -s <target> <link>'
      const target = resolvePath(args[0])
      const path = resolvePath(args[1])
      const res = await fetch(
        `${wsUrl}/symlink?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}`,
        {
          method: 'POST',
        }
      )
      if (!res.ok) return `Error: could not symlink ${args[1]}`
      return `Symlinked ${args[1]} -> ${args[0]}`
    },
    stat: async (args: string[]) => {
      const path = resolvePath(args[0])
      if (!args[0]) return 'Usage: stat <file|dir>'
      const res = await fetch(`${wsUrl}/stat?path=${encodeURIComponent(path)}`)
      if (!res.ok) return `Error: could not stat ${args[0]}`
      const stat = await res.json()
      return JSON.stringify(stat, null, 2)
    },
    df: async () => {
      const res = await fetch(`${wsUrl}/df`)
      if (!res.ok) return 'Error: could not get device stats'
      const stats = (await res.json()) as { deviceSize: number; spaceUsed: number; spaceAvailable: number }
      function humanSize(size: number | undefined): string {
        if (size == null) return '?'
        if (size < 1024) return size + 'B'
        if (size < 1024 * 1024) return (size / 1024).toFixed(1).replace(/\.0$/, '') + 'K'
        if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M'
        return (size / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'G'
      }
      const rows = [
        ['Filesystem', 'Size', 'Used', 'Avail'],
        ['dofs', humanSize(stats.deviceSize), humanSize(stats.spaceUsed), humanSize(stats.spaceAvailable)],
      ]
      return formatColumns(rows)
    },
  }
  const allCommands = Object.keys(allowedCommands)
  async function getCompletions(cmd: string, argPrefix: string, cwdArg = '/'): Promise<string[]> {
    // Only complete for file args (not command name)
    let path = argPrefix
    let base = ''
    if (!path || path.endsWith('/')) {
      base = path || cwdArg
      path = ''
    } else {
      const idx = path.lastIndexOf('/')
      if (idx >= 0) {
        base = resolvePath(path.slice(0, idx + 1))
        path = path.slice(idx + 1)
      } else {
        base = cwdArg
      }
    }
    try {
      const res = await fetch(`${wsUrl}/ls?path=${encodeURIComponent(base || '/')}`)
      if (!res.ok) return []
      const stats = (await res.json()) as StatEntry[]
      return stats
        .filter((f: StatEntry) => !f.error && f.name.startsWith(path))
        .map((f: StatEntry) => f.name + (f.isDirectory ? '/' : ''))
        .sort()
    } catch {
      return []
    }
  }
  term.onData(async (e: string) => {
    if (e === '\r') {
      // Enter
      const [cmd, ...args] = buffer.trim().split(' ')
      term.writeln('')
      if (buffer.trim().length > 0) {
        history.push(buffer)
        historyIndex = history.length
      }
      if (allowedCommands[cmd]) {
        const result = allowedCommands[cmd](args)
        if (result instanceof Promise) {
          const awaited = await result
          if (awaited !== undefined && awaited !== null) term.writeln(awaited as string)
        } else {
          if (result !== undefined && result !== null) term.writeln(result as string)
        }
        if (cmd === 'cd') {
          term.write(`${cwd} ${prompt}`)
          buffer = ''
          return
        }
      } else if (cmd.length > 0) {
        term.writeln('Command not found')
      }
      buffer = ''
      term.write(`${cwd} ${prompt}`)
    } else if (e === '\u007F') {
      // Backspace
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1)
        term.write('\b \b')
      }
    } else if (e === '\u001b[A') {
      // Up arrow
      if (history.length > 0 && historyIndex > 0) {
        historyIndex--
        // Clear current line
        term.write(`\r\x1b[K${prompt}`)
        buffer = history[historyIndex]
        term.write(buffer)
      }
    } else if (e === '\u001b[B') {
      // Down arrow
      if (history.length > 0 && historyIndex < history.length - 1) {
        historyIndex++
        term.write(`\r\x1b[K${prompt}`)
        buffer = history[historyIndex]
      } else if (historyIndex === history.length - 1) {
        historyIndex++
        term.write(`\r\x1b[K${prompt}`)
        buffer = ''
      }
      term.write(buffer) // Make sure buffer is written in both cases if history changes
    } else if (e === '\t') {
      // TAB
      // Find word to complete (after last space, or command)
      const parts = buffer.split(/ +/)
      const isCmd = buffer.trim().length === 0 || buffer.match(/^\s*\S*$/)
      let insertPos = buffer.length
      let prefix = ''
      if (isCmd) {
        prefix = parts[0] || ''
        insertPos = buffer.length
        // Complete command
        const candidates = allCommands.filter((c) => c.startsWith(prefix))
        if (!candidates.length) return
        if (!autocompleteState || autocompleteState.lastBuffer !== buffer) {
          autocompleteState = { candidates, prefix, insertPos, cycleIndex: 0, lastBuffer: buffer }
        } else {
          autocompleteState.cycleIndex = (autocompleteState.cycleIndex + 1) % candidates.length
        }
        let common = candidates[0]
        for (const c of candidates) {
          let i = 0
          while (i < common.length && c[i] === common[i]) i++
          common = common.slice(0, i)
        }
        const toInsert = candidates.length === 1 ? candidates[0] : common
        // Rewrite line
        term.write(`\r\x1b[K${prompt}` + toInsert)
        buffer = toInsert
        if (candidates.length > 1 && autocompleteState.cycleIndex === 0) {
          term.writeln('\r\n' + candidates.join('  '))
          term.write(`${prompt}` + toInsert)
        } else if (candidates.length > 1) {
          const pick = candidates[autocompleteState.cycleIndex]
          term.write(`\r\x1b[K${prompt}` + pick)
          buffer = pick
        }
        return
      } else {
        // Complete file/dir
        const argIdx = parts.length - 1
        prefix = parts[argIdx] || ''
        insertPos = buffer.lastIndexOf(prefix)
        const candidates = await getCompletions(parts[0], prefix, cwd)
        if (!candidates.length) return
        if (!autocompleteState || autocompleteState.lastBuffer !== buffer) {
          autocompleteState = { candidates, prefix, insertPos, cycleIndex: 0, lastBuffer: buffer }
        } else {
          autocompleteState.cycleIndex = (autocompleteState.cycleIndex + 1) % candidates.length
        }
        let common = candidates[0]
        for (const c of candidates) {
          let i = 0
          while (i < common.length && c[i] === common[i]) i++
          common = common.slice(0, i)
        }
        const toInsert = candidates.length === 1 ? candidates[0] : common
        const newBuffer = buffer.slice(0, insertPos) + toInsert
        // Rewrite line
        term.write(`\r\x1b[K${prompt}` + newBuffer)
        buffer = newBuffer
        if (candidates.length > 1 && autocompleteState.cycleIndex === 0) {
          term.writeln('\r\n' + candidates.join('  '))
          term.write(`${prompt}` + newBuffer)
        } else if (candidates.length > 1) {
          const pick = candidates[autocompleteState.cycleIndex]
          const newBuffer2 = buffer.slice(0, insertPos) + pick // Corrected: use original buffer for slicing
          term.write(`\r\x1b[K${prompt}` + newBuffer2)
          buffer = newBuffer2
        }
        return
      }
    } else if (e === '\u0003') {
      // Ctrl+C
      term.write(`^C\r\n${prompt}`)
      buffer = ''
    } else if (e >= ' ' && e <= '~') {
      // Printable
      buffer += e
      term.write(e)
    }
    autocompleteState = null
  })
  // Utility: format columns for terminal output
  function formatColumns(rows: string[][]): string {
    if (!rows.length) return ''
    // Compute max width for each column
    const colCount = rows[0].length
    const colWidths: number[] = Array(colCount).fill(0)
    for (const row of rows) {
      for (let i = 0; i < colCount; ++i) {
        colWidths[i] = Math.max(colWidths[i], String(row[i]).length)
      }
    }
    // Build lines
    return rows
      .map((row: string[]) =>
        row
          .map((cell: string, i: number) => {
            // Right-align numbers, left-align text
            if (typeof cell === 'number' || (i > 0 && /^ *[0-9,.]+ *$/.test(cell))) {
              return String(cell).padStart(colWidths[i], ' ')
            }
            return String(cell).padEnd(colWidths[i], ' ')
          })
          .join('  ')
      )
      .join('\r\n')
  }
}
