import * as THREE from "three";
import type { GhostStyleId } from "../models/types";

export const SPECTRAL_RENDER_VERSION = "spectral-render-v3-core-v1" as const;

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

/** Existing saved style ids remain readable while the UI converges on two families. */
export const SPECTRAL_RENDER_PRESETS: Readonly<Record<GhostStyleId, SpectralRenderPreset>> = Object.freeze({
  wraith: Object.freeze({
    family: "fantasy",
    baseColor: 0x9fc7ed,
    shadowColor: 0x1e324a,
    rimColor: 0xf2f8ff,
    opacity: 0.76,
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

export const SPECTRAL_VERTEX_COMMON = /* glsl */ `
  attribute vec3 bridgeCanonical;
  attribute vec2 bridgeRegionChain;
  uniform float uTime;
  uniform float uDisplacement;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;

  float spectralVertexWave(vec3 canonical, vec2 regionChain, float time) {
    float low = sin(dot(canonical, vec3(5.37, 8.11, 4.73)) + time * 0.42);
    float detail = sin(dot(canonical, vec3(-11.3, 3.7, 9.1)) - time * 0.29 + regionChain.y * 2.4);
    return low * 0.72 + detail * 0.28;
  }
`;

export const SPECTRAL_STRUCTURAL_FRAGMENT = /* glsl */ `
  uniform float uStructuralCut;

  float spectralHash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float spectralStructuralMask(vec3 canonical, vec2 regionChain) {
    float stableCell = spectralHash13(floor(canonical * 36.0) + vec3(regionChain.x * 7.0));
    float footCut = uStructuralCut + (stableCell - 0.5) * 0.016;
    return step(footCut, canonical.y);
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
    float anchored = smoothstep(0.02, 0.14, bridgeCanonical.y);
    float displacement = spectralVertexWave(bridgeCanonical, bridgeRegionChain, uTime)
      * uDisplacement * anchored;
    vec3 spectralPosition = position + normal * displacement;
    vec4 mvPosition = modelViewMatrix * vec4(spectralPosition, 1.0);
    vSpectralViewPosition = -mvPosition.xyz;
    vSpectralNormal = normalize(normalMatrix * normal);
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
  uniform float uOpacity;
  uniform float uRimStrength;
  uniform float uBandStrength;
  uniform float uCompositeAttenuation;
  uniform float uTime;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;

    vec3 viewDir = normalize(vSpectralViewPosition);
    vec3 normal = normalize(vSpectralNormal);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 1.55);
    float formLight = 0.36 + 0.34 * max(normal.y, 0.0) + 0.30 * facing;
    float flow = sin(vSpectralCanonical.y * 12.0 + vSpectralRegionChain.y * 3.5 - uTime * 0.55) * 0.5 + 0.5;
    float band = smoothstep(0.88, 1.0, sin(vSpectralCanonical.y * 48.0 - uTime * 1.2) * 0.5 + 0.5);
    float energy = 0.88 + flow * 0.12 + band * uBandStrength;

    vec3 core = mix(uShadowColor, uBaseColor, clamp(formLight, 0.0, 1.0));
    vec3 rim = uRimColor * fresnel * uRimStrength * uCompositeAttenuation;
    vec3 color = core * energy + rim;
    color = color / (vec3(1.0) + max(color - vec3(0.72), vec3(0.0)) * 0.62);

    float coverage = spectralAppearanceCoverage(vSpectralCanonical);
    float alpha = uOpacity * coverage * (0.78 + fresnel * 0.22);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const spectralShellFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uRimColor;
  uniform float uShellOpacity;
  uniform float uCompositeAttenuation;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    float rim = pow(1.0 - abs(dot(normalize(vSpectralNormal), viewDir)), 1.35);
    float alpha = uShellOpacity * spectralAppearanceCoverage(vSpectralCanonical) * rim;
    if (alpha < 0.004) discard;
    vec3 color = uRimColor * uCompositeAttenuation;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

function createUniforms(preset: SpectralRenderPreset, compositeAttenuation: number) {
  return {
    uTime: { value: 0 },
    uDisplacement: { value: preset.displacementMeters },
    uStructuralCut: { value: 0.018 },
    uBaseColor: { value: new THREE.Color(preset.baseColor) },
    uShadowColor: { value: new THREE.Color(preset.shadowColor) },
    uRimColor: { value: new THREE.Color(preset.rimColor) },
    uOpacity: { value: preset.opacity },
    uRimStrength: { value: preset.rimStrength },
    uShellOpacity: { value: preset.shellOpacity },
    uBandStrength: { value: preset.bandStrength },
    uCompositeAttenuation: { value: THREE.MathUtils.clamp(compositeAttenuation, 0, 1) },
  };
}

export interface SpectralRenderOptions {
  compositeAttenuation?: number;
  shellScale?: number;
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

  const preset = SPECTRAL_RENDER_PRESETS[styleId];
  const compositeAttenuation = options.compositeAttenuation ?? 1;
  const commonMaterial = {
    vertexShader: spectralVertexShader,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    premultipliedAlpha: true,
  } as const;

  const depthMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation),
    fragmentShader: spectralDepthFragmentShader,
    colorWrite: false,
    depthWrite: true,
    transparent: false,
    side: THREE.FrontSide,
  });
  depthMaterial.name = `${SPECTRAL_RENDER_VERSION}-depth`;

  const surfaceMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation),
    fragmentShader: spectralSurfaceFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  surfaceMaterial.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}-surface`;

  const shellMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation),
    fragmentShader: spectralShellFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  shellMaterial.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}-shell`;

  const group = new THREE.Group();
  group.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}`;
  group.userData.spectralRenderVersion = SPECTRAL_RENDER_VERSION;
  group.userData.spectralRenderFamily = preset.family;

  const depth = new THREE.Mesh(geometry, depthMaterial);
  depth.name = "spectral-v3-depth-prepass";
  depth.renderOrder = 0;
  group.add(depth);

  const surface = new THREE.Mesh(geometry, surfaceMaterial);
  surface.name = "spectral-v3-main-surface";
  surface.renderOrder = 1;
  group.add(surface);

  const shell = new THREE.Mesh(geometry, shellMaterial);
  shell.name = "spectral-v3-additive-back-shell";
  shell.scale.setScalar(options.shellScale ?? 1.018);
  shell.renderOrder = 2;
  group.add(shell);

  return group;
}
