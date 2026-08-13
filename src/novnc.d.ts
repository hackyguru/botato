// noVNC ships plain JS with JSDoc, so declare the slice of RFB we use.
declare module "@novnc/novnc" {
  interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, url: string | URL, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendCtrlAltDel(): void;
  }
}
