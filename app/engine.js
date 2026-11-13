// Rendering engine: draws slides on one WebGPU canvas, runs Figma shader modules
// unmodified on the layers that carry them, and tweens between two slides.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(1, Math.max(0, v));

const QUAD_WGSL = /* wgsl */`
struct U {
  rect: vec4f,   // clip-space origin.xy, size.xy
  tint: vec4f,   // premultiplied colour multiplier
  misc: vec4f,   // opacity, mix between t0 and t1, corner radius (px), unused
  size: vec4f,   // layer size in slide px
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t0: texture_2d<f32>;
@group(0) @binding(3) var t1: texture_2d<f32>;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) c: vec2f) -> V {
  var o: V;
  o.p = vec4f(u.rect.xy + c * u.rect.zw, 0.0, 1.0);
  o.uv = c;
  return o;
}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let a = textureSampleLevel(t0, s, uv, 0.0);
  let b = textureSampleLevel(t1, s, uv, 0.0);
  var c = mix(a, b, u.misc.y) * u.tint;
  let r = u.misc.z;
  if (r > 0.0) {
    let half = u.size.xy * 0.5;
    let q = abs(uv * u.size.xy - half) - (half - vec2f(r));
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
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
    this.textures.clear(); this.staticOut.clear(); this.instances.clear(); this.plans.clear();
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
  }

  // Loads everything the given slides need (textures, shader modules and instances) and frees the rest.
  async prepare(indices) {
    const keep = new Set(), jobs = [];
    const wanted = indices.filter(i => i >= 0 && i < this.deck.slides.length);
    for (const i of wanted) for (const layer of this.deck.slides[i].layers) {
      if (layer.asset) { keep.add(layer.asset); if (!this.textures.has(layer.asset)) jobs.push(this.loadTexture(layer.asset)); }
      if (layer.kind === "shader") jobs.push(this.loadInstance(layer));
    }
    await Promise.all(jobs);
    for (const [name, t] of this.textures) if (!keep.has(name)) { t.tex.destroy(); this.textures.delete(name); }
    const live = new Set(wanted.flatMap(i => this.deck.slides[i].layers));
    for (const [layer, o] of this.staticOut) if (!live.has(layer)) { o.tex.destroy(); this.staticOut.delete(layer); }
    for (const layer of this.instances.keys()) if (!live.has(layer)) this.instances.delete(layer);
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
      this.uniforms.push({ buffer: this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), data: new Float32Array(16) });
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
    u.data.set([-1, 1, 2, -2, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0]);
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

  // --- frame ---------------------------------------------------------------
  // Draws the transition from slide a to slide b. g = eased progress for geometry (may overshoot),
  // style = "SMART_ANIMATE" | "DISSOLVE". a === b draws a single slide.
  draw(a, b, g = 0, style = "SMART_ANIMATE", timeMs = 0, targetView = null) {
    const { device, deck } = this;
    const k = clamp01(g);
    const SA = deck.slides[a], SB = deck.slides[b];
    const items = this.plan(a, b, style);
    this.uniformCursor = 0;
    const draws = [];

    for (const it of items) {
      const { A, B } = it, L = B || A;
      const matched = A && B && a !== b;
      let rect = matched ? A.rect.map((v, i) => lerp(v, B.rect[i], g)) : L.rect;
      if (!matched && a !== b && style === "SMART_ANIMATE" && L.parent) {
        // A layer with no partner still travels with its container when the container has one.
        const ga = SA.groups && SA.groups[L.parent], gb = SB.groups && SB.groups[L.parent];
        if (ga && gb) {
          const own = B ? gb : ga;
          rect = [lerp(ga[0], gb[0], g) + (L.rect[0] - own[0]), lerp(ga[1], gb[1], g) + (L.rect[1] - own[1]), L.rect[2], L.rect[3]];
        }
      }
      const opacity = a === b || matched ? 1 : (B ? k : 1 - k);
      if (opacity <= 0 || rect[2] <= 0 || rect[3] <= 0) continue;
      let view0 = this.white, view1 = this.white, mix = 0, tint = [1, 1, 1, 1], radius = 0;

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
          view0 = srcA.view; view1 = srcB.view; mix = k;       // shader source missing: show the plain images
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
        const ta = A && this.textures.get(A.asset), tb = B && this.textures.get(B.asset);
        if (!ta && !tb) continue;
        view0 = (ta || tb).view; view1 = (tb || ta).view;
        mix = matched && A.asset !== B.asset ? k : 0;
      }

      const u = this.nextUniform();
      u.data.set([
        rect[0] / deck.width * 2 - 1, 1 - rect[1] / deck.height * 2, rect[2] / deck.width * 2, -rect[3] / deck.height * 2,
        tint[0], tint[1], tint[2], tint[3],
        opacity, mix, radius, 0,
        rect[2], rect[3], 0, 0,
      ]);
      draws.push({ pipeline: this.pipelines[BLEND_ALIAS[L.blend] || "NORMAL"], group: this.bind(u, view0, view1) });
    }

    const bg = SA.background.map((v, i) => lerp(v, SB.background[i], k));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: targetView || this.ctx.getCurrentTexture().createView(),
      loadOp: "clear", clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 }, storeOp: "store",
    }] });
    pass.setVertexBuffer(0, this.quad);
    for (const d of draws) { pass.setPipeline(d.pipeline); pass.setBindGroup(0, d.group); pass.draw(6); }
    pass.end();
    device.queue.submit([encoder.finish()]);
    for (const t of this.trash) t.destroy();
    this.trash.length = 0;
  }

  // True when the slide needs redrawing every frame (it has a time-driven shader).
  isAnimated(index) {
    return this.deck.slides[index].layers.some(l => l.kind === "shader" && l.shader.animated && this.instances.has(l));
  }
}
