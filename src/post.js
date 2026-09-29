import * as THREE from 'three';

// HDR render pipeline:
//  main (MSAA) -> particles (reduced res, premultiplied) ->
//  composite -> bloom mip chain -> ACES tonemap, grain, vignette -> screen
//  The reduced-res passes read scene depth from a separate single-sample depth prepass
//  target (resolving the MSAA float depth is slow on tile-based GPUs).

const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

function pass(frag, uniforms = {}) {
  return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
}

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene();
    this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.params = { partScale: 0.6, reflScale: 0.5, bloom: 0.06, exposure: 1, grain: 0.035, vignette: 0.22, msaa: 4 };

    this.composite = pass(/* glsl */ `
      uniform sampler2D tMain, tPart;
      varying vec2 vUv;
      void main() {
        vec4 m = texture2D(tMain, vUv);
        vec4 p = texture2D(tPart, vUv);
        gl_FragColor = vec4(min(m.rgb * (1.0 - p.a) + p.rgb, vec3(30000.0)), 1.0);
      }`, { tMain: { value: null }, tPart: { value: null } });

    this.prefilter = pass(/* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
      varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        c *= 0.25;
        float l = max(c.r, max(c.g, c.b));
        float k = max(l - uThreshold, 0.0);
        k = k * k / (k + uThreshold * 0.5 + 1e-4);
        c *= k / max(l, 1e-4);
        gl_FragColor = vec4(min(c, vec3(4000.0)), 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 } });

    this.down = pass(/* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

    this.up = pass(/* glsl */ `
      uniform sampler2D tSrc, tPrev; uniform vec2 uTexel; uniform float uWeight;
      varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(min(c / 12.0 + texture2D(tPrev, vUv).rgb * uWeight, vec3(30000.0)), 1.0);
      }`, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });

    this.final = pass(/* glsl */ `
      uniform sampler2D tColor, tBloom;
      uniform float uExposure, uBloom, uGrain, uVignette, uTime;
      uniform vec3 uWB;
      uniform vec2 uRes;
      varying vec2 vUv;
      vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
      }
      vec3 ACESFitted(vec3 color) {
        const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        color = ACESInputMat * color;
        color = RRTAndODTFit(color);
        color = ACESOutputMat * color;
        return clamp(color, 0.0, 1.0);
      }
      float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec2 d = vUv - 0.5;
        // subtle lateral chromatic aberration toward the frame edges
        float ca = dot(d, d) * 0.0025;
        vec3 c;
        c.r = texture2D(tColor, vUv - d * ca).r;
        c.g = texture2D(tColor, vUv).g;
        c.b = texture2D(tColor, vUv + d * ca).b;
        c += texture2D(tBloom, vUv).rgb * uBloom;
        c *= uExposure * uWB;
        c = ACESFitted(c * 0.9);
        c *= 1.0 - uVignette * smoothstep(0.25, 0.95, length(d * vec2(1.0, 0.8)) * 1.35);
        c = srgb(c);
        float g = hash(vUv * uRes + fract(uTime * 13.7) * 311.0) - 0.5;
        c += g * uGrain * (0.6 + 0.4 * (1.0 - c));
        gl_FragColor = vec4(c, 1.0);
      }`, {
      tColor: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.1 },
      uGrain: { value: 0.03 }, uVignette: { value: 0.2 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() },
    });
    this.targets = [];
  }

  makeRT(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
      type: opts.type ?? THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: opts.depth ?? false,
      samples: opts.samples ?? 0,
      resolveDepthBuffer: opts.resolveDepth ?? true,
    });
    if (opts.depthTexture) {
      rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.FloatType);
    }
    this.targets.push(rt);
    return rt;
  }

  setSize(w, h) {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    const p = this.params;
    this.w = w; this.h = h;
    this.main = this.makeRT(w, h, { depth: true, samples: p.msaa, resolveDepth: false });
    this.refl = this.makeRT(w * p.reflScale, h * p.reflScale, { depth: true });
    this.part = this.makeRT(w * p.partScale, h * p.partScale);
    this.depth = this.makeRT(w, h, { depth: true, depthTexture: true, type: THREE.UnsignedByteType }); // colour unused
    this.comp = this.makeRT(w, h);
    this.bloomDown = [];
    this.bloomUp = [];
    let bw = w / 2, bh = h / 2;
    for (let i = 0; i < 6; i++) {
      this.bloomDown.push(this.makeRT(bw, bh));
      this.bloomUp.push(this.makeRT(bw, bh));
      bw /= 2; bh /= 2;
    }
  }

  blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.qscene, this.qcam);
  }

  bloom() {
    const src = this.comp.texture;
    const p = this.prefilter.uniforms;
    p.tSrc.value = src;
    p.uTexel.value.set(1 / this.w, 1 / this.h);
    p.uThreshold.value = 2.5 / Math.max(this.params.exposure, 1e-3);
    this.blit(this.prefilter, this.bloomDown[0]);
    for (let i = 1; i < this.bloomDown.length; i++) {
      const s = this.bloomDown[i - 1];
      this.down.uniforms.tSrc.value = s.texture;
      this.down.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this.blit(this.down, this.bloomDown[i]);
    }
    const n = this.bloomDown.length;
    let prev = this.bloomDown[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      this.up.uniforms.tSrc.value = prev.texture;
      this.up.uniforms.tPrev.value = this.bloomDown[i].texture;
      this.up.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
      this.up.uniforms.uWeight.value = 1.0;
      this.blit(this.up, this.bloomUp[i]);
      prev = this.bloomUp[i];
    }
    return this.bloomUp[0].texture;
  }

  finish(time) {
    this.composite.uniforms.tMain.value = this.main.texture;
    this.composite.uniforms.tPart.value = this.part.texture;
    this.blit(this.composite, this.comp);
    const bloomTex = this.bloom();
    const f = this.final.uniforms;
    f.tColor.value = this.comp.texture;
    f.tBloom.value = bloomTex;
    f.uExposure.value = this.params.exposure;
    if (this.params.wb) f.uWB.value.copy(this.params.wb);
    f.uBloom.value = this.params.bloom;
    f.uGrain.value = this.params.grain;
    f.uVignette.value = this.params.vignette;
    f.uTime.value = time;
    f.uRes.value.set(this.w, this.h);
    this.blit(this.final, null);
  }
}
