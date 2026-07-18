import * as THREE from "three";
import type { GhostStyleId, Landmark } from "../models/types";
import type { GhostRig } from "./body-model";
import {
  createSpectralRuntimePose,
  createSpectralSkinnedMesh,
  type SpectralRuntimePose,
} from "./spectral-skinned-mesh";

export const SPECTRAL_RENDER_VERSION = "spectral-render-v3-core-v13" as const;
export const SPECTRAL_FANTASY_VERSION = "fantasy-spirit-v5-16-souls-surface" as const;
export const SPECTRAL_CYBER_VERSION = "cyber-projection-v6-11" as const;
export const SPECTRAL_NORMAL_OFFSETS_METERS = Object.freeze({
  fantasyCore: 0.0015,
  fantasyShell: 0.010,
  fantasyAura: 0.026,
  fantasyContrastOutline: 0.008,
  cyberShell: 0.006,
  cyberPhaseEcho: 0.006,
  sharedShell: 0.007,
});
export const SPECTRAL_CYBER_PHASE_PERIOD_SECONDS = 3.2;
export const SPECTRAL_CYBER_PHASE_DURATION_SECONDS = 0.12;
export const SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS = 0.02;
export const SPECTRAL_CYBER_PHASE_MAX_OFFSET_METERS = 0.05;

export function sampleSpectralCyberPhasePulse(timeSeconds: number, seed: number): number {
  const shifted = timeSeconds + seed * 2.31;
  const localTime = ((shifted % SPECTRAL_CYBER_PHASE_PERIOD_SECONDS) + SPECTRAL_CYBER_PHASE_PERIOD_SECONDS)
    % SPECTRAL_CYBER_PHASE_PERIOD_SECONDS;
  const smoothstep = (edge0: number, edge1: number, value: number) => {
    const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  return smoothstep(0, 0.018, localTime)
    * (1 - smoothstep(0.095, SPECTRAL_CYBER_PHASE_DURATION_SECONDS, localTime));
}

export type SpectralRenderFamily = "fantasy" | "cyber";

export interface SpectralRenderPreset {
  family: SpectralRenderFamily;
  baseColor: number;
  shadowColor: number;
  rimColor: number;
  opacity: number;
  rimStrength: number;
  shellOpacity: number;
  displacementMeters: number;
  bandStrength: number;
}

export interface SpectralFantasyPreset extends SpectralRenderPreset {
  fantasyStrength: number;
  particleColor: number;
  contrastOutline: number;
}

export interface SpectralCyberPreset extends SpectralRenderPreset {
  cyberStrength: number;
  accentColor: number;
  phaseSeed: number;
}

/** Existing saved style ids remain readable while the UI converges on two families. */
export const SPECTRAL_RENDER_PRESETS: Readonly<Record<GhostStyleId, SpectralRenderPreset>> = Object.freeze({
  wraith: Object.freeze({
    family: "fantasy",
    baseColor: 0x9fc7ed,
    shadowColor: 0x1e324a,
    rimColor: 0xf2f8ff,
    opacity: 0.81,
    rimStrength: 0.72,
    shellOpacity: 0.14,
    displacementMeters: 0.0045,
    bandStrength: 0,
  }),
  phantom: Object.freeze({
    family: "fantasy",
    baseColor: 0xe5e9f0,
    shadowColor: 0x566174,
    rimColor: 0xffffff,
    opacity: 0.7,
    rimStrength: 0.5,
    shellOpacity: 0.09,
    displacementMeters: 0.0035,
    bandStrength: 0,
  }),
  cyber: Object.freeze({
    family: "cyber",
    baseColor: 0x45efd3,
    shadowColor: 0x063f48,
    rimColor: 0xbafff4,
    opacity: 0.76,
    rimStrength: 0.72,
    shellOpacity: 0.1,
    displacementMeters: 0.0015,
    bandStrength: 0.1,
  }),
  quantum: Object.freeze({
    family: "cyber",
    baseColor: 0x9b7dff,
    shadowColor: 0x30245e,
    rimColor: 0xe8dcff,
    opacity: 0.72,
    rimStrength: 0.76,
    shellOpacity: 0.11,
    displacementMeters: 0.0018,
    bandStrength: 0.08,
  }),
});

/** V5 final fantasy palettes; V4 core presets stay reproducible behind their own flag. */
export const SPECTRAL_FANTASY_PRESETS: Readonly<Record<"wraith" | "phantom", SpectralFantasyPreset>> = Object.freeze({
  wraith: Object.freeze({
    family: "fantasy",
    baseColor: 0xff493f,
    shadowColor: 0x650912,
    rimColor: 0xffc391,
    opacity: 0.76,
    rimStrength: 1.12,
    shellOpacity: 0.23,
    displacementMeters: 0.0082,
    bandStrength: 0,
    fantasyStrength: 1,
    particleColor: 0xff6f52,
    contrastOutline: 0,
  }),
  phantom: Object.freeze({
    family: "fantasy",
    baseColor: 0xf4fbff,
    shadowColor: 0x18354d,
    rimColor: 0xc6f1ff,
    opacity: 0.72,
    rimStrength: 1.24,
    shellOpacity: 0.22,
    displacementMeters: 0.0070,
    bandStrength: 0,
    fantasyStrength: 0.88,
    particleColor: 0xb9efff,
    contrastOutline: 0.78,
  }),
});

export const SPECTRAL_CYBER_PRESETS: Readonly<Record<"cyber" | "quantum", SpectralCyberPreset>> = Object.freeze({
  cyber: Object.freeze({
    family: "cyber",
    baseColor: 0x47d8e3,
    shadowColor: 0x05283d,
    rimColor: 0xc8faff,
    opacity: 0.78,
    rimStrength: 1.12,
    shellOpacity: 0.15,
    displacementMeters: 0.0016,
    bandStrength: 0.32,
    cyberStrength: 1,
    accentColor: 0xff4fc7,
    phaseSeed: 0.173,
  }),
  quantum: Object.freeze({
    family: "cyber",
    baseColor: 0xa27dff,
    shadowColor: 0x21114d,
    rimColor: 0x8affed,
    opacity: 0.83,
    rimStrength: 1.10,
    shellOpacity: 0.15,
    displacementMeters: 0.0018,
    bandStrength: 0.27,
    cyberStrength: 0.92,
    accentColor: 0xff66d9,
    phaseSeed: 0.617,
  }),
});

export function applySpectralTint<T extends SpectralRenderPreset>(preset: T, tintHex?: string): T {
  if (!tintHex || !/^#[0-9a-f]{6}$/i.test(tintHex)) return preset;
  const base = new THREE.Color(tintHex);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const neutralTint = hsl.s < 0.08;
  const shadow = new THREE.Color().setHSL(
    hsl.h,
    neutralTint ? 0 : THREE.MathUtils.clamp(hsl.s * 0.78 + 0.12, 0, 1),
    THREE.MathUtils.clamp(hsl.l * 0.22 + 0.025, 0.035, 0.24),
  );
  const rim = new THREE.Color().setHSL(
    hsl.h,
    neutralTint ? 0 : THREE.MathUtils.clamp(hsl.s * 0.52 + 0.18, 0, 1),
    THREE.MathUtils.clamp(hsl.l + 0.34, 0.72, 0.96),
  );
  const tinted: SpectralRenderPreset & Partial<SpectralFantasyPreset & SpectralCyberPreset> = {
    ...preset,
    baseColor: base.getHex(),
    shadowColor: shadow.getHex(),
    rimColor: rim.getHex(),
  };
  if ("particleColor" in preset) {
    tinted.particleColor = base.clone().lerp(rim, 0.46).getHex();
  }
  if ("accentColor" in preset) {
    tinted.accentColor = new THREE.Color().setHSL(
      (hsl.h + 0.14) % 1,
      THREE.MathUtils.clamp(hsl.s * 0.72 + 0.26, 0.38, 1),
      THREE.MathUtils.clamp(hsl.l + 0.18, 0.56, 0.82),
    ).getHex();
  }
  return tinted as T;
}

export const SPECTRAL_VERTEX_COMMON = /* glsl */ `
  attribute vec3 bridgeCanonical;
  attribute vec2 bridgeRegionChain;
  attribute float bridgeAppearance;
  #ifndef USE_SKINNING
    attribute vec4 skinIndex;
    attribute vec4 skinWeight;
  #endif
  uniform float uTime;
  uniform float uDisplacement;
  uniform float uNormalOffset;
  uniform float uFantasyStrength;
  uniform float uCyberStrength;
  uniform float uCyberSeed;
  uniform float uRuntimePose;
  uniform mat4 uPoseMatrices[17];
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  varying float vSpectralAppearance;

  float spectralVertexHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float spectralVertexNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 blend = fract(p);
    blend = blend * blend * (3.0 - 2.0 * blend);
    float n000 = spectralVertexHash(cell);
    float n100 = spectralVertexHash(cell + vec3(1.0, 0.0, 0.0));
    float n010 = spectralVertexHash(cell + vec3(0.0, 1.0, 0.0));
    float n110 = spectralVertexHash(cell + vec3(1.0, 1.0, 0.0));
    float n001 = spectralVertexHash(cell + vec3(0.0, 0.0, 1.0));
    float n101 = spectralVertexHash(cell + vec3(1.0, 0.0, 1.0));
    float n011 = spectralVertexHash(cell + vec3(0.0, 1.0, 1.0));
    float n111 = spectralVertexHash(cell + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, blend.x), mix(n010, n110, blend.x), blend.y),
      mix(mix(n001, n101, blend.x), mix(n011, n111, blend.x), blend.y), blend.z);
  }

  float spectralVertexWave(vec3 canonical, float time) {
    float low = sin(dot(canonical, vec3(5.37, 8.11, 4.73)) + time * 0.42);
    float detail = sin(dot(canonical, vec3(-11.3, 3.7, 9.1)) - time * 0.29);
    float coreWave = low * 0.72 + detail * 0.28;
    vec3 flow = vec3(canonical.x * 3.2, canonical.y * 3.6 - time * 0.13, canonical.z * 3.2);
    float fantasyLow = spectralVertexNoise(flow) * 2.0 - 1.0;
    float fantasyDetail = spectralVertexNoise(flow * 1.93 + vec3(7.1, -time * 0.07, 3.4)) * 2.0 - 1.0;
    float fantasyWave = fantasyLow * 0.72 + fantasyDetail * 0.28;
    return mix(coreWave, fantasyWave, clamp(uFantasyStrength, 0.0, 1.0));
  }

  float spectralCyberPulse(float time, float seed) {
    float localTime = mod(time + seed * 2.31, ${SPECTRAL_CYBER_PHASE_PERIOD_SECONDS.toFixed(1)});
    return smoothstep(0.0, 0.018, localTime) * (1.0 - smoothstep(0.095, ${SPECTRAL_CYBER_PHASE_DURATION_SECONDS.toFixed(2)}, localTime));
  }

  vec3 spectralCyberPhaseOffset(vec3 canonical, float time) {
    if (uCyberStrength < 0.001) return vec3(0.0);
    float eventIndex = floor((time + uCyberSeed * 2.31) / ${SPECTRAL_CYBER_PHASE_PERIOD_SECONDS.toFixed(1)});
    float selector = spectralVertexHash(vec3(eventIndex + 3.7, uCyberSeed * 19.0, 5.1));
    float sliceCenter = 0.18 + selector * 0.64;
    float halfWidth = 0.032 + spectralVertexHash(vec3(eventIndex, 8.2, uCyberSeed)) * 0.024;
    float slice = 1.0 - smoothstep(halfWidth, halfWidth + 0.012, abs(canonical.y - sliceCenter));
    float direction = selector < 0.5 ? -1.0 : 1.0;
    float distance = ${SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS.toFixed(2)} + spectralVertexHash(vec3(2.1, eventIndex, uCyberSeed * 7.0)) * ${(SPECTRAL_CYBER_PHASE_MAX_OFFSET_METERS - SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS).toFixed(2)};
    return vec3(direction * distance * slice * spectralCyberPulse(time, uCyberSeed) * uCyberStrength, 0.0, 0.0);
  }

  vec3 spectralRuntimePosition(vec3 source) {
    if (uRuntimePose < 0.5) return source;
    vec4 sourcePosition = vec4(source, 1.0);
    vec4 posed = uPoseMatrices[int(skinIndex.x + 0.5)] * sourcePosition * skinWeight.x;
    posed += uPoseMatrices[int(skinIndex.y + 0.5)] * sourcePosition * skinWeight.y;
    posed += uPoseMatrices[int(skinIndex.z + 0.5)] * sourcePosition * skinWeight.z;
    posed += uPoseMatrices[int(skinIndex.w + 0.5)] * sourcePosition * skinWeight.w;
    return posed.xyz;
  }
`;

export const SPECTRAL_STRUCTURAL_FRAGMENT = /* glsl */ `
  uniform float uStructuralCut;
  uniform float uCyberStrength;
  uniform float uCyberSeed;
  uniform float uTime;

  float spectralHash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float spectralValueNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 blend = fract(p);
    blend = blend * blend * (3.0 - 2.0 * blend);
    float n000 = spectralHash13(cell);
    float n100 = spectralHash13(cell + vec3(1.0, 0.0, 0.0));
    float n010 = spectralHash13(cell + vec3(0.0, 1.0, 0.0));
    float n110 = spectralHash13(cell + vec3(1.0, 1.0, 0.0));
    float n001 = spectralHash13(cell + vec3(0.0, 0.0, 1.0));
    float n101 = spectralHash13(cell + vec3(1.0, 0.0, 1.0));
    float n011 = spectralHash13(cell + vec3(0.0, 1.0, 1.0));
    float n111 = spectralHash13(cell + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, blend.x), mix(n010, n110, blend.x), blend.y),
      mix(mix(n001, n101, blend.x), mix(n011, n111, blend.x), blend.y), blend.z);
  }

  float spectralTemporalHash(vec3 cell, float timeline, float seed) {
    float frame = floor(timeline);
    float phase = fract(timeline);
    phase = phase * phase * (3.0 - 2.0 * phase);
    vec3 frameOffset = vec3(17.0, 7.0, 3.0);
    vec3 seedOffset = vec3(seed * 1.7, seed * -0.9, seed * 2.3);
    float previous = spectralHash13(cell + frameOffset * frame + seedOffset);
    float next = spectralHash13(cell + frameOffset * (frame + 1.0) + seedOffset);
    return mix(previous, next, phase);
  }

  float spectralStructuralMask(vec3 canonical, vec2 regionChain) {
    float stableCell = spectralHash13(floor(canonical * 36.0) + vec3(regionChain.x * 7.0));
    float footCut = uStructuralCut + (stableCell - 0.5) * 0.016;
    float baseMask = step(footCut, canonical.y);
    float localTime = mod(uTime + uCyberSeed * 2.31, ${SPECTRAL_CYBER_PHASE_PERIOD_SECONDS.toFixed(1)});
    float phasePulse = smoothstep(0.0, 0.018, localTime) * (1.0 - smoothstep(0.095, ${SPECTRAL_CYBER_PHASE_DURATION_SECONDS.toFixed(2)}, localTime));
    float eventIndex = floor((uTime + uCyberSeed * 2.31) / ${SPECTRAL_CYBER_PHASE_PERIOD_SECONDS.toFixed(1)});
    float selector = spectralHash13(vec3(eventIndex + 3.7, uCyberSeed * 19.0, 5.1));
    float sliceCenter = 0.18 + selector * 0.64;
    float halfWidth = 0.032 + spectralHash13(vec3(eventIndex, 8.2, uCyberSeed)) * 0.024;
    float slice = 1.0 - smoothstep(halfWidth, halfWidth + 0.012, abs(canonical.y - sliceCenter));
    float missingCell = step(0.76, spectralHash13(floor(canonical * vec3(11.0, 22.0, 11.0)) + vec3(eventIndex * 3.0)));
    float cyberMissing = uCyberStrength * phasePulse * slice * missingCell;
    return baseMask * (1.0 - step(0.5, cyberMissing));
  }

  float spectralAppearanceCoverage(vec3 canonical) {
    return smoothstep(uStructuralCut - 0.002, uStructuralCut + 0.085, canonical.y);
  }
`;

const spectralVertexShader = /* glsl */ `
  ${SPECTRAL_VERTEX_COMMON}

  void main() {
    vSpectralCanonical = bridgeCanonical;
    vSpectralRegionChain = bridgeRegionChain;
    vSpectralAppearance = bridgeAppearance;
    vec3 cyberOffset = spectralCyberPhaseOffset(bridgeCanonical, uTime);
    vec3 posedPosition = spectralRuntimePosition(position) + cyberOffset;
    vec3 posedNormal = normal;
    if (uRuntimePose > 0.5) {
      vec3 posedOffset = spectralRuntimePosition(position + normal * 0.01) + cyberOffset;
      posedNormal = normalize(posedOffset - posedPosition);
    }
    float anchored = smoothstep(0.02, 0.14, bridgeCanonical.y);
    float displacement = spectralVertexWave(bridgeCanonical, uTime)
      * uDisplacement * anchored;
    vec3 spectralPosition = posedPosition + posedNormal * (displacement + uNormalOffset);
    vec4 mvPosition = modelViewMatrix * vec4(spectralPosition, 1.0);
    vSpectralViewPosition = -mvPosition.xyz;
    vSpectralNormal = normalize(normalMatrix * posedNormal);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const spectralDepthFragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    gl_FragColor = vec4(0.0);
  }
`;

const spectralSurfaceFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uShadowColor;
  uniform vec3 uRimColor;
  uniform vec3 uAccentColor;
  uniform float uOpacity;
  uniform float uRimStrength;
  uniform float uBandStrength;
  uniform float uFantasyStrength;
  uniform float uContrastOutline;
  uniform float uCompositeAttenuation;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  varying float vSpectralAppearance;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;

    vec3 viewDir = normalize(vSpectralViewPosition);
    vec3 normal = normalize(vSpectralNormal);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 1.55);
    float capturedRelief = clamp((vSpectralAppearance - 0.5) * 2.0, -1.0, 1.0);
    float surfaceGrain = spectralHash13(floor(
      vSpectralCanonical * 22.0 + vec3(0.0, -uTime * 0.08, 0.0)
    ));
    float flow = sin(vSpectralCanonical.y * 12.0
      + vSpectralCanonical.x * 2.7 + vSpectralCanonical.z * 2.1
      - uTime * 0.55) * 0.5 + 0.5;
    float band = smoothstep(0.88, 1.0, sin(vSpectralCanonical.y * 48.0 - uTime * 1.2) * 0.5 + 0.5);
    float coreEnergy = 0.88 + flow * 0.12 + band * uBandStrength;
    float fantasyLow = 0.5;
    float fantasyDetail = 0.5;
    float fantasyCavity = 0.5;
    float fantasyVoid = 0.0;
    float fantasyCurrent = 0.0;
    float fantasyAsh = 0.0;
    float fantasyRelief = 0.5;
    float fantasyMicro = 0.5;
    float soulFlame = 0.0;
    if (uFantasyStrength > 0.001) {
      vec3 fantasyFlow = vec3(
        vSpectralCanonical.x * 3.1,
        vSpectralCanonical.y * 3.7 - uTime * 0.14,
        vSpectralCanonical.z * 3.1
      );
      fantasyLow = spectralValueNoise(fantasyFlow);
      fantasyDetail = spectralValueNoise(fantasyFlow * 1.91 + vec3(5.3, -uTime * 0.08, 2.7));
      fantasyCavity = clamp(0.28 + fantasyLow * 0.46 + (1.0 - fantasyDetail) * 0.26, 0.0, 1.0);
      float fantasyVoidLow = spectralValueNoise(fantasyFlow * 0.73 + vec3(8.4, uTime * 0.035, 1.7));
      float fantasyVoidDetail = spectralValueNoise(fantasyFlow * 2.67 + vec3(1.9, -uTime * 0.11, 6.2));
      fantasyVoid = smoothstep(0.58, 0.86, fantasyVoidLow * 0.68 + fantasyVoidDetail * 0.42);
      fantasyCurrent = smoothstep(0.76, 0.96,
        sin(vSpectralCanonical.x * 11.7 + vSpectralCanonical.z * 9.3
          + vSpectralCanonical.y * 6.4 + fantasyLow * 8.0
          - uTime * 0.74) * 0.5 + 0.5);
      fantasyAsh = smoothstep(0.68, 0.90,
        spectralValueNoise(vSpectralCanonical * 36.0
          + vec3(4.1, -uTime * 0.055, 7.6)));
      fantasyRelief = spectralValueNoise(vSpectralCanonical * 13.5
        + vec3(2.8, -uTime * 0.035, 9.1));
      fantasyMicro = spectralValueNoise(vSpectralCanonical * 41.0
        + vec3(11.7, -uTime * 0.018, 3.6));
      float soulFlowField = spectralValueNoise(vec3(
        vSpectralCanonical.x * 5.2,
        vSpectralCanonical.y * 4.1 - uTime * 0.22,
        vSpectralCanonical.z * 5.2
      ));
      float soulTide = sin(vSpectralCanonical.y * 18.0
        + vSpectralCanonical.x * 3.6 + vSpectralCanonical.z * 2.8
        + soulFlowField * 7.0 - uTime * 1.02) * 0.5 + 0.5;
      soulFlame = smoothstep(0.64, 0.94,
        soulTide * 0.68 + fantasyDetail * 0.32);
    }
    vec3 reliefVector = vec3(
      fantasyRelief - 0.5,
      fantasyMicro - 0.5,
      fantasyDetail - 0.5
    );
    float reliefStrength = uFantasyStrength
      * (0.055 + fantasyAsh * 0.055 + abs(fantasyRelief - 0.5) * 0.075);
    vec3 shadedNormal = normalize(normal + reliefVector * reliefStrength);
    vec3 keyDirection = normalize(vec3(-0.42, 0.58, 0.70));
    vec3 fillDirection = normalize(vec3(0.58, -0.08, 0.62));
    float keyLight = pow(max(dot(shadedNormal, keyDirection), 0.0), 0.82);
    float fillLight = max(dot(shadedNormal, fillDirection), 0.0);
    float formLight = 0.18 + 0.47 * keyLight + 0.14 * fillLight + 0.21 * facing
      + (surfaceGrain - 0.5) * 0.035
      + (fantasyRelief - 0.5) * 0.11 * uFantasyStrength
      + capturedRelief * (0.18 * uFantasyStrength + 0.12 * uCyberStrength);
    float shoulderHeight = 1.0 - smoothstep(0.12, 0.30,
      abs(vSpectralCanonical.y - 0.70));
    float shoulderLateral = smoothstep(0.08, 0.34,
      abs(vSpectralCanonical.x - 0.50));
    float shoulderEnergy = shoulderHeight * shoulderLateral;
    float fantasyEnergy = 0.72 + fantasyLow * 0.20 + fantasyDetail * 0.10
      + fantasyCavity * 0.08 + shoulderEnergy * 0.12;
    float energy = mix(coreEnergy, fantasyEnergy, uFantasyStrength);

    vec3 core = mix(uShadowColor, uBaseColor, clamp(formLight, 0.0, 1.0));
    vec3 rim = uRimColor * fresnel * uRimStrength * uCompositeAttenuation
      * (1.0 - uContrastOutline * 0.58);
    rim *= mix(1.0, 0.66 + fantasyDetail * 0.24 + fantasyCurrent * 0.10, uFantasyStrength);
    float filament = smoothstep(0.58, 0.84, fantasyDetail * 0.78 + fantasyLow * 0.34);
    float fantasyOpticalDepth = pow(facing, 0.54)
      * (0.72 + fantasyLow * 0.48 + fantasyCavity * 0.16 + fantasyVoid * 0.24);
    float fantasyOpticalAbsorption = 1.0 - exp(-fantasyOpticalDepth * 1.78);
    float innerDensity = clamp(0.16 + fantasyLow * 0.36 + fantasyDetail * 0.18
      + (1.0 - fantasyOpticalAbsorption) * 0.12 - fantasyCavity * 0.05
      - fantasyVoid * 0.16 + fantasyCurrent * 0.08, 0.0, 1.0);
    float capturedSurface = clamp(vSpectralAppearance, 0.0, 1.0);
    float soulPatina = spectralValueNoise(vSpectralCanonical * 8.4
      + vec3(9.2, -uTime * 0.026, 2.4));
    float surfaceRipple = 0.94
      + (capturedSurface - 0.5) * 0.16
      + (soulPatina - 0.5) * 0.055
      + fantasyAsh * 0.025;
    float soulBodyLight = clamp(0.31 + formLight * 0.53
      + capturedRelief * 0.055, 0.0, 1.0);
    vec3 soulSurface = mix(
      uShadowColor * (0.58 + fantasyLow * 0.10),
      uBaseColor * (0.88 + innerDensity * 0.08),
      soulBodyLight
    );
    vec3 fantasyColor = soulSurface * energy * surfaceRipple
      + uRimColor * (filament * (0.22 + fantasyCavity * 0.18) + shoulderEnergy * 0.10)
      + rim * (0.84 + fantasyDetail * 0.26 + fantasyCavity * 0.12);
    fantasyColor += mix(uBaseColor, uRimColor, 0.58)
      * soulFlame * fresnel * (0.07 + fantasyDetail * 0.08)
      * uCompositeAttenuation;
    fantasyColor += uBaseColor * (0.055 + (1.0 - fantasyOpticalAbsorption) * 0.085)
      * uCompositeAttenuation;
    float smokeVeil = smoothstep(0.38, 0.76, fantasyCavity)
      * (0.28 + (1.0 - fantasyDetail) * 0.72);
    float ashCrust = smoothstep(0.57, 0.86,
      fantasyRelief * 0.62 + fantasyMicro * 0.38)
      * (0.54 + fantasyAsh * 0.46);
    fantasyColor = mix(
      fantasyColor,
      uShadowColor * (0.48 + fantasyLow * 0.12),
      (smokeVeil * 0.10 + fantasyVoid * 0.05 + ashCrust * 0.09)
        * (1.0 - fresnel * 0.42)
    );
    float soulVein = smoothstep(0.88, 0.995,
      sin(vSpectralCanonical.x * 17.0 + vSpectralCanonical.z * 13.0
        + vSpectralCanonical.y * 5.0 + fantasyLow * 7.0
        - uTime * 0.92) * 0.5 + 0.5);
    fantasyColor += uRimColor * (soulVein * (0.028 + fantasyDetail * 0.064)
      + fantasyCurrent * (0.018 + fantasyLow * 0.042)
      + fantasyAsh * (0.018 + fresnel * 0.034));
    fantasyColor *= 1.02 + soulVein * 0.06 + fantasyCurrent * 0.035
      + fantasyAsh * 0.045 + capturedRelief * 0.12;
    vec3 color = mix(core * energy + rim, fantasyColor, uFantasyStrength);
    color = mix(color, uShadowColor * 0.82, fresnel * uContrastOutline * 0.28);
    color += mix(uShadowColor, uRimColor, 0.18) * uContrastOutline
      * (0.025 + fresnel * 0.10)
      * uCompositeAttenuation;
    color += uBaseColor * uContrastOutline * (0.16 + facing * 0.12)
      * uCompositeAttenuation;
    float fineBand = 0.0;
    float mainBand = 0.0;
    float blockEnergy = 0.5;
    float dataStreak = 0.0;
    float carrierLine = 0.0;
    float signalNoise = 1.0;
    float packetSpark = 0.0;
    float microCarrier = 0.0;
    float columnCarrier = 0.0;
    float signalIntegrity = 1.0;
    float projectionVeil = 1.0;
    float projectorRise = 0.0;
    float sourceLock = 1.0;
    float projectionColumn = 1.0;
    if (uCyberStrength > 0.001) {
      float scanWarp = (spectralValueNoise(vec3(
        vSpectralCanonical.x * 15.0 + uCyberSeed * 2.0,
        vSpectralCanonical.y * 7.0 - uTime * 0.12,
        vSpectralCanonical.z * 15.0
      )) - 0.5) * 13.0;
      fineBand = smoothstep(0.90, 0.995,
        sin(vSpectralCanonical.y * 188.0 + vSpectralCanonical.x * 4.0
          + vSpectralCanonical.z * 6.0 + scanWarp
          - uTime * 4.4) * 0.5 + 0.5);
      float scanPosition = fract(uTime * 0.071 + uCyberSeed);
      float scanDistance = abs(fract(vSpectralCanonical.y - scanPosition + 0.5) - 0.5);
      mainBand = 1.0 - smoothstep(0.025, 0.075, scanDistance);
      float projectionHeight = clamp((vSpectralCanonical.y - 0.02) / 0.96, 0.0, 1.0);
      float risePhase = abs(fract(vSpectralCanonical.y * 0.74
        - uTime * 0.13 + uCyberSeed + 0.5) - 0.5);
      projectorRise = 1.0 - smoothstep(0.035, 0.16, risePhase);
      sourceLock = 1.10 - projectionHeight * 0.16;
      projectionColumn = 0.78 + 0.22 * spectralTemporalHash(
        vec3(
          floor(vSpectralCanonical.x * 22.0),
          floor(vSpectralCanonical.y * 5.0),
          floor(vSpectralCanonical.z * 22.0)
        ),
        uTime * 0.34,
        uCyberSeed * 13.0
      );
      blockEnergy = spectralTemporalHash(
        floor(vSpectralCanonical * vec3(10.0, 18.0, 10.0)),
        uTime * 0.42,
        uCyberSeed * 11.0
      );
      float dataColumnSeed = spectralHash13(vec3(
        floor(vSpectralCanonical.x * 52.0),
        floor(vSpectralCanonical.z * 43.0),
        floor(uCyberSeed * 97.0)
      ));
      float dataStreakPhase = fract(vSpectralCanonical.y * (2.2 + dataColumnSeed * 2.4)
        - uTime * (0.16 + dataColumnSeed * 0.24) + dataColumnSeed);
      dataStreak = step(0.83, dataColumnSeed)
        * (1.0 - smoothstep(0.015, 0.09, dataStreakPhase));
      carrierLine = smoothstep(0.955, 1.0,
        sin(vSpectralCanonical.x * 118.0 + blockEnergy * 7.0) * 0.5 + 0.5);
      float signalHash = spectralTemporalHash(
        floor(vSpectralCanonical * vec3(38.0, 96.0, 38.0)),
        uTime * 5.2,
        uCyberSeed * 31.0
      );
      signalNoise = 0.76 + signalHash * 0.24;
      packetSpark = smoothstep(0.955, 0.997, signalHash)
        * (0.45 + fineBand * 0.35 + mainBand * 0.20);
      microCarrier = smoothstep(0.965, 1.0,
        sin(vSpectralCanonical.y * 421.0 + vSpectralCanonical.x * 37.0 - uTime * 8.4) * 0.5 + 0.5);
      columnCarrier = smoothstep(0.975, 1.0,
        sin(vSpectralCanonical.x * 173.0 + vSpectralCanonical.z * 113.0
          + blockEnergy * 5.0 + uTime * 0.34) * 0.5 + 0.5);
      float integrityHash = spectralTemporalHash(
        floor(vSpectralCanonical * vec3(28.0, 112.0, 28.0)),
        uTime * 1.6,
        uCyberSeed * 43.0
      );
      signalIntegrity = 0.70 + 0.30 * smoothstep(0.12, 0.62, integrityHash);
      projectionVeil = 0.88 + 0.12 * spectralValueNoise(vec3(
        vSpectralCanonical.x * 12.0 + uCyberSeed * 3.0,
        vSpectralCanonical.y * 16.0 - uTime * 0.18,
        vSpectralCanonical.z * 12.0
      ));
    }
    float edgeSide = smoothstep(-0.28, 0.28, normal.x + sin(vSpectralCanonical.y * 8.0) * 0.12);
    vec3 cyberEdge = mix(uRimColor, uAccentColor, edgeSide);
    vec3 cyberColor = mix(uShadowColor, uBaseColor, 0.68 + blockEnergy * 0.16)
      * (0.88 + fineBand * 0.055 + mainBand * 0.25
        + projectorRise * 0.14 + microCarrier * 0.075)
      + cyberEdge * (
        fresnel * uRimStrength * (0.72 + mainBand * 0.34)
        + fineBand * 0.038
        + mainBand * 0.085
        + dataStreak * 0.17
        + carrierLine * (0.025 + blockEnergy * 0.045)
        + microCarrier * (0.035 + fresnel * 0.055)
        + columnCarrier * 0.032
        + packetSpark * 0.14
      ) * uCompositeAttenuation;
    float chromaFringe = fresnel * (0.34 + projectorRise * 0.26 + columnCarrier * 0.18);
    cyberColor += mix(uRimColor, uAccentColor, edgeSide)
      * chromaFringe * 0.10 * uCompositeAttenuation;
    cyberColor *= (0.86 + signalNoise * 0.14)
      * (0.86 + signalIntegrity * 0.16)
      * projectionVeil
      * sourceLock
      * projectionColumn
      * (1.0 + capturedRelief * 0.16);
    color = mix(color, cyberColor, uCyberStrength);
    color = color / (vec3(1.0) + max(color - vec3(0.72), vec3(0.0)) * 0.62);

    float coverage = spectralAppearanceCoverage(vSpectralCanonical);
    float fantasyPorosity = smoothstep(0.30, 0.78,
      spectralValueNoise(vSpectralCanonical * 5.6
        + vec3(2.1, -uTime * 0.10, 4.7)) * 0.72
        + fantasyDetail * 0.28);
    float fantasyFringeNoise = smoothstep(0.24, 0.76,
      spectralValueNoise(vSpectralCanonical * 10.5
        + vec3(6.4, -uTime * 0.065, 1.8)));
    float fantasyFringeErosion = mix(
      1.0,
      0.70 + fantasyFringeNoise * 0.30,
      fresnel * 0.76
    );
    float fantasyDensity = 0.72 + fantasyOpticalAbsorption * 0.10
      + fantasyLow * 0.14 + fantasyDetail * 0.06
      + fantasyCavity * 0.06 + soulVein * 0.03
      + fantasyPorosity * 0.05 - fantasyVoid * 0.025 + fantasyCurrent * 0.04;
    float alpha = uOpacity * coverage * (0.78 + fresnel * 0.22)
      * mix(1.0, fantasyDensity, uFantasyStrength);
    alpha *= mix(1.0, fantasyFringeErosion, uFantasyStrength);
    alpha *= mix(1.0, 0.93 + blockEnergy * 0.035 + fineBand * 0.018
      + mainBand * 0.05 + projectorRise * 0.025 + microCarrier * 0.035, uCyberStrength);
    alpha *= mix(1.0, signalNoise * signalIntegrity, uCyberStrength);
    float fantasySurfaceOcclusion = step(0.001, uFantasyStrength) * coverage
      * (0.94 + facing * 0.03 + capturedSurface * 0.015);
    float cyberSurfaceOcclusion = step(0.001, uCyberStrength) * coverage
      * (0.72 + mainBand * 0.05);
    float opaqueSurfaceFloor = max(fantasySurfaceOcclusion, cyberSurfaceOcclusion);
    alpha = max(alpha, opaqueSurfaceFloor);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const spectralShellFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uRimColor;
  uniform vec3 uAccentColor;
  uniform float uShellOpacity;
  uniform float uCompositeAttenuation;
  uniform float uFantasyStrength;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    float rim = pow(1.0 - abs(dot(normalize(vSpectralNormal), viewDir)), 1.35);
    float fantasyShellNoise = spectralValueNoise(vSpectralCanonical * 7.8 + vec3(2.7, -uTime * 0.09, 5.1));
    float fantasyShellFlow = spectralValueNoise(vec3(
      vSpectralCanonical.x * 5.8,
      vSpectralCanonical.y * 4.0 - uTime * 0.26,
      vSpectralCanonical.z * 5.8
    ));
    float fantasyShellTide = sin(vSpectralCanonical.y * 19.0
      + vSpectralCanonical.x * 4.1 + vSpectralCanonical.z * 3.3
      + fantasyShellFlow * 7.4 - uTime * 1.08) * 0.5 + 0.5;
    float fantasySoulLick = smoothstep(0.62, 0.94,
      fantasyShellTide * 0.70 + fantasyShellNoise * 0.30);
    float fantasyPulse = (0.66 + spectralValueNoise(vSpectralCanonical * 4.2
      + vec3(0.0, -uTime * 0.12, 0.0)) * 0.24)
      * (0.68 + fantasyShellNoise * 0.20 + fantasySoulLick * 0.30);
    float cyberPulse = 0.82 + 0.18 * (sin(vSpectralCanonical.y * 64.0 - uTime * 2.7) * 0.5 + 0.5);
    float alpha = uShellOpacity * spectralAppearanceCoverage(vSpectralCanonical) * rim
      * mix(1.0, fantasyPulse, uFantasyStrength)
      * mix(1.0, cyberPulse, uCyberStrength);
    if (alpha < 0.004) discard;
    vec3 cyberRim = mix(uRimColor, uAccentColor, smoothstep(-0.25, 0.25, vSpectralNormal.x));
    vec3 color = mix(uRimColor, cyberRim, uCyberStrength) * uCompositeAttenuation;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const spectralFantasyCoreFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uShadowColor;
  uniform vec3 uRimColor;
  uniform float uFantasyStrength;
  uniform float uCompositeAttenuation;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    float facing = clamp(dot(normalize(vSpectralNormal), viewDir), 0.0, 1.0);
    vec3 flowSpace = vec3(
      vSpectralCanonical.x * 4.4,
      vSpectralCanonical.y * 5.1 - uTime * 0.24,
      vSpectralCanonical.z * 4.4
    );
    float soulVolume = spectralValueNoise(flowSpace);
    float soulDetail = spectralValueNoise(flowSpace * 1.73 + vec3(7.3, -uTime * 0.16, 2.4));
    float longitudinalCurrent = sin(
      vSpectralCanonical.y * 25.0
      + soulVolume * 9.0
      + vSpectralCanonical.x * 4.2 + vSpectralCanonical.z * 3.4
      - uTime * 1.05
    ) * 0.5 + 0.5;
    float current = smoothstep(0.68, 0.94,
      longitudinalCurrent * 0.64 + soulDetail * 0.48);
    float mistPocket = smoothstep(0.30, 0.74, soulVolume)
      * (0.36 + soulDetail * 0.64);
    float centerGlow = smoothstep(0.05, 0.78, facing);
    float alpha = spectralAppearanceCoverage(vSpectralCanonical)
      * uFantasyStrength
      * (0.018 + mistPocket * 0.030 + current * 0.050)
      * (0.62 + centerGlow * 0.38)
      * uCompositeAttenuation;
    if (alpha < 0.006) discard;
    vec3 color = mix(uShadowColor, uBaseColor, 0.48 + soulVolume * 0.34);
    color = mix(color, uRimColor, current * 0.48 + soulDetail * 0.08);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const spectralContrastOutlineFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uShadowColor;
  uniform float uContrastOutline;
  uniform float uCompositeAttenuation;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    float rim = pow(1.0 - abs(dot(normalize(vSpectralNormal), viewDir)), 1.18);
    float alpha = uContrastOutline * spectralAppearanceCoverage(vSpectralCanonical)
      * (0.045 + rim * 0.19);
    if (alpha < 0.004) discard;
    vec3 color = uShadowColor * (0.72 + rim * 0.16) * uCompositeAttenuation;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const fantasyParticleVertexShader = /* glsl */ `
  ${SPECTRAL_VERTEX_COMMON}
  attribute float particleSeed;
  uniform float uParticleSize;
  varying float vParticleAlpha;
  varying float vParticleSeed;

  void main() {
    vec3 posedPosition = spectralRuntimePosition(position);
    vec3 posedNormal = normal;
    if (uRuntimePose > 0.5) {
      posedNormal = normalize(spectralRuntimePosition(position + normal * 0.01) - posedPosition);
    }
    float age = fract(uTime * (0.075 + particleSeed * 0.018) + particleSeed);
    float rise = age * (0.08 + particleSeed * 0.13);
    float sway = sin(uTime * 0.72 + particleSeed * 23.7 + bridgeCanonical.y * 4.1) * 0.018 * age;
    vec3 particlePosition = posedPosition + posedNormal * (0.012 + age * 0.018)
      + vec3(sway, rise, cos(uTime * 0.61 + particleSeed * 17.1) * 0.012 * age);
    vec4 mvPosition = modelViewMatrix * vec4(particlePosition, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(uParticleSize * (1.0 + particleSeed * 0.52) / max(1.0, -mvPosition.z), 1.0, 4.2);
    float fadeIn = smoothstep(0.0, 0.12, age);
    float fadeOut = 1.0 - smoothstep(0.66, 1.0, age);
    vParticleAlpha = fadeIn * fadeOut * (0.18 + particleSeed * 0.22);
    vParticleSeed = particleSeed;
  }
`;

const fantasyParticleFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uParticleColor;
  uniform float uCompositeAttenuation;
  varying float vParticleAlpha;
  varying float vParticleSeed;

  void main() {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    point.x *= mix(1.62, 2.02, vParticleSeed);
    point.y *= mix(0.70, 0.90, vParticleSeed);
    point.y += 0.08;
    float radius = dot(point, point);
    if (radius > 1.0) discard;
    float core = exp(-radius * 4.4);
    float tail = exp(-abs(point.x) * 6.2) * (1.0 - smoothstep(-0.82, 0.78, point.y)) * 0.27;
    float softness = core + tail;
    float alpha = vParticleAlpha * softness * uCompositeAttenuation;
    gl_FragColor = vec4(uParticleColor * alpha, alpha);
  }
`;

const cyberSignalVertexShader = /* glsl */ `
  ${SPECTRAL_VERTEX_COMMON}
  attribute float particleSeed;
  uniform float uSignalSize;
  varying float vSignalAlpha;
  varying float vSignalSeed;

  void main() {
    vec3 posedPosition = spectralRuntimePosition(position);
    vec3 posedNormal = normal;
    if (uRuntimePose > 0.5) {
      posedNormal = normalize(spectralRuntimePosition(position + normal * 0.01) - posedPosition);
    }
    float cycle = fract(uTime * (0.055 + particleSeed * 0.028) + particleSeed);
    float packet = step(0.34, spectralVertexHash(vec3(
      floor(uTime * 2.4 + particleSeed * 19.0),
      particleSeed * 71.0,
      bridgeCanonical.y * 23.0
    )));
    float rise = cycle * (0.035 + particleSeed * 0.075);
    float lateral = sin(uTime * 1.15 + particleSeed * 41.0) * 0.012;
    vec3 signalPosition = posedPosition
      + posedNormal * (0.016 + particleSeed * 0.030)
      + vec3(lateral, rise, cos(uTime * 0.83 + particleSeed * 29.0) * 0.010);
    vec4 mvPosition = modelViewMatrix * vec4(signalPosition, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(uSignalSize * (0.72 + particleSeed * 0.58)
      / max(1.0, -mvPosition.z), 2.0, 6.5);
    float appear = smoothstep(0.0, 0.10, cycle)
      * (1.0 - smoothstep(0.70, 1.0, cycle));
    vSignalAlpha = appear * packet * (0.22 + particleSeed * 0.24);
    vSignalSeed = particleSeed;
  }
`;

const cyberSignalFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uAccentColor;
  uniform float uCompositeAttenuation;
  varying float vSignalAlpha;
  varying float vSignalSeed;

  void main() {
    vec2 glyph = abs(gl_PointCoord * 2.0 - 1.0);
    float vertical = (1.0 - smoothstep(0.16, 0.30, glyph.x))
      * (1.0 - smoothstep(0.70, 0.96, glyph.y));
    float horizontal = (1.0 - smoothstep(0.16, 0.30, glyph.y))
      * (1.0 - smoothstep(0.54, 0.88, glyph.x));
    float crossGlyph = max(vertical, horizontal);
    if (crossGlyph < 0.02 || vSignalAlpha < 0.01) discard;
    vec3 color = mix(uBaseColor, uAccentColor, step(0.82, vSignalSeed));
    float alpha = vSignalAlpha * crossGlyph * uCompositeAttenuation;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const cyberPhaseEchoVertexShader = /* glsl */ `
  ${SPECTRAL_VERTEX_COMMON}
  varying float vPhaseEcho;

  void main() {
    vSpectralCanonical = bridgeCanonical;
    vSpectralRegionChain = bridgeRegionChain;
    vec3 posedPosition = spectralRuntimePosition(position);
    vec3 posedNormal = normal;
    if (uRuntimePose > 0.5) {
      posedNormal = normalize(spectralRuntimePosition(position + normal * 0.01) - posedPosition);
    }
    float eventIndex = floor((uTime + uCyberSeed * 2.31) / ${SPECTRAL_CYBER_PHASE_PERIOD_SECONDS.toFixed(1)});
    float selector = spectralVertexHash(vec3(eventIndex + 3.7, uCyberSeed * 19.0, 5.1));
    float sliceCenter = 0.18 + selector * 0.64;
    float halfWidth = 0.032 + spectralVertexHash(vec3(eventIndex, 8.2, uCyberSeed)) * 0.024;
    float slice = 1.0 - smoothstep(halfWidth, halfWidth + 0.018, abs(bridgeCanonical.y - sliceCenter));
    float pulse = spectralCyberPulse(uTime, uCyberSeed);
    float carrier = smoothstep(0.90, 0.995,
      sin(bridgeCanonical.y * 72.0 + bridgeRegionChain.y * 9.0 - uTime * 2.15) * 0.5 + 0.5);
    float direction = selector < 0.5 ? -1.0 : 1.0;
    float echoOffset = -direction * (carrier * 0.006 + pulse * slice * 0.032) * uCyberStrength;
    vec3 echoPosition = posedPosition + posedNormal * uNormalOffset + vec3(echoOffset, 0.0, 0.0);
    vec4 mvPosition = modelViewMatrix * vec4(echoPosition, 1.0);
    vSpectralViewPosition = -mvPosition.xyz;
    vSpectralNormal = normalize(normalMatrix * posedNormal);
    vPhaseEcho = max(carrier * 0.18, pulse * slice);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const cyberPhaseEchoFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform vec3 uAccentColor;
  uniform float uCompositeAttenuation;
  varying float vPhaseEcho;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    vec3 normal = normalize(vSpectralNormal);
    float fresnel = pow(1.0 - abs(dot(normal, viewDir)), 1.26);
    float chromaSide = smoothstep(-0.24, 0.24,
      normal.x + sin(vSpectralCanonical.y * 11.0) * 0.10);
    vec3 echoColor = mix(uRimColor, uAccentColor, chromaSide);
    echoColor = mix(uBaseColor, echoColor, 0.54 + fresnel * 0.34);
    float alpha = spectralAppearanceCoverage(vSpectralCanonical)
      * uCyberStrength
      * vPhaseEcho
      * (0.070 + fresnel * 0.21)
      * uCompositeAttenuation;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(echoColor * alpha, alpha);
  }
`;

const spectralGroundVertexShader = /* glsl */ `
  varying vec2 vGroundUv;
  void main() {
    vGroundUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fantasyGroundFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform float uTime;
  uniform float uCompositeAttenuation;
  varying vec2 vGroundUv;

  void main() {
    float radius = length(vGroundUv);
    if (radius > 1.0) discard;
    float angle = atan(vGroundUv.y, vGroundUv.x);
    float primaryFlow = sin(angle * 3.0 - uTime * 0.22 + radius * 13.0) * 0.5 + 0.5;
    float secondaryFlow = sin(angle * 5.0 + uTime * 0.14 - radius * 19.0) * 0.5 + 0.5;
    float angularWisp = smoothstep(0.62, 0.94, primaryFlow * 0.68 + secondaryFlow * 0.42)
      * smoothstep(0.08, 0.26, radius)
      * (1.0 - smoothstep(0.58, 1.0, radius));
    float brokenVeil = 0.68 + 0.32 * (
      sin(vGroundUv.x * 21.0 + vGroundUv.y * 17.0 - uTime * 0.18) * 0.5 + 0.5
    );
    float contactMist = exp(-radius * radius * 8.5) * brokenVeil;
    float radialHaze = (1.0 - smoothstep(0.16, 1.0, radius))
      * (0.44 + primaryFlow * 0.34 + secondaryFlow * 0.22);
    float alpha = (contactMist * 0.090 + radialHaze * 0.046 + angularWisp * 0.078)
      * uCompositeAttenuation;
    if (alpha < 0.004) discard;
    vec3 color = mix(uBaseColor, uRimColor, 0.18 + angularWisp * 0.58 + contactMist * 0.10);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const cyberGroundFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uAccentColor;
  uniform float uTime;
  uniform float uCompositeAttenuation;
  varying vec2 vGroundUv;

  void main() {
    float radius = length(vGroundUv);
    if (radius > 1.0) discard;
    float outerRing = 1.0 - smoothstep(0.015, 0.055, abs(radius - 0.76));
    float innerRing = 1.0 - smoothstep(0.018, 0.060, abs(radius - 0.42));
    float sweepAngle = atan(vGroundUv.y, vGroundUv.x) + uTime * 0.42;
    float rawAngle = atan(vGroundUv.y, vGroundUv.x);
    float ringSegments = 0.42 + 0.58 * step(-0.2, sin(rawAngle * 24.0 + floor(uTime * 0.5) * 0.35));
    outerRing *= ringSegments;
    float sweep = pow(max(0.0, cos(sweepAngle)), 14.0) * smoothstep(0.18, 0.82, radius);
    float grid = smoothstep(0.92, 1.0, sin((vGroundUv.x + vGroundUv.y) * 31.0 - uTime * 1.4) * 0.5 + 0.5);
    float radialFade = (1.0 - smoothstep(0.18, 1.0, radius)) * 0.18;
    float radialTick = (1.0 - smoothstep(0.018, 0.06, abs(radius - 0.91)))
      * smoothstep(0.72, 1.0, sin(rawAngle * 48.0) * 0.5 + 0.5);
    float sourceBeat = 0.72 + 0.28 * (sin(uTime * 0.82) * 0.5 + 0.5);
    float sourceCore = exp(-radius * radius * 14.0) * sourceBeat;
    float uplinkCells = smoothstep(0.84, 1.0,
      sin(vGroundUv.x * 38.0) * sin(vGroundUv.y * 38.0) * 0.5 + 0.5)
      * (1.0 - smoothstep(0.12, 0.68, radius));
    float alpha = (outerRing * 0.42 + innerRing * 0.22 + sweep * 0.30
      + grid * radialFade * 1.25 + radialTick * 0.18
      + sourceCore * 0.20 + uplinkCells * 0.08) * uCompositeAttenuation;
    vec3 color = mix(uBaseColor, uAccentColor,
      sweep * 0.66 + outerRing * 0.12 + uplinkCells * 0.18);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

function createCyberGroundDisc(preset: SpectralCyberPreset, compositeAttenuation: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(0.66, 64);
  const material = new THREE.ShaderMaterial({
    vertexShader: spectralGroundVertexShader,
    fragmentShader: cyberGroundFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uBaseColor: { value: new THREE.Color(preset.baseColor) },
      uAccentColor: { value: new THREE.Color(preset.accentColor) },
      uCompositeAttenuation: { value: THREE.MathUtils.clamp(compositeAttenuation, 0, 1) },
    },
    transparent: true,
    depthWrite: false,
    // Draw as a projected decal between the opaque floor and the body passes.
    // A physical depth test would let the preview floor erase the source disc.
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.name = `${SPECTRAL_CYBER_VERSION}-ground-disc`;
  const disc = new THREE.Mesh(geometry, material);
  disc.name = "spectral-v6-cyber-ground-disc";
  disc.rotation.x = -Math.PI / 2;
  // The product preview has an opaque floor at -0.9. Keep the projector disc
  // a few millimetres above it so the Death-Stranding-style source remains
  // visible instead of being depth-occluded outside transparent baselines.
  disc.position.y = -0.895;
  disc.userData.spectralGroundAnchorY = -0.895;
  disc.renderOrder = 0.5;
  return disc;
}

function createFantasyGroundMist(preset: SpectralFantasyPreset, compositeAttenuation: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(0.60, 48);
  const material = new THREE.ShaderMaterial({
    vertexShader: spectralGroundVertexShader,
    fragmentShader: fantasyGroundFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uBaseColor: { value: new THREE.Color(preset.baseColor) },
      uRimColor: { value: new THREE.Color(preset.rimColor) },
      uCompositeAttenuation: { value: THREE.MathUtils.clamp(compositeAttenuation, 0, 1) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.name = `${SPECTRAL_FANTASY_VERSION}-ground-mist`;
  const mist = new THREE.Mesh(geometry, material);
  mist.name = "spectral-v5-fantasy-ground-mist";
  mist.rotation.x = -Math.PI / 2;
  mist.position.y = -0.895;
  mist.userData.spectralGroundAnchorY = -0.895;
  mist.renderOrder = 0.45;
  return mist;
}

function sampleSurfaceEffectGeometry(
  source: THREE.BufferGeometry,
  count: number,
  sequenceOffset = 0,
): THREE.BufferGeometry {
  const sourcePosition = source.getAttribute("position");
  const sourceNormal = source.getAttribute("normal");
  const sourceCanonical = source.getAttribute("bridgeCanonical");
  const sourceRegionChain = source.getAttribute("bridgeRegionChain");
  const sourceSkinIndex = source.getAttribute("skinIndex");
  const sourceSkinWeight = source.getAttribute("skinWeight");
  if (!sourcePosition || !sourceNormal || !sourceCanonical || !sourceRegionChain || !sourceSkinIndex || !sourceSkinWeight) {
    throw new Error("Spectral surface effects require the complete body attribute contract.");
  }
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const canonical = new Float32Array(count * 3);
  const regionChain = new Float32Array(count * 2);
  const skinIndex = new Uint8Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const seeds = new Float32Array(count);
  const components = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number) => [
    attribute.getX(index),
    attribute.itemSize > 1 ? attribute.getY(index) : 0,
    attribute.itemSize > 2 ? attribute.getZ(index) : 0,
    attribute.itemSize > 3 ? attribute.getW(index) : 0,
  ];
  for (let particle = 0; particle < count; particle += 1) {
    const sourceIndex = (
      particle * 1597 + particle * particle * 17 + 23 + sequenceOffset * 811
    ) % sourcePosition.count;
    positions.set(components(sourcePosition, sourceIndex).slice(0, 3), particle * 3);
    normals.set(components(sourceNormal, sourceIndex).slice(0, 3), particle * 3);
    canonical.set(components(sourceCanonical, sourceIndex).slice(0, 3), particle * 3);
    regionChain.set(components(sourceRegionChain, sourceIndex).slice(0, 2), particle * 2);
    skinIndex.set(components(sourceSkinIndex, sourceIndex).map((value) => Math.round(value)), particle * 4);
    skinWeight.set(components(sourceSkinWeight, sourceIndex), particle * 4);
    seeds[particle] = ((particle * 73 + sequenceOffset * 47) % 307) / 307;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("bridgeCanonical", new THREE.BufferAttribute(canonical, 3));
  geometry.setAttribute("bridgeRegionChain", new THREE.BufferAttribute(regionChain, 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  geometry.setAttribute("particleSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function createUniforms(
  preset: SpectralRenderPreset,
  compositeAttenuation: number,
  runtimePose?: SpectralRuntimePose,
  fantasyStrength = 0,
  contrastOutline = 0,
  cyberStrength = 0,
  accentColor = 0xffffff,
  cyberSeed = 0,
) {
  const emptyJoints = Array.from({ length: 17 }, () => new THREE.Vector3());
  return {
    uTime: { value: 0 },
    uDisplacement: { value: preset.displacementMeters },
    uNormalOffset: { value: 0 },
    uStructuralCut: { value: 0.018 },
    uBaseColor: { value: new THREE.Color(preset.baseColor) },
    uShadowColor: { value: new THREE.Color(preset.shadowColor) },
    uRimColor: { value: new THREE.Color(preset.rimColor) },
    uOpacity: { value: preset.opacity },
    uRimStrength: { value: preset.rimStrength },
    uShellOpacity: { value: preset.shellOpacity },
    uBandStrength: { value: preset.bandStrength },
    uFantasyStrength: { value: fantasyStrength },
    uContrastOutline: { value: contrastOutline },
    uCyberStrength: { value: cyberStrength },
    uCyberSeed: { value: cyberSeed },
    uAccentColor: { value: new THREE.Color(accentColor) },
    uCompositeAttenuation: { value: THREE.MathUtils.clamp(compositeAttenuation, 0, 1) },
    uRuntimePose: { value: runtimePose ? 1 : 0 },
    uRestJoints: { value: runtimePose?.restJoints ?? emptyJoints },
    uTargetJoints: { value: runtimePose?.targetJoints ?? emptyJoints.map((joint) => joint.clone()) },
    uRestHandEnds: { value: runtimePose?.restHandEnds ?? [new THREE.Vector3(), new THREE.Vector3()] },
    uTargetHandEnds: { value: runtimePose?.targetHandEnds ?? [new THREE.Vector3(), new THREE.Vector3()] },
    uPoseMatrices: {
      value: runtimePose?.poseMatrices
        ?? Array.from({ length: 17 }, () => new THREE.Matrix4()),
    },
  };
}

export interface SpectralRenderOptions {
  compositeAttenuation?: number;
  shellNormalOffsetMeters?: number;
  /** @deprecated Retained only for saved callers; new shells use a world-space normal offset. */
  shellScale?: number;
  enableShell?: boolean;
  fantasyEffects?: boolean;
  particleCount?: number;
  cyberEffects?: boolean;
  groundInteraction?: boolean;
  cyberSignalCount?: number;
  runtimeSkinning?: boolean;
  rig?: GhostRig;
  poseLandmarks?: Landmark[];
  tintHex?: string;
}

/**
 * Pass 0 owns structure depth, pass 1 draws only the nearest surface, and pass 2
 * adds a restrained back-face halo. All passes use canonical, seeded inputs.
 */
export function createSpectralRenderGroup(
  geometry: THREE.BufferGeometry,
  styleId: GhostStyleId,
  options: SpectralRenderOptions = {},
): THREE.Group {
  if (!geometry.getAttribute("bridgeCanonical") || !geometry.getAttribute("bridgeRegionChain")) {
    throw new Error("Spectral Render V3 requires canonical and region-chain vertex attributes.");
  }
  if (!geometry.getAttribute("bridgeAppearance")) {
    const neutralAppearance = new Float32Array(geometry.getAttribute("position").count);
    neutralAppearance.fill(0.5);
    geometry.setAttribute("bridgeAppearance", new THREE.BufferAttribute(neutralAppearance, 1));
    geometry.userData.spectralAppearanceViews = 0;
  }

  const corePreset = SPECTRAL_RENDER_PRESETS[styleId];
  const fantasyEnabled = options.fantasyEffects === true && corePreset.family === "fantasy";
  const fantasyPreset = fantasyEnabled
    ? applySpectralTint(SPECTRAL_FANTASY_PRESETS[styleId as "wraith" | "phantom"], options.tintHex)
    : undefined;
  const cyberEnabled = options.cyberEffects === true && corePreset.family === "cyber";
  const cyberPreset = cyberEnabled
    ? applySpectralTint(SPECTRAL_CYBER_PRESETS[styleId as "cyber" | "quantum"], options.tintHex)
    : undefined;
  const preset = fantasyPreset ?? cyberPreset ?? applySpectralTint(corePreset, options.tintHex);
  const fantasyStrength = fantasyPreset?.fantasyStrength ?? 0;
  const contrastOutline = fantasyPreset?.contrastOutline ?? 0;
  const cyberStrength = cyberPreset?.cyberStrength ?? 0;
  const accentColor = cyberPreset?.accentColor ?? 0xffffff;
  const cyberSeed = cyberPreset?.phaseSeed ?? 0;
  const compositeAttenuation = options.compositeAttenuation ?? 1;
  if (options.runtimeSkinning && (!options.rig || !options.poseLandmarks)) {
    throw new Error("Spectral runtime skinning requires a rig and pose landmarks.");
  }
  const runtimePose = options.runtimeSkinning
    ? createSpectralRuntimePose(options.rig!, options.poseLandmarks!)
    : undefined;
  const commonMaterial = {
    vertexShader: spectralVertexShader,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    premultipliedAlpha: true,
  } as const;

  const depthMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
    fragmentShader: spectralDepthFragmentShader,
    colorWrite: false,
    depthWrite: true,
    transparent: false,
    side: THREE.FrontSide,
  });
  depthMaterial.name = `${SPECTRAL_RENDER_VERSION}-depth`;

  const surfaceMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
    fragmentShader: spectralSurfaceFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  surfaceMaterial.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}-surface`;

  const shellMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
    fragmentShader: spectralShellFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  shellMaterial.uniforms.uNormalOffset.value = options.shellNormalOffsetMeters
    ?? (fantasyEnabled
      ? SPECTRAL_NORMAL_OFFSETS_METERS.fantasyShell
      : cyberEnabled
        ? SPECTRAL_NORMAL_OFFSETS_METERS.cyberShell
        : SPECTRAL_NORMAL_OFFSETS_METERS.sharedShell);
  shellMaterial.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}-shell`;

  const group = new THREE.Group();
  group.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}`;
  group.userData.spectralRenderVersion = SPECTRAL_RENDER_VERSION;
  group.userData.spectralRenderFamily = preset.family;
  group.userData.spectralFantasyV5 = fantasyEnabled;
  if (fantasyEnabled) group.userData.spectralFantasyVersion = SPECTRAL_FANTASY_VERSION;
  group.userData.spectralCyberV6 = cyberEnabled;
  if (cyberEnabled) group.userData.spectralCyberVersion = SPECTRAL_CYBER_VERSION;
  group.userData.spectralGroundInteraction = options.groundInteraction === true;

  const createMesh = (material: THREE.Material) => runtimePose
    ? createSpectralSkinnedMesh(geometry, material, options.rig!)
    : new THREE.Mesh(geometry, material);

  const depth = createMesh(depthMaterial);
  depth.name = "spectral-v3-depth-prepass";
  depth.renderOrder = 0;
  group.add(depth);

  const surface = createMesh(surfaceMaterial);
  surface.name = "spectral-v3-main-surface";
  surface.renderOrder = 1;
  group.add(surface);

  if (fantasyEnabled && options.enableShell !== false) {
    const coreMaterial = new THREE.ShaderMaterial({
      ...commonMaterial,
      uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
      fragmentShader: spectralFantasyCoreFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    coreMaterial.uniforms.uNormalOffset.value = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyCore;
    coreMaterial.name = `${SPECTRAL_FANTASY_VERSION}-inner-soul-current`;
    const core = createMesh(coreMaterial);
    core.name = "spectral-v5-fantasy-inner-soul-current";
    core.userData.spectralNormalOffsetMeters = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyCore;
    core.userData.spectralSurfaceAttached = true;
    core.renderOrder = 1.5;
    group.add(core);
  }

  if (options.enableShell !== false) {
    const shell = createMesh(shellMaterial);
    shell.name = "spectral-v3-additive-back-shell";
    shell.scale.setScalar(options.shellScale ?? 1);
    shell.userData.spectralNormalOffsetMeters = shellMaterial.uniforms.uNormalOffset.value;
    shell.renderOrder = 2;
    group.add(shell);

    if (cyberEnabled) {
      const echoMaterial = new THREE.ShaderMaterial({
        vertexShader: cyberPhaseEchoVertexShader,
        fragmentShader: cyberPhaseEchoFragmentShader,
        uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      });
      echoMaterial.uniforms.uNormalOffset.value = SPECTRAL_NORMAL_OFFSETS_METERS.cyberPhaseEcho;
      echoMaterial.name = `${SPECTRAL_CYBER_VERSION}-phase-echo`;
      const echo = createMesh(echoMaterial);
      echo.name = "spectral-v6-cyber-phase-echo";
      echo.userData.spectralNormalOffsetMeters = SPECTRAL_NORMAL_OFFSETS_METERS.cyberPhaseEcho;
      echo.renderOrder = 2.4;
      group.add(echo);
    }

    if (fantasyEnabled) {
      const auraMaterial = shellMaterial.clone();
      auraMaterial.name = `${SPECTRAL_RENDER_VERSION}-fantasy-aura`;
      auraMaterial.uniforms.uShellOpacity.value = preset.shellOpacity * 0.42;
      auraMaterial.uniforms.uNormalOffset.value = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyAura;
      const aura = createMesh(auraMaterial);
      aura.name = "spectral-v5-fantasy-aura-shell";
      aura.userData.spectralNormalOffsetMeters = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyAura;
      aura.renderOrder = 2;
      group.add(aura);

      if (contrastOutline > 0.001) {
        const outlineMaterial = new THREE.ShaderMaterial({
          ...commonMaterial,
          uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed),
          fragmentShader: spectralContrastOutlineFragmentShader,
          transparent: true,
          depthWrite: false,
          side: THREE.BackSide,
          blending: THREE.NormalBlending,
        });
        outlineMaterial.uniforms.uNormalOffset.value = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyContrastOutline;
        outlineMaterial.name = `${SPECTRAL_RENDER_VERSION}-fantasy-contrast-outline`;
        const outline = createMesh(outlineMaterial);
        outline.name = "spectral-v5-fantasy-contrast-outline";
        outline.userData.spectralNormalOffsetMeters = SPECTRAL_NORMAL_OFFSETS_METERS.fantasyContrastOutline;
        outline.renderOrder = 2;
        group.add(outline);
      }
    }
  }

  const particleCount = fantasyEnabled ? Math.max(0, Math.trunc(options.particleCount ?? 0)) : 0;
  if (particleCount > 0 && fantasyPreset) {
    const particleGeometry = sampleSurfaceEffectGeometry(geometry, particleCount);
    const particleUniforms = createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed);
    Object.assign(particleUniforms, {
      uParticleColor: { value: new THREE.Color(fantasyPreset.particleColor) },
      uParticleSize: { value: particleCount > 72 ? 10 : 8 },
    });
    const particleMaterial = new THREE.ShaderMaterial({
      vertexShader: fantasyParticleVertexShader,
      fragmentShader: fantasyParticleFragmentShader,
      uniforms: particleUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    });
    particleMaterial.name = `${SPECTRAL_RENDER_VERSION}-fantasy-particles`;
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    particles.name = "spectral-v5-fantasy-particles";
    particles.renderOrder = 3;
    particles.frustumCulled = false;
    particles.userData.particleCount = particleCount;
    group.add(particles);
  }

  if (options.groundInteraction) {
    if (fantasyEnabled && fantasyPreset) {
      group.add(createFantasyGroundMist(fantasyPreset, compositeAttenuation));
    } else if (cyberEnabled && cyberPreset) {
      group.add(createCyberGroundDisc(cyberPreset, compositeAttenuation));
    }
  }

  const cyberSignalCount = cyberEnabled
    ? Math.max(0, Math.trunc(options.cyberSignalCount ?? 0))
    : 0;
  if (cyberSignalCount > 0 && cyberPreset) {
    const signalGeometry = sampleSurfaceEffectGeometry(geometry, cyberSignalCount, 5);
    const signalUniforms = createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline, cyberStrength, accentColor, cyberSeed);
    Object.assign(signalUniforms, {
      uSignalSize: { value: cyberSignalCount > 48 ? 17 : 14 },
    });
    const signalMaterial = new THREE.ShaderMaterial({
      vertexShader: cyberSignalVertexShader,
      fragmentShader: cyberSignalFragmentShader,
      uniforms: signalUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    });
    signalMaterial.name = `${SPECTRAL_CYBER_VERSION}-signal-glyphs`;
    const signals = new THREE.Points(signalGeometry, signalMaterial);
    signals.name = "spectral-v6-cyber-signal-glyphs";
    signals.renderOrder = 3;
    signals.frustumCulled = false;
    signals.userData.signalCount = cyberSignalCount;
    group.add(signals);
  }

  return group;
}
