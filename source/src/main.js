// ============================================================================
// renderer, camera and input
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` (the share done) over ~`ms` on the compositor, so it moves while this
// thread is busy
let loaded = 0, dead; // dead: the graphics device was lost
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  // go on once the animation runs: one not started before the thread gets busy stays stuck (timer: hidden tabs)
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const fail = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message that is shown as it is
if (!navigator.gpu) fail('This scene needs WebGPU. Try a current Chrome or Edge.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter found.');
$('w').hidden = !!navigator.userAgentData; // only Chromium-based browsers have it
const hasTS = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
// out of memory or a GPU timeout: reload a level lower, or on Low say what happened
device.lost.then((l) => {
  if (l.reason === 'destroyed') return; // the page is closing
  if (LV < 2) { keep('abyssal', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;

const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength); return b; };
const tex = (w, h, format, usage, o = {}) => device.createTexture({ size: [w, h, o.d || 1], format, usage, mipLevelCount: o.mips || 1, sampleCount: o.samples || 1, dimension: o.d ? '3d' : '2d' });

// ---------------------------------------------------------------- static resources
const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: LV > 1 ? 1 : 8 });
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const tShadow = tex(SHADOW, SHADOW, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tWater = tex(WATER, WATER, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 5 });
const tDetail = tex(1024, 1024, 'rgba8unorm', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 11 });
const tVol = tex(NX / 2, NY / 2, 'rg8unorm', TU.TEXTURE_BINDING | TU.COPY_DST, { d: NZ / 2 });
const tMap = tex(512, 512, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);

const UB = new Float32Array(60), UBS = new Float32Array(60);
const ubo = device.createBuffer({ size: 240, usage: BU.UNIFORM | BU.COPY_DST }), uboS = device.createBuffer({ size: 240, usage: BU.UNIFORM | BU.COPY_DST });
const WT = new Float32Array(4), uboW = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

const VF = SS.VERTEX | SS.FRAGMENT;
const bgl0 = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} },
  { binding: 1, visibility: VF, sampler: {} }, { binding: 2, visibility: VF, sampler: {} }, { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
  { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
  { binding: 5, visibility: VF, texture: {} }, { binding: 6, visibility: VF, texture: {} },
  { binding: 7, visibility: VF, texture: { viewDimension: '3d' } }, { binding: 8, visibility: VF, texture: {} }] });
const mkBG0 = (u, sh) => device.createBindGroup({ layout: bgl0, entries: [
  { binding: 0, resource: { buffer: u } }, { binding: 1, resource: sRep }, { binding: 2, resource: sClamp }, { binding: 3, resource: sCmp },
  { binding: 4, resource: sh.createView() }, { binding: 5, resource: tWater.createView() }, { binding: 6, resource: tDetail.createView() },
  { binding: 7, resource: tVol.createView() }, { binding: 8, resource: tMap.createView() }] });
const bg0 = mkBG0(ubo, tShadow), bg0s = mkBG0(uboS, tDummy);
const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, sampler: {} }] });
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const mBlit = mod(W_BLIT);
const blitPipe = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: mBlit, entryPoint: 'vs' },
  fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } });
const pMip8 = blitPipe('fsMip', 'rgba8unorm'), pMip16 = blitPipe('fsMip', HDR), pDown0 = blitPipe('fsDown0', HDR), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, true);
const blitBG = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sClamp }] });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// vertex layouts
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const ibSolid = { arrayStride: 48, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4')] };
const ibLeaf = { arrayStride: 36, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4'), A(2, 32, 'unorm8x4')] };
const ibAnim = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] };
const ibBub = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] };
const ibSnow = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] };

const scenePipe = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR, blend: o.blend }] },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.blend, depthCompare: 'greater' }, multisample: { count: AA } });
const shadowPipe = (m, vsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 } });

await say('Compiling shaders…', 0.05, 300);
const mSolid = mod(W_SOLID), mLeaf = mod(W_LEAF), mAnim = mod(W_ANIM), mSurf = mod(W_SURF), mSpr = mod(W_SPR);
const pTerrain = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid], { cull: 'back' });
const pSolid = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid]);
const pLeaf = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 9 } });
const pLeaf5 = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 5 } });
const pLeafS = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3, FAR: 70 } });
const pLeafF = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3 } });
const pFish = scenePipe(mAnim, 'vsFish', 'fsFish', [vbSolid, ibAnim]);
const pManta = scenePipe(mAnim, 'vsManta', 'fsManta', [vbSolid, ibAnim]);
const pSurf = scenePipe(mSurf, 'vs', 'fs', [], { strip: true }), pBack = scenePipe(mSurf, 'vsB', 'fsB', [], { strip: true });
const pBub = scenePipe(mSpr, 'vsBub', 'fsBub', [ibBub], { strip: true, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } });
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const pSnow = scenePipe(mSpr, 'vsSnow', 'fsSnow', [ibSnow], { strip: true, blend: ADD });
const pPod = scenePipe(mod(W_POD), 'vs', 'fs', [{ arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] }], { cull: 'front' });
const pPearl = scenePipe(mod(W_PEARL), 'vs', 'fs', [ibBub], { strip: true, blend: ADD });
const pSwarm = scenePipe(mod(W_SWARM), 'vs', 'fs', [{ arrayStride: 48, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4'), A(2, 32, 'float32x4')] }], { cull: 'front' });
const pGl = scenePipe(mLeaf, 'vsGl', 'fsGl', [ibBub], { strip: true, blend: ADD, constants: { ROWS: 7 } });
const pSolidSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid]), pTerrSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid], { cull: 'front' });
const pLeafSh = shadowPipe(mLeaf, 'vs', [ibLeaf], { strip: true, constants: { ROWS: 3 } });

const mWater = mod(W_WATER);
const pWater = device.createRenderPipeline({ layout: 'auto', vertex: { module: mWater, entryPoint: 'vs' }, fragment: { module: mWater, entryPoint: 'fs', targets: [{ format: HDR }] } });
const bgWater = device.createBindGroup({ layout: pWater.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uboW } }] });
const waterViews = [0, 1, 2, 3, 4].map((m) => tWater.createView({ baseMipLevel: m, mipLevelCount: 1 }));
const waterBG = waterViews.map((v) => blitBG(v));
const waterPass = waterViews.map((v) => ({ colorAttachments: [colorAtt(v, true)] }));

const mRays = mod(W_RAYS), mPost = mod(W_POST), mRB = mod(W_RBLUR), mVox = mod(W_VOX);
const NINK = 16, inkBuf = device.createBuffer({ size: (1 + NINK * 2) * 16, usage: BU.UNIFORM | BU.COPY_DST }), inkArr = new Float32Array((1 + NINK * 2) * 4);
const pVox = device.createRenderPipeline({ layout: 'auto', vertex: { module: mVox, entryPoint: 'vs' }, fragment: { module: mVox, entryPoint: 'fs', targets: [{ format: HDR }] } });
const pRB = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRB, entryPoint: 'vs' }, fragment: { module: mRB, entryPoint: 'fs', targets: [{ format: HDR }] } });
const pRays = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRays, entryPoint: 'vs' }, fragment: { module: mRays, entryPoint: 'fs', targets: [{ format: HDR }] } });
const pPost = device.createRenderPipeline({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] } });

// ---------------------------------------------------------------- sun + shadow matrix
const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l); })();
{
  const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll;
  const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]];
  const R = 225, d0 = -175, d1 = 125, m = UBS;
  m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0;
  m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0;
  m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  for (let i = 0; i < 16; i++) { UBS[16 + i] = m[i]; UB[16 + i] = m[i]; }
  for (let i = 0; i < 3; i++) { UB[48 + i] = UBS[48 + i] = SUN[i]; }
  UBS[32] = 0; UBS[33] = -20; UBS[34] = 0; UBS[35] = 0; UBS[58] = 1;
  Q.writeBuffer(uboS, 0, UBS);
}

// ---------------------------------------------------------------- world generation
await say('Sculpting the seabed…', 0.25, 1200);
// marks a load in progress (quality.js); leaving the page before it ends is not a crash
keep('abyssalLoad', 1);
addEventListener('pagehide', () => keep('abyssalLoad', ''));
let D;
{
  const prims = primBuffer();
  const m = mod(W_DENS), p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const size = NX * NY * NZ * 4;
  const u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = NX; uu[1] = NY; uu[2] = NZ; uf[4] = OX; uf[5] = OY; uf[6] = OZ; uf[7] = VS;
  uu[8] = MESAS.length; uu[9] = ARCHES.length; uu[10] = HOLES.length; uu[11] = CLEARS.length;
  const bu = buf(new Uint8Array(u), BU.UNIFORM), bp = buf(prims, BU.STORAGE);
  const bd = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_SRC }), br = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
  const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bu } }, { binding: 1, resource: { buffer: bd } }, { binding: 2, resource: { buffer: bp } }] });
  const e = device.createCommandEncoder(), c = e.beginComputePass();
  c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(NX / 4, NY / 4, NZ / 4); c.end();
  e.copyBufferToBuffer(bd, 0, br, 0, size);
  Q.submit([e.finish()]);
  await br.mapAsync(GPUMapMode.READ);
  D = new Float32Array(br.getMappedRange().slice(0));
  br.unmap(); br.destroy(); bd.destroy();
  // rock connected to the seabed: each column's unbroken run up from the bottom is, and the rock above a gap
  // (overhangs, specks) is when it touches rock that is. What never connects is a speck of noise floating in
  // the water (surface nets would make it a small box), so it becomes water
  const S = NX * NY, R = new Uint8Array(D.length), O = [1, -1, NX, -NX, S, -S], b = new Uint8Array(NX), L = [];
  for (let i = 0; i < D.length;) { b.fill(1); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++, i++) if (D[i] <= 0) b[x] = 0; else if (b[x]) R[i] = 1; else L.push(i); }
  for (let k = 1; k; L.reverse()) { k = 0; for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1; }
  for (const i of L) if (!R[i]) D[i] = -D[i];
}
// Distance to the rock for collide(), in 1/127 m (> 0 in rock, clamped to ±1 m), kept only in the 4x4x4-voxel
// bricks near the surface within the camera's reach (~2 MB). CI per brick: 0 all water, 1 all rock, n brick n-2 in CG.
const CO = 52, CN = 102, CI = new Uint16Array(CN * CN * NY / 4);
let CG = new Int8Array(64 * 65534);
{
  let n = 0;
  for (let bz = 0; bz < CN; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < CN; bx++) {
    if (hypot(bx - CN / 2 + 0.5, bz - CN / 2 + 0.5) > 52) continue; // more than 156 m out: never reached
    let lo = 127, hi = -127;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = CO + bx * 4 + x + NX * (by * 4 + y + NY * (CO + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY];
      const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.5;
      const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127);
      CG[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q;
    }
    CI[bx + CN * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1);
  }
  CG = CG.slice(0, n * 64);
}
await say('Carving canyons…', 0.32, 400);
const T = buildTerrain(D);

// preset viewpoints (position, look-at), keys 1-6; the world generator dresses the scene around them
const POSES = [
  [10, 1.3, 7, -9, -31, -10],
  [50, 1.3, 34, 58, -23, 8],
  [-26, 2.2, -100, 0, -9, -108],
  [-55, 1.5, -18, -60, -30, 8],
  [10, 1.2, -62, 6, -22, -90],
  [3, 1.6, 62, 1, -28, 100],
];
// 60 s camera path (position + look-at, Catmull-Rom): the world generator keeps it clear, dev.js flies along it
const FLY = new Float32Array([
  10, -42.2, 7, -9, -31, -10,
  7.5, -41.8, 5.5, -10, -31, -12,
  9, -40.5, 18, 17, -37, 42,
  22, -39.2, 40, 48, -36, 45,
  38, -39.2, 46, 57, -27, 18,
  50, -40.4, 35, 58, -24, 8,
  55, -39, 20, 60, -18, -10,
  58, -34, -12, 40, -26, -60,
  50, -30, -44, 10, -26, -80,
  30, -30, -70, 4, -28, -90,
  12, -38.5, -62, 6, -27, -90,
  -4, -36.5, -70, 0, -14, -100,
  -16, -37, -84, 0, -22, -108,
  -29, -38, -90, -44, -34, -60,
  -41, -38, -70, -56, -34, -40,
  -53, -38, -50, -60, -34, -20,
  -58, -38, -28, -60, -32, 0,
  -57, -38, -10, -60, -30, 16,
  -60, -38, 10, -50, -36, 40,
  -52, -37, 36, -20, -35, 44,
  -22, -38, 43, 4, -38, 52,
  -6, -39.2, 44.5, 4, -37, 70,
  3, -40.6, 53, 3, -35, 84,
  3, -41.5, 62, 1, -30, 100,
  4, -39, 76, 3, -22, 100,
]);
const FLYN = FLY.length / 6, FLYT = 60, LUTN = 1024, flyLUT = new Float32Array(LUTN + 1);
const flyPts = [];
// per-frame float state lives in one preallocated array, so the frame loop allocates no heap numbers
const F = new Float64Array(32), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, FLT = 17, LAST = 18, GPU = 19, HUDT = 20, SPL = 21, MX = 22, MY = 23, MZ = 24;
// aim the camera from P6 = position + look-at point
function aim() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2];
  F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aim(); };
// camera spline (Catmull-Rom over position + look-at) at parameter F[SPL]
function flyRaw() {
  const s = F[SPL]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2;
  const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6;
  for (let o = 0; o < 6; o++) {
    const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o];
    P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  }
  aim();
}
{ // arc-length table: flyLUT[k] = spline parameter at fraction k/LUTN of the total path length
  const M = 4096, len = new Float32Array(M + 1); let px = 0, py = 0, pz = 0;
  for (let k = 0; k <= M; k++) { F[SPL] = k / M * (FLYN - 1); flyRaw(); if (k) len[k] = len[k - 1] + hypot(F[CX] - px, F[CY] - py, F[CZ] - pz); px = F[CX]; py = F[CY]; pz = F[CZ]; }
  for (let k = 0, j = 0; k <= LUTN; k++) { const d = k / LUTN * len[M]; while (j < M - 1 && len[j + 1] < d) j++; flyLUT[k] = (j + (d - len[j]) / max(len[j + 1] - len[j], 1e-6)) / M * (FLYN - 1); }
}
// camera on the scripted path at time F[FLT]
function flyAt() {
  let s = F[FLT] / FLYT; s = s < 0 ? 0 : s > 1 ? 1 : s; s = s * s * (3 - 2 * s) * 0.25 + s * 0.75;
  s *= LUTN; let k = floor(s) | 0; if (k > LUTN - 1) k = LUTN - 1;
  F[SPL] = flyLUT[k] + (flyLUT[k + 1] - flyLUT[k]) * (s - k); flyRaw();
}
for (let t = 0; t <= FLYT; t += 0.1) { F[FLT] = t; flyAt(); flyPts.push([F[CX], F[CY], F[CZ]]); }
for (const p of POSES) flyPts.push([p[0], -40, p[2]]);

await say('Growing kelp…', 0.73, 2500);
const Wd = makeWorld(D, T, flyPts, POSES);
for (const p of POSES) p[1] += Wd.gy(p[0], p[2]);
// three podGANs floating in a row a few metres in front of the first viewpoint: x, y, z, cell size; phase, which one
const PODS = new Float32Array(3 * 8);
{
  const [x, y, z, tx, , tz] = POSES[0], l = hypot(tx - x, tz - z), dx = (tx - x) / l, dz = (tz - z) / l;
  [[5, -2.4], [5.6, 0], [5, 2.4]].forEach(([d, s], k) => {
    const px = x + dx * d - dz * s, pz = z + dz * d + dx * s;
    PODS.set([px, max(y - 0.4, Wd.gy(px, pz) + 0.5), pz, 0.09, k * 1.7, k, 0, 0], k * 8);
  });
}
// the swarm: NPOD podGANs scattered through open water, a few dozen near the first viewpoint
const SW = { P: new Float32Array(NPOD * 3), V: new Float32Array(NPOD * 3), H: new Float32Array(NPOD * 3), O: new Float32Array(NPOD * 3),
  U: new Float32Array(NPOD * 3), L: new Float32Array(NPOD * 3), ph: new Float32Array(NPOD), cn: new Float32Array(NPOD), roam: new Float32Array(NPOD), g: [],
  pc: new Uint16Array(NPOD), E: new Float32Array(NPOD * 3), own: new Int8Array(NPOD).fill(-1) }; // pulse count, correction still to apply, player inside
{
  const [x0, , z0] = POSES[0];
  for (let i = 0; i < NPOD; i++) {
    const G = podGenome(i); SW.g.push(G);
    let x = 0, y = -20, z = 0;
    for (let t = 0; t < 40; t++) {
      if (i < 48) { const a = Math.random() * 6.283, r = 6 + Math.random() * 26; x = x0 + cos(a) * r; z = z0 + sin(a) * r; }
      else { const a = Math.random() * 6.283, r = 140 * sqrt(Math.random()); x = cos(a) * r; z = sin(a) * r; }
      const f = Wd.gy(x, z), top = min(f + 14, -3);
      y = f + 1.5 + Math.random() * max(top - f - 1.5, 0);
      if (sdAt(x, y, z) < -0.95) break;
    }
    SW.P.set([x, y, z], i * 3); SW.O.set([x, y, z], i * 3);
    const a = Math.random() * 6.283; SW.H.set([cos(a), 0, sin(a)], i * 3); SW.U.set([0, 1, 0], i * 3); SW.L.set([cos(a), 0, sin(a)], i * 3);
    SW.ph[i] = Math.random(); SW.roam[i] = 8 + Math.random() * 14;
  }
}
SW.home = SW.O.slice(); // where each podGAN started: pearls sit at these (always open water)
D = Wd.gy = T.smp = null; // with gy goes the generator's working memory (about 200 MB)

await say('Building set pieces…', 0.94, 1200);
// mesh ids: 0-3 boulders, 4-6 sponges, 7-8 coral, 9 tube sponge, 10 whale fluke, 11 ship, 12 manta, 13 fish,
// 14-20 rock chunks + pebbles, 21-22 coral LOD, 23-25 far LOD of the large rock chunks
const meshes = [meshChunk(1, 3), meshChunk(7, 3), meshChunk(13, 3), meshChunk(22, 3),
  meshLathe([[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9),
  meshLathe([[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8),
  meshLathe([[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10),
  meshCoral(0), meshCoral(1), meshTubes()].map((m) => m.build());
meshes.push(meshFluke(), meshShip().build(), meshManta().build(), meshFish().build(),
  meshChunk(3).build(), meshChunk(11).build(), meshChunk(29).build(), meshChunk(5, 3).build(), meshChunk(17, 3).build(), meshChunk(41, 3).build(), meshChunk(9, 1).build(), meshCoral(0, 1).build(), meshCoral(1, 1).build(), meshChunk(5, 2, 1).build(), meshChunk(17, 2, 1).build(), meshChunk(41, 2, 1).build());
let nV = 0, nI = 0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0); }
const vbMesh = buf(allV, BU.VERTEX), ibMesh = buf(allI, BU.INDEX);
const vbTerrain = buf(new Uint8Array(T.vb), BU.VERTEX), ibTerrain = buf(T.ib, BU.INDEX);
const nSolid = Wd.solids.data.length / 12;
const solidData = new Float32Array((nSolid + 1) * 12); solidData.set(Wd.solids.data); solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12);
const ibSolids = buf(solidData, BU.VERTEX);
const ibChunk = Wd.chunks.map((c) => buf(c.data, BU.VERTEX)), ibProp = Wd.props.map((c) => buf(c.data, BU.VERTEX));
const ibBig = buf(new Uint8Array(Wd.big.buf), BU.VERTEX), ibBigF = buf(new Uint8Array(Wd.bigF.buf), BU.VERTEX), ibSmall = buf(new Uint8Array(Wd.small.buf), BU.VERTEX);
const ibFish = buf(Wd.fish, BU.VERTEX), ibManta = buf(Wd.mantas, BU.VERTEX), ibBubbles = buf(Wd.bubbles, BU.VERTEX), ibSnowB = buf(Wd.snow, BU.VERTEX);
const ibPods = buf(PODS, BU.VERTEX);
const ibSwarm = device.createBuffer({ size: NPOD * 48, usage: BU.VERTEX | BU.COPY_DST }), swBuf = new Float32Array(NPOD * 12);
const ibPearl = device.createBuffer({ size: 200 * 32, usage: BU.VERTEX | BU.COPY_DST }), prBuf = new Float32Array(200 * 8);
let nPearl = 0;
let nSwarm = 0;
const ibGl = buf(Wd.glints, BU.VERTEX), nGl = Wd.glints.length / 8;
const nFish = Wd.fish.length / 8, nManta = Wd.mantas.length / 8, nBub = Wd.bubbles.length / 8, nSnow = Wd.snow.length / 4;
const MANTA = meshes[12], FISH = meshes[13];
Q.writeTexture({ texture: tVol }, Wd.volD, { bytesPerRow: NX, rowsPerImage: NY / 2 }, [NX / 2, NY / 2, NZ / 2]);
Q.writeTexture({ texture: tMap }, Wd.gm, { bytesPerRow: 2048 }, [512, 512]);

// ---------------------------------------------------------------- one-time bakes: detail texture, shadow map
{
  const m = mod(W_DETAIL), p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const e = device.createCommandEncoder();
  let r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] });
  r.setPipeline(p); r.draw(3); r.end();
  for (let i = 1; i < 11; i++) {
    r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
    r.setPipeline(pMip8); r.setBindGroup(0, blitBG(tDetail.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end();
  }
  r = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: tShadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  r.setBindGroup(0, bg0s);
  r.setPipeline(pTerrSh);
  r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32');
  r.drawIndexed(T.ib.length, 1, 0, 0, nSolid);
  r.setPipeline(pSolidSh); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]); }
  // small rocks, sponges and corals (~35M triangles) only on High: too much for a phone's driver
  if (!LV) for (let i = 0; i < NCHUNK; i++) { r.setVertexBuffer(1, ibChunk[i]); r.drawIndexed(meshes[14 + i].ib.length, Wd.chunks[i].n, meshes[14 + i].i0, meshes[14 + i].v0, 0); }
  if (!LV) for (let i = 0; i < 6; i++) if (Wd.props[i].n) { r.setVertexBuffer(1, ibProp[i]); r.drawIndexed(meshes[4 + i].ib.length, Wd.props[i].n, meshes[4 + i].i0, meshes[4 + i].v0, 0); }
  r.setPipeline(pLeafSh); r.setVertexBuffer(0, ibBig); r.draw(6, Wd.big.n);
  r.end();
  Q.submit([e.finish()]);
}
// the GPU has its own copies now: let go of the generator's (about 300 MB)
for (const o of [Wd.big, Wd.bigF, Wd.small, ...Wd.chunks, ...Wd.props]) o.buf = o.data = 0;
Wd.glints = Wd.volD = Wd.gm = T.vb = T.ib = T.wp = T.wn = 0;

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
// for 60 fps; both start where the last visit left them.
const PIXMAX = 2560 * 1440, PIXMIN = mob ? 25e4 : 5e5, DETMIN = 0.4;
let W = 0, H = 0, DW = 0, DH = 0, pix = +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : PIXMAX), det = +SV[2] || 1, dynN = 0, dynT = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3;
let passScene, passVox, bgVox, passRays, passBlur, bgBlur, passPost, bgRays, bgPost, bloomPass = [], bloomBG = [], targets = [];
const NB = 6;
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  if (w === W && h === H) return;
  dynN = dynG = dynGN = 0; dynT = -300; // let the new size settle before measuring again
  W = w; H = h; canvas.width = W; canvas.height = H;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const tMS = tex(AA > 1 ? W : 1, H, HDR, TU.RENDER_ATTACHMENT, { samples: AA }), tDp = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { samples: AA });
  const tRes = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay = tex(W / 2, H / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay2 = tex(W / 2, H / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  const tVox = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  targets = [tMS, tDp, tRes, tRay, tRay2, tVox];
  const bl = [];
  for (let i = 0; i < NB; i++) { const t = tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING); bl.push(t); targets.push(t); }
  const vDp = tDp.createView(), vRes = tRes.createView(), vVox = tVox.createView(), vRay = tRay.createView(), vRay2 = tRay2.createView(), vBl = bl.map((t) => t.createView());
  // without anti-aliasing (Low) the scene goes straight into the resolve target, and tMS is one unused column
  passScene = { colorAttachments: [{ view: AA > 1 ? tMS.createView() : vRes, resolveTarget: AA > 1 ? vRes : undefined, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
  passVox = { colorAttachments: [colorAtt(vVox, true)] };
  bgVox = device.createBindGroup({ layout: pVox.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: vRes }, { binding: 2, resource: vDp }, { binding: 3, resource: { buffer: inkBuf } }] });
  passRays = { colorAttachments: [colorAtt(vRay, true)] };
  passBlur = { colorAttachments: [colorAtt(vRay2, true)] };
  bgBlur = device.createBindGroup({ layout: pRB.getBindGroupLayout(0), entries: [{ binding: 0, resource: vRay }] });
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  bgRays = device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sRep }, { binding: 2, resource: sCmp },
    { binding: 3, resource: tShadow.createView() }, { binding: 4, resource: tWater.createView() }, { binding: 5, resource: vDp }, { binding: 6, resource: tVol.createView() }, { binding: 7, resource: sClamp }] });
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sClamp }, { binding: 2, resource: vVox },
    { binding: 3, resource: vRay2 }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] });
  bloomPass = []; bloomBG = [];
  // down: res -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] }); bloomBG.push(blitBG(i ? vBl[i - 1] : vVox)); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] }); bloomBG.push(blitBG(vBl[i])); }
  UB[52] = W; UB[53] = H; UB[54] = 1 / W; UB[55] = 1 / H;
}
resize();
addEventListener('resize', resize);

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs, qResolve, qRead = [], tsBegin, tsEnd;
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6; F[GPU] = ms; b.unmap(); o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) { dynG += ms; dynGN++; }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- frame
let hud = false;
let kj = 0, kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, tId = -1, tN = 0, tx0 = 0, ty0 = 0, tx = 0, ty = 0;
// voxel edge length in metres (V toggles the voxel look)
const VOXEL = 0.2; let voxOn = true;
const TANH = 0.6, NEAR = 0.1, EXPO = 0.62, RAYS = 0.54;
const submitList = [null];
const rowOrd = new Uint8Array(CELLS);
// Draws the cells of a cell-sorted buffer that are in view and within [minD, maxD) (scaled by `det`, but not for the
// terrain) as merged runs, nearest rows first.
function drawCells(r, start, lo, hi, mar, indexed, verts, minD, maxD) {
  const cx = F[CX], cy = F[CY], cz = F[CZ], fx = F[FX], fy = F[FY], fz = F[FZ], rx = F[RX], rz = F[RZ], ux = F[UX], uy = F[UY], uz = F[UZ];
  const ds = indexed === 1 ? 1 : det * det;
  const tx = TANH * W / H, hw = CELLW * 0.5, ex = hw + mar, min2 = minD * minD * ds, max2 = maxD * maxD * ds;
  for (let k = 0; k < CELLS; k++) {
    const rw = rowOrd[k], row = rw * CELLS, pz = OZ + (rw + 0.5) * CELLW - cz, hz = max(abs(pz) - hw, 0);
    let run = -1;
    for (let x = 0; x <= CELLS; x++) {
      const c = row + x; let v = false;
      if (x < CELLS) {
        const l = lo[c], h = hi[c];
        if (l <= h) {
          const px = OX + (x + 0.5) * CELLW - cx, py = (l + h) * 0.5 - cy, ey = (h - l) * 0.5 + mar, hx = max(abs(px) - hw, 0), h2 = hx * hx + hz * hz;
          if (h2 < max2 && h2 >= min2) {
            const lim = px * fx + py * fy + pz * fz + ex * abs(fx) + ey * abs(fy) + ex * abs(fz);
            if (lim >= 0 && abs(px * rx + pz * rz) - ex * (abs(rx) + abs(rz)) <= lim * tx) v = abs(px * ux + py * uy + pz * uz) - ex * (abs(ux) + abs(uz)) - ey * abs(uy) <= lim * TANH;
          }
        }
      }
      if (v) { if (run < 0) run = c; } else if (run >= 0) {
        const a = start[run], n = start[c] - a;
        if (n > 0) { if (indexed === 1) r.drawIndexed(n * 6, 1, a * 6, 0, nSolid); else if (indexed) r.drawIndexed(indexed.ib.length, n, indexed.i0, indexed.v0, a); else r.draw(verts, n, 0, a); }
        run = -1;
      }
    }
  }
}
function render() {
  // camera basis (right vector is horizontal)
  const cx = F[CX], cy = F[CY], cz = F[CZ], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  m[32] = cx; m[33] = cy; m[34] = cz; m[35] = F[TIME];
  m[36] = rx; m[37] = 0; m[38] = rz; m[39] = TANH * asp;
  m[40] = ux; m[41] = uy; m[42] = uz; m[43] = TANH;
  m[44] = fx; m[45] = fy; m[46] = fz; m[47] = NEAR;
  const zx = cx - PURPLE[0], zz = cz - PURPLE[1]; let zt = (44 - sqrt(zx * zx + zz * zz)) / 18; zt = zt < 0 ? 0 : zt > 1 ? 1 : zt;
  m[51] = zt * zt * (3 - 2 * zt);
  let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek;
  m[56] = EXPO * (0.6 + 0.4 * ek); m[57] = RAYS; m[58] = det; m[59] = voxOn ? VOXEL : 0;
  Q.writeBuffer(ubo, 0, UB);
  packSwarm(); packPearls();
  labels();
  Q.writeBuffer(inkBuf, 0, inkData());
  WT[0] = F[TIME]; Q.writeBuffer(uboW, 0, WT);

  { let cr = floor((cz - OZ) / CELLW) | 0; cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr; let n = 0; rowOrd[n++] = cr; for (let d = 1; d < CELLS; d++) { if (cr - d >= 0) rowOrd[n++] = cr - d; if (cr + d < CELLS) rowOrd[n++] = cr + d; } }
  const e = device.createCommandEncoder();
  let slot = null;
  if (hasTS) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; } }
  waterPass[0].timestampWrites = slot ? tsBegin : undefined;
  passPost.timestampWrites = slot ? tsEnd : undefined;
  // animated water texture + mips
  let r = e.beginRenderPass(waterPass[0]); r.setPipeline(pWater); r.setBindGroup(0, bgWater); r.draw(3); r.end();
  for (let i = 1; i < 5; i++) { r = e.beginRenderPass(waterPass[i]); r.setPipeline(pMip16); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end(); }
  // scene
  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0);
  r.setPipeline(pTerrain); r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32');
  drawCells(r, T.start, T.lo, T.hi, 1.5, 1, 0, 0, 240);
  r.setPipeline(pSolid); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]); }
  for (let i = 0; i < NCHUNK; i++) {
    const c = Wd.chunks[i], big = i > 2 && i < 6; r.setVertexBuffer(1, ibChunk[i]);
    drawCells(r, c.start, c.lo, c.hi, 3, meshes[14 + i], 0, 0, i > 5 ? 30 : big ? 40 : 96);
    if (big) drawCells(r, c.start, c.lo, c.hi, 3, meshes[20 + i], 0, 40, 150);
  }
  for (let i = 0; i < 6; i++) {
    const lod = i === 3 || i === 4; r.setVertexBuffer(1, ibProp[i]);
    drawCells(r, Wd.props[i].start, Wd.props[i].lo, Wd.props[i].hi, 3, meshes[4 + i], 0, 0, lod ? 6 : 110);
    if (lod) drawCells(r, Wd.props[i].start, Wd.props[i].lo, Wd.props[i].hi, 3, meshes[18 + i], 0, 6, 110);
  }
  r.setPipeline(pManta); r.setVertexBuffer(1, ibManta); r.drawIndexed(MANTA.ib.length, nManta, MANTA.i0, MANTA.v0, 0);
  r.setPipeline(pFish); r.setVertexBuffer(1, ibFish); r.drawIndexed(FISH.ib.length, nFish, FISH.i0, FISH.v0, 0);
  // kelp and plants: 9-row blades up close, 5 rows mid-range, a decimated set far away
  r.setPipeline(pLeaf); r.setVertexBuffer(0, ibBig); drawCells(r, Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, 18, 0, 24);
  r.setPipeline(pLeaf5); drawCells(r, Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, 10, 24, 58);
  r.setPipeline(pLeafF); r.setVertexBuffer(0, ibBigF); drawCells(r, Wd.bigF.start, Wd.bigF.lo, Wd.bigF.hi, 5, false, 6, 58, 150);
  r.setPipeline(pLeafS); r.setVertexBuffer(0, ibSmall); drawCells(r, Wd.small.start, Wd.small.lo, Wd.small.hi, 1.5, false, 6, 0, 70);
  r.setPipeline(pPod); r.setVertexBuffer(0, ibPods); r.draw(36, 3);
  if (nSwarm) { r.setPipeline(pSwarm); r.setVertexBuffer(0, ibSwarm); r.draw(36, nSwarm); }
  r.setPipeline(pSurf); r.draw(4);
  r.setPipeline(pBack); r.draw(4);
  r.setPipeline(pBub); r.setVertexBuffer(0, ibBubbles); r.draw(4, nBub);
  r.setPipeline(pGl); r.setVertexBuffer(0, ibGl); r.draw(4, nGl);
  r.setPipeline(pSnow); r.setVertexBuffer(0, ibSnowB); r.draw(4, nSnow);
  if (nPearl) { r.setPipeline(pPearl); r.setVertexBuffer(0, ibPearl); r.draw(4, nPearl); }
  r.end();
  // rebuild the image out of voxels
  r = e.beginRenderPass(passVox); r.setPipeline(pVox); r.setBindGroup(0, bgVox); r.draw(3); r.end();
  // light shafts
  r = e.beginRenderPass(passRays); r.setPipeline(pRays); r.setBindGroup(0, bgRays); r.draw(3); r.end();
  r = e.beginRenderPass(passBlur); r.setPipeline(pRB); r.setBindGroup(0, bgBlur); r.draw(3); r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end();
  }
  // composite
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16); }
  submitList[0] = e.finish();
  Q.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
}

// CS[j] = distance to the rock (metres, < 0 in water) at the camera + CE[3j..3j+2]: the camera, then ±0.375 m on
// each axis for the gradient
const CE = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), CS = new Float64Array(7);
const cv = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127; };
function sd(j) {
  const x = (F[CX] + CE[j * 3] - OX) / VS - CO, y = (F[CY] + CE[j * 3 + 1] - OY) / VS, z = (F[CZ] + CE[j * 3 + 2] - OZ) / VS - CO;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1);
  const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; CS[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// Moves the camera by F[MX..MZ] in steps shorter than its radius CR (so it can't pass through thin rock), pushing it
// back out after each step and dropping velocity into the rock, so it slides along.
const CR = 0.5;
function collide() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 2; k++) {
      sd(0); const s = CS[0] + CR; if (s <= 0) break;
      for (let j = 1; j < 7; j++) sd(j);
      let gx = CS[1] - CS[2], gy = CS[3] - CS[4], gz = CS[5] - CS[6]; const l = sqrt(gx * gx + gy * gy + gz * gz);
      if (l < 0.075) break; // flat: deep in rock
      gx /= l; gy /= l; gz /= l; const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s;
      if (vn > 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}

// Distance to the rock (metres, < 0 in water, clamped to ±1) anywhere the collision field covers; a function
// declaration so the world generator can use it before the code below has run.
function sdAt(x, y, z) {
  x = (x - OX) / VS - CO; y = (y - OY) / VS; z = (z - OZ) / VS - CO;
  if (!(x >= 0 && z >= 0 && y >= 4 && x < CN * 4 - 1 && z < CN * 4 - 1 && y < NY - 5)) return -1;
  const v = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127; };
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, w = y - iy, a = v(ix, iy, iz), b = v(ix, iy + 1, iz), c = v(ix, iy, iz + 1), d = v(ix, iy + 1, iz + 1);
  const p = a + (v(ix + 1, iy, iz) - a) * u, q = b + (v(ix + 1, iy + 1, iz) - b) * u, r = c + (v(ix + 1, iy, iz + 1) - c) * u, s = d + (v(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * w; return (e + (r + (s - r) * w - e) * (z - iz)) / 127;
}
// Cephalopod swimming. Each podGAN works in jet pulses: it contracts (body narrows, legs draw in) for the first
// 55% of a pulse, squirts over the next 15%, then glides with its legs trailing while drag slows it. At the start of
// each pulse it picks a new heading: a random turn, pulled back toward home when it strays, away from rock, the
// surface and the swimmer. Its body leans into its motion, legs behind, and its face turns to you when you are close.
function swim(dt) {
  const { P, V, H, O, U, L, ph, cn, roam, g } = SW, cx = F[CX], cy = F[CY], cz = F[CZ];
  for (let i = 0, j = 0; i < NPOD; i++, j += 3) {
    // other people's podGANs move by their own messages; yours and the bots' drift with the swarm
    const ow = SW.own[i]; if (ow >= 0 && ow !== NET.id && !NET.players.get(ow)?.bot) continue;
    const G = g[i];
    let px = P[j], py = P[j + 1], pz = P[j + 2], vx = V[j], vy = V[j + 1], vz = V[j + 2], hx = H[j], hy = H[j + 1], hz = H[j + 2];
    let p = ph[i] + dt / G.per;
    if (p >= 1) {
      p -= 1; const q = SW.pc[i] = (SW.pc[i] + 1) & 65535, rn = (k) => ih(i * 7919 + q, k) - 0.5; // same turns for every player
      if (i === PL.pod) { // yours swims the general way you are looking, wandering a little each pulse
        hx = F[FX] + rn(0) * 0.6; hy = F[FY] + rn(1) * 0.3; hz = F[FZ] + rn(2) * 0.6;
      } else {
        let ox = O[j] - px, oy = O[j + 1] - py, oz = O[j + 2] - pz; const od = hypot(ox, oy, oz) + 1e-6, pull = od > roam[i] ? 1.4 * od / roam[i] : 0.25;
        hx += rn(0) * 1.4 + ox / od * pull; hy += rn(1) * 0.7 + oy / od * pull + (py > -5 ? -0.8 : 0); hz += rn(2) * 1.4 + oz / od * pull;
        const tx = px - cx, ty = py - cy, tz = pz - cz, td = hypot(tx, ty, tz);
        if (td < 4) { hx += tx / td; hy += ty / td; hz += tz / td; } // startled by the swimmer
        hy *= 0.6;
      }
      const l = hypot(hx, hy, hz) + 1e-6; hx /= l; hy /= l; hz /= l;
    }
    if (i === PL.pod) { // and turns toward where you look between pulses too; its home moves with it
      const k = min(1, dt * 1.5); hx += (F[FX] - hx) * k; hy += (F[FY] * 0.8 - hy) * k; hz += (F[FZ] - hz) * k;
      const l = hypot(hx, hy, hz) + 1e-6; hx /= l; hy /= l; hz /= l;
      O[j] = px; O[j + 1] = py; O[j + 2] = pz;
    }
    ph[i] = p;
    cn[i] = p < 0.55 ? 0.5 - 0.5 * cos(p / 0.55 * PI) : p < 0.7 ? 1 - (p - 0.55) / 0.15 : 0;
    if (p >= 0.55 && p < 0.7) { const a = G.jet * dt / (0.15 * G.per); vx += hx * a; vy += hy * a; vz += hz * a; }
    const dr = Math.exp(-1.6 * dt); vx *= dr; vy *= dr; vz *= dr;
    // keep out of the rock: push back along the distance gradient and turn the heading off the wall
    const s = sdAt(px, py, pz);
    if (s > -0.9) {
      let gx = sdAt(px + 0.4, py, pz) - sdAt(px - 0.4, py, pz), gy = sdAt(px, py + 0.4, pz) - sdAt(px, py - 0.4, pz), gz = sdAt(px, py, pz + 0.4) - sdAt(px, py, pz - 0.4);
      const gl = hypot(gx, gy, gz);
      if (gl > 1e-4) {
        gx /= gl; gy /= gl; gz /= gl; const k = (s + 0.9) * 8 * dt;
        vx -= gx * k; vy -= gy * k; vz -= gz * k;
        const hd = hx * gx + hy * gy + hz * gz; if (hd > 0) { hx -= gx * hd * 1.2; hy -= gy * hd * 1.2; hz -= gz * hd * 1.2; const l = hypot(hx, hy, hz) + 1e-6; hx /= l; hy /= l; hz /= l; }
      }
    }
    px += vx * dt; py += vy * dt; pz += vz * dt;
    { const E = SW.E, k = min(1, dt * 3); px += E[j] * k; py += E[j + 1] * k; pz += E[j + 2] * k; E[j] -= E[j] * k; E[j + 1] -= E[j + 1] * k; E[j + 2] -= E[j + 2] * k; }
    if (py > -1.8) { py = -1.8; vy = min(vy, 0); }
    const rr = hypot(px, pz); if (rr > 150) { px *= 150 / rr; pz *= 150 / rr; }
    P[j] = px; P[j + 1] = py; P[j + 2] = pz; V[j] = vx; V[j + 1] = vy; V[j + 2] = vz; H[j] = hx; H[j + 1] = hy; H[j + 2] = hz;
    // body axis: upright when still, leaning into the motion (legs trailing) when fast
    const sp = hypot(vx, vy, vz) + 1e-6, t = min(sp / 1.2, 1) * 0.8;
    let ux = vx / sp * t, uy = (1 - t) + vy / sp * t, uz = vz / sp * t; let l = hypot(ux, uy, uz) + 1e-6;
    const ku = min(1, dt * 3);
    ux = U[j] + (ux / l - U[j]) * ku; uy = U[j + 1] + (uy / l - U[j + 1]) * ku; uz = U[j + 2] + (uz / l - U[j + 2]) * ku; l = hypot(ux, uy, uz) + 1e-6;
    U[j] = ux / l; U[j + 1] = uy / l; U[j + 2] = uz / l;
    // where the face looks: at you when you are within 14 m, otherwise the way it is heading
    let lx = cx - px, ly = cy - py, lz = cz - pz; const ld = hypot(lx, ly, lz);
    if (ld < 14) { lx /= ld; ly /= ld; lz /= ld; } else { const hl = hypot(hx, hz) + 1e-6; lx = hx / hl; ly = 0; lz = hz / hl; }
    const kl = min(1, dt * 2);
    L[j] += (lx - L[j]) * kl; L[j + 1] += (ly - L[j + 1]) * kl; L[j + 2] += (lz - L[j + 2]) * kl;
  }
}
// Packs the podGANs in view (and within fog range) into the instance buffer, and names the one you look at.
function packSwarm() {
  const { P, U, L, cn, g } = SW, cx = F[CX], cy = F[CY], cz = F[CZ], fx = F[FX], fy = F[FY], fz = F[FZ], rx = F[RX], rz = F[RZ], ux = F[UX], uy = F[UY], uz = F[UZ];
  const far = 85 * det, tx = TANH * W / H; let n = 0;
  // the other players' podGANs glow gold so you can find your friends
  const outl = new Map();
  for (const [id, p] of NET.players) if (id !== NET.id && SW.own[p.pod] === id) outl.set(p.pod, 3);
  for (let i = 0, j = 0; i < NPOD; i++, j += 3) {
    const dx = P[j] - cx, dy = P[j + 1] - cy, dz = P[j + 2] - cz, d = hypot(dx, dy, dz), G = g[i], r = G.size * 26;
    if (d > far + r && !outl.has(i)) continue;
    const z = dx * fx + dy * fy + dz * fz;
    if (z < -r || abs(dx * rx + dz * rz) - r > z * tx + r || abs(dx * ux + dy * uy + dz * uz) - r > z * TANH + r) continue;
    // the face direction must not be parallel to the body axis
    let qx = L[j], qy = L[j + 1], qz = L[j + 2]; const ud = qx * U[j] + qy * U[j + 1] + qz * U[j + 2];
    if (hypot(qx - U[j] * ud, qy - U[j + 1] * ud, qz - U[j + 2] * ud) < 0.2) { qx = -U[j + 2]; qy = 0; qz = U[j]; if (abs(qx) + abs(qz) < 1e-3) qx = 1; }
    const o = n * 12;
    swBuf[o] = P[j]; swBuf[o + 1] = P[j + 1]; swBuf[o + 2] = P[j + 2]; swBuf[o + 3] = G.size;
    swBuf[o + 4] = U[j]; swBuf[o + 5] = U[j + 1]; swBuf[o + 6] = U[j + 2]; swBuf[o + 7] = i + 2048 * (i === PL.pod ? 1 : outl.get(i) || 0);
    swBuf[o + 8] = qx; swBuf[o + 9] = qy; swBuf[o + 10] = qz; swBuf[o + 11] = cn[i];
    n++;
  }
  nSwarm = n;
  if (n) Q.writeBuffer(ibSwarm, 0, swBuf, 0, n * 12);
}

// ============================================================================ the game: podGAN Photo Lap
// You are a podGAN: one of the swarm, seen from behind and above, drawn as a wireframe so you can see through
// yourself. It swims the general way you look; hold right-click to jet (tap for one kick). Swim a lap through the
// 8 glowing gates, and on the way take 3 photos (left-click). Each podGAN in a photo scores by how rare it is
// (rainbows are everywhere, inkfish are 1 in 128, krakens are worth more), plus a crowd bonus for lots in one
// shot and a bonus for every matching pair. Your lap score is your three photos.
// Opened from the podGARDEN server (server/server.mjs), friends swim in the same ocean and the best laps go on a
// shared board; anywhere else you swim on your own, with your best lap kept in this browser.
const NET = { ws: null, id: 0, host: true, online: false, players: new Map(), sendT: 0, podT: 0, board: [] };
const PL = { pod: -1, pt: -1, kicked: false, hold: 0, cx: 0, cy: -30, cz: 0, snap: true, jetDown: false };
const LAP = { on: false, t0: 0, gate: 1, shots: [], left: 3, next: 0, best: 0, flash: 0, pend: null };
try { LAP.best = +localStorage.podLapBest || 0; } catch {}
const NGATE = 8, SHOTS = 3, SHOT_R = 40, FRAME = 0.8; // the photo frame is the middle 80% of the view
const inks = []; // (the voxel pass still reads ink clouds; none in this game)
const feedEl = $('feed'), nsEl = $('ns'), nmEl = $('nm'), tagEl = $('n'), itEl = $('itb'), lblEl = $('lbl'), inkEl = $('ink'), resEl = $('res');
const vfEl = $('vf'), phEl = $('ph'), flEl = $('fl');
const pname = (id) => id === NET.id ? 'you' : NET.players.get(id)?.name || `podGAN ${id + 1}`;
const podName = (i) => `${SW.g[i].name} · #${String(i).padStart(4, '0')}`;
function feed(msg) {
  const p = document.createElement('p'); p.textContent = msg; feedEl.prepend(p);
  setTimeout(() => p.remove(), 6000); while (feedEl.children.length > 4) feedEl.lastChild.remove();
}
const esc = (t) => String(t).replace(/[<&]/g, '');
const mmss = (s) => { const t = max(0, floor(s)); return `${floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function inkData() { inkArr[0] = 0; return inkArr; }
const dist = (a, b) => hypot(SW.P[a * 3] - SW.P[b * 3], SW.P[a * 3 + 1] - SW.P[b * 3 + 1], SW.P[a * 3 + 2] - SW.P[b * 3 + 2]);
// a short tone sliding from f0 to f1 Hz, through the game's sound (audio.js), quiet when muted
function sfx(f0, f1, dur, vol, type = 'sine') {
  try {
    if (muted) return; if (!AC) sound();
    const t = AC.currentTime, o = AC.createOscillator(), gn = AC.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * .75);
    gn.gain.setValueAtTime(.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + .015); gn.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(gn).connect(OUT || AC.destination); o.start(t); o.stop(t + dur + .05);
  } catch {}
}
// move into podGAN i (snap: the camera jumps there instead of flying over)
function become(i, snap) {
  const { own } = SW, o = PL.pod;
  if (o >= 0 && own[o] === NET.id) own[o] = -1;
  PL.pod = i; own[i] = NET.id; PL.snap = !!snap; PL.pt = -1;
  if (o < 0) { const j = i * 3; F[YAW] = atan2(SW.L[j], -SW.L[j + 2]); F[PIT] = -0.4; }
}

// ---------------------------------------------------------------- the course: 8 gates round the garden
// Each gate sits at the home of the wild podGAN nearest a point on a 42 m circle (homes are always open water), and
// faces along the course. Gate 0 is the start and finish.
const GATES = [];
function course() {
  if (GATES.length) return;
  for (let k = 0; k < NGATE; k++) {
    const a = k / NGATE * 6.2832, x = cos(a) * 42, z = sin(a) * 42;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < NPOD; i++) { const d = (SW.home[i * 3] - x) ** 2 + (SW.home[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    GATES.push([SW.home[bi * 3], SW.home[bi * 3 + 1], SW.home[bi * 3 + 2]]);
  }
  for (let k = 0; k < NGATE; k++) { // which way each gate faces: from the gate before to the gate after
    const a = GATES[(k + NGATE - 1) % NGATE], b = GATES[(k + 1) % NGATE];
    let dx = b[0] - a[0], dy = (b[1] - a[1]) * 0.3, dz = b[2] - a[2]; const l = hypot(dx, dy, dz) || 1;
    GATES[k].push(dx / l, dy / l, dz / l);
  }
}
const GATE_R = 4; // ring radius, metres
// the gates for drawing (through the pearl pipeline): rings of glowing beads, the next gate gold and big
function packPearls() {
  let n = 0;
  if (GATES.length) for (let k = 0; k < NGATE; k++) {
    const [gx, gy, gz, fx, fy, fz] = GATES[k], nxt = LAP.on && k === LAP.gate, fin = k === 0;
    // two directions across the gate
    let ax = -fz, az = fx; const al = hypot(ax, az) || 1; ax /= al; az /= al;
    const bx = fy * az, by = fz * ax - fx * az, bz = -fy * ax;
    const nb = nxt ? 20 : 12, rr = nxt ? 0.45 : 0.28;
    const c = nxt ? [1.8, 1.3, 0.3] : fin ? [0.4, 1.6, 0.6] : [0.35, 0.9, 1.3];
    for (let b = 0; b < nb && n < 200; b++) {
      const t = b / nb * 6.2832 + (nxt ? F[TIME] * 0.8 : 0), ca = cos(t) * GATE_R, sa = sin(t) * GATE_R;
      prBuf.set([gx + ax * ca + bx * sa, gy + by * sa, gz + az * ca + bz * sa, rr, ...c, b * 0.7 + k], n * 8); n++;
    }
  }
  nPearl = n;
  if (n) Q.writeBuffer(ibPearl, 0, prBuf, 0, n * 8);
}

// ---------------------------------------------------------------- photos
// How much a podGAN is worth in a photo: by colour scheme (how common it is), krakens +2
const PTS = { Rainbow: 1, Flaming: 3, Frozen: 3, Phantom: 4, Inkfish: 30 };
const worth = (name) => (PTS[name.split(' ')[0]] || 1) + (name.endsWith('Kraken') ? 2 : 0);
// what's in the photo frame right now: podGANs within SHOT_R metres, big enough to make out, not behind rock
function inShot(full) {
  const out = [], cx = F[CX], cy = F[CY], cz = F[CZ], asp = W / H, { P, U } = SW;
  for (let i = 0; i < NPOD; i++) {
    if (i === PL.pod) continue;
    const j = i * 3, s = SW.g[i].size;
    const x = P[j] + U[j] * s * 8 - cx, y = P[j + 1] + U[j + 1] * s * 8 - cy, z0 = P[j + 2] + U[j + 2] * s * 8 - cz;
    const z = x * F[FX] + y * F[FY] + z0 * F[FZ]; if (z < 0.8 || z > SHOT_R) continue;
    const sx = (x * F[RX] + z0 * F[RZ]) / (z * TANH * asp), sy = (x * F[UX] + y * F[UY] + z0 * F[UZ]) / (z * TANH);
    if (abs(sx) > FRAME || abs(sy) > FRAME) continue;
    if (s * 10 / (z * TANH) < 0.03) continue; // too small to make out
    if (full) { // rock in the way?
      const d = hypot(x, y, z0); let hid = false;
      for (let t = 1.5; t < d - 1; t += 1.5) if (sdAt(cx + x * t / d, cy + y * t / d, cz + z0 * t / d) > 0.05) { hid = true; break; }
      if (hid) continue;
    }
    out.push(i);
  }
  return out;
}
// a photo's points: each podGAN by rarity, a crowd bonus (n²/4 from 6 up), 5 a matching pair (same scheme and
// size) and double that with 3 pairs or more
function scoreShot(list) {
  const counts = new Map(); let base = 0;
  for (const i of list) { const n = SW.g[i].name; base += worth(n); counts.set(n, (counts.get(n) || 0) + 1); }
  const n = list.length, crowd = n >= 6 ? floor(n * n / 4) : 0;
  let pairs = 0; for (const c of counts.values()) pairs += floor(c / 2);
  const pair = pairs * 5 * (pairs >= 3 ? 2 : 1);
  const rare = list.filter((i) => SW.g[i].name.startsWith('Inkfish')).length;
  return { n, base, crowd, pairs, pair, rare, total: base + crowd + pair, counts };
}
// left-click: snap! (the picture itself is grabbed straight after this frame is drawn)
function photo() {
  if (!LAP.on) return;
  if (LAP.left <= 0) { feed('No photos left this lap: swim for the finish!'); return; }
  const sc = scoreShot(inShot(true));
  LAP.left--; LAP.shots.push(sc); LAP.pend = sc; LAP.flash = 1;
  sfx(3000, 1500, 0.08, 0.3, 'square'); setTimeout(() => sfx(900, 700, 0.12, 0.2, 'triangle'), 60);
  feed(`📸 ${sc.n} podGAN${sc.n === 1 ? '' : 's'} · ${sc.total} pts${sc.rare ? ' · an INKFISH! 🖤' : ''}${sc.pairs ? ` · ${sc.pairs} pair${sc.pairs > 1 ? 's' : ''}` : ''}${sc.crowd ? ' · crowd bonus!' : ''}`);
}
// right after the frame with the photo in it is drawn: copy it into a polaroid
function grabPhoto() {
  const sc = LAP.pend; if (!sc) return; LAP.pend = null;
  const c = document.createElement('canvas'); c.width = 240; c.height = 150;
  const w = canvas.width * FRAME, h = canvas.height * FRAME;
  try { c.getContext('2d').drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, 240, 150); } catch {}
  sc.img = c.toDataURL('image/jpeg', 0.8);
  drawPhotos();
}
const shotLines = (s) => [`${s.n} podGAN${s.n === 1 ? '' : 's'}: ${s.base}`, s.crowd ? `crowd bonus: +${s.crowd}` : '', s.pairs ? `${s.pairs} pair${s.pairs > 1 ? 's' : ''}${s.pairs >= 3 ? ' (×2!)' : ''}: +${s.pair}` : '', s.rare ? `inkfish! 🖤 ×${s.rare}` : ''].filter(Boolean);
function drawPhotos() {
  phEl.innerHTML = [0, 1, 2].map((k) => { const s = LAP.shots[k]; return s ? `<figure>${s.img ? `<img src="${s.img}">` : '<i></i>'}<figcaption>${s.total} pts</figcaption></figure>` : '<figure class=e><i>📷</i></figure>'; }).join('');
}

// ---------------------------------------------------------------- the lap
// start: your podGAN is put just behind the start gate, facing the first gate
function lapStart() {
  course();
  const [gx, gy, gz, fx, fy, fz] = GATES[0], j = PL.pod * 3;
  if (PL.pod < 0) return;
  SW.P[j] = gx - fx * 8; SW.P[j + 1] = gy - fy * 8; SW.P[j + 2] = gz - fz * 8; SW.V.fill(0, j, j + 3); SW.E.fill(0, j, j + 3);
  F[YAW] = atan2(fx, -fz); F[PIT] = -0.15; PL.snap = true;
  Object.assign(LAP, { on: true, t0: F[TIME], gate: 0, shots: [], left: SHOTS, pend: null, start: true });
  resEl.className = ''; drawPhotos();
  feed('🏁 Swim through the glowing gates · 3 photos this lap: left-click!');
}
function lapGates() {
  if (!LAP.on || PL.pod < 0) return;
  const j = PL.pod * 3, [gx, gy, gz] = GATES[LAP.gate];
  if (hypot(SW.P[j] - gx, SW.P[j + 1] - gy, SW.P[j + 2] - gz) > GATE_R + 1.5) return;
  if (LAP.start) { LAP.start = false; LAP.t0 = F[TIME]; LAP.gate = 1; sfx(660, 990, 0.25, 0.2); feed('Go! 🐙'); return; }
  if (LAP.gate === 0) { lapEnd(); return; }
  sfx(880, 1320, 0.2, 0.2); LAP.gate = (LAP.gate + 1) % NGATE;
  if (LAP.gate === 0) feed('Last stretch: back to the green start gate!');
}
function lapEnd() {
  LAP.on = false;
  const secs = F[TIME] - LAP.t0, pts = LAP.shots.reduce((a, s) => a + s.total, 0), best = pts > LAP.best;
  if (best) { LAP.best = pts; try { localStorage.podLapBest = pts; } catch {} }
  sfx(523, 1046, 0.6, 0.25); setTimeout(() => sfx(784, 1568, 0.6, 0.2), 150);
  netSend({ t: 'lap', pts, secs });
  LAP.next = performance.now() + 15000;
  resEl.innerHTML = `<h2>Lap done! ${pts} points${best ? ' · new best! 🏆' : ''}</h2>
    <div class=pics>${LAP.shots.map((s, k) => `<figure>${s.img ? `<img src="${s.img}">` : '<i></i>'}<figcaption><b>Photo ${k + 1}: ${s.total} pts</b>${shotLines(s).map((l) => `<br>${l}`).join('')}</figcaption></figure>`).join('') || '<p>No photos this lap!</p>'}</div>
    <p class=nx>Lap time ${mmss(secs)} · your best ${LAP.best} pts</p>${boardHtml()}
    <p class=nx>Click or wait <i>15</i> s for the next lap</p>`;
  resEl.className = 'v';
}
const boardHtml = () => NET.board.length ? `<div class=bd><b>Best laps</b>${NET.board.map(([n, p, s], k) => `<p><span>${k + 1}.</span><span>${esc(n)}</span><span>${p} pts</span><span>${mmss(s)}</span></p>`).join('')}</div>` : '';
// the banner: gate, clock, photos left, and what the frame would score right now
let itTxt = '', liveT = 0, live = null;
function drawIt(dt) {
  if ((liveT -= dt) <= 0 && LAP.on) { liveT = 0.25; live = scoreShot(inShot(true)); }
  let t;
  if (!LAP.on) t = '🏁 Lap done!';
  else if (LAP.start) t = '🏁 Swim through the green start gate to begin';
  else t = `🏁 Gate ${LAP.gate === 0 ? 'FINISH' : `${LAP.gate}/${NGATE - 1}`} · ⏱ ${mmss(F[TIME] - LAP.t0)} · 📷 ${LAP.left} left`;
  if (t !== itTxt) { itTxt = t; itEl.textContent = t; }
  const v = LAP.on && LAP.left > 0 && live ? `📷 ${live.n} in frame · ≈${live.total} pts${live.pairs ? ` · ${live.pairs} pair${live.pairs > 1 ? 's' : ''}` : ''}` : '';
  if (vfEl.dataset.t !== v) { vfEl.dataset.t = v; vfEl.lastChild.textContent = v; }
  vfEl.className = LAP.on && LAP.left > 0 ? 'v' : '';
  if (LAP.flash > 0 || flEl.style.opacity !== '0') { LAP.flash = max(0, LAP.flash - dt * 3); flEl.style.opacity = LAP.flash.toFixed(2); }
}
// Tab: the board
function drawScores() {
  $('sb').innerHTML = `<p><b>Best laps${NET.online ? '' : ' (this browser)'}</b><b></b><b>Points</b><b>Time</b></p>` +
    (NET.online ? NET.board : LAP.best ? [['you', LAP.best, 0]] : []).map(([n, p, s], k) => `<p><span>${k + 1}. ${esc(n)}</span><span></span><span>${p}</span><span>${s ? mmss(s) : ''}</span></p>`).join('');
}

// --- what happened, from the server
const addP = (p) => { NET.players.set(p.id, { id: p.id, name: p.name, pod: p.pod, tp: null }); SW.own[p.pod] = p.id; };
function netMsg(m) {
  const P = NET.players, own = SW.own;
  switch (m.t) {
    case 'full': NET.full = true; status('The server is full (8 podGANs). Swimming on your own.'); break;
    case 'hi': {
      NET.online = true; NET.host = m.host === m.id; NET.id = m.id; NET.board = m.board || [];
      for (const p of P.values()) if (own[p.pod] === p.id) own[p.pod] = -1;
      P.clear();
      for (const p of m.players) if (p.id !== m.id) addP(p);
      const was = PL.pod; PL.pod = -1; become(m.players.find((p) => p.id === m.id).pod, true);
      if (was >= 0 && own[was] < 0) own[was] = -1;
      lapStart(); netName(); countMsg();
      break;
    }
    case 'join': addP(m.p); feed(`${m.p.name} swam in`); countMsg(); break;
    case 'bye': feed(`${pname(m.id)} left`); if (own[m.i] === m.id) own[m.i] = -1; P.delete(m.id); countMsg(); break;
    case 'name': { const p = P.get(m.id); if (p) p.name = m.name; break; }
    case 'host': NET.host = m.id === NET.id; countMsg(); break;
    case 's': { const p = P.get(m.id); if (!p || m.i !== p.pod) break; p.tp = m; break; }
    case 'lap': feed(`🏁 ${pname(m.id)} finished a lap: ${m.pts} pts`); break;
    case 'board': NET.board = m.board; break;
  }
}
// --- networking
const status = (m) => { nsEl.textContent = m; };
function netStart() {
  const srv = new URLSearchParams(location.search).get('server');
  if (!srv && (!/^https?:$/.test(location.protocol) || /github\.io$/.test(location.hostname))) { status('Swimming on your own. To swim with friends, open the game from your podGARDEN server.'); return; }
  const u = srv || location.host;
  status('Connecting to the server…');
  const ws = NET.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + u + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => { if (typeof e.data !== 'string') podFix(e.data); else netMsg(JSON.parse(e.data)); };
  ws.onclose = () => {
    const was = NET.online; NET.online = false; NET.host = true;
    if (was) { for (const p of NET.players.values()) if (SW.own[p.pod] === p.id) SW.own[p.pod] = -1; NET.players.clear(); }
    if (NET.full) return;
    status(was ? 'Lost the server. Swimming on your own, reconnecting…' : 'No server here. Swimming on your own, retrying…'); setTimeout(netStart, 3000);
  };
}
const netSend = (m) => { if (NET.online && NET.ws.readyState === 1) NET.ws.send(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m)); };
function netName() { const n = nmEl.value.trim(); try { localStorage.podName = n; } catch {} if (n) netSend({ t: 'name', name: n }); }
const countMsg = () => status(`Online · ${NET.players.size + 1} of 8 podGANs${NET.host ? ' · your browser hosts the swarm' : ''}`);
// wild swarm corrections: the host sends every podGAN's position, velocity, heading, pulse phase and count twice a second
const POD_REC = 10; // int16s per podGAN
function podSend() {
  const a = new Int16Array(NPOD * POD_REC), { P, V, H, ph, pc } = SW;
  for (let i = 0; i < NPOD; i++) {
    const o = i * POD_REC, j = i * 3;
    a[o] = P[j] * 64; a[o + 1] = P[j + 1] * 64; a[o + 2] = P[j + 2] * 64;
    a[o + 3] = V[j] * 256; a[o + 4] = V[j + 1] * 256; a[o + 5] = V[j + 2] * 256;
    a[o + 6] = H[j] * 32000; a[o + 7] = H[j + 1] * 32000; a[o + 8] = H[j + 2] * 32000;
    a[o + 9] = (round(ph[i] * 255) & 255) | ((pc[i] & 255) << 8);
  }
  netSend(a.buffer);
}
function podFix(buf) {
  if (NET.host || buf.byteLength !== NPOD * POD_REC * 2) return;
  const a = new Int16Array(buf), { P, V, H, ph, pc, E, own } = SW;
  for (let i = 0; i < NPOD; i++) {
    if (own[i] >= 0) continue; // players' bodies come from their own messages
    const o = i * POD_REC, j = i * 3;
    // the position error is blended in over a moment, the rest is taken as it is
    E[j] = a[o] / 64 - P[j]; E[j + 1] = a[o + 1] / 64 - P[j + 1]; E[j + 2] = a[o + 2] / 64 - P[j + 2];
    if (E[j] * E[j] + E[j + 1] * E[j + 1] + E[j + 2] * E[j + 2] > 100) { P[j] += E[j]; P[j + 1] += E[j + 1]; P[j + 2] += E[j + 2]; E[j] = E[j + 1] = E[j + 2] = 0; }
    V[j] = a[o + 3] / 256; V[j + 1] = a[o + 4] / 256; V[j + 2] = a[o + 5] / 256;
    H[j] = a[o + 6] / 32000; H[j + 1] = a[o + 7] / 32000; H[j + 2] = a[o + 8] / 32000;
    const w = a[o + 9] & 65535; ph[i] = (w & 255) / 255; pc[i] = (pc[i] & ~255) | (w >> 8);
  }
}

// ---------------------------------------------------------------- your podGAN and the camera
function jetTap() { if (PL.pt < 0 || PL.pt > 0.25) { PL.pt = 0; PL.kicked = false; } }
function pilot(dt) {
  const i = PL.pod; if (i < 0) return;
  const { P, V, U, cn } = SW, j = i * 3, s = SW.g[i].size;
  const cp = cos(F[PIT]), fx = cp * sin(F[YAW]), fy = sin(F[PIT]), fz = -cp * cos(F[YAW]);
  // your podGAN swims the way you look with the swarm's pulses (swim()); right-click jets: a tap draws in for
  // 0.18 s then kicks once, held is full jets
  PL.hold = PL.jetDown ? PL.hold + dt : 0;
  if (PL.pt >= 0) {
    PL.pt += dt;
    const kk = { Squidder: 6, Squid: 5, Octopod: 4.5, Kraken: 4 }[SW.g[i].name.split(' ')[1]] || 4.5;
    if (PL.pt >= 0.18 && !PL.kicked) { PL.kicked = true; V[j] += fx * kk; V[j + 1] += fy * kk; V[j + 2] += fz * kk; }
    cn[i] = PL.pt < 0.18 ? PL.pt / 0.18 : max(0, 1 - (PL.pt - 0.18) / 0.17);
    if (PL.pt > 0.35) PL.pt = -1;
  }
  if (PL.hold > 0.25) { const a = 18 * dt; V[j] += fx * a; V[j + 1] += fy * a; V[j + 2] += fz * a; cn[i] = 0.5 + 0.5 * sin(F[TIME] * 16); }
  const px = P[j], py = P[j + 1], pz = P[j + 2];
  // camera: behind and above, pulled in by rock
  const tx = px + U[j] * s * 8, ty = py + U[j + 1] * s * 8, tz = pz + U[j + 2] * s * 8, kc = PL.snap ? 1 : min(1, dt * 6);
  PL.cx += (tx - PL.cx) * kc; PL.cy += (ty - PL.cy) * kc; PL.cz += (tz - PL.cz) * kc; PL.snap = false;
  let D = 1.2 + s * 28;
  for (let d = 0.4; d < D; d += 0.25) if (sdAt(PL.cx - fx * d, PL.cy - fy * d, PL.cz - fz * d) > -0.25) { D = max(d - 0.25, 0.3); break; }
  F[CX] = PL.cx - fx * D; F[CY] = min(PL.cy - fy * D, -1); F[CZ] = PL.cz - fz * D;
  tagEl.className = ''; $('x').className = '';
  lapGates();
}

function game(dt) {
  // other players' podGANs glide toward what they last reported
  const { P, V, U, L, cn } = SW, k = min(1, dt * 10);
  for (const p of NET.players.values()) {
    const m = p.tp; if (!m || SW.own[p.pod] !== p.id) continue;
    const j = p.pod * 3;
    for (let a = 0; a < 3; a++) { m.p[a] += m.v[a] * dt; P[j + a] += (m.p[a] - P[j + a]) * k; V[j + a] = m.v[a]; U[j + a] += (m.u[a] - U[j + a]) * k; L[j + a] += (m.l[a] - L[j + a]) * k; }
    cn[p.pod] = m.c;
  }
  drawIt(dt);
  if (resEl.className) {
    const e = resEl.querySelector('i'), left = (LAP.next - performance.now()) / 1000;
    if (e) e.textContent = max(0, Math.ceil(left));
    if (left <= 0) lapStart();
  }
  if ($('sb').className) drawScores();
  if (!NET.online) return;
  if ((NET.sendT -= dt) <= 0 && PL.pod >= 0) {
    NET.sendT = 1 / 15;
    const j = PL.pod * 3, f = (a, n) => [+a[j].toFixed(n), +a[j + 1].toFixed(n), +a[j + 2].toFixed(n)];
    netSend({ t: 's', p: f(P, 2), v: f(V, 2), u: f(U, 3), l: f(L, 3), c: +cn[PL.pod].toFixed(2) });
  }
  if (NET.host && (NET.podT -= dt) <= 0) { NET.podT = 0.5; podSend(); }
}
// floating names over the other players' podGANs, and an arrow to the next gate when it's off screen
const lbls = [];
function labels() {
  let n = 0;
  const cx = F[CX], cy = F[CY], cz = F[CZ], asp = W / H;
  for (const [id, p] of NET.players) {
    if (SW.own[p.pod] !== id) continue;
    const j = p.pod * 3, s = SW.g[p.pod].size, x = SW.P[j] + SW.U[j] * s * 22 - cx, y = SW.P[j + 1] + SW.U[j + 1] * s * 22 - cy, z0 = SW.P[j + 2] + SW.U[j + 2] * s * 22 - cz;
    const z = x * F[FX] + y * F[FY] + z0 * F[FZ]; if (z < 0.5 || z > 90) continue;
    const sx = (x * F[RX] + z0 * F[RZ]) / (z * TANH * asp), sy = (x * F[UX] + y * F[UY] + z0 * F[UZ]) / (z * TANH);
    if (abs(sx) > 1.1 || abs(sy) > 1.1) continue;
    let e = lbls[n]; if (!e) { e = lbls[n] = document.createElement('p'); lblEl.append(e); }
    e.textContent = p.name; e.className = 'free';
    e.style.left = `${(sx * 0.5 + 0.5) * 100}%`; e.style.top = `${(0.5 - sy * 0.5) * 100}%`; e.style.display = '';
    n++;
  }
  for (let k = n; k < lbls.length; k++) lbls[k].style.display = 'none';
  arrow();
}
let arw = null;
function arrow() {
  if (!arw) { arw = document.createElement('div'); arw.className = 'arw'; arw.innerHTML = '<b>➤</b><span></span>'; lblEl.append(arw); }
  if (!LAP.on || PL.pod < 0 || !GATES.length) { arw.style.display = 'none'; return; }
  const g = GATES[LAP.gate], j0 = PL.pod * 3, asp = W / H;
  const d = hypot(g[0] - SW.P[j0], g[1] - SW.P[j0 + 1], g[2] - SW.P[j0 + 2]);
  const x = g[0] - F[CX], y = g[1] - F[CY], z0 = g[2] - F[CZ], z = x * F[FX] + y * F[FY] + z0 * F[FZ];
  let sx = (x * F[RX] + z0 * F[RZ]) / (abs(z) * TANH * asp + 1e-6), sy = (x * F[UX] + y * F[UY] + z0 * F[UZ]) / (abs(z) * TANH + 1e-6);
  const on = z > 0.5 && abs(sx) < 0.85 && abs(sy) < 0.85;
  arw.lastChild.textContent = `${LAP.gate === 0 ? '🏁' : `gate ${LAP.gate}`} · ${Math.round(d)} m`;
  if (on) { // in view: the label sits on the gate
    arw.firstChild.style.display = 'none'; arw.style.left = `${(sx * 0.5 + 0.5) * 100}%`; arw.style.top = `${(0.5 - sy * 0.5) * 100 - 6}%`;
  } else {
    if (z <= 0.5 && abs(sx) < 0.05 && abs(sy) < 0.05) sy = -1;
    const ang = Math.atan2(-sy, sx);
    arw.firstChild.style.display = ''; arw.firstChild.style.transform = `rotate(${ang}rad)`;
    arw.style.left = `${50 + Math.cos(ang) * 42}%`; arw.style.top = `${50 + Math.sin(ang) * 40}%`;
  }
  arw.style.display = '';
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtr = now - F[LAST]; F[LAST] = now;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  // Dynamic resolution for 60 fps: every second (0.4 s behind the menu) scale the load by k
  if (dtr < 1e3 && (dynT += dtr) > 0 && (dynN++, dynT > (menu ? 400 : 1000))) {
    const a = dynT / dynN, g = dynGN ? dynG / dynGN : 0; let k = 1;
    // with GPU timing: keep it between 9.8 and 13.6 ms
    if (g) { if (g > 13.6 || g < 9.8) k = 11.7 / g; }
    // without: slow for two periods in a row means fewer pixels, and twice as long before trying to go back up
    else if (a > 17.6) { dynOk = 0; if (++dynBad > 1) { k = 15 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
    // at the display's rate there is no telling if there is room, so try a little more now and then
    else { dynBad = 0; if (a < 12.5) k = 15 / a; else if (++dynOk > dynWait) { k = 1.17; dynOk = 0; } }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; const top = min(PIXMAX, DW * DH), mid = max(top / 2, PIXMIN), was = pix + det;
    // too slow: pixels down to `mid` first, then draw distance, then the remaining pixels; faster goes back the same way
    if (k < 1 ? pix > mid || det <= DETMIN : pix < mid || det >= 1) {
      const end = k < 1 ? (det > DETMIN ? mid : PIXMIN) : det < 1 ? mid : top;
      pix *= k; if (k < 1 ? pix < end : pix > end) pix = end;
    } else { det *= sqrt(k); det = det < DETMIN ? DETMIN : det > 1 ? 1 : det; }
    if (was !== pix + det) keep('abyssal', [LV, pix < top ? pix | 0 : '', det]); // nothing kept at full resolution
    dynN = dynT = dynG = dynGN = 0; resize();
  }
  F[TIME] += dt;
  {
    // touch: holding the finger away from where it went down keeps turning, like a joystick
    if (tId >= 0) {
      const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
      jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
      lkx += jx * 1.5 * dt; lky += jy * dt;
    }
    // mouse look through two cascaded low-pass stages
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
    F[YAW] = yaw; F[PIT] = pitch > 1.45 ? 1.45 : pitch < -1.45 ? -1.45 : pitch;
  }
  swim(dt);
  pilot(dt);
  game(dt);
  render();
  grabPhoto();
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; if (dtr < hMin) hMin = dtr; if (dtr > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) { info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  GPU ${F[GPU].toFixed(2)} ms  ·  ${W}x${H} (${W * 100 / DW | 0}%)`; F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; }
  }
}

// ---------------------------------------------------------------- input
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': kf = v; break; case 'KeyS': kb = v; break; case 'KeyA': kl = v; break; case 'KeyD': kr = v; break;
    case 'KeyE': ku = v; break; case 'KeyQ': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') { hud = !hud; hTot = 0; hPer = 1e9; info.textContent = ''; }
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'KeyV') voxOn = !voxOn;
      else if (e.code === 'Escape') ui(true);
    }
  }
};
// behind the menu only the stats and mute keys work
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') { if (e.code === 'Enter') go(); return; }
  if (e.code === 'Tab') { e.preventDefault(); if (!menu) $('sb').className = 'v'; drawScores(); return; }
  if (menu && e.code !== 'KeyH' && e.code !== 'KeyM') return; sound(); key(e, 1);
});
addEventListener('keyup', (e) => { if (e.code === 'Tab') $('sb').className = ''; });
// left: take a photo (or, after a lap, start the next); right: jets (tap for one kick, hold for full jets)
addEventListener('mousedown', (e) => {
  if (menu || document.pointerLockElement !== canvas) return;
  if (e.button === 0) { if (resEl.className) lapStart(); else photo(); }
  else if (e.button === 2) { jetTap(); PL.jetDown = true; }
});
addEventListener('mouseup', (e) => { if (e.button === 2) PL.jetDown = false; });
addEventListener('contextmenu', (e) => { if (!menu) e.preventDefault(); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = kj = 0; tId = -1; tN = 0; };
const capture = () => { sound(); const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', capture);
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); sound(); tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    // the touch axes turn with the page when it lies on its side
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; } // the view follows the finger at once
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
// The scene keeps rendering (blurred by CSS) behind the menu. Esc, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  // focus the dive button so Enter works (delayed: it can't take focus while still hidden)
  if (m) { release(); setTimeout(() => menu && bDive.focus(), 100); } else document.activeElement.blur();
};
const go = () => {
  netName();
  sound(); ui(false); bDive.textContent = 'Resume';
  // phones: go fullscreen and ask for landscape; where that is refused the CSS rotation still applies
  if (mob) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation.lock('landscape')).catch(() => 0);
  if (!mob) capture();
};
bDive.onclick = go; $('o').onclick = () => ui(true);
// detail buttons: the current level is lit, the others reload the page with theirs
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => { keep('abyssal', 2 - i); location.reload(); }; });
document.addEventListener('pointerlockchange', () => ui(!document.pointerLockElement));

// draw the first frame and wait for the GPU to finish it (pipelines get compiled on first use) before the reveal
lookAt(...POSES[0]);
become(floor(Math.random() * NPOD), true);
lapStart();
netStart();
await say('Letting the light in…', 1, 400);
render(); await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'abyssalLoad', ''); // the load counts as survived after 15 s of frames
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
