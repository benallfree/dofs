# Durable Object File System Terminal (dterm)

`dterm` provides a terminal interface to interact with a Durable Object File System (DOFS) instance. This allows you to manage files and directories within a Durable Object using familiar command-line operations.

## Features

- **Terminal Interface:** Uses Xterm.js to provide a rich terminal experience in the browser.
- **DOFS Integration:** Connects to a Durable Object that exposes the `IDurableObjectFs` interface.
- **Command Execution:** Translates terminal input into DOFS operations (e.g., `ls`, `mkdir`, `cat`).

## How it Works

`dterm` consists of two main parts:

1.  **Frontend:** An Xterm.js terminal running in the browser.
2.  **Backend:** A Cloudflare Worker that routes commands from the terminal to a Durable Object. The Durable Object implements the `IDurableObjectFs` interface from the `dofs` package to perform file system operations.

## Setup

### 1. Create a Durable Object with `IDurableObjectFs`

First, you need a Durable Object that exposes the file system operations. The `dofs` package provides an `IDurableObjectFs` interface that your Durable Object should implement. You can delegate the calls to an `Fs` instance from `dofs`.

Here's an example of how to create such a Durable Object:

```typescript
import { DurableObject, DurableObjectState } from '@cloudflare/workers-types'
import {
  Fs,
  type IDurableObjectFs,
  type ReadFileOptions,
  type WriteFileOptions,
  type ReadOptions,
  type WriteOptions,
  type MkdirOptions,
  type RmdirOptions,
  type ListDirOptions,
  type SetAttrOptions,
  type CreateOptions,
} from 'dofs'

export class MyDofsDO extends DurableObject<Env> implements IDurableObjectFs {
  private fs: Fs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Initialize the Fs instance. You can customize options like chunkSize.
    this.fs = new Fs(ctx, env, { chunkSize: 64 * 1024 }) // 64KB chunk size
  }

  // Implement all methods from IDurableObjectFs by delegating to this.fs
  public readFile(path: string, options?: ReadFileOptions) {
    return this.fs.readFile(path, options)
  }

  public writeFile(path: string, data: ArrayBuffer | string | ReadableStream<Uint8Array>, options?: WriteFileOptions) {
    return this.fs.writeFile(path, data, options)
  }

  public read(path: string, options: ReadOptions) {
    return this.fs.read(path, options)
  }

  public write(path: string, data: ArrayBuffer | string, options: WriteOptions) {
    return this.fs.write(path, data, options)
  }

  public mkdir(path: string, options?: MkdirOptions) {
    return this.fs.mkdir(path, options)
  }

  public rmdir(path: string, options?: RmdirOptions) {
    return this.fs.rmdir(path, options)
  }

  public listDir(path: string, options?: ListDirOptions) {
    return this.fs.listDir(path, options)
  }

  public stat(path: string) {
    return this.fs.stat(path)
  }

  public setattr(path: string, options: SetAttrOptions) {
    return this.fs.setattr(path, options)
  }

  public symlink(target: string, path: string) {
    return this.fs.symlink(target, path)
  }

  public readlink(path: string) {
    return this.fs.readlink(path)
  }

  public rename(oldPath: string, newPath: string) {
    return this.fs.rename(oldPath, newPath)
  }

  public unlink(path: string) {
    return this.fs.unlink(path)
  }

  public create(path: string, options?: CreateOptions) {
    return this.fs.create(path, options)
  }

  public truncate(path: string, size: number) {
    return this.fs.truncate(path, size)
  }

  public getDeviceStats() {
    return this.fs.getDeviceStats()
  }

  public setDeviceSize(newSize: number) {
    return this.fs.setDeviceSize(newSize)
  }
}
```

### 2. Initialize Xterm.js in your Frontend

In your HTML page, you'll need a container element for Xterm.js and a script to initialize it.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Durable Object File System Terminal</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        background: #181818;
      }
      #terminal {
        height: 100vh;
        width: 100vw;
      }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { Terminal } from '@xterm/xterm'
      import '@xterm/xterm/css/xterm.css'
      import { dterm } from 'dofs-term/vanilla'

      const term = new Terminal({
        theme: { background: '#181818', foreground: '#e0e0e0' },
        fontFamily: 'monospace',
        fontSize: 16,
        cursorBlink: true,
      })
      dterm(term)
      term.open(document.getElementById('terminal'))
    </script>
  </body>
</html>
```

### 3. Bootstrap Communication (Worker Backend)

You'll need a Cloudflare Worker to act as an intermediary between the Xterm.js frontend and your `MyDofsDO` Durable Object. This worker will receive commands from the frontend, get a stub for the Durable Object, and call the appropriate method on the DO.

Here's a conceptual example using Hono for routing (you can adapt this to your preferred setup):

```typescript
import { DurableObject } from 'cloudflare:workers'
import { dterm } from 'dofs-term/hono'
import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.route(
  '/api/dterm',
  dterm((env: Env) => {
    const id = env.MY_DURABLE_OBJECT.idFromName('dofs')
    return env.MY_DURABLE_OBJECT.get(id)
  })
)

export default app
```
