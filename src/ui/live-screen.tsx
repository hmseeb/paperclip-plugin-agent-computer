// The agent's browser as a live stream, with full mouse and keyboard while a person holds it.
// Ported from OpenBot's app/src/components/computer/live-screen.tsx (MIT, CopilotKit), which
// follows Chrome DevTools' InputModel.ts for the event translation. Differences: the socket goes
// through the plugin's gateway with a short-lived ticket, and it is used for watching as well.
import { useCallback, useEffect, useRef, useState } from "react";

/** CDP's modifier bits: Alt 1, Control 2, Shift 8. Command is sent as Control (the computer is Linux). */
function modifierBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0);
}

function remoteKey(e: KeyboardEvent) {
  return e.key === "Meta"
    ? { key: "Control", code: e.code === "MetaRight" ? "ControlRight" : "ControlLeft", windowsVirtualKeyCode: 17 }
    : { key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode };
}

/** The V of Cmd/Ctrl+V on any layout. */
function keyOf(e: KeyboardEvent): string {
  const written = e.key.toLowerCase();
  if (written.length !== 1 || written.charCodeAt(0) < 0x80) return written;
  return /^(?:Key|Digit)([A-Z0-9])$/.exec(e.code)?.[1]?.toLowerCase() ?? written;
}
const isPaste = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && keyOf(e) === "v";

/** A keystroke aimed at a field on this page (the address bar, the password box), not the agent's browser. */
function isLocalField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

type Props = {
  /** A fresh ticketed path for the stream, e.g. /_computer/stream?agent=…&exp=…&sig=… */
  ticket: () => Promise<string>;
  /** Whether this person holds the browser. Input is sent only then. */
  driving: boolean;
  onProblem: (problem: string | null) => void;
};

export function LiveScreen({ ticket, driving, onProblem }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const localKeyUps = useRef(new Set<string>());
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  const latestId = useRef(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const draw = async (data: string, id: number) => {
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        const canvas = canvasRef.current;
        if (stopped || id !== latestId.current || !canvas || document.visibilityState !== "visible") { bitmap.close(); return; }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch { /* a corrupt frame; the next replaces it */ }
    };

    const connect = async () => {
      if (stopped) return;
      let path: string;
      try { path = await ticket(); } catch (e) { onProblem(String((e as Error)?.message ?? e)); return retry(); }
      if (stopped) return;
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
      socketRef.current = socket;
      socket.onopen = () => { if (socketRef.current === socket) { setConnected(true); onProblem(null); } };
      socket.onmessage = (event) => {
        let m: { type?: string; data?: string; width?: number; height?: number; error?: string } | null = null;
        try { m = JSON.parse(String(event.data)); } catch { return; }
        if (!m || typeof m !== "object" || typeof m.type !== "string") return;
        if (m.type === "error") {
          // Input sent a moment before control arrived, or after it left: not worth showing.
          if (!/take control|has control|hand it back/i.test(m.error ?? "")) onProblem(m.error ?? "Couldn't show the screen.");
          return;
        }
        if (m.type !== "frame" || typeof m.data !== "string" || m.data.length > 20_000_000) return;
        const width = m.width ?? 1280, height = m.height ?? 800;
        if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) return;
        attempts = 0;
        frameSize.current = { width, height };
        void draw(m.data, ++latestId.current);
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setConnected(false);
        retry();
      };
      socket.onerror = () => socket.close();
    };
    const retry = () => {
      if (stopped) return;
      const delay = BACKOFF[Math.min(attempts++, BACKOFF.length - 1)];
      if (attempts > 3) onProblem("Reconnecting to the live screen…");
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      const s = socketRef.current;
      socketRef.current = null;
      s?.close();
    };
  }, [ticket, onProblem]);

  const send = useCallback((message: Record<string, unknown>) => {
    const s = socketRef.current;
    if (driving && s?.readyState === WebSocket.OPEN) s.send(JSON.stringify(message));
  }, [driving]);

  const at = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current, size = frameSize.current;
    if (!canvas || !size) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(((e.clientX - r.left) / r.width) * size.width), y: Math.round(((e.clientY - r.top) / r.height) * size.height) };
  }, []);

  const onMouse = useCallback((kind: "pressed" | "released" | "moved") => (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = at(e);
    if (!p) return;
    send({
      type: "mouse", event: kind, ...p,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
      // The browser's own click count, so double clicks arrive as double clicks.
      clickCount: kind === "moved" ? 0 : Math.max(1, e.detail),
      modifiers: modifierBits(e),
    });
  }, [at, send]);

  // Keys on window (a canvas cannot hold focus), in the capture phase so Paperclip's own shortcuts don't also fire.
  useEffect(() => {
    if (!driving || !connected) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      if (isPaste(e) || isLocalField(e.target)) { localKeyUps.current.add(e.code); return; }
      e.preventDefault();
      e.stopPropagation();
      send({ type: "key", event: "down", ...remoteKey(e), ...(e.key.length === 1 ? { text: e.key } : {}), modifiers: modifierBits(e) });
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      if (localKeyUps.current.delete(e.code) || isPaste(e)) return;
      e.preventDefault();
      send({ type: "key", event: "up", ...remoteKey(e), modifiers: modifierBits(e) });
    };
    const paste = (e: ClipboardEvent) => {
      if (isLocalField(e.target)) return;
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      e.preventDefault();
      send({ type: "text", text });
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up);
      window.removeEventListener("paste", paste);
      localKeyUps.current.clear();
    };
  }, [driving, connected, send]);

  // The wheel from a non-passive listener, so it scrolls the agent's page and not this one.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !connected || !canvas) return;
    const wheel = (e: WheelEvent) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      send({ type: "wheel", ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifierBits(e) });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [driving, connected, at, send]);

  return (
    <canvas
      ref={canvasRef}
      width={1280}
      height={800}
      style={{ display: "block", width: "100%", height: "auto", background: "#fff", cursor: driving ? "default" : "not-allowed" }}
      {...(driving ? { onMouseDown: onMouse("pressed"), onMouseUp: onMouse("released"), onMouseMove: onMouse("moved"), onContextMenu: (e: React.MouseEvent) => e.preventDefault() } : {})}
      aria-label={driving ? "The agent's browser. You have control: click and type here." : "The agent's browser, live"}
    />
  );
}
