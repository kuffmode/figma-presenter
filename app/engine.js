// Rendering engine: draws slides on one WebGPU canvas, runs Figma shader modules
// unmodified on the layers that carry them, and tweens between two slides.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(1, Math.max(0, v));

const QUAD_WGSL = /* wgsl */`
struct U {
  box: vec4f,    // centre.xy and size.xy in slide px
  xf: vec4f,     // cos, sin of the rotation (clockwise), slide width, slide height
  tint: vec4f,   // premultiplied colour multiplier
  misc: vec4f,   // opacity, mix between t0 and t1, corner radius (px), unused
  uv: vec4f,     // texture coordinate scale.xy, offset.xy
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t0: texture_2d<f32>;
@group(0) @binding(3) var t1: texture_2d<f32>;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) c: vec2f) -> V {
  var o: V;
  let l = (c - vec2f(0.5)) * u.box.zw;
  let p = u.box.xy + vec2f(l.x * u.xf.x - l.y * u.xf.y, l.x * u.xf.y + l.y * u.xf.x);
  o.p = vec4f(p.x / u.xf.z * 2.0 - 1.0, 1.0 - p.y / u.xf.w * 2.0, 0.0, 1.0);
  o.uv = c;
  return o;
}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let q = uv * u.uv.xy + u.uv.zw;
  let a = textureSampleLevel(t0, s, q, 0.0);
  let b = textureSampleLevel(t1, s, q, 0.0);
  var c = mix(a, b, u.misc.y) * u.tint;
  let r = u.misc.z;
  if (r > 0.0) {
    let half = u.box.zw * 0.5;
    let e = abs(uv * u.box.zw - half) - (half - vec2f(r));
    let d = length(max(e, vec2f(0.0))) + min(max(e.x, e.y), 0.0) - r;
    c = c * clamp(0.5 - d, 0.0, 1.0);
  }
  return c * u.misc.x;
}`;

// Figma blend modes mapped to what fixed-function blending can express (premultiplied alpha).
const OVER = { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" };
const BLEND_STATES = {
  NORMAL: { color: OVER, alpha: OVER },
  MULTIPLY: { color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: OVER },
  SCREEN: { color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" }, alpha: OVER },
  ADD: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: OVER },
};
const BLEND_ALIAS = {
  PASS_THROUGH: "NORMAL", NORMAL: "NORMAL", MULTIPLY: "MULTIPLY", DARKEN: "MULTIPLY", LINEAR_BURN: "MULTIPLY",
  COLOR_BURN: "MULTIPLY", SCREEN: "SCREEN", LIGHTEN: "SCREEN", COLOR_DODGE: "SCREEN", LINEAR_DODGE: "ADD",
};
const INTERMEDIATE = "rgba8unorm";

// ---------------------------------------------------------------------------
// Shader modules
// ---------------------------------------------------------------------------

// Loads a Figma shader source (the module with setup/render/defineProperties) as-is.
export async function loadShaderModule(source) {
  const shim = "const __defs = {}; const defineProperties = (fn, defs) => { Object.assign(__defs, defs); };";
  const importLine = /import\s*\{[^}]*\}\s*from\s*["']figma:shaders["'];?/;
  if (!importLine.test(source)) throw new Error("Not a Figma shader module (no figma:shaders import).");
  const code = source.replace(importLine, shim) + "\nexport const __properties = __defs;\n";
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}

function isDiscrete(def, value) {
  if (typeof value === "boolean" || typeof value === "string") return true;
  return !!def && (def.control === "select" || def.type === "boolean" || def.type === "string");
}

function mixValue(a, b, t) {
  if (typeof a === "number" && typeof b === "number") return lerp(a, b, t);
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a)) return a.length === b.length ? a.map((v, i) => mixValue(v, b[i], t)) : (t < 0.5 ? a : b);
    const out = {};
    for (const k in a) out[k] = k in b ? mixValue(a[k], b[k], t) : a[k];
    return out;
  }
  return t < 0.5 ? a : b;
}

// Blend two parameter sets. Settings that cannot be blended numerically are taken from `side`.
function mixParams(defs, a, b, t, side) {
  const out = {};
  for (const k in a) {
    if (!(k in b)) { out[k] = a[k]; continue; }
    out[k] = isDiscrete(defs[k], a[k]) ? (side === "a" ? a[k] : b[k]) : mixValue(a[k], b[k], t);
  }
  for (const k in b) if (!(k in out)) out[k] = b[k];
  return out;
}

function discreteDiffer(defs, a, b) {
  for (const k in a) if (k in b && isDiscrete(defs[k], a[k]) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  return false;
}

class ShaderInstance {
  constructor(engine, mod) {
    this.engine = engine; this.mod = mod; this.sharp = true; this.frameCount = 0; this.lastTime = 0;
    this.defs = mod.__properties || {};
    this.frame = { input: null, output: null, params: {}, state: {}, time: 0, deltaTime: 0, frame: 0, mousePosition: { x: 0, y: 0 } };
    mod.setup(engine.device, this.frame);
  }
  // Renders the effect for `source` (a bitmap texture) at a logical size; returns a new texture the caller owns.
  run(source, lw, lh, params, timeMs) {
    const { engine } = this, { device } = engine;
    const pw = Math.min(8192, Math.max(1, Math.round(lw * engine.scale))), ph = Math.min(8192, Math.max(1, Math.round(lh * engine.scale)));
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const input = device.createTexture({ size: [pw, ph], format: INTERMEDIATE, usage });
    const output = device.createTexture({ size: [pw, ph], format: INTERMEDIATE, usage });
    engine.blit(source, input);
    const f = this.frame;
    f.params = params; f.time = timeMs; f.deltaTime = this.frameCount ? timeMs - this.lastTime : 0; f.frame = this.frameCount++;
    this.lastTime = timeMs;
    const attempt = sharp => {
      // "Sharp": the shader is told the layer's slide-pixel size while drawing into a denser texture,
      // so pixel-based patterns keep their designed size but render at full screen resolution.
      const lwI = Math.max(1, Math.round(lw)), lhI = Math.max(1, Math.round(lh));
      const wrap = tex => !sharp ? tex : new Proxy(tex, { get(t, k) {
        if (k === "width") return lwI; if (k === "height") return lhI;
        const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
      } });
      f.input = wrap(input); f.output = wrap(output);
      this.mod.render(device, f);
    };
    try { attempt(this.sharp); }
    catch (err) {
      if (!this.sharp) throw err;
      this.sharp = false; attempt(false);                 // this shader needs real texture sizes
    }
    f.input = null; f.output = null;
    engine.trash.push(input);
    return output;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class Engine {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error("This browser has no WebGPU. Use a recent Chrome or Edge.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No GPU adapter available.");
    const device = await adapter.requestDevice();
    const engine = new Engine(canvas, device);
    device.lost.then(info => { if (info.reason !== "destroyed") engine.onError(new Error("The graphics device was lost: " + info.message)); });
    await engine.init();
    return engine;
  }

  constructor(canvas, device) {
    this.canvas = canvas; this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx = canvas ? canvas.getContext("webgpu") : null;
    this.scale = 1; this.pxW = 1; this.pxH = 1;
    this.textures = new Map();      // asset name -> { tex, view }
    this.instances = new Map();     // layer object -> ShaderInstance
    this.staticOut = new Map();     // layer object -> { tex, key }
    this.modules = new Map();       // shader version -> module | null
    this.videos = new Map();        // video hash -> { el, tex, view }
    this.slideTex = null;
    this.plans = new Map();
    this.trash = [];
    this.uniforms = []; this.uniformCursor = 0;
    this.onError = () => {};
    device.addEventListener("uncapturederror", e => this.onError(e.error));
  }

  async init() {
    const { device } = this;
    const module = device.createShaderModule({ code: QUAD_WGSL });
    this.quad = device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(this.quad.getMappedRange()).set([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
    this.quad.unmap();
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (format, blend) => device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, format: "float32x2", offset: 0 }] }] },
      fragment: { module, entryPoint: "fs", targets: [blend ? { format, blend } : { format }] },
      primitive: { topology: "triangle-list" },
    });
    const names = Object.keys(BLEND_STATES);
    const built = await Promise.all([...names.map(n => make(this.format, BLEND_STATES[n])), make(INTERMEDIATE, null)]);
    this.pipelines = {};
    names.forEach((n, i) => { this.pipelines[n] = built[i]; });
    this.copyPipeline = built[names.length];
    const white = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 });
    this.white = white.createView();
  }

  // loaders: { bitmap(assetName) -> Promise<ImageBitmap>, shaderSource(version) -> Promise<string|null> }
  setDeck(deck, loaders) {
    this.clear();
    this.deck = deck; this.loaders = loaders;
  }

  clear() {
    for (const t of this.textures.values()) t.tex.destroy();
    for (const o of this.staticOut.values()) o.tex.destroy();
    for (const v of this.videos.values()) { if (v.el) v.el.pause(); if (v.tex) v.tex.destroy(); }
    this.textures.clear(); this.staticOut.clear(); this.instances.clear(); this.plans.clear(); this.videos.clear();
    if (this.slideTex) this.slideTex.key = null;
  }

  resize(pxW, pxH) {
    this.pxW = Math.max(1, Math.round(pxW)); this.pxH = Math.max(1, Math.round(pxH));
    if (this.canvas) {
      this.canvas.width = this.pxW; this.canvas.height = this.pxH;
      this.ctx.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
    }
    this.scale = this.pxW / this.deck.width;
    for (const o of this.staticOut.values()) o.tex.destroy();
    this.staticOut.clear();
    if (this.slideTex) this.slideTex.key = null;
  }

  // Loads everything the given slides need (textures, shader modules and instances) and frees the rest.
  async prepare(indices) {
    const keep = new Set(), jobs = [];
    const wanted = indices.filter(i => i >= 0 && i < this.deck.slides.length);
    for (const i of wanted) for (const layer of this.deck.slides[i].layers) {
      if (layer.asset) { keep.add(layer.asset); if (!this.textures.has(layer.asset)) jobs.push(this.loadTexture(layer.asset)); }
      if (layer.kind === "shader") jobs.push(this.loadInstance(layer));
      if (layer.kind === "video") jobs.push(this.loadVideo(layer.video.hash));
    }
    await Promise.all(jobs);
    for (const [name, t] of this.textures) if (!keep.has(name)) { t.tex.destroy(); this.textures.delete(name); }
    const live = new Set(wanted.flatMap(i => this.deck.slides[i].layers));
    for (const [layer, o] of this.staticOut) if (!live.has(layer)) { o.tex.destroy(); this.staticOut.delete(layer); }
    for (const layer of this.instances.keys()) if (!live.has(layer)) this.instances.delete(layer);
    if (this.slideTex) this.slideTex.key = null;
  }

  async loadTexture(name) {
    if (this.textures.has(name)) return;
    const pending = this.loaders.bitmap(name).then(bitmap => {
      const tex = this.device.createTexture({
        size: [bitmap.width, bitmap.height], format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex, premultipliedAlpha: true }, [bitmap.width, bitmap.height]);
      if (bitmap.close) bitmap.close();
      this.textures.set(name, { tex, view: tex.createView() });
    });
    await pending;
  }

  async loadInstance(layer) {
    if (this.instances.has(layer)) return;
    const version = layer.shader.version;
    if (!this.modules.has(version)) {
      this.modules.set(version, (async () => {
        const source = await this.loaders.shaderSource(version);
        if (!source) return null;
        try { return await loadShaderModule(source); }
        catch (err) { this.onError(new Error(`Shader ${version.slice(0, 8)} failed to load: ${err.message}`)); return null; }
      })());
    }
    const mod = await this.modules.get(version);
    if (!mod || this.instances.has(layer)) return;
    try { this.instances.set(layer, new ShaderInstance(this, mod)); }
    catch (err) { this.onError(new Error(`Shader setup failed on "${layer.name}": ${err.message}`)); }
  }

  missingShaders() {
    const out = new Set();
    for (const [version, mod] of this.modules) if (mod === null) out.add(version);
    return [...out];
  }

  // --- low-level drawing ---------------------------------------------------
  nextUniform() {
    if (this.uniformCursor === this.uniforms.length) {
      this.uniforms.push({ buffer: this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), data: new Float32Array(20) });
    }
    return this.uniforms[this.uniformCursor++];
  }

  bind(u, view0, view1) {
    this.device.queue.writeBuffer(u.buffer, 0, u.data);
    return this.device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: { buffer: u.buffer } },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: view0 },
      { binding: 3, resource: view1 },
    ] });
  }

  // Copies (and rescales) a texture into another texture.
  blit(sourceView, target) {
    const u = this.nextUniform();
    u.data.set([0.5, 0.5, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0]);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
    pass.setPipeline(this.copyPipeline);
    pass.setBindGroup(0, this.bind(u, sourceView, sourceView));
    pass.setVertexBuffer(0, this.quad);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  // --- planning a transition -----------------------------------------------
  plan(a, b, style) {
    const id = `${a}:${b}:${style}`;
    if (this.plans.has(id)) return this.plans.get(id);
    const A = this.deck.slides[a].layers, B = this.deck.slides[b].layers;
    let items;
    if (a === b) items = A.map((l, i) => ({ A: l, B: l, order: i }));
    else {
      const match = style === "SMART_ANIMATE";
      const byKeyB = new Map(B.map(l => [l.key, l]));
      const usedB = new Set(), pairOfA = new Map();
      if (match) for (const l of A) {
        const m = byKeyB.get(l.key);
        if (m && m.kind === l.kind && !usedB.has(m)) { usedB.add(m); pairOfA.set(l, m); }
      }
      const pairOfB = new Map([...pairOfA].map(([la, lb]) => [lb, la]));
      items = B.map((l, i) => ({ A: pairOfB.get(l) || null, B: l, order: i }));
      let anchor = -1;
      A.forEach((l, i) => {
        const m = pairOfA.get(l);
        if (m) anchor = B.indexOf(m);
        else items.push({ A: l, B: null, order: anchor + 0.5 + i / 10000 });
      });
      items.sort((x, y) => x.order - y.order);
    }
    this.plans.set(id, items);
    if (this.plans.size > 12) this.plans.delete(this.plans.keys().next().value);
    return items;
  }

  // Output of a shader layer that is not changing (cached until resize).
  staticOutput(layer, timeMs) {
    const inst = this.instances.get(layer), src = this.textures.get(layer.asset);
    if (!inst || !src) return null;
    const animated = !!layer.shader.animated;
    const cached = this.staticOut.get(layer);
    if (cached && !animated) return cached.tex;
    const tex = inst.run(src.view, layer.rect[2], layer.rect[3], layer.shader.params, timeMs);
    if (cached) this.trash.push(cached.tex);
    this.staticOut.set(layer, { tex });
    return tex;
  }

  // --- videos ----------------------------------------------------------------
  async loadVideo(hash) {
    if (this.videos.has(hash)) return;
    this.videos.set(hash, { el: null, tex: null, view: null });
    const el = this.loaders.video ? await this.loaders.video(hash).catch(() => null) : null;
    const entry = this.videos.get(hash);
    if (entry) entry.el = el;
  }

  // Copies the current video frame into a texture; returns it, or null while no frame is available.
  videoFrame(hash) {
    const v = this.videos.get(hash);
    if (!v || !v.el || v.el.readyState < 2 || !v.el.videoWidth) return null;
    const w = v.el.videoWidth, h = v.el.videoHeight;
    if (!v.tex || v.w !== w || v.h !== h) {
      if (v.tex) this.trash.push(v.tex);
      v.tex = this.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      v.view = v.tex.createView(); v.w = w; v.h = h;
    }
    try { this.device.queue.copyExternalImageToTexture({ source: v.el }, { texture: v.tex, premultipliedAlpha: true }, [w, h]); }
    catch (err) { return null; }
    return v;
  }

  videoElements(index) {
    return this.deck.slides[index].layers.filter(l => l.kind === "video").map(l => ({ layer: l, el: (this.videos.get(l.video.hash) || {}).el })).filter(x => x.el);
  }

  // --- frame ---------------------------------------------------------------
  // Draws the move from slide a to slide b. g = eased progress (springs may overshoot 1).
  // a === b draws one slide. Smart animate tweens layers; every other style moves or fades whole slides.
  draw(a, b, g = 0, style = "SMART_ANIMATE", timeMs = 0, targetView = null) {
    const target = targetView || this.ctx.getCurrentTexture().createView();
    if (a === b || style === "SMART_ANIMATE") { this.drawLayers(a, b, g, timeMs, target); return; }
    // Whole-slide transitions: draw each slide to its own picture once, then move the pictures.
    const key = `${a}:${b}:${this.pxW}x${this.pxH}`;
    if (!this.slideTex || this.slideTex.w !== this.pxW || this.slideTex.h !== this.pxH) {
      if (this.slideTex) this.slideTex.tex.forEach(t => t.destroy());
      const make = () => this.device.createTexture({ size: [this.pxW, this.pxH], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const tex = [make(), make()];
      this.slideTex = { tex, views: tex.map(t => t.createView()), w: this.pxW, h: this.pxH, key: null };
    }
    if (this.slideTex.key !== key || this.isAnimated(a) || this.isAnimated(b)) {
      this.drawLayers(a, a, 0, timeMs, this.slideTex.views[0]);
      this.drawLayers(b, b, 0, timeMs, this.slideTex.views[1]);
      this.slideTex.key = key;
    }
    const W = this.deck.width, H = this.deck.height, k = clamp01(g);
    const m = /^(SLIDE_FROM|PUSH_FROM|MOVE_FROM|SLIDE_OUT_TO|MOVE_OUT_TO)_(LEFT|RIGHT|TOP|BOTTOM)$/.exec(style);
    const side = m ? { LEFT: [-1, 0], RIGHT: [1, 0], TOP: [0, -1], BOTTOM: [0, 1] }[m[2]] : [0, 0];
    // Each entry: which slide picture, its offset in slides, its opacity. Later entries are drawn on top.
    let quads;
    if (!m) quads = [[0, 0, 0, 1], [1, 0, 0, k]];                                             // dissolve
    else if (m[1] === "PUSH_FROM") quads = [[0, -side[0] * g, -side[1] * g, 1], [1, side[0] * (1 - g), side[1] * (1 - g), 1]];
    else if (m[1] === "MOVE_FROM") quads = [[0, 0, 0, 1], [1, side[0] * (1 - g), side[1] * (1 - g), 1]];
    else if (m[1] === "SLIDE_FROM") quads = [[0, 0, 0, 1 - k], [1, side[0] * (1 - g), side[1] * (1 - g), 1]];
    else if (m[1] === "MOVE_OUT_TO") quads = [[1, 0, 0, 1], [0, side[0] * g, side[1] * g, 1]];
    else quads = [[1, 0, 0, 1], [0, side[0] * g, side[1] * g, 1 - k * k * k]];               // slide out: leaves while fading late
    this.uniformCursor = 0;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
    pass.setVertexBuffer(0, this.quad);
    pass.setPipeline(this.pipelines.NORMAL);
    for (const [which, dx, dy, opacity] of quads) {
      if (opacity <= 0) continue;
      const u = this.nextUniform();
      u.data.set([W / 2 + dx * W, H / 2 + dy * H, W, H, 1, 0, W, H, 1, 1, 1, 1, opacity, 0, 0, 0, 1, 1, 0, 0]);
      const view = this.slideTex.views[which];
      pass.setBindGroup(0, this.bind(u, view, view));
      pass.draw(6);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  drawLayers(a, b, g, timeMs, target) {
    const { device, deck } = this;
    const k = clamp01(g), moving = a !== b;
    const SA = deck.slides[a], SB = deck.slides[b];
    const items = this.plan(a, b, "SMART_ANIMATE");
    this.uniformCursor = 0;
    const draws = [];

    for (const it of items) {
      const { A, B } = it, L = B || A;
      const matched = A && B && moving;
      let rect = matched ? A.rect.map((v, i) => lerp(v, B.rect[i], g)) : L.rect;
      let rot = L.rot || 0;
      if (matched) {
        const ra = A.rot || 0; let d = ((B.rot || 0) - ra) % 360;
        if (d > 180) d -= 360; else if (d < -180) d += 360;
        rot = ra + d * g;
      }
      if (!matched && moving && L.parent) {
        // A layer with no partner still travels with its container when the container has one.
        const ga = SA.groups && SA.groups[L.parent], gb = SB.groups && SB.groups[L.parent];
        if (ga && gb) {
          const own = B ? gb : ga;
          rect = [lerp(ga[0], gb[0], g) + (L.rect[0] - own[0]), lerp(ga[1], gb[1], g) + (L.rect[1] - own[1]), L.rect[2], L.rect[3]];
        }
      }
      const opacity = !moving || matched ? 1 : (B ? k : 1 - k);
      if (opacity <= 0 || rect[2] <= 0 || rect[3] <= 0) continue;
      let view0 = this.white, view1 = this.white, mix = 0, tint = [1, 1, 1, 1], radius = 0, uv = [1, 1, 0, 0];

      if (L.kind === "solid") {
        const ca = (A || B).color, cb = (B || A).color;
        const c = ca.map((v, i) => lerp(v, cb[i], k));
        tint = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
        radius = lerp((A || B).radius || 0, (B || A).radius || 0, k);
      } else if (L.kind === "shader") {
        const instA = A && this.instances.get(A), instB = B && this.instances.get(B);
        const srcA = A && this.textures.get(A.asset), srcB = B && this.textures.get(B.asset);
        if (!matched) {
          const out = this.staticOutput(L, timeMs);
          const plain = this.textures.get(L.asset);
          if (!out && !plain) continue;
          view0 = view1 = out ? out.createView() : plain.view;
        } else if (!instA || !instB || !srcA || !srcB) {
          if (!srcA || !srcB) continue;
          view0 = srcA.view; view1 = srcB.view; mix = k;       // shader code missing: show the plain pictures
        } else {
          const same = A.shader.version === B.shader.version;
          const defs = instA.defs;
          const pa = same ? mixParams(defs, A.shader.params, B.shader.params, k, "a") : A.shader.params;
          const pb = same ? mixParams(defs, A.shader.params, B.shader.params, k, "b") : B.shader.params;
          const twoSided = !same || A.asset !== B.asset || discreteDiffer(defs, A.shader.params, B.shader.params);
          const outA = instA.run(srcA.view, rect[2], rect[3], pa, timeMs);
          this.trash.push(outA);
          view0 = view1 = outA.createView();
          if (twoSided && k > 0) {
            const outB = (same ? instA : instB).run(srcB.view, rect[2], rect[3], pb, timeMs);
            this.trash.push(outB);
            view1 = outB.createView(); mix = k;
          }
        }
      } else {
        const frame = L.kind === "video" ? this.videoFrame(L.video.hash) : null;
        if (frame) {
          // Figma's "fill" mode: cover the layer, centred.
          const va = frame.w / frame.h, la = rect[2] / rect[3];
          uv = va > la ? [la / va, 1, (1 - la / va) / 2, 0] : [1, va / la, 0, (1 - va / la) / 2];
          view0 = view1 = frame.view; radius = L.radius || 0;
        } else {
          const ta = A && this.textures.get(A.asset), tb = B && this.textures.get(B.asset);
          if (!ta && !tb) continue;
          view0 = (ta || tb).view; view1 = (tb || ta).view;
          mix = matched && A.asset !== B.asset ? k : 0;
        }
      }

      const u = this.nextUniform(), rad = rot * Math.PI / 180;
      u.data.set([
        rect[0] + rect[2] / 2, rect[1] + rect[3] / 2, rect[2], rect[3],
        Math.cos(rad), Math.sin(rad), deck.width, deck.height,
        tint[0], tint[1], tint[2], tint[3],
        opacity, mix, radius, 0,
        uv[0], uv[1], uv[2], uv[3],
      ]);
      draws.push({ pipeline: this.pipelines[BLEND_ALIAS[L.blend] || "NORMAL"], group: this.bind(u, view0, view1) });
    }

    const bg = SA.background.map((v, i) => lerp(v, SB.background[i], k));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 }, storeOp: "store" }] });
    pass.setVertexBuffer(0, this.quad);
    for (const d of draws) { pass.setPipeline(d.pipeline); pass.setBindGroup(0, d.group); pass.draw(6); }
    pass.end();
    device.queue.submit([encoder.finish()]);
    for (const t of this.trash) t.destroy();
    this.trash.length = 0;
  }

  // True when the slide needs redrawing every frame (a time-driven shader or a playing video).
  isAnimated(index) {
    return this.deck.slides[index].layers.some(l =>
      (l.kind === "shader" && l.shader.animated && this.instances.has(l)) ||
      (l.kind === "video" && (() => { const v = this.videos.get(l.video.hash); return v && v.el && !v.el.paused && !v.el.ended; })()));
  }
}
