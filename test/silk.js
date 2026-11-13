// Silkscreen & riso print — Figma shader e8221d3d-a334-4ffb-9a76-6bfc8e0a1f69, version ae5f676f909dbb0499f1f38b3f0b5edf385b7eaf.
// Same shader code and uniform maths as the Figma version, written against the same setup/render contract.
import { defineProperties } from "figma:shaders"

export default function Effect() {}

export function setup(device, frame) {
  const st = frame.state
  st.module = device.createShaderModule({ code: `
diagnostic(off,derivative_uniformity);
struct Uniforms {
  a: vec4f,        // dims.xy, strength, halftoneAmount
  reg: vec4f,      // plate A uv offset.xy, plate C uv offset.xy
  tone: vec4f,     // ink spread uv.xy, contrast, brightness
  rot01: vec4f,    // screen 0 cos/sin, screen 1 cos/sin
  rot2: vec4f,     // screen 2 cos/sin, 1/period, aa
  tex: vec4f,      // spread term, 1/grainSize, grain scale, mottle scale
  ink: vec4f,      // hole edge, hole scale, ink density, paper texture
  mode: vec4f,     // riso, colorMode, registration flag, unused
  inkOne: vec4f,
  inkTwo: vec4f,
  inkThree: vec4f,
  paper: vec4f,    // paper base rgb, unused
  offA: vec4f,     // grain noise offset.xy, fleck noise offset.xy
  offB: vec4f,     // mottle noise offset.xy, paper noise offset.xy
  offC: vec4f,     // fiber noise offset.xy, unused
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var inputTex: texture_2d<f32>;
@group(0) @binding(3) var noiseSamp: sampler;
@group(0) @binding(4) var noiseTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

fn sampleInput(p: vec2f) -> vec4f {
  return textureSampleLevel(inputTex, samp, clamp(p, vec2f(0.0), vec2f(1.0)), 0.0);
}

fn sampleInputOrZero(p: vec2f) -> vec4f {
  let inside = step(vec2f(0.0), p) * step(p, vec2f(1.0));
  return sampleInput(p) * (inside.x * inside.y);
}

fn noiseSmooth(c: vec2f, off: vec2f) -> vec4f {
  let cell = floor(c);
  let f = c - cell;
  let blend = f * f * (3.0 - 2.0 * f);
  let base = fract((cell + off) * 0.001953125);
  return textureSampleLevel(noiseTex, noiseSamp, base + (blend + vec2f(0.5)) * 0.001953125, 0.0);
}

fn noiseCell(c: vec2f, off: vec2f) -> vec4f {
  let base = fract((floor(c) + off) * 0.001953125);
  return textureSampleLevel(noiseTex, noiseSamp, base + vec2f(0.0009765625), 0.0);
}

fn straightPrint(c: vec4f) -> vec3f {
  return mix(vec3f(1.0), c.rgb / max(c.a, 0.00001), step(0.00001, c.a));
}

fn screenPrint(p: vec2f, rot: vec2f, coverage: f32) -> f32 {
  let q = vec2f(rot.x * p.x - rot.y * p.y, rot.y * p.x + rot.x * p.y) * u.rot2.z;
  let aa = u.rot2.w;
  let spreadTerm = u.tex.x;
  let distanceValue = length(fract(q) - vec2f(0.5));
  let radius = sqrt(clamp(coverage, 0.0, 1.0) * 0.31830989) + spreadTerm;
  let dots = 1.0 - smoothstep(radius - aa, radius + aa, distanceValue);
  let inverseRadius = sqrt(clamp(1.0 - coverage, 0.0, 1.0) * 0.31830989) - spreadTerm;
  let inverseDistance = length(fract(q + vec2f(0.5)) - vec2f(0.5));
  let inverseDots = smoothstep(inverseRadius - aa, inverseRadius + aa, inverseDistance);
  let screened = mix(dots, inverseDots, smoothstep(0.4, 0.6, coverage));
  return mix(screened * smoothstep(0.0, 0.025, coverage), 1.0, smoothstep(0.975, 1.0, coverage));
}

@vertex fn vs_main(@location(0) corner: vec2f) -> VsOut {
  var out: VsOut;
  out.position = vec4f(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
  out.uv = corner;
  return out;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let strength = u.a.z;
  let inputColor = sampleInput(uv);
  if (strength == 0.0 || inputColor.a == 0.0) {
    return inputColor * (1.0 - strength);
  }

  let p = uv * u.a.xy;
  let riso = u.mode.x;
  let colorMode = i32(u.mode.y + 0.5);
  let contrast = u.tone.z;
  let brightness = u.tone.w;

  let centerRgb = straightPrint(inputColor);
  var plateA = centerRgb;
  var plateB = centerRgb;
  var plateC = centerRgb;
  if (u.mode.z != 0.0) {
    plateA = straightPrint(sampleInputOrZero(uv + u.reg.xy));
    plateB = straightPrint(sampleInputOrZero(uv - u.reg.xy));
    if (colorMode != 1) {
      plateC = straightPrint(sampleInputOrZero(uv + u.reg.zw));
    }
  }

  var spreadDarkening = vec3f(0.0);
  if (u.tone.x != 0.0) {
    let sx = vec2f(u.tone.x, 0.0);
    let sy = vec2f(0.0, u.tone.y);
    let spreadRgb = min(min(straightPrint(sampleInputOrZero(uv + sx)), straightPrint(sampleInputOrZero(uv - sx))), min(straightPrint(sampleInputOrZero(uv + sy)), straightPrint(sampleInputOrZero(uv - sy))));
    spreadDarkening = max(centerRgb - spreadRgb, vec3f(0.0)) * 0.45;
  }

  let rgbA = clamp((plateA - spreadDarkening - 0.5) * contrast + 0.5 + brightness, vec3f(0.0), vec3f(1.0));
  let rgbB = clamp((plateB - spreadDarkening - 0.5) * contrast + 0.5 + brightness, vec3f(0.0), vec3f(1.0));
  let rgbC = clamp((plateC - spreadDarkening - 0.5) * contrast + 0.5 + brightness, vec3f(0.0), vec3f(1.0));
  let lumaWeights = vec3f(0.2126, 0.7152, 0.0722);
  var coverage = vec3f(1.0 - rgbA.r, 1.0 - rgbB.g, 1.0 - rgbC.b);
  if (colorMode == 1) {
    let darknessA = 1.0 - dot(rgbA, lumaWeights);
    let darknessB = 1.0 - dot(rgbB, lumaWeights);
    coverage = vec3f(pow(darknessA, 1.25), darknessB * (1.0 - darknessB * 0.55), 0.0);
  } else if (colorMode == 2) {
    let darknessA = 1.0 - dot(rgbA, lumaWeights);
    coverage = vec3f(darknessA * 0.85 + max(rgbA.b - rgbA.r, 0.0) * 0.35, max(rgbB.r - rgbB.g, 0.0) * 0.9 + (1.0 - dot(rgbB, lumaWeights)) * 0.32, max(rgbC.r - rgbC.b, 0.0) * 0.9 + (1.0 - dot(rgbC, lumaWeights)) * 0.18);
  }
  coverage = clamp(coverage, vec3f(0.0), vec3f(1.0));

  if (u.a.w != 0.0) {
    let screenedA = screenPrint(p, u.rot01.xy, coverage.x);
    let screenedB = screenPrint(p + vec2f(13.0, 7.0), u.rot01.zw, coverage.y);
    var screenedC = 0.0;
    if (colorMode != 1) {
      screenedC = screenPrint(p + vec2f(3.0, 19.0), u.rot2.xy, coverage.z);
    }
    coverage = mix(coverage, vec3f(screenedA, screenedB, screenedC), u.a.w);
  }

  let grainCoord = p * u.tex.y;
  var textureFactor = vec3f(1.0);
  if (u.tex.z != 0.0) {
    textureFactor = textureFactor + (noiseSmooth(grainCoord, u.offA.xy).rgb - vec3f(0.5)) * u.tex.z;
  }
  if (u.tex.w != 0.0) {
    let mottle = vec3f(noiseSmooth(p * 0.03030303, u.offB.xy).r, noiseSmooth(p * 0.02564103, u.offB.xy).g, noiseSmooth(p * 0.03448276, u.offB.xy).b);
    textureFactor = textureFactor - (vec3f(1.0) - mottle) * u.tex.w;
  }
  var holeFactor = vec3f(1.0);
  if (u.ink.x < 1.0) {
    let fleck = noiseCell(grainCoord, u.offA.zw).rgb;
    let holes = smoothstep(vec3f(u.ink.x), vec3f(1.001), fleck);
    holeFactor = vec3f(1.0) - holes * u.ink.y;
  }
  coverage = clamp(coverage * textureFactor * holeFactor, vec3f(0.0), vec3f(1.0));
  coverage = vec3f(1.0) - pow(vec3f(1.0) - coverage, vec3f(u.ink.z));

  var paper = u.paper.rgb;
  if (u.ink.w != 0.0) {
    let paperFine = noiseSmooth(p * 1.17647059, u.offB.zw).a - 0.5;
    let fibers = noiseSmooth(p * vec2f(0.5, 0.07142857), u.offC.xy).a - 0.5;
    paper = clamp(paper + vec3f((paperFine * 0.11 + fibers * 0.055) * u.ink.w), vec3f(0.0), vec3f(1.0));
  }

  var printed = paper * (vec3f(1.0) - coverage);
  if (colorMode != 0) {
    let inkOne = u.inkOne;
    let inkTwo = u.inkTwo;
    let inkThree = u.inkThree;
    let transA = mix(vec3f(1.0), inkOne.rgb, coverage.x * inkOne.a);
    let transB = mix(vec3f(1.0), inkTwo.rgb, coverage.y * inkTwo.a);
    let transC = mix(vec3f(1.0), inkThree.rgb, coverage.z * inkThree.a);
    let risoColor = paper * transA * transB * transC;
    let screenColor = mix(mix(mix(paper, inkThree.rgb, coverage.z * inkThree.a), inkTwo.rgb, coverage.y * inkTwo.a), inkOne.rgb, coverage.x * inkOne.a);
    printed = mix(screenColor, risoColor, riso);
  }
  return mix(inputColor, vec4f(clamp(printed, vec3f(0.0), vec3f(1.0)) * inputColor.a, inputColor.a), strength);
}
` })
  st.pipeline = null
  st.pipelineFormat = null
  st.quad = device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true })
  new Float32Array(st.quad.getMappedRange()).set([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0])
  st.quad.unmap()
  st.data = new Float32Array(60)
  st.uniformBuf = device.createBuffer({ size: 240, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  st.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
  st.noiseSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" })
  const n = 512, bytes = new Uint8Array(n * n * 4)
  let rng = 0x9e3779b9 | 0
  for (let i = 0; i < bytes.length; i += 4) {
    rng = (rng + 0x6d2b79f5) | 0
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    t = (t ^ (t >>> 14)) >>> 0
    bytes[i] = t & 255; bytes[i + 1] = (t >>> 8) & 255; bytes[i + 2] = (t >>> 16) & 255; bytes[i + 3] = (t >>> 24) & 255
  }
  st.noiseTex = device.createTexture({ size: [n, n, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: st.noiseTex }, bytes, { bytesPerRow: n * 4 }, { width: n, height: n, depthOrArrayLayers: 1 })
  st.noiseView = st.noiseTex.createView()
}

export function render(device, frame) {
  if (frame.input == null) return
  const st = frame.state, p = frame.params || {}, d = st.data
  const num = (v, f) => { const x = Number(v); return Number.isFinite(x) ? x : f }
  const sel = (v, count, f) => { const i = Math.round(Number(v)); return Number.isFinite(i) && i >= 0 && i < count ? i : f }
  const col = (at, v, r, g, b, a) => { const c = v || {}; d[at] = num(c.r, r); d[at + 1] = num(c.g, g); d[at + 2] = num(c.b, b); d[at + 3] = num(c.a, a) }
  const w = Math.max(1, num(frame.output.width, 1)), h = Math.max(1, num(frame.output.height, 1))
  const riso = sel(p.printStyle, 2, 1) === 1
  const grainSize = Math.max(num(p.grainSize, 1.3), 0.5)
  const period = Math.max(num(p.dotSize, 5), 0.5)
  const theta = num(p.screenAngle, 22.5) * 0.01745329252
  const registration = num(p.registration, 0.8)
  const dir = num(p.registrationAngle, 25) * 0.01745329252
  const inkSpread = num(p.inkSpread, 0.35)
  d[0] = w; d[1] = h; d[2] = num(p.strength, 0.8); d[3] = num(p.halftoneAmount, 0.25)
  const ox = Math.cos(dir) * registration / w, oy = Math.sin(dir) * registration / h
  d[4] = ox; d[5] = oy; d[6] = -oy * h / w * 0.7; d[7] = ox * w / h * 0.7
  d[8] = inkSpread / w; d[9] = inkSpread / h; d[10] = num(p.contrast, 1); d[11] = num(p.brightness, 0)
  const a1 = theta + (riso ? 0.52359878 : 1.04719755), a2 = theta + (riso ? 1.04719755 : 0.52359878)
  d[12] = Math.cos(theta); d[13] = Math.sin(theta); d[14] = Math.cos(a1); d[15] = Math.sin(a1)
  d[16] = Math.cos(a2); d[17] = Math.sin(a2); d[18] = 1 / period; d[19] = Math.min(0.22, 0.65 / period)
  d[20] = inkSpread / period * 0.22; d[21] = 1 / grainSize
  d[22] = num(p.grainAmount, 0.18) * (riso ? 1.1 : 0.65); d[23] = num(p.unevenCoverage, 0.2) * (riso ? 0.8 : 0.45)
  d[24] = 1 - num(p.breakup, 0.12) * 0.38; d[25] = riso ? 0.65 : 0.8; d[26] = num(p.inkDensity, 1.05); d[27] = num(p.paperTexture, 0.16)
  d[28] = riso ? 1 : 0; d[29] = sel(p.colorMode, 3, 0); d[30] = registration !== 0 ? 1 : 0; d[31] = 0
  col(32, p.inkOne, 0.08, 0.19, 0.3, 1); col(36, p.inkTwo, 0.9, 0.23, 0.22, 1); col(40, p.inkThree, 0.97, 0.7, 0.19, 1)
  col(44, p.paperColor, 0.98, 0.958, 0.905, 1)
  const pa = d[47]
  for (let i = 44; i < 47; i++) d[i] = Math.min(1, Math.max(0, 1 + (d[i] - 1) * pa))
  d[47] = 0
  const seed = num(p.randomSeed, 7)
  for (let i = 0; i < 10; i++) { const s = Math.sin(seed * 12.9898 + (i + 1) * 78.233) * 43758.5453; d[48 + i] = Math.floor((s - Math.floor(s)) * 512) }
  d[58] = 0; d[59] = 0
  device.queue.writeBuffer(st.uniformBuf, 0, d)

  const format = frame.output.format
  if (st.pipeline == null || st.pipelineFormat !== format) {
    st.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: st.module, entryPoint: "vs_main", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, format: "float32x2", offset: 0 }] }] },
      fragment: { module: st.module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })
    st.pipelineFormat = format
  }
  const bindGroup = device.createBindGroup({ layout: st.pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: st.uniformBuf } },
    { binding: 1, resource: st.sampler },
    { binding: 2, resource: frame.input.createView() },
    { binding: 3, resource: st.noiseSampler },
    { binding: 4, resource: st.noiseView },
  ] })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: frame.output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] })
  pass.setPipeline(st.pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.setVertexBuffer(0, st.quad)
  pass.draw(6)
  pass.end()
  device.queue.submit([encoder.finish()])
}

defineProperties(Effect, {
  printStyle: { type: "number", defaultValue: 1, control: "select" },
  strength: { type: "number", defaultValue: 0.8 },
  grainAmount: { type: "number", defaultValue: 0.18 },
  grainSize: { type: "number", defaultValue: 1.3 },
  breakup: { type: "number", defaultValue: 0.12 },
  unevenCoverage: { type: "number", defaultValue: 0.2 },
  dotSize: { type: "number", defaultValue: 5 },
  screenAngle: { type: "number", defaultValue: 22.5 },
  halftoneAmount: { type: "number", defaultValue: 0.25 },
  registration: { type: "number", defaultValue: 0.8 },
  registrationAngle: { type: "number", defaultValue: 25 },
  inkSpread: { type: "number", defaultValue: 0.35 },
  inkDensity: { type: "number", defaultValue: 1.05 },
  colorMode: { type: "number", defaultValue: 0, control: "select" },
  inkOne: { type: "color", defaultValue: { r: 0.08, g: 0.19, b: 0.3, a: 1 } },
  inkTwo: { type: "color", defaultValue: { r: 0.9, g: 0.23, b: 0.22, a: 1 } },
  inkThree: { type: "color", defaultValue: { r: 0.97, g: 0.7, b: 0.19, a: 1 } },
  paperColor: { type: "color", defaultValue: { r: 0.98, g: 0.958, b: 0.905, a: 1 } },
  paperTexture: { type: "number", defaultValue: 0.16 },
  brightness: { type: "number", defaultValue: 0 },
  contrast: { type: "number", defaultValue: 1 },
  randomSeed: { type: "number", defaultValue: 7 },
})
