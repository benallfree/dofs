import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { dterm } from './dterm'

export class DTermElement extends HTMLElement {
  private fitAddon?: FitAddon
  private terminal?: Terminal
  private resizeObserver?: ResizeObserver

  connectedCallback() {
    // Add CSS styles to make the element take full height
    this.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    `

    const xtermAttr = this.getAttribute('xterm')
    const url = this.getAttribute('url')

    if (!url) {
      throw new Error('d-term: url attribute is required')
    }

    let xtermInstance: Terminal
    if (xtermAttr) {
      // Look for window[attribute]
      xtermInstance = (window as any)[xtermAttr]
      if (!xtermInstance) {
        console.warn(`d-term: window.${xtermAttr} not found, falling back to default`)
        xtermInstance = this.createDefaultTerminal()
      }
    } else {
      // No xterm attribute specified, check window.xterm first, then create default
      xtermInstance = (window as any).xterm || this.createDefaultTerminal()
    }

    // Store terminal reference for cleanup
    this.terminal = xtermInstance

    // Create and load the fit addon
    this.fitAddon = new FitAddon()
    xtermInstance.loadAddon(this.fitAddon)

    dterm(xtermInstance, { url })
    xtermInstance.open(this)

    // Fit the terminal to the container after it's opened
    setTimeout(() => {
      this.fitAddon?.fit()
    }, 0)

    // Set up resize observer to handle container resizing
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit()
    })
    this.resizeObserver.observe(this)
  }

  disconnectedCallback() {
    // Clean up resources when element is removed
    this.resizeObserver?.disconnect()
    this.terminal?.dispose()
  }

  private createDefaultTerminal(): Terminal {
    return new Terminal({
      theme: { background: '#181818', foreground: '#e0e0e0' },
      fontFamily: 'monospace',
      fontSize: 16,
      cursorBlink: true,
    })
  }
}
