import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  IcosahedronGeometry,
  Matrix3,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
  type Blending,
} from 'three';
import { SIMPLEX_3D } from './noise.ts';

/** Visual states. Each one is driven by a real agent/recorder event in the app (see App.tsx), never by a timer. */
export type OrbState = 'idle' | 'thinking' | 'searching' | 'listening' | 'responding' | 'error';
export type OrbQuality = 'full' | 'reduced';
export type OrbTheme = 'dark' | 'light';

export interface OrbOptions {
  quality: OrbQuality;
  theme: OrbTheme;
  /** Live microphone level 0..1, read every frame only in the listening state. */
  amplitude: { readonly current: number };
  /** Called once when sustained frame times show the device cannot keep up (the owner downgrades or falls back). */
  onSlow: () => void;
  onContextLost: () => void;
}

interface Targets { energy: number; spin: number; route: number; warn: number; glow: number }
const STATE_TARGETS: Record<OrbState, Targets> = {
  idle: { energy: 0.3, spin: 1, route: 0.18, warn: 0, glow: 0.92 },
  thinking: { energy: 0.75, spin: 1.7, route: 0.4, warn: 0, glow: 1.05 },
  searching: { energy: 0.85, spin: 2.6, route: 1, warn: 0, glow: 1.1 },
  listening: { energy: 0.5, spin: 1.2, route: 0.25, warn: 0, glow: 1 },
  responding: { energy: 0.95, spin: 1.4, route: 0.5, warn: 0, glow: 1.2 },
  error: { energy: 0.2, spin: 0.45, route: 0, warn: 1, glow: 0.75 },
};

// Display-referred colors written straight to the framebuffer (no color-management round trip).
const rgb = (hex: number) => new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
const PALETTE: Record<OrbTheme, { c1: Vector3; c2: Vector3; c3: Vector3; warn: Vector3; core: Vector3 }> = {
  dark: { c1: rgb(0x14d7c4), c2: rgb(0x38bdf8), c3: rgb(0x6366f1), warn: rgb(0xf47764), core: rgb(0xeafffb) },
  light: { c1: rgb(0x0fbfae), c2: rgb(0x1f9fe0), c3: rgb(0x5458ee), warn: rgb(0xd0523f), core: rgb(0xf6fffd) },
};

/**
 * Liquid glass shell. The vertex stage turns the sphere into a slowly flowing liquid surface (noise displacement,
 * louder with the real microphone level) and rebuilds the normal from neighbouring displaced points, so lighting
 * follows the moving surface instead of the original sphere.
 */
const GLASS_VERT = /* glsl */ `
${SIMPLEX_3D}
uniform float uTime; uniform float uEnergy; uniform float uAmp;
varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vViewNormal; varying vec3 vViewPos;
float wobble(vec3 n) {
  float t = uTime;
  return snoise(n * 1.2 + vec3(0.0, t * 0.33, t * 0.21)) * (0.017 + uEnergy * 0.017)
       + snoise(n * 2.4 - vec3(t * 0.45)) * (0.005 + uAmp * 0.045);
}
vec3 displaced(vec3 n) { return n * (1.0 + wobble(n)); }
void main() {
  vec3 n = normalize(position);
  vec3 p = displaced(n);
  vec3 axis = abs(n.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(n, axis));
  vec3 b = cross(n, t);
  vec3 pt = displaced(normalize(n + t * 0.035));
  vec3 pb = displaced(normalize(n + b * 0.035));
  vec3 nn = normalize(cross(pt - p, pb - p));
  if (dot(nn, n) < 0.0) nn = -nn;
  vObjPos = p;
  vObjNormal = nn;
  vViewNormal = normalize(normalMatrix * nn);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

/**
 * Glass + fluid energy in one pass:
 *  - Fresnel (Schlick, glass F0 ≈ 0.04) mixes a reflected procedural studio environment (cyan key, teal side,
 *    violet bounce, two softboxes for crisp highlights) with the refracted interior;
 *  - the view ray is refracted at the surface (IOR 1.33) and marched through the sphere: domain-warped noise ridges
 *    form luminous energy filaments around a bright nucleus, so the interior has real parallax and depth;
 *  - a thin-film term adds a subtle iridescent sheen near the rim.
 * Output is premultiplied: emission adds light while (1 − alpha) lets the page show through the clear glass.
 */
const GLASS_FRAG = /* glsl */ `
${SIMPLEX_3D}
uniform float uTime; uniform float uEnergy; uniform float uAmp; uniform float uWarn; uniform float uGlow; uniform float uLight;
uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uWarnC; uniform vec3 uCore; uniform vec3 uCamObj;
varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vViewNormal; varying vec3 vViewPos;

vec3 environment(vec3 d) {
  float up = smoothstep(-0.2, 0.95, d.y);
  vec3 base = mix(mix(vec3(0.02, 0.05, 0.10), vec3(0.9, 0.96, 0.99), uLight), mix(uC2 * 0.85, vec3(0.78, 0.94, 1.0), uLight), up);
  base += uC1 * 0.55 * pow(max(dot(d, normalize(vec3(0.85, 0.05, 0.45))), 0.0), 6.0);
  base += uC3 * 0.4 * pow(max(dot(d, normalize(vec3(-0.75, -0.55, 0.3))), 0.0), 5.0);
  // Softboxes: one crisp key, one long strip.
  // Emitters are much brighter than the room (as real light sources are), so they read through a 4% Fresnel.
  base += vec3(1.0) * pow(max(dot(d, normalize(vec3(-0.45, 0.75, 0.55))), 0.0), 160.0) * 28.0;
  base += mix(uC2, vec3(1.0), 0.55) * smoothstep(0.9, 0.975, dot(d, normalize(vec3(0.72, 0.5, 0.48)))) * 5.0;
  return base;
}

void main() {
  vec3 N = normalize(vViewNormal);
  vec3 V = normalize(-vViewPos);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  vec3 reflection = environment(reflect(-V, N));

  // Refract into the liquid and march through it (object space).
  vec3 ro = vObjPos;
  vec3 rd = refract(normalize(ro - uCamObj), normalize(vObjNormal), 1.0 / 1.33);
  float tExit = max(-2.0 * dot(ro, rd), 0.2);
  float dt = tExit / float(STEPS);
  float flow = uTime * 0.22 * (0.55 + uEnergy);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (dt * (float(i) + 0.5));
    float r = length(p);
    vec3 q = p * 1.25;
    // Two noise samples warp the domain (the third axis reuses them): 3 noise evaluations per step in total.
    float w1 = snoise(q + vec3(0.0, flow, 0.0));
    float w2 = snoise(q + vec3(4.3, -flow, 1.7));
    vec3 warp = vec3(w1, w2, w1 * w2 - 0.25);
    float n = snoise(q * 1.15 + warp * 0.8 + vec3(0.0, 0.0, flow * 1.4));
    float filament = pow(1.0 - abs(n), 9.0);
    float nucleus = exp(-r * r * 8.0) * (0.85 + uEnergy * 0.5 + uAmp * 0.75);
    float density = filament * (0.55 + uEnergy * 0.75) * smoothstep(0.96, 0.2, r) + nucleus + 0.03;
    vec3 c = mix(uC3, uC2, smoothstep(-0.55, 0.55, p.y + n * 0.35));
    c = mix(c, uC1, filament * 0.7);
    c = mix(c, uCore, clamp(nucleus * 0.55, 0.0, 1.0));
    c = mix(c, uWarnC, uWarn * 0.65);
    acc += trans * c * density * dt * 2.4;
    trans *= exp(-density * dt * mix(1.5, 1.7, uLight));
  }

  vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + (1.0 - NdV) * 1.7 + uTime * 0.02));
  float rim = pow(1.0 - NdV, 2.6);
  vec3 color = acc * (1.0 - F) * uGlow
             + reflection * F * mix(1.0, 0.85, uLight)
             + film * rim * 0.12
             + mix(uC2, uC1, 0.45) * rim * 0.3 * uGlow;
  // Clear glass lets almost all background light through; on a light page a faint white sheen (scattering) keeps the
  // body visible without a grey veil.
  float clear = trans * (1.0 - F) * mix(0.88, 0.95, uLight);
  color += uLight * vec3(0.94, 0.99, 1.0) * 0.07;
  float alpha = clamp(1.0 - clear + uLight * 0.07, 0.0, 1.0);
  gl_FragColor = vec4(min(color, vec3(1.6)), alpha);
}`;

// Soft outer atmosphere (back faces): the halo that makes the orb sit in light rather than on top of the page.
const ATMO_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vP = position;
  gl_Position = projectionMatrix * mv;
}`;
const ATMO_FRAG = /* glsl */ `
uniform float uGlow; uniform float uWarn; uniform float uLight; uniform float uAmp; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uWarnC;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  // Back faces: -dot(N,V) is 1 behind the orb centre and 0 at the halo edge, so the glow fades out with no rim.
  float i = pow(clamp(-dot(vN, vV), 0.0, 1.0), 3.0) * 1.6;
  vec3 col = mix(mix(uC1, uC2, 0.5 + vP.y * 0.3), uWarnC, uWarn * 0.6);
  gl_FragColor = vec4(col, i * (0.4 + uAmp * 0.4) * uGlow * mix(1.0, 0.45, uLight));
}`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Orbit path: a faint gradient body, a travelling comet with a bright head (route energy); searching adds a second.
const RING_FRAG = /* glsl */ `
uniform float uTime; uniform float uSpin; uniform float uRoute; uniform float uGlow; uniform float uOffset; uniform float uWarn; uniform float uLight;
uniform vec3 uA; uniform vec3 uB; uniform vec3 uWarnC;
varying vec2 vUv;
void main() {
  float a = vUv.x;
  float head = fract(uTime * 0.05 * uSpin + uOffset);
  float d1 = fract(head - a);
  float d2 = fract(head + 0.5 - a);
  float comet = pow(1.0 - d1, 9.0) * (0.5 + uRoute * 0.9) + pow(1.0 - d2, 12.0) * uRoute * 0.9;
  float spark = smoothstep(0.005, 0.0, min(d1, 1.0 - d1)) * (0.7 + uRoute);
  float body = (0.12 + 0.06 * sin(a * 6.2831 * 2.0 + uTime * 0.4)) * (1.0 + uLight * 1.1);
  vec3 col = mix(mix(uA, uB, a), uWarnC, uWarn * 0.6);
  float alpha = (body * (0.7 + uRoute * 0.6) + comet + spark) * uGlow;
  gl_FragColor = vec4(col + spark * 0.4 * (1.0 - uLight), clamp(alpha, 0.0, 1.0) * mix(1.0, 0.9, uLight));
}`;

const PARTICLE_VERT = /* glsl */ `
attribute vec4 aSeed; // radius, phase, height, speed
uniform float uTime; uniform float uSpin; uniform float uAmp; uniform float uPixelRatio; uniform float uSize; uniform mat3 uTilt;
varying float vFade; varying float vHue; varying float vSpark;
void main() {
  float ang = aSeed.y + uTime * aSeed.w * 0.09 * uSpin;
  float r = aSeed.x * (1.0 + uAmp * 0.16);
  vec3 p = uTilt * vec3(cos(ang) * r, aSeed.z, sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.5 + 0.5 * sin(uTime * (0.8 + aSeed.w) + aSeed.y * 7.0);
  vSpark = step(0.93, fract(aSeed.y * 3.71));
  vFade = twinkle * smoothstep(2.3, 1.45, r);
  vHue = fract(aSeed.y * 0.159);
  gl_PointSize = uSize * uPixelRatio * (0.45 + aSeed.w * 0.35 + vSpark * 0.7) * (6.0 / -mv.z);
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform float uGlow; uniform float uRoute; uniform float uLight; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uCore;
varying float vFade; varying float vHue; varying float vSpark;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  vec3 col = mix(mix(mix(uC1, uC2, vHue), uC3, step(0.82, vHue)), uCore, vSpark * 0.6);
  gl_FragColor = vec4(col, a * a * vFade * (0.45 + uRoute * 0.35 + vSpark * 0.4) * uGlow * mix(1.0, 0.8, uLight));
}`;

function tiltMatrix(x: number, z: number): Matrix3 {
  const cx = Math.cos(x), sx = Math.sin(x), cz = Math.cos(z), sz = Math.sin(z);
  // Rz * Rx (column-major via set(row-major))
  return new Matrix3().set(
    cz, -sz * cx, sz * sx,
    sz, cz * cx, -cz * sx,
    0, sx, cx,
  );
}

const RINGS = [
  { radius: 1.42, rx: 1.22, ry: 0, rz: -0.49, offset: 0, a: 'c1', b: 'c2' },
  { radius: 1.7, rx: 1.02, ry: 0.5, rz: 0.36, offset: 0.33, a: 'c2', b: 'c3' },
  { radius: 1.97, rx: 1.42, ry: -0.3, rz: -0.95, offset: 0.66, a: 'c1', b: 'c3' },
] as const;

/**
 * The Living Orb (liquid glass, 2026-11-04): one WebGL canvas, 9 draw calls, all motion computed on the GPU from a
 * time uniform. Owned imperatively (no React state per frame). Pauses when hidden/offscreen, renders the docked
 * orb at a lower pixel ratio and ~30 fps when calm, disposes every GPU resource on destroy, and reports context
 * loss / slow devices to its owner. Full quality marches 8 steps through the liquid; reduced marches 5.
 */
export class OrbScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 0.1, 50);
  private readonly root = new Group();
  private readonly rings = new Group();
  private readonly glass: Mesh;
  private readonly materials: ShaderMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly camObj = new Vector3();
  private readonly basePixelRatio: number;
  private readonly shared = {
    uTime: { value: 0 },
    uEnergy: { value: STATE_TARGETS.idle.energy },
    uSpin: { value: 1 },
    uRoute: { value: STATE_TARGETS.idle.route },
    uWarn: { value: 0 },
    // Start at the idle look (the canvas fades in with CSS): never a dark orb while ramping up.
    uGlow: { value: STATE_TARGETS.idle.glow },
    uAmp: { value: 0 },
    uLight: { value: 0 },
    uC1: { value: new Vector3() },
    uC2: { value: new Vector3() },
    uC3: { value: new Vector3() },
    uWarnC: { value: new Vector3() },
    uCore: { value: new Vector3() },
  };
  private state: OrbState = 'idle';
  private raf = 0;
  private running = false;
  private visible = true;
  private docked = false;
  private last = 0;
  private lastDraw = 0;
  private slowFrames = 0;
  private sampled = 0;
  private slowReported = false;
  private destroyed = false;
  private readonly onLost: (e: Event) => void;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly opts: OrbOptions) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: opts.quality === 'full', powerPreference: 'default', premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, opts.quality === 'full' ? 1.75 : 1.25);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.onLost = (e: Event) => {
      e.preventDefault();
      this.stop();
      opts.onContextLost();
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    this.camera.position.set(0, 0, 8);
    this.glass = this.build();
    this.setTheme(opts.theme);
    this.resize();
  }

  private material(
    vertexShader: string,
    fragmentShader: string,
    extra: Record<string, { value: unknown }>,
    o: { blending: Blending; transparent: boolean; depthWrite: boolean; back?: boolean; premultiplied?: boolean; defines?: Record<string, number> },
  ): ShaderMaterial {
    const m = new ShaderMaterial({
      vertexShader, fragmentShader, uniforms: { ...this.shared, ...extra }, blending: o.blending, transparent: o.transparent,
      depthWrite: o.depthWrite, side: o.back ? BackSide : FrontSide, premultipliedAlpha: o.premultiplied ?? false, defines: o.defines ?? {},
    });
    this.materials.push(m);
    return m;
  }

  private build(): Mesh {
    const full = this.opts.quality === 'full';
    const additive = this.opts.theme === 'dark' ? AdditiveBlending : NormalBlending;
    const sphere = new IcosahedronGeometry(1, full ? 24 : 12);
    const atmoGeo = new IcosahedronGeometry(1, full ? 8 : 5);
    this.geometries.push(sphere, atmoGeo);

    const atmosphere = new Mesh(atmoGeo, this.material(ATMO_VERT, ATMO_FRAG, {}, { blending: additive, transparent: true, depthWrite: false, back: true }));
    atmosphere.scale.setScalar(1.5);
    atmosphere.renderOrder = 0;

    const palette = PALETTE[this.opts.theme];
    for (const r of RINGS) {
      const geo = new TorusGeometry(r.radius, full ? 0.0065 : 0.009, 6, full ? 280 : 170);
      this.geometries.push(geo);
      // Two draws per ring, same geometry and material: first behind the glass (the glass then tints the far arc,
      // as a real lens would), then again after it, where the glass depth lets only the near arc through.
      const mat = this.material(RING_VERT, RING_FRAG, { uOffset: { value: r.offset }, uA: { value: palette[r.a] }, uB: { value: palette[r.b] } }, { blending: additive, transparent: true, depthWrite: false });
      for (const order of [2, 4]) {
        const ring = new Mesh(geo, mat);
        ring.rotation.set(r.rx, r.ry, r.rz);
        ring.renderOrder = order;
        this.rings.add(ring);
      }
    }

    const count = full ? 700 : 280;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const band = Math.random();
      seeds[i * 4] = 1.2 + Math.pow(band, 0.7) * 1.0;
      seeds[i * 4 + 1] = Math.random() * Math.PI * 2;
      seeds[i * 4 + 2] = (Math.random() - 0.5) * (0.1 + band * 0.45);
      seeds[i * 4 + 3] = 0.4 + Math.random() * 1.1;
    }
    const pGeo = new BufferGeometry();
    pGeo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    pGeo.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    this.geometries.push(pGeo);
    const points = new Points(pGeo, this.material(PARTICLE_VERT, PARTICLE_FRAG, {
      uPixelRatio: { value: this.basePixelRatio },
      uSize: { value: full ? 7 : 8 },
      uTilt: { value: tiltMatrix(1.2, -0.49) },
    }, { blending: additive, transparent: true, depthWrite: false }));
    points.frustumCulled = false;
    points.renderOrder = 1;

    const glass = new Mesh(sphere, this.material(GLASS_VERT, GLASS_FRAG, { uCamObj: { value: this.camObj } }, {
      blending: NormalBlending, transparent: true, depthWrite: true, premultiplied: true, defines: { STEPS: full ? 8 : 5 },
    }));
    glass.scale.setScalar(0.95);
    glass.renderOrder = 3;

    this.root.add(atmosphere, points, this.rings, glass);
    this.scene.add(this.root);
    return glass;
  }

  /** Compiles every shader without blocking the main thread where KHR_parallel_shader_compile exists. */
  async prepare(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  setTheme(theme: OrbTheme): void {
    const p = PALETTE[theme];
    this.shared.uC1.value.copy(p.c1);
    this.shared.uC2.value.copy(p.c2);
    this.shared.uC3.value.copy(p.c3);
    this.shared.uWarnC.value.copy(p.warn);
    this.shared.uCore.value.copy(p.core);
    this.shared.uLight.value = theme === 'light' ? 1 : 0;
    // Additive light disappears on a light page: rings, particles and halo switch to normal blending there.
    const blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
    for (const m of this.materials) {
      if (m.transparent && !m.premultipliedAlpha && m.blending !== blending) { m.blending = blending; m.needsUpdate = true; }
    }
    RINGS.forEach((r, i) => {
      const mesh = this.rings.children[i * 2];
      if (mesh instanceof Mesh && mesh.material instanceof ShaderMaterial) {
        (mesh.material.uniforms['uA'] as { value: Vector3 }).value = p[r.a];
        (mesh.material.uniforms['uB'] as { value: Vector3 }).value = p[r.b];
      }
    });
    if (!this.running) this.renderOnce();
  }

  setState(state: OrbState): void {
    this.state = state;
    if (!this.running) this.renderOnce();
  }

  /** Docked, the orb is shown at ~15% scale: a lower pixel ratio cuts fragment work without visible loss. */
  setDocked(docked: boolean): void {
    if (docked === this.docked) return;
    this.docked = docked;
    this.renderer.setPixelRatio(docked ? Math.min(this.basePixelRatio, 0.6) : this.basePixelRatio);
    this.resize();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.start();
    else this.stop();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running || this.destroyed || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.lastDraw = this.last;
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const frameMs = now - this.last;
      this.last = now;
      // ~30 fps is plenty for a calm, small, docked orb; full rate whenever it reacts to something.
      const calm = this.docked && (this.state === 'idle' || this.state === 'error');
      if (calm && now - this.lastDraw < 31) return;
      this.watchPerformance(frameMs);
      this.step(Math.min(now - this.lastDraw, 100) / 1000);
      this.lastDraw = now;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Sustained frames over ~40 ms (under ~25 fps) after warm-up mean this device needs a lighter tier. */
  private watchPerformance(frameMs: number): void {
    if (this.slowReported || frameMs > 250) return; // tab switches and stalls are not the GPU's fault
    this.sampled++;
    if (this.sampled < 30) return; // first frames
    if (frameMs > 40) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 45) {
      this.slowReported = true;
      this.opts.onSlow();
    }
  }

  /** Advances every uniform by `dt` seconds of wall time (same speed at 60 or 30 fps). */
  private step(dt: number): void {
    const s = this.shared;
    const target = STATE_TARGETS[this.state];
    const k = 1 - Math.exp(-dt * 2.6);
    s.uEnergy.value += (target.energy - s.uEnergy.value) * k;
    s.uSpin.value += (target.spin - s.uSpin.value) * k;
    s.uRoute.value += (target.route - s.uRoute.value) * k;
    s.uWarn.value += (target.warn - s.uWarn.value) * k;
    s.uGlow.value += (target.glow - s.uGlow.value) * k;
    const amp = this.state === 'listening' ? Math.min(1, Math.max(0, this.opts.amplitude.current)) : 0;
    // Fast attack, slower release: follows speech without jitter and settles the moment recording ends.
    const ka = 1 - Math.exp(-dt * (amp > s.uAmp.value ? 18 : 6));
    s.uAmp.value += (amp - s.uAmp.value) * ka;
    s.uTime.value += dt * (0.6 + s.uEnergy.value * 0.6);
    const t = s.uTime.value;
    this.root.scale.setScalar(1 + Math.sin(t * 0.9) * 0.01 + s.uAmp.value * 0.05);
    this.root.rotation.y = Math.sin(t * 0.12) * 0.25;
    this.rings.rotation.y += dt * 0.12 * s.uSpin.value;
    this.root.updateMatrixWorld();
    // Camera in the glass mesh's object space, for the refracted interior march.
    this.camObj.copy(this.camera.position);
    this.glass.worldToLocal(this.camObj);
    this.renderer.render(this.scene, this.camera);
  }

  private renderOnce(): void {
    if (this.destroyed) return;
    this.step(0.016);
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.renderer.dispose();
  }
}
