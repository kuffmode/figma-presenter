import { Engine } from "./engine.js";
import { curve } from "./easing.js";
import * as store from "./store.js";
import { Repo } from "./gh.js";

const $ = id => document.getElementById(id);
const VIEWS = ["setup", "library", "loading", "present", "presenter"];
const show = name => VIEWS.forEach(v => { $("view-" + v).hidden = v !== name; });
const channel = new BroadcastChannel("figma-presenter");
const isPresenterWindow = new URLSearchParams(location.search).has("presenter");

const config = {
  get repo() { return localStorage.getItem("presenter.repo") || ""; },
  get token() { return localStorage.getItem("presenter.token") || ""; },
  save(repo, token) { localStorage.setItem("presenter.repo", repo); localStorage.setItem("presenter.token", token); },
};
const repo = () => new Repo(config.repo, config.token);

function toast(text, action) {
  const el = $("toast");
  el.textContent = text;
  if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = e => { e.stopPropagation(); el.hidden = true; action.run(); }; el.append(b); }
  el.hidden = false;
  clearTimeout(toast.timer);
  if (!action) toast.timer = setTimeout(() => { el.hidden = true; }, 9000);
}
$("toast").addEventListener("click", () => { $("toast").hidden = true; });

// ---------------------------------------------------------------------------
// Deck data
// ---------------------------------------------------------------------------
async function blobBytes(sha) {
  let buf = await store.get("blobs", sha);
  if (!buf) { buf = await repo().blob(sha); await store.set("blobs", sha, buf); }
  return buf;
}

async function assetBlob(deck, name) {
  const a = deck.assets[name];
  if (!a) throw new Error(`Deck is missing asset ${name}`);
  const buf = await blobBytes(a.blob);
  const bytes = a.length != null ? buf.slice(a.offset, a.offset + a.length) : buf;
  return new Blob([bytes], { type: a.type || "image/png" });
}

async function shaderSource(version) {
  const key = "shader:" + version;
  let src = await store.get("kv", key);
  if (!src && navigator.onLine && config.token) {
    src = await repo().shaderSource(version).catch(() => null);
    if (src) await store.set("kv", key, src);
  }
  return src || null;
}

const VIDEO_TYPES = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
let videoListing = null;
async function videoInfo(hash) {
  let info = await store.get("kv", "video:" + hash);
  if (!info && navigator.onLine && config.token) {
    videoListing ??= await repo().list("videos").catch(() => []);
    const file = videoListing.find(f => f.name.startsWith(hash));
    if (file) { info = { sha: file.sha, type: VIDEO_TYPES[file.name.split(".").pop().toLowerCase()] || "video/mp4" }; await store.set("kv", "video:" + hash, info); }
  }
  return info || null;
}
async function videoElement(hash) {
  const info = await videoInfo(hash);
  if (!info) return null;
  const el = document.createElement("video");
  el.src = URL.createObjectURL(new Blob([await blobBytes(info.sha)], { type: info.type }));
  el.playsInline = true; el.preload = "auto";
  el.onplay = el.onseeked = () => redraw();
  await new Promise(resolve => { el.onloadeddata = resolve; el.onerror = resolve; setTimeout(resolve, 8000); });
  return el.readyState >= 2 ? el : null;
}

const thumbUrls = new Map();
async function thumbUrl(deck, index) {
  const name = deck.slides[index] && deck.slides[index].thumb;
  if (!name) return "";
  const key = deck.id + ":" + name;
  if (!thumbUrls.has(key)) thumbUrls.set(key, URL.createObjectURL(await assetBlob(deck, name)));
  return thumbUrls.get(key);
}

const deckBlobs = deck => [...new Set(Object.values(deck.assets).map(a => a.blob))];

// ---------------------------------------------------------------------------
// Setup and library
// ---------------------------------------------------------------------------
function openSetup(canCancel) {
  $("cfg-repo").value = config.repo; $("cfg-token").value = config.token;
  $("cfg-cancel").hidden = !canCancel; $("cfg-msg").textContent = "";
  show("setup");
}
$("cfg-save").onclick = async () => {
  const full = $("cfg-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""), token = $("cfg-token").value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(full) || !token) { $("cfg-msg").textContent = "Enter the repository as owner/name and a token."; return; }
  $("cfg-msg").textContent = "Checking…";
  try { await new Repo(full, token).request(""); }
  catch (err) { $("cfg-msg").textContent = err.message + " Check the repository name and that the token can read it."; return; }
  config.save(full, token);
  openLibrary();
};
$("cfg-cancel").onclick = () => openLibrary();
$("lib-settings").onclick = () => openSetup(true);
$("lib-refresh").onclick = () => openLibrary();

async function openLibrary() {
  show("library");
  let decks = (await store.get("kv", "decks")) || [];
  renderLibrary(decks);
  if (!navigator.onLine) { $("lib-status").textContent = "Offline: showing saved decks"; return; }
  $("lib-status").textContent = "Checking for updates…";
  try {
    decks = await repo().listDecks();
    decks.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    await store.set("kv", "decks", decks);
    $("lib-status").textContent = "";
    renderLibrary(decks);
  } catch (err) { $("lib-status").textContent = "Could not reach GitHub: " + err.message; }
}

async function renderLibrary(decks) {
  const grid = $("deck-grid");
  grid.replaceChildren();
  $("lib-empty").hidden = decks.length > 0;
  const cached = new Set(await store.keys("blobs"));
  for (const deck of decks) {
    const card = document.createElement("button");
    card.className = "deck";
    const offline = deckBlobs(deck).every(sha => cached.has(sha));
    const when = deck.publishedAt ? new Date(deck.publishedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    card.innerHTML = `<div class="thumb"></div><div class="meta"><b></b><span></span></div>`;
    card.querySelector("b").textContent = deck.name;
    card.querySelector("span").textContent = `${deck.slides.length} slides · ${when}${offline ? " · saved offline" : ""}`;
    card.onclick = () => openDeck(deck);
    grid.append(card);
    thumbUrl(deck, 0).then(url => { if (url) card.querySelector(".thumb").style.backgroundImage = `url(${url})`; }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Presenting
// ---------------------------------------------------------------------------
const P = {
  deck: null, engine: null, index: 0, anim: null, busy: false,
  timer: { running: false, base: 0, since: 0 },
  laserOn: false, trail: [], stats: null, loop: null,
};
// Which slide's transition plays when moving forward: the slide being left.
const transitionFor = (from, to) => P.deck.slides[Math.min(from, to)].transition || { style: "NONE" };
const elapsed = () => P.timer.base + (P.timer.running ? Date.now() - P.timer.since : 0);
const fmt = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0"); };

async function openDeck(deck) {
  show("loading");
  $("load-title").textContent = deck.name;
  try {
    videoListing = null;
    const videoHashes = Object.keys(deck.videos || {});
    const videoInfos = await Promise.all(videoHashes.map(h => videoInfo(h).catch(() => null)));
    const shas = [...deckBlobs(deck), ...videoInfos.filter(Boolean).map(i => i.sha)], have = new Set(await store.keys("blobs"));
    const missing = shas.filter(s => !have.has(s));
    let done = 0;
    const progress = () => { $("load-bar").style.width = (missing.length ? done / missing.length * 100 : 100) + "%"; $("load-text").textContent = missing.length ? `Downloading ${done} of ${missing.length}` : "Preparing…"; };
    progress();
    const queue = [...missing];
    await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { await blobBytes(queue.shift()); done++; progress(); } }));
    await store.set("kv", "deck:" + deck.id, deck);
    $("load-text").textContent = "Preparing…";

    if (!P.engine) {
      P.engine = await Engine.create($("stage"));
      P.engine.onError = err => { console.error(err); toast("Graphics error: " + err.message); };
    }
    P.deck = deck; P.index = firstVisible(0, 1); P.timer = { running: false, base: 0, since: 0 };
    P.engine.setDeck(deck, {
      bitmap: async name => createImageBitmap(await assetBlob(deck, name), { premultiplyAlpha: "premultiply" }),
      shaderSource,
      video: videoElement,
    });
    show("present");
    layout();
    await P.engine.prepare(windowAround(P.index));
    // Warm the first transition so nothing is compiled while it plays.
    const next = firstVisible(P.index + 1, 1);
    if (next !== P.index) P.engine.draw(P.index, next, 0.5, styleOf(transitionFor(P.index, next)), 0);
    enterSlide();
    reportMissing(videoHashes.filter((h, i) => !videoInfos[i]));
    broadcast();
  } catch (err) {
    console.error(err);
    show("library"); toast("Could not open the deck: " + err.message);
  }
}

// Things the plugin cannot read from Figma (shader code, video files) are added here once.
function reportMissing(missingVideos) {
  const shaders = P.engine.missingShaders();
  if (!shaders.length && !missingVideos.length) return;
  const sName = v => (P.deck.shaders && P.deck.shaders[v] && P.deck.shaders[v].name) || v.slice(0, 8);
  const vName = h => (P.deck.videos[h] && P.deck.videos[h].name) || h.slice(0, 8);
  const parts = [];
  if (shaders.length) parts.push(`shader code for ${shaders.map(sName).join(", ")}`);
  if (missingVideos.length) parts.push(`the video file for ${missingVideos.map(vName).join(", ")}`);
  toast(`Not in the decks repository yet: ${parts.join("; ")}. Shown without it for now.`, { label: "Add files", run: async () => {
    for (const v of shaders) if (!await addFile(`Choose the code file for the shader “${sName(v)}”`, ".js,.ts,.mjs,text/javascript,text/plain", f => addShader(v, f))) return;
    for (const h of missingVideos) if (!await addFile(`Choose the video file for “${vName(h)}”`, "video/*,.mp4,.mov,.webm,.m4v", f => addVideo(h, f))) return;
    P.engine.modules.clear();
    openDeck(P.deck);
  } });
}

function addFile(prompt, accept, save) {
  return new Promise(resolve => {
    const input = document.createElement("input"); input.type = "file"; input.accept = accept;
    input.oncancel = () => resolve(false);
    input.onchange = async () => {
      if (!input.files[0]) return resolve(false);
      toast("Uploading " + input.files[0].name + "…");
      try { await save(input.files[0]); resolve(true); }
      catch (err) { toast("Could not save the file: " + err.message); resolve(false); }
    };
    toast(prompt, { label: "Choose file", run: () => input.click() });
  });
}

async function addShader(version, file) {
  const source = await file.text();
  await repo().putShader(version, source);
  await store.set("kv", "shader:" + version, source);
}

async function addVideo(hash, file) {
  const buffer = await file.arrayBuffer();
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const sha = await repo().putFile(`videos/${hash}.${ext}`, new Uint8Array(buffer), `Add video ${file.name}`);
  await store.set("blobs", sha, buffer);
  await store.set("kv", "video:" + hash, { sha, type: file.type || VIDEO_TYPES[ext] || "video/mp4" });
}

const windowAround = i => [i - 1, i, i + 1, i + 2];
function firstVisible(from, step) {
  const slides = P.deck.slides;
  for (let i = from; i >= 0 && i < slides.length; i += step) if (!slides[i].skipped) return i;
  return Math.min(Math.max(P.index, 0), slides.length - 1);
}

function layout() {
  if (!P.deck) return;
  const scale = Math.min(innerWidth / P.deck.width, innerHeight / P.deck.height);
  const w = P.deck.width * scale, h = P.deck.height * scale, st = $("stage").style;
  st.width = w + "px"; st.height = h + "px"; st.left = (innerWidth - w) / 2 + "px"; st.top = (innerHeight - h) / 2 + "px";
  P.stageBox = { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
  P.engine.resize(w * devicePixelRatio, h * devicePixelRatio);
  const lc = $("laser"); lc.width = innerWidth * devicePixelRatio; lc.height = innerHeight * devicePixelRatio;
  if (!P.anim) redraw();
}

const styleOf = tr => tr.style || "NONE";

// Called whenever a slide becomes the current one.
function enterSlide() {
  for (const v of P.engine.videos.values()) if (v.el) v.el.pause();
  for (const { el } of P.engine.videoElements(P.index)) { el.currentTime = 0; el.play().catch(() => {}); }
  $("tb-count").textContent = `${P.index + 1} / ${P.deck.slides.length}`;
  redraw();
}

function redraw() {
  if (P.anim) return;
  P.engine.draw(P.index, P.index, 0, "SMART_ANIMATE", performance.now());
  cancelAnimationFrame(P.loop);
  if (P.engine.isAnimated(P.index)) P.loop = requestAnimationFrame(redraw);
}

async function go(target) {
  if (!P.deck || P.busy) return;
  if (P.anim) { cancelAnimationFrame(P.anim.raf); P.index = P.anim.to; P.anim = null; enterSlide(); }
  target = Math.min(Math.max(target, 0), P.deck.slides.length - 1);
  if (target === P.index) return;
  const from = P.index;
  if (!P.timer.running && P.timer.base === 0) { P.timer.running = true; P.timer.since = Date.now(); }
  P.busy = true;
  await P.engine.prepare([...new Set([from, ...windowAround(target)])]);
  P.busy = false;
  const tr = transitionFor(from, target);
  const adjacent = Math.abs(target - from) === 1 || P.deck.slides.slice(Math.min(from, target) + 1, Math.max(from, target)).every(s => s.skipped);
  if (!adjacent || styleOf(tr) === "NONE" || !(tr.duration > 0)) { P.index = target; enterSlide(); broadcast(); return; }
  cancelAnimationFrame(P.loop);
  const style = styleOf(tr);
  for (const v of P.engine.videos.values()) if (v.el) v.el.pause();
  const ease = curve(tr.curve, tr.duration), start = performance.now();
  // Going back plays the same transition in reverse.
  const [a, b, reverse] = target > from ? [from, target, false] : [target, from, true];
  const stats = { frames: 0, sum: 0, max: 0, slow: 0 };
  let last = start;
  const step = now => {
    const dt = now - last; last = now;
    if (stats.frames++ > 0) { stats.sum += dt; stats.max = Math.max(stats.max, dt); if (dt > 20) stats.slow++; }
    const sec = (now - start) / 1000;
    if (sec >= tr.duration) { P.anim = null; P.index = target; enterSlide(); showStats(stats); return; }
    const g = ease(sec);
    P.engine.draw(a, b, reverse ? 1 - g : g, style, now);
    P.anim.raf = requestAnimationFrame(step);
  };
  P.anim = { to: target, raf: requestAnimationFrame(step) };
  broadcast(target);
}
const next = () => go(firstVisible((P.anim ? P.anim.to : P.index) + 1, 1));
const prev = () => go(firstVisible((P.anim ? P.anim.to : P.index) - 1, -1));

function showStats(s) {
  const n = Math.max(1, s.frames - 1);
  $("hud").textContent = `last transition\nframes        ${s.frames}\navg frame     ${(s.sum / n).toFixed(1)} ms\nworst frame   ${s.max.toFixed(1)} ms\nframes >20 ms ${s.slow}\nrender size   ${P.engine.pxW} x ${P.engine.pxH}`;
}

function exitDeck() {
  cancelAnimationFrame(P.loop);
  if (P.anim) cancelAnimationFrame(P.anim.raf);
  P.anim = null; P.deck = null; P.engine.clear();
  if (document.fullscreenElement) document.exitFullscreen();
  openLibrary();
}

// --- timer -----------------------------------------------------------------
function timerAction(action) {
  const t = P.timer;
  if (action === "reset") { t.base = 0; t.since = Date.now(); }
  else if (t.running) { t.base = elapsed(); t.running = false; }
  else { t.running = true; t.since = Date.now(); }
  broadcast();
}
setInterval(() => { if (P.deck) $("timer-chip").textContent = fmt(elapsed()); }, 250);

// --- laser pointer ---------------------------------------------------------
// Points are stored in slide coordinates (0..1) so the presenter window can drive it too.
function laserPoint(x, y) {
  P.trail.push({ x, y, t: performance.now() });
  if (!P.laserRaf) P.laserRaf = requestAnimationFrame(drawLaser);
}
function drawLaser(now) {
  const c = $("laser"), g = c.getContext("2d"), box = P.stageBox, dpr = devicePixelRatio;
  g.clearRect(0, 0, c.width, c.height);
  P.trail = P.trail.filter(p => now - p.t < 320);
  const live = P.laserHold && (P.laserOn || now - P.laserHold.t < 1500) ? P.laserHold : null;
  if (!box || (!P.trail.length && !live)) { P.laserRaf = 0; return; }
  const px = p => [(box.x + p.x * box.w) * dpr, (box.y + p.y * box.h) * dpr];
  const r = Math.max(5, box.w * 0.005) * dpr;
  g.lineCap = "round"; g.lineJoin = "round";
  for (let i = 1; i < P.trail.length; i++) {
    const a = P.trail[i - 1], b = P.trail[i], age = 1 - (now - b.t) / 320;
    g.strokeStyle = `rgba(255,40,40,${0.55 * age})`; g.lineWidth = r * 1.4 * age;
    g.beginPath(); g.moveTo(...px(a)); g.lineTo(...px(b)); g.stroke();
  }
  const head = P.trail[P.trail.length - 1] || live;
  if (head) {
    const [x, y] = px(head);
    g.shadowColor = "rgba(255,30,30,.9)"; g.shadowBlur = r * 3;
    g.fillStyle = "#ff3b30"; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.shadowBlur = 0; g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(x, y, r * 0.35, 0, 7); g.fill();
  }
  P.laserRaf = requestAnimationFrame(drawLaser);
}

let cursorTimer;
$("view-present").addEventListener("mousemove", e => {
  const view = $("view-present");
  if (P.laserOn && P.stageBox && !$("toolbar").contains(e.target)) {
    const p = { x: (e.clientX - P.stageBox.x) / P.stageBox.w, y: (e.clientY - P.stageBox.y) / P.stageBox.h, t: performance.now() };
    P.laserHold = p; laserPoint(p.x, p.y);
    if (e.clientY > 90) { view.classList.remove("pointer"); return; }
  }
  view.classList.add("pointer");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => { if (!$("toolbar").matches(":hover")) view.classList.remove("pointer"); }, 2200);
});
$("view-present").addEventListener("click", e => {
  // Clicking a video plays or pauses it, as in Figma; anywhere else moves on.
  if (P.stageBox && !P.anim) {
    const x = (e.clientX - P.stageBox.x) / P.stageBox.w * P.deck.width, y = (e.clientY - P.stageBox.y) / P.stageBox.h * P.deck.height;
    const hit = P.engine.videoElements(P.index).reverse().find(({ layer: l }) => x >= l.rect[0] && x <= l.rect[0] + l.rect[2] && y >= l.rect[1] && y <= l.rect[1] + l.rect[3]);
    if (hit) { hit.el.paused || hit.el.ended ? hit.el.play().catch(() => {}) : hit.el.pause(); redraw(); return; }
  }
  next();
});

const actions = {
  full: () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); },
  notes: () => window.open(location.pathname + "?presenter", "figma-presenter-notes", "width=1180,height=760"),
  laser: () => { P.laserOn = !P.laserOn; P.laserHold = null; $("tb-laser").classList.toggle("on", P.laserOn); },
  timer: () => { $("timer-chip").hidden = !$("timer-chip").hidden; $("tb-timer").classList.toggle("on", !$("timer-chip").hidden); },
  help: () => { $("help").hidden = !$("help").hidden; },
};
$("toolbar").addEventListener("click", e => e.stopPropagation());
$("tb-back").onclick = () => exitDeck();
$("tb-prev").onclick = () => prev();
$("tb-next").onclick = () => next();
for (const name of ["full", "notes", "laser", "timer", "help"]) $("tb-" + name).onclick = actions[name];

addEventListener("keydown", e => {
  if ($("view-present").hidden || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(k)) { e.preventDefault(); next(); }
  else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) { e.preventDefault(); prev(); }
  else if (k === "Home") go(firstVisible(0, 1));
  else if (k === "End") go(firstVisible(P.deck.slides.length - 1, -1));
  else if (k === "f" || k === "F") actions.full();
  else if (k === "l" || k === "L") actions.laser();
  else if (k === "t" || k === "T") actions.timer();
  else if (k === "d" || k === "D") $("hud").hidden = !$("hud").hidden;
  else if (k === "h" || k === "H" || k === "?") actions.help();
  else if (k === "p" || k === "P") actions.notes();
  else if (k === "Escape" && !document.fullscreenElement) exitDeck();
});
addEventListener("resize", () => { if (!$("view-present").hidden) layout(); });

// --- link to the presenter window ------------------------------------------
function broadcast(indexOverride) {
  if (!P.deck) return;
  channel.postMessage({ type: "state", deckId: P.deck.id, index: indexOverride ?? P.index, total: P.deck.slides.length, timer: { ...P.timer }, sentAt: Date.now() });
}
if (!isPresenterWindow) channel.onmessage = e => {
  const m = e.data;
  if (!P.deck) return;
  if (m.type === "hello") broadcast(P.anim ? P.anim.to : P.index);
  else if (m.type === "go") (m.delta > 0 ? next : prev)();
  else if (m.type === "timer") timerAction(m.action);
  else if (m.type === "laser") { if (m.x == null) P.laserHold = null; else { P.laserHold = { x: m.x, y: m.y, t: performance.now() }; laserPoint(m.x, m.y); } }
};

// ---------------------------------------------------------------------------
// Presenter window (notes, next slide, timer, laser)
// ---------------------------------------------------------------------------
function startPresenterWindow() {
  show("presenter");
  document.title = "Presenter notes";
  let state = null, deck = null;
  const render = async () => {
    if (!state) return;
    if (!deck || deck.id !== state.deckId) deck = await store.get("kv", "deck:" + state.deckId);
    if (!deck) return;
    const slide = deck.slides[state.index];
    let nextIndex = state.index + 1;
    while (deck.slides[nextIndex] && deck.slides[nextIndex].skipped) nextIndex++;
    $("p-cur").src = await thumbUrl(deck, state.index).catch(() => "");
    $("p-next").src = deck.slides[nextIndex] ? await thumbUrl(deck, nextIndex).catch(() => "") : "";
    $("p-next").style.visibility = deck.slides[nextIndex] ? "visible" : "hidden";
    $("p-notes").textContent = slide.notes || "";
    $("p-count").textContent = `Slide ${state.index + 1} of ${state.total}`;
    $("p-toggle").textContent = state.timer.running ? "Pause" : (state.timer.base ? "Resume" : "Start");
  };
  channel.onmessage = e => { if (e.data.type === "state") { state = e.data; render(); } };
  channel.postMessage({ type: "hello" });
  setInterval(() => {
    $("p-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (state) $("p-timer").textContent = fmt(state.timer.base + (state.timer.running ? Date.now() - state.timer.since : 0));
  }, 250);
  $("p-fwd").onclick = () => channel.postMessage({ type: "go", delta: 1 });
  $("p-prev").onclick = () => channel.postMessage({ type: "go", delta: -1 });
  $("p-toggle").onclick = () => channel.postMessage({ type: "timer", action: "toggle" });
  $("p-reset").onclick = () => channel.postMessage({ type: "timer", action: "reset" });
  addEventListener("keydown", e => {
    if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(e.key)) { e.preventDefault(); channel.postMessage({ type: "go", delta: 1 }); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); channel.postMessage({ type: "go", delta: -1 }); }
  });
  // Adjustable layout: drag the dividers, change the notes text size; remembered between sessions.
  const root = $("view-presenter");
  const saved = JSON.parse(localStorage.getItem("presenter.layout") || "{}");
  const layoutState = { side: saved.side || 320, notes: saved.notes || 34, size: saved.size || 20 };
  const applyLayout = () => {
    root.style.setProperty("--side", layoutState.side + "px"); root.style.setProperty("--notes", layoutState.notes + "%"); root.style.setProperty("--notes-size", layoutState.size + "px");
    localStorage.setItem("presenter.layout", JSON.stringify(layoutState));
  };
  applyLayout();
  const drag = (handle, onMove) => handle.addEventListener("pointerdown", e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add("drag");
    const move = ev => { onMove(ev); applyLayout(); };
    const up = () => { handle.classList.remove("drag"); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  });
  drag($("split-side"), ev => { const r = root.getBoundingClientRect(); layoutState.side = Math.round(Math.min(r.width - 220, Math.max(180, r.right - 16 - ev.clientX))); });
  drag($("split-notes"), ev => { const r = root.getBoundingClientRect(); layoutState.notes = Math.round(Math.min(85, Math.max(8, (r.bottom - 16 - ev.clientY) / r.height * 100))); });
  $("p-smaller").onclick = () => { layoutState.size = Math.max(12, layoutState.size - 2); applyLayout(); };
  $("p-larger").onclick = () => { layoutState.size = Math.min(64, layoutState.size + 2); applyLayout(); };

  const img = $("p-cur");
  img.addEventListener("mousemove", e => {
    const r = img.getBoundingClientRect();
    channel.postMessage({ type: "laser", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  });
  img.addEventListener("mouseleave", () => channel.postMessage({ type: "laser", x: null }));
}

// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (isPresenterWindow) startPresenterWindow();
else if (!config.repo || !config.token) openSetup(false);
else openLibrary();
