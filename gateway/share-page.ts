// The pages a shared link opens, served by the gateway: the browser itself, full screen, for the
// person the link was sent to, and a recording's replay for the team. Self-contained HTML and script,
// so they work on any device without Paperclip. The live screen's input translation follows
// src/ui/live-screen.tsx (itself from OpenBot's, after Chrome DevTools' InputModel.ts).

const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">`;

/** Shown for a link that is wrong, expired or ended. */
export function closedPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `${HEAD}<title>Shared browser</title><style>body{margin:0;height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#0d1117;color:#e6edf3}p{max-width:420px;text-align:center;padding:0 24px}</style><p>${safe}</p>`;
}

export function sharePage(): string {
  return `${HEAD}<title>Shared browser</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font:14px/1.4 system-ui,-apple-system,sans-serif;overflow:hidden}
#bar{height:46px;display:flex;align-items:center;gap:12px;padding:0 12px;background:#161b22;border-bottom:1px solid #30363d}
#title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22vw}
#access{flex:1;display:flex;align-items:center;gap:6px;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
#access span.l{color:#8b949e;margin-right:2px}
.chip{border:1px solid #30363d;border-radius:999px;padding:3px 10px;color:#c9d1d9;background:#0d1117;font-size:13px;cursor:pointer}
.chip.static{cursor:default;color:#8b949e}.chip:hover:not(.static){border-color:#58a6ff;color:#fff}
#left{color:#8b949e;white-space:nowrap;font-variant-numeric:tabular-nums}
#done{background:#238636;color:#fff;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer;white-space:nowrap}
#done:disabled{background:#30363d;color:#8b949e;cursor:default}
#stage{position:absolute;top:46px;left:0;right:0;bottom:0;display:grid;place-items:center;background:#0d1117}
canvas{display:block;background:#fff;touch-action:none;outline:none}
#note{position:absolute;left:50%;top:58px;transform:translateX(-50%);background:#1f6feb;color:#fff;padding:8px 14px;border-radius:8px;display:none;max-width:90vw;text-align:center;z-index:2}
#cover{position:absolute;inset:46px 0 0 0;display:grid;place-items:center;background:rgba(13,17,23,.92);z-index:3;text-align:center;padding:24px}
#cover p{max-width:460px;font-size:16px}
@media (max-width:640px){#title{display:none}#access span.l{display:none}}
</style></head><body>
<div id="bar"><div id="title">Shared browser</div><div id="access"><span class="l">You can access:</span></div><button id="kept" class="chip" style="display:none">&#128274; Sign-in kept</button><div id="left"></div><button id="done">I'm done</button></div>
<div id="stage"><canvas id="screen" tabindex="0" width="1280" height="800" aria-label="Shared browser"></canvas></div>
<div id="note"></div><div id="cover"><p>Opening the browser…</p></div>
<script>
(() => {
  const token = location.pathname.split("/")[3];
  const base = "/_computer/s/" + token;
  const $ = (id) => document.getElementById(id);
  const canvas = $("screen"), stage = $("stage"), cover = $("cover"), note = $("note"), doneBtn = $("done");
  let info = null, socket = null, frame = null, latest = 0, attempts = 0, stopped = false, sized = null;
  const driving = () => info && info.status === "active";
  const show = (text) => { cover.style.display = text ? "grid" : "none"; if (text) cover.firstElementChild.textContent = text; };
  const toast = (text, ms) => { note.textContent = text; note.style.display = "block"; clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => note.style.display = "none", ms); };
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  async function load() {
    const r = await fetch(base + "/info", { cache: "no-store" });
    if (!r.ok) { stop(r.status === 404 || r.status === 410 ? "This shared browser has ended." : "This link is not valid or has expired."); return null; }
    const before = info && info.status;
    info = await r.json();
    $("title").textContent = info.title || "Shared browser";
    document.title = info.title ? info.title + " · Shared browser" : "Shared browser";
    const access = $("access");
    if (!access.dataset.done) {
      access.dataset.done = "1";
      for (const a of info.allow) {
        const chip = document.createElement(a.url ? "button" : "span");
        chip.className = "chip" + (a.url ? "" : " static");
        chip.textContent = a.label;
        if (a.url) chip.onclick = () => { if (!driving()) return; post("/go", { url: a.url }).then((x) => x.ok ? null : x.json().then((j) => toast(j.error || "Could not open that.", 4000))); };
        access.appendChild(chip);
      }
    }
    if (info.notice) {
      const kept = $("kept");
      kept.style.display = "inline-block";
      kept.title = info.notice;
      kept.onclick = () => toast(info.notice, 10000);
      if (!before) toast(info.notice, 10000);
    }
    if (info.status === "ended") { stop("This shared browser has ended. You can close this page."); return info; }
    if (info.status === "done") {
      doneBtn.disabled = true; doneBtn.textContent = "Done";
      if (before !== "done") toast(info.mode === "login" ? "Thanks! We're finishing up from here. You can watch, or close this page." : "Thanks, you're all set. You can close this page.");
    }
    return info;
  }

  function stop(text) {
    stopped = true;
    if (socket) { const s = socket; socket = null; s.close(); }
    doneBtn.disabled = true;
    show(text);
  }

  // The browser is sized to this window before the screen starts, so it fills it and clicks land true.
  async function size() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (sized && Math.abs(sized.w - w) < 40 && Math.abs(sized.h - h) < 40) return false;
    sized = { w, h };
    if (driving()) await post("/size", { width: w, height: h }).catch(() => null);
    return true;
  }

  function fit() {
    if (!frame) return;
    const s = Math.min(stage.clientWidth / frame.width, stage.clientHeight / frame.height, 1.5);
    canvas.style.width = Math.floor(frame.width * s) + "px";
    canvas.style.height = Math.floor(frame.height * s) + "px";
  }

  async function draw(data, id, w, h) {
    try {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (id !== latest) { bmp.close(); return; }
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
      frame = { width: w, height: h };
      fit();
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
      show(null);
    } catch {}
  }

  function connect() {
    if (stopped) return;
    const s = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + base + "/stream");
    socket = s;
    s.onopen = () => { attempts = 0; };
    s.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "status") { load(); return; }
      if (m.type === "error") { if (/blocked|isn't part/i.test(m.error || "")) toast(m.error, 4000); return; }
      if (m.type !== "frame" || typeof m.data !== "string") return;
      void draw(m.data, ++latest, m.width || 1280, m.height || 800).finally(() => { if (s.readyState === 1) s.send('{"type":"ack"}'); });
    };
    s.onclose = (e) => {
      if (socket !== s) return;
      socket = null;
      if (e.code === 4001) { load(); return; }
      if (stopped) return;
      if (++attempts > 2) show("Reconnecting…");
      setTimeout(connect, Math.min(15000, 500 * 2 ** attempts));
    };
  }

  const send = (m) => { if (driving() && socket && socket.readyState === 1) socket.send(JSON.stringify(m)); };
  const bits = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0);
  const at = (e) => { if (!frame) return null; const r = canvas.getBoundingClientRect(); if (!r.width) return null;
    return { x: Math.round((e.clientX - r.left) / r.width * frame.width), y: Math.round((e.clientY - r.top) / r.height * frame.height) }; };
  let move = null, wheel = null, queued = false;
  const flush = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false;
    if (move) { send(move); move = null; } if (wheel) { send(Object.assign({ type: "wheel" }, wheel)); wheel = null; } }); };
  const mouse = (kind) => (e) => {
    const p = at(e); if (!p) return;
    const m = Object.assign({ type: "mouse", event: kind, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clickCount: kind === "moved" ? 0 : Math.max(1, e.detail || 1), modifiers: bits(e) }, p);
    if (kind === "moved") { move = m; flush(); return; }
    if (move) { send(move); move = null; }
    send(m);
  };
  canvas.addEventListener("mousedown", (e) => { canvas.focus(); mouse("pressed")(e); });
  canvas.addEventListener("mouseup", mouse("released"));
  canvas.addEventListener("mousemove", mouse("moved"));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => { const p = at(e); if (!p) return; e.preventDefault();
    wheel = Object.assign({}, p, { deltaX: (wheel ? wheel.deltaX : 0) + e.deltaX, deltaY: (wheel ? wheel.deltaY : 0) + e.deltaY, modifiers: bits(e) }); flush(); }, { passive: false });
  // Touch: a tap clicks, a drag scrolls.
  let touch = null;
  canvas.addEventListener("touchstart", (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY, moved: false }; e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (!touch) return; const dx = touch.x - t.clientX, dy = touch.y - t.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 6) { touch.moved = true; const p = at(t); if (p) { wheel = Object.assign({}, p, { deltaX: dx * 2, deltaY: dy * 2, modifiers: 0 }); flush(); } touch.x = t.clientX; touch.y = t.clientY; }
    e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchend", (e) => { const t = e.changedTouches[0]; if (touch && !touch.moved) { const p = at(t); if (p) {
    send(Object.assign({ type: "mouse", event: "pressed", button: "left", clickCount: 1, modifiers: 0 }, p)); send(Object.assign({ type: "mouse", event: "released", button: "left", clickCount: 1, modifiers: 0 }, p)); } }
    touch = null; e.preventDefault(); }, { passive: false });
  const key = (e) => e.key === "Meta" ? { key: "Control", code: e.code === "MetaRight" ? "ControlRight" : "ControlLeft", windowsVirtualKeyCode: 17 } : { key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode };
  const isPaste = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
  window.addEventListener("keydown", (e) => { if (!driving() || isPaste(e) || e.target === doneBtn) return; e.preventDefault();
    send(Object.assign({ type: "key", event: "down" }, key(e), e.key.length === 1 ? { text: e.key } : {}, { modifiers: bits(e) })); }, true);
  window.addEventListener("keyup", (e) => { if (!driving() || isPaste(e) || e.target === doneBtn) return; e.preventDefault();
    send(Object.assign({ type: "key", event: "up" }, key(e), { modifiers: bits(e) })); });
  window.addEventListener("paste", (e) => { const text = e.clipboardData && e.clipboardData.getData("text"); if (text) { e.preventDefault(); send({ type: "text", text }); } });

  doneBtn.onclick = async () => {
    const lend = info && info.mode === "lend";
    if (!confirm(lend ? "Finish? This closes the shared browser." : "Done signing in? We'll take it from here.")) return;
    doneBtn.disabled = true;
    await post("/done").catch(() => null);
    await load();
  };

  const tick = () => { if (!info) return; const s = Math.max(0, info.exp - Date.now() / 1000);
    $("left").textContent = s > 86400 ? Math.floor(s / 86400) + "d " + Math.floor(s % 86400 / 3600) + "h left" : s > 3600 ? Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m left" : Math.floor(s / 60) + "m left";
    if (s <= 0) stop("This link has expired."); };
  let resizing;
  window.addEventListener("resize", () => { fit(); clearTimeout(resizing); resizing = setTimeout(async () => { if (await size() && socket) socket.close(); }, 700); });

  (async () => {
    if (!(await load()) || stopped) return;
    await size();
    connect();
    tick(); setInterval(tick, 30000);
    setInterval(() => { if (!stopped) load(); }, 15000);
  })();
})();
</script></body></html>`;
}

/** The replay of a share's recording: its frames at their own pace, idle gaps shortened. */
export function replayPage(): string {
  return `${HEAD}<title>Recording · Shared browser</title>
<style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font:14px/1.4 system-ui,sans-serif}
#bar{height:48px;display:flex;align-items:center;gap:12px;padding:0 12px;background:#161b22;border-bottom:1px solid #30363d}
#t{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button,select{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:5px 10px}
input[type=range]{flex:2}#when{color:#8b949e;font-variant-numeric:tabular-nums;white-space:nowrap}
#stage{position:absolute;top:48px;left:0;right:0;bottom:0;display:grid;place-items:center}img{max-width:100%;max-height:100%;background:#fff}</style></head><body>
<div id="bar"><div id="t">Recording</div><button id="play">Play</button><select id="speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option><option value="8">8×</option></select><input id="pos" type="range" min="0" value="0"><span id="when"></span></div>
<div id="stage"><img id="img" alt="Recorded screen"></div>
<script>
(async () => {
  const base = "/_computer/r/" + location.pathname.split("/")[3];
  const r = await fetch(base + "/frames", { cache: "no-store" });
  if (!r.ok) { document.body.innerHTML = '<p style="padding:24px">This recording is not available.</p>'; return; }
  const { frames, title } = await r.json();
  document.getElementById("t").textContent = (title || "Shared browser") + " · " + frames.length + " frames";
  const img = document.getElementById("img"), pos = document.getElementById("pos"), when = document.getElementById("when"), play = document.getElementById("play"), speed = document.getElementById("speed");
  if (!frames.length) { when.textContent = "Nothing was recorded."; return; }
  pos.max = frames.length - 1;
  const at = (i) => Number(frames[i].split(".")[0]);
  const show = (i) => { pos.value = i; img.src = base + "/f/" + frames[i]; when.textContent = new Date(at(i)).toLocaleString(); };
  let i = 0, timer = null;
  const step = () => { if (i >= frames.length - 1) { stopPlay(); return; } const gap = Math.min(at(i + 1) - at(i), 3000) / Number(speed.value); i++; show(i); timer = setTimeout(step, Math.max(gap, 30)); };
  const stopPlay = () => { clearTimeout(timer); timer = null; play.textContent = "Play"; };
  play.onclick = () => { if (timer) stopPlay(); else { if (i >= frames.length - 1) i = 0; play.textContent = "Pause"; step(); } };
  pos.oninput = () => { stopPlay(); i = Number(pos.value); show(i); };
  show(0);
})();
</script></body></html>`;
}
