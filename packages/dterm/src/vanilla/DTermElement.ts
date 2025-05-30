import { Terminal } from '@xterm/xterm'
import { dterm } from './dterm'

export class DTermElement extends HTMLElement {
  connectedCallback() {
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

    dterm(xtermInstance, { url })
    xtermInstance.open(this)
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
