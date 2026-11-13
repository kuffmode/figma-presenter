// Publish to Presenter: exports a Figma Slides deck (layers, shader settings, transitions,
// notes, thumbnails) and hands it to the plugin window, which uploads it to GitHub.
// Written in plain ES2017 for the plugin sandbox.

var EXPORT_SCALE = 2;
var MAX_DESCEND_CHILDREN = 12;
var warnings = [];
var assetCounter = 0;

function post(msg) { figma.ui.postMessage(msg); }

function pngSize(bytes) {
  return {
    w: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0,
    h: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0
  };
}

function visibleShaderEffects(node) {
  if (!('effects' in node)) return [];
  return node.effects.filter(function (e) { return e.type === 'SHADER' && e.visible !== false; });
}

function subtreeHasShader(node) {
  if (visibleShaderEffects(node).length) return true;
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].visible && subtreeHasShader(node.children[i])) return true;
    }
  }
  return false;
}

function visiblePaints(paints) {
  if (!paints || paints === figma.mixed) return [];
  return paints.filter(function (p) { return p.visible !== false; });
}

function boxOf(node, origin) {
  var b = node.absoluteBoundingBox;
  return b ? [b.x - origin.x, b.y - origin.y, b.width, b.height] : null;
}

// Can this container be taken apart so its children animate on their own?
function canDescend(node, forced) {
  if (!('children' in node) || node.children.length === 0) return false;
  if (node.type === 'BOOLEAN_OPERATION') return false;
  if (forced) return true;
  if (node.children.length > MAX_DESCEND_CHILDREN) return false;
  for (var i = 0; i < node.children.length; i++) if (node.children[i].isMask) return false;
  if (node.opacity !== 1) return false;
  if (node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') return false;
  if ('effects' in node && node.effects.some(function (e) { return e.visible !== false; })) return false;
  if (node.type === 'GROUP') return true;
  if (node.type !== 'FRAME' && node.type !== 'INSTANCE' && node.type !== 'COMPONENT') return false;
  if (visiblePaints(node.strokes).length) return false;
  var fills = visiblePaints(node.fills);
  if (fills.length > 1 || (fills.length === 1 && fills[0].type !== 'SOLID')) return false;
  if (fills.length === 1 && (node.cornerRadius === figma.mixed || Math.abs(node.rotation) > 0.01)) return false;
  if (node.clipsContent) {
    var nb = node.absoluteBoundingBox;
    for (var j = 0; j < node.children.length; j++) {
      var c = node.children[j];
      if (!c.visible) continue;
      var cb = c.absoluteBoundingBox;
      if (!nb || !cb) return false;
      if (cb.x < nb.x - 1 || cb.y < nb.y - 1 || cb.x + cb.width > nb.x + nb.width + 1 || cb.y + cb.height > nb.y + nb.height + 1) return false;
    }
  }
  return true;
}

// Rotation of a node on the slide, in degrees clockwise.
function rotationOf(node) {
  var t = node.absoluteTransform;
  var deg = Math.atan2(t[1][0], t[0][0]) * 180 / Math.PI;
  return Math.abs(deg) < 0.01 ? 0 : deg;
}

function topVideoFill(node) {
  if (!('fills' in node) || node.fills === figma.mixed) return null;
  var fills = visiblePaints(node.fills);
  var top = fills[fills.length - 1];
  return top && top.type === 'VIDEO' && top.videoHash ? top : null;
}

// Where an exported picture sits on the slide. The export covers the node's full painted area,
// which can be larger than its box (shadows, strokes, text overhang).
function placeExport(node, size, origin, upright) {
  var w = size.w / EXPORT_SCALE, h = size.h / EXPORT_SCALE;
  var bb = node.absoluteBoundingBox, rb = node.absoluteRenderBounds;
  // A rotated layer is exported upright; it sits centred on the rotated layer's centre.
  if (upright && bb) return [bb.x + bb.width / 2 - w / 2 - origin.x, bb.y + bb.height / 2 - h / 2 - origin.y, w, h];
  if (bb && Math.abs(bb.width - w) < 1 && Math.abs(bb.height - h) < 1) return [bb.x - origin.x, bb.y - origin.y, w, h];
  if (rb && Math.abs(rb.width - w) < 1.5 && Math.abs(rb.height - h) < 1.5) return [rb.x - origin.x, rb.y - origin.y, w, h];
  if (bb) return [bb.x + bb.width / 2 - w / 2 - origin.x, bb.y + bb.height / 2 - h / 2 - origin.y, w, h];
  return null;
}

async function exportPng(node) {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: EXPORT_SCALE } });
}

// Exports a temporary copy of a layer: optionally without shader effects and upright.
// The copy is placed where no slide clips it, and is always removed again.
async function exportCopy(node, stripShaders, upright) {
  var copy = null;
  try {
    copy = node.clone();
    if (stripShaders) copy.effects = node.effects.filter(function (e) { return e.type !== 'SHADER'; });
    if (upright) copy.rotation = 0;
    if (copy.parent && copy.parent.type !== 'PAGE') { try { figma.currentPage.appendChild(copy); } catch (e) {} }
    if (copy.parent && copy.parent.type === 'PAGE') { copy.x = -60000; copy.y = -60000; }
    else if (copy.parent && 'width' in copy.parent) { copy.x = (copy.parent.width - copy.width) / 2; copy.y = (copy.parent.height - copy.height) / 2; }
    var bytes = await exportPng(copy);
    var got = pngSize(bytes);
    if (got.w <= 2 && got.h <= 2 && node.width > 4 && node.height > 4) throw new Error('the copy could not be drawn');
    return bytes;
  } finally {
    if (copy) { try { copy.remove(); } catch (e) {} }
  }
}

function sendAsset(bytes, type) {
  var id = 'a' + (++assetCounter);
  post({ type: 'asset', id: id, bytes: bytes, mime: type });
  return id;
}

async function exportShaderLayer(node, effect, ctx) {
  // The shader needs the layer's picture without the effect: export a temporary copy with shader effects removed.
  var bytes = null, rot = rotationOf(node);
  try { bytes = await exportCopy(node, true, !!rot); }
  catch (err) { warnings.push('"' + node.name + '": could not export without its shader (' + err.message + '); published with the effect baked in.'); }
  if (!bytes) return exportBitmapLayer(node, ctx);
  var rect = placeExport(node, pngSize(bytes), ctx.origin, !!rot);
  if (!rect) return null;
  var params = {};
  var meta = effect.propertyMetadata || {};
  for (var key in effect.properties) {
    var name = meta[key] && meta[key].name ? meta[key].name : key;
    params[name] = effect.properties[key];
  }
  var version = String(effect.id).split('/').pop();
  ctx.shaders[version] = true;
  if (visibleShaderEffects(node).length > 1) warnings.push('"' + node.name + '" has several shader effects; only the first is published.');
  return { kind: 'shader', rect: rect, rot: rot, asset: sendAsset(bytes, 'image/png'), shader: { version: version, params: params } };
}

// A layer that reaches past the slide edge is cut off there when exported in place. Exporting a
// temporary copy placed outside the slide gives the whole layer, so it can move into view intact.
function reachesPastSlide(node, ctx) {
  var b = node.absoluteBoundingBox, s = ctx.slideBox;
  if (!b) return false;
  return b.x < s.x - 0.5 || b.y < s.y - 0.5 || b.x + b.width > s.x + s.width + 0.5 || b.y + b.height > s.y + s.height + 0.5;
}

async function exportBitmapLayer(node, ctx) {
  var bytes = null, rot = rotationOf(node), upright = false;
  if (rot || (ctx.slideBox && reachesPastSlide(node, ctx))) {
    try { bytes = await exportCopy(node, false, !!rot); upright = !!rot; }
    catch (err) { bytes = null; upright = false; }
  }
  if (!bytes) {
    try { bytes = await exportPng(node); }
    catch (err) { warnings.push('"' + node.name + '" could not be exported: ' + err.message); return null; }
  }
  var rect = placeExport(node, pngSize(bytes), ctx.origin, upright);
  if (!rect) return null;
  return { kind: 'bitmap', rect: rect, rot: upright ? rot : 0, asset: sendAsset(bytes, 'image/png') };
}

async function walk(node, path, parentKey, ctx) {
  var seen = {};
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i];
    var n = seen[child.name] = (seen[child.name] || 0) + 1;
    if (!child.visible) continue;
    var key = (path ? path + '/' : '') + child.name + (n > 1 ? '#' + n : '');
    var layer = null;
    var shaders = visibleShaderEffects(child);
    if (shaders.length) {
      layer = await exportShaderLayer(child, shaders[0], ctx);
    } else {
      var forced = 'children' in child && subtreeHasShader(child);
      if (canDescend(child, forced)) {
        if (forced && !canDescend(child, false)) warnings.push('"' + child.name + '" was taken apart to reach a shader layer inside it; its own clipping, opacity or effects are not published.');
        var box = boxOf(child, ctx.origin);
        if (box) ctx.groups[key] = box;
        var fills = child.type === 'GROUP' ? [] : visiblePaints(child.fills);
        if (fills.length === 1 && fills[0].type === 'SOLID' && box) {
          var f = fills[0];
          ctx.layers.push({
            key: key, name: child.name, parent: parentKey, kind: 'solid', rect: box, blend: 'PASS_THROUGH',
            color: [f.color.r, f.color.g, f.color.b, f.opacity === undefined ? 1 : f.opacity],
            radius: typeof child.cornerRadius === 'number' ? child.cornerRadius : 0
          });
        }
        await walk(child, key, key, ctx);
        continue;
      }
      layer = await exportBitmapLayer(child, ctx);
      var video = layer ? topVideoFill(child) : null;
      if (video) {
        // The picture just exported is the video's current frame; the presenter swaps in the real video.
        layer.kind = 'video';
        layer.video = { hash: video.videoHash };
        layer.radius = typeof child.cornerRadius === 'number' ? child.cornerRadius : 0;
        ctx.videos[video.videoHash] = { name: child.name };
      }
    }
    if (!layer) continue;
    layer.key = key; layer.name = child.name; layer.parent = parentKey;
    layer.blend = 'blendMode' in child ? child.blendMode : 'PASS_THROUGH';
    ctx.layers.push(layer);
  }
}

async function exportSlide(slide, shaders, videos) {
  var t = slide.absoluteTransform;
  var ctx = { origin: { x: t[0][2], y: t[1][2] }, slideBox: { x: t[0][2], y: t[1][2], width: slide.width, height: slide.height }, layers: [], groups: {}, shaders: shaders, videos: videos };
  var hasMask = slide.children.some(function (c) { return c.isMask; });
  if (hasMask) {
    warnings.push('Slide "' + slide.name + '" uses a mask at the top level; it is published as one flat picture.');
    var whole = await exportPng(slide);
    ctx.layers.push({ key: '(slide)', name: slide.name, parent: null, kind: 'bitmap', blend: 'PASS_THROUGH', rect: [0, 0, slide.width, slide.height], asset: sendAsset(whole, 'image/png') });
  } else {
    await walk(slide, '', null, ctx);
  }
  var background = [1, 1, 1];
  var fills = visiblePaints(slide.fills);
  if (fills.length && fills[0].type === 'SOLID') {
    var o = fills[0].opacity === undefined ? 1 : fills[0].opacity;
    background = [1 + (fills[0].color.r - 1) * o, 1 + (fills[0].color.g - 1) * o, 1 + (fills[0].color.b - 1) * o];
  } else if (fills.length) {
    warnings.push('Slide "' + slide.name + '" has a non-solid background; it is published as white.');
  }
  var transition = { style: 'NONE' };
  try {
    var tr = slide.getSlideTransition();
    transition = { style: tr.style, duration: tr.duration, curve: tr.curve, timing: tr.timing };
  } catch (e) {}
  var thumb = await slide.exportAsync({ format: 'JPG', constraint: { type: 'WIDTH', value: 800 } });
  return {
    id: slide.id, name: slide.name, notes: slide.speakerNotes || '', skipped: !!slide.isSkippedSlide,
    background: background, transition: transition, thumb: sendAsset(thumb, 'image/jpeg'),
    layers: ctx.layers, groups: ctx.groups
  };
}

async function publish() {
  warnings = [];
  if (figma.editorType !== 'slides') { post({ type: 'error', message: 'Open a Figma Slides file to publish.' }); return; }
  var slides = [];
  var grid = figma.getSlideGrid();
  for (var r = 0; r < grid.length; r++) for (var c = 0; c < grid[r].length; c++) slides.push(grid[r][c]);
  if (!slides.length) { post({ type: 'error', message: 'This deck has no slides.' }); return; }
  var id = figma.root.getPluginData('presenterDeckId');
  if (!id) {
    id = 'deck-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    figma.root.setPluginData('presenterDeckId', id);
  }
  var shaders = {};
  var videos = {};
  var out = [];
  for (var i = 0; i < slides.length; i++) {
    post({ type: 'progress', stage: 'export', done: i, total: slides.length });
    out.push(await exportSlide(slides[i], shaders, videos));
  }
  var names = {};
  try {
    var available = await figma.listAvailableShaders();
    available.forEach(function (s) { var v = String(s.id).split('/').pop(); if (shaders[v]) names[v] = { name: s.name || '' }; });
  } catch (e) {}
  for (var v in shaders) if (!names[v]) names[v] = { name: '' };
  post({
    type: 'deck', warnings: warnings,
    deck: {
      version: 1, id: id, name: figma.root.name, width: slides[0].width, height: slides[0].height,
      exportScale: EXPORT_SCALE, publishedAt: new Date().toISOString(), shaders: names, videos: videos, slides: out
    }
  });
}

figma.showUI(__html__, { width: 380, height: 460, themeColors: true });
figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'init') {
      post({ type: 'settings', repo: (await figma.clientStorage.getAsync('repo')) || '', token: (await figma.clientStorage.getAsync('token')) || '', deckName: figma.root.name });
    } else if (msg.type === 'save-settings') {
      await figma.clientStorage.setAsync('repo', msg.repo);
      await figma.clientStorage.setAsync('token', msg.token);
    } else if (msg.type === 'publish') {
      if (msg.scale) EXPORT_SCALE = msg.scale;
      await publish();
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
