import * as THREE from "three";
import type { GhostStyleId, Landmark } from "../models/types";
import type { GhostRig } from "./body-model";
import {
  createSpectralRuntimePose,
  createSpectralSkinnedMesh,
  type SpectralRuntimePose,
} from "./spectral-skinned-mesh";

export const SPECTRAL_RENDER_VERSION = "spectral-render-v3-core-v1" as const;
export const SPECTRAL_FANTASY_VERSION = "fantasy-spirit-v5-1" as const;

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
    baseColor: 0xf0443e,
    shadowColor: 0x52070d,
    rimColor: 0xffb070,
    opacity: 0.76,
    rimStrength: 0.94,
    shellOpacity: 0.22,
    displacementMeters: 0.0048,
    bandStrength: 0,
    fantasyStrength: 1,
    particleColor: 0xff6f52,
    contrastOutline: 0,
  }),
  phantom: Object.freeze({
    family: "fantasy",
    baseColor: 0xdff7ff,
    shadowColor: 0x29445f,
    rimColor: 0xecffff,
    opacity: 0.63,
    rimStrength: 1.05,
    shellOpacity: 0.20,
    displacementMeters: 0.0042,
    bandStrength: 0,
    fantasyStrength: 0.88,
    particleColor: 0xcaf5ff,
    contrastOutline: 0.48,
  }),
});

export const SPECTRAL_VERTEX_COMMON = /* glsl */ `
  attribute vec3 bridgeCanonical;
  attribute vec2 bridgeRegionChain;
  #ifndef USE_SKINNING
    attribute vec4 skinIndex;
    attribute vec4 skinWeight;
  #endif
  uniform float uTime;
  uniform float uDisplacement;
  uniform float uFantasyStrength;
  uniform float uRuntimePose;
  uniform vec3 uRestJoints[17];
  uniform vec3 uTargetJoints[17];
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;

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

  float spectralVertexWave(vec3 canonical, vec2 regionChain, float time) {
    float low = sin(dot(canonical, vec3(5.37, 8.11, 4.73)) + time * 0.42);
    float detail = sin(dot(canonical, vec3(-11.3, 3.7, 9.1)) - time * 0.29 + regionChain.y * 2.4);
    float coreWave = low * 0.72 + detail * 0.28;
    vec3 flow = vec3(canonical.x * 3.2, canonical.y * 3.6 - time * 0.13 - regionChain.y * 0.9, canonical.z * 3.2);
    float fantasyLow = spectralVertexNoise(flow) * 2.0 - 1.0;
    float fantasyDetail = spectralVertexNoise(flow * 1.93 + vec3(7.1, -time * 0.07, 3.4)) * 2.0 - 1.0;
    float fantasyWave = fantasyLow * 0.72 + fantasyDetail * 0.28;
    return mix(coreWave, fantasyWave, clamp(uFantasyStrength, 0.0, 1.0));
  }

  vec3 spectralRotateBetween(vec3 value, vec3 fromDirection, vec3 toDirection) {
    float fromLength = length(fromDirection);
    float toLength = length(toDirection);
    if (fromLength < 0.00001 || toLength < 0.00001) return value;
    vec3 from = fromDirection / fromLength;
    vec3 to = toDirection / toLength;
    float cosine = clamp(dot(from, to), -1.0, 1.0);
    if (cosine > 0.9999) return value;
    if (cosine < -0.9999) {
      vec3 reference = abs(from.x) < 0.8 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      vec3 axis = normalize(cross(from, reference));
      return -value + 2.0 * axis * dot(axis, value);
    }
    vec3 crossValue = cross(from, to);
    float sine = length(crossValue);
    vec3 axis = crossValue / max(sine, 0.00001);
    return value * cosine
      + cross(axis, value) * sine
      + axis * dot(axis, value) * (1.0 - cosine);
  }

  vec3 spectralMapSegment(
    vec3 source,
    vec3 restStart,
    vec3 restEnd,
    vec3 targetStart,
    vec3 targetEnd,
    float parameter
  ) {
    float t = clamp(parameter, 0.0, 1.0);
    vec3 restCenter = mix(restStart, restEnd, t);
    vec3 targetCenter = mix(targetStart, targetEnd, t);
    return spectralRotateBetween(source - restCenter, restEnd - restStart, targetEnd - targetStart)
      + targetCenter;
  }

  float spectralSegmentParameter(vec3 source, vec3 start, vec3 end) {
    vec3 segment = end - start;
    float denominator = dot(segment, segment);
    if (denominator < 0.0000001) return 0.0;
    return clamp(dot(source - start, segment) / denominator, 0.0, 1.0);
  }

  vec3 spectralMapCore(vec3 source) {
    int start = 0;
    if (source.y > uRestJoints[1].y) start = 1;
    if (source.y > uRestJoints[2].y) start = 2;
    if (source.y > uRestJoints[3].y) start = 3;
    int end = start + 1;
    return spectralMapSegment(
      source,
      uRestJoints[start],
      uRestJoints[end],
      uTargetJoints[start],
      uTargetJoints[end],
      spectralSegmentParameter(source, uRestJoints[start], uRestJoints[end])
    );
  }

  float spectralRangeWeight(float minimumBone, float maximumBone) {
    float total = 0.0;
    if (skinIndex.x >= minimumBone && skinIndex.x <= maximumBone) total += skinWeight.x;
    if (skinIndex.y >= minimumBone && skinIndex.y <= maximumBone) total += skinWeight.y;
    if (skinIndex.z >= minimumBone && skinIndex.z <= maximumBone) total += skinWeight.z;
    if (skinIndex.w >= minimumBone && skinIndex.w <= maximumBone) total += skinWeight.w;
    return total;
  }

  vec3 spectralMapLimb(
    vec3 source,
    float chainT,
    int startBone,
    int middleBone,
    int endBone,
    bool arm
  ) {
    float firstEnd = arm ? 0.52 : 0.5;
    float secondEnd = 0.9;
    if (chainT <= firstEnd) {
      return spectralMapSegment(
        source,
        uRestJoints[startBone], uRestJoints[middleBone],
        uTargetJoints[startBone], uTargetJoints[middleBone],
        chainT / firstEnd
      );
    }
    if (chainT <= secondEnd) {
      return spectralMapSegment(
        source,
        uRestJoints[middleBone], uRestJoints[endBone],
        uTargetJoints[middleBone], uTargetJoints[endBone],
        (chainT - firstEnd) / (secondEnd - firstEnd)
      );
    }
    vec3 restEnd = arm
      ? uRestJoints[endBone] + (uRestJoints[endBone] - uRestJoints[middleBone]) * 0.3
      : uRestJoints[endBone] + vec3(0.0, -0.05, 0.2);
    vec3 targetEnd = arm
      ? uTargetJoints[endBone] + (uTargetJoints[endBone] - uTargetJoints[middleBone]) * 0.3
      : uTargetJoints[endBone] + vec3(0.0, -0.05, 0.2);
    return spectralMapSegment(
      source,
      uRestJoints[endBone], restEnd,
      uTargetJoints[endBone], targetEnd,
      (chainT - secondEnd) / (1.0 - secondEnd)
    );
  }

  vec3 spectralRuntimePosition(vec3 source) {
    if (uRuntimePose < 0.5) return source;
    float region = floor(bridgeRegionChain.x * 255.0 + 0.5);
    float chainT = bridgeRegionChain.y;
    vec3 core = spectralMapCore(source);
    vec3 limb = core;
    float attachment = 0.0;
    if (region == 2.0 || region == 3.0) {
      bool left = region == 2.0;
      int startBone = left ? 5 : 8;
      int middleBone = left ? 6 : 9;
      int endBone = left ? 7 : 10;
      limb = spectralMapLimb(source, chainT, startBone, middleBone, endBone, true);
      attachment = smoothstep(0.01, 0.2, chainT)
        * min(1.0, spectralRangeWeight(float(startBone), float(endBone)) * 1.35);
    } else if (region == 4.0 || region == 5.0) {
      bool left = region == 4.0;
      int startBone = left ? 11 : 14;
      int middleBone = left ? 12 : 15;
      int endBone = left ? 13 : 16;
      limb = spectralMapLimb(source, chainT, startBone, middleBone, endBone, false);
      attachment = smoothstep(0.01, 0.22, chainT)
        * min(1.0, spectralRangeWeight(float(startBone), float(endBone)) * 1.35);
    }
    return mix(core, limb, attachment);
  }
`;

export const SPECTRAL_STRUCTURAL_FRAGMENT = /* glsl */ `
  uniform float uStructuralCut;

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
    vec3 posedPosition = spectralRuntimePosition(position);
    vec3 posedNormal = normal;
    if (uRuntimePose > 0.5) {
      vec3 posedOffset = spectralRuntimePosition(position + normal * 0.01);
      posedNormal = normalize(posedOffset - posedPosition);
    }
    float anchored = smoothstep(0.02, 0.14, bridgeCanonical.y);
    float displacement = spectralVertexWave(bridgeCanonical, bridgeRegionChain, uTime)
      * uDisplacement * anchored;
    vec3 spectralPosition = posedPosition + posedNormal * displacement;
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
  uniform float uOpacity;
  uniform float uRimStrength;
  uniform float uBandStrength;
  uniform float uFantasyStrength;
  uniform float uContrastOutline;
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
    float coreEnergy = 0.88 + flow * 0.12 + band * uBandStrength;
    vec3 fantasyFlow = vec3(
      vSpectralCanonical.x * 3.1,
      vSpectralCanonical.y * 3.7 - uTime * 0.14 - vSpectralRegionChain.y * 0.92,
      vSpectralCanonical.z * 3.1
    );
    float fantasyLow = spectralValueNoise(fantasyFlow);
    float fantasyDetail = spectralValueNoise(fantasyFlow * 1.91 + vec3(5.3, -uTime * 0.08, 2.7));
    float regionId = floor(vSpectralRegionChain.x * 255.0 + 0.5);
    float shoulderCore = (1.0 - smoothstep(0.16, 0.34, abs(vSpectralCanonical.y - 0.70)))
      * (1.0 - step(1.5, regionId));
    float shoulderLimb = (step(1.5, regionId) - step(3.5, regionId))
      * (1.0 - smoothstep(0.04, 0.28, vSpectralRegionChain.y));
    float shoulderEnergy = clamp(max(shoulderCore, shoulderLimb), 0.0, 1.0);
    float fantasyEnergy = 0.78 + fantasyLow * 0.28 + fantasyDetail * 0.13 + shoulderEnergy * 0.18;
    float energy = mix(coreEnergy, fantasyEnergy, uFantasyStrength);

    vec3 core = mix(uShadowColor, uBaseColor, clamp(formLight, 0.0, 1.0));
    vec3 rim = uRimColor * fresnel * uRimStrength * uCompositeAttenuation;
    float filament = smoothstep(0.56, 0.82, fantasyDetail + fantasyLow * 0.22);
    vec3 innerGlow = mix(uShadowColor, uBaseColor, 0.42 + fantasyLow * 0.50);
    vec3 fantasyColor = innerGlow * energy
      + uRimColor * (filament * 0.34 + shoulderEnergy * 0.13)
      + rim * (0.90 + fantasyDetail * 0.24);
    vec3 color = mix(core * energy + rim, fantasyColor, uFantasyStrength);
    color = mix(color, uShadowColor * 0.82, fresnel * uContrastOutline);
    color = color / (vec3(1.0) + max(color - vec3(0.72), vec3(0.0)) * 0.62);

    float coverage = spectralAppearanceCoverage(vSpectralCanonical);
    float fantasyDensity = 0.84 + fantasyLow * 0.13 + fantasyDetail * 0.05;
    float alpha = uOpacity * coverage * (0.78 + fresnel * 0.22)
      * mix(1.0, fantasyDensity, uFantasyStrength);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const spectralShellFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uRimColor;
  uniform float uShellOpacity;
  uniform float uCompositeAttenuation;
  uniform float uFantasyStrength;
  uniform float uTime;
  varying vec3 vSpectralNormal;
  varying vec3 vSpectralViewPosition;
  varying vec3 vSpectralCanonical;
  varying vec2 vSpectralRegionChain;
  ${SPECTRAL_STRUCTURAL_FRAGMENT}

  void main() {
    if (spectralStructuralMask(vSpectralCanonical, vSpectralRegionChain) < 0.5) discard;
    vec3 viewDir = normalize(vSpectralViewPosition);
    float rim = pow(1.0 - abs(dot(normalize(vSpectralNormal), viewDir)), 1.35);
    float fantasyPulse = 0.74 + spectralValueNoise(vSpectralCanonical * 4.2 + vec3(0.0, -uTime * 0.12, 0.0)) * 0.26;
    float alpha = uShellOpacity * spectralAppearanceCoverage(vSpectralCanonical) * rim
      * mix(1.0, fantasyPulse, uFantasyStrength);
    if (alpha < 0.004) discard;
    vec3 color = uRimColor * uCompositeAttenuation;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const fantasyParticleVertexShader = /* glsl */ `
  ${SPECTRAL_VERTEX_COMMON}
  attribute float particleSeed;
  uniform float uParticleSize;
  varying float vParticleAlpha;

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
    gl_PointSize = clamp(uParticleSize * (1.0 + particleSeed * 0.68) / max(1.0, -mvPosition.z), 1.25, 7.5);
    float fadeIn = smoothstep(0.0, 0.12, age);
    float fadeOut = 1.0 - smoothstep(0.66, 1.0, age);
    vParticleAlpha = fadeIn * fadeOut * (0.42 + particleSeed * 0.38);
  }
`;

const fantasyParticleFragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uParticleColor;
  uniform float uCompositeAttenuation;
  varying float vParticleAlpha;

  void main() {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    float radius = dot(point, point);
    if (radius > 1.0) discard;
    float softness = exp(-radius * 3.6);
    float alpha = vParticleAlpha * softness * uCompositeAttenuation;
    gl_FragColor = vec4(uParticleColor * alpha, alpha);
  }
`;

function sampleFantasyParticleGeometry(source: THREE.BufferGeometry, count: number): THREE.BufferGeometry {
  const sourcePosition = source.getAttribute("position");
  const sourceNormal = source.getAttribute("normal");
  const sourceCanonical = source.getAttribute("bridgeCanonical");
  const sourceRegionChain = source.getAttribute("bridgeRegionChain");
  const sourceSkinIndex = source.getAttribute("skinIndex");
  const sourceSkinWeight = source.getAttribute("skinWeight");
  if (!sourcePosition || !sourceNormal || !sourceCanonical || !sourceRegionChain || !sourceSkinIndex || !sourceSkinWeight) {
    throw new Error("Fantasy particles require the complete Spectral body attribute contract.");
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
    const sourceIndex = (particle * 1597 + particle * particle * 17 + 23) % sourcePosition.count;
    positions.set(components(sourcePosition, sourceIndex).slice(0, 3), particle * 3);
    normals.set(components(sourceNormal, sourceIndex).slice(0, 3), particle * 3);
    canonical.set(components(sourceCanonical, sourceIndex).slice(0, 3), particle * 3);
    regionChain.set(components(sourceRegionChain, sourceIndex).slice(0, 2), particle * 2);
    skinIndex.set(components(sourceSkinIndex, sourceIndex).map((value) => Math.round(value)), particle * 4);
    skinWeight.set(components(sourceSkinWeight, sourceIndex), particle * 4);
    seeds[particle] = ((particle * 73) % 307) / 307;
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
) {
  const emptyJoints = Array.from({ length: 17 }, () => new THREE.Vector3());
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
    uFantasyStrength: { value: fantasyStrength },
    uContrastOutline: { value: contrastOutline },
    uCompositeAttenuation: { value: THREE.MathUtils.clamp(compositeAttenuation, 0, 1) },
    uRuntimePose: { value: runtimePose ? 1 : 0 },
    uRestJoints: { value: runtimePose?.restJoints ?? emptyJoints },
    uTargetJoints: { value: runtimePose?.targetJoints ?? emptyJoints.map((joint) => joint.clone()) },
  };
}

export interface SpectralRenderOptions {
  compositeAttenuation?: number;
  shellScale?: number;
  enableShell?: boolean;
  fantasyEffects?: boolean;
  particleCount?: number;
  runtimeSkinning?: boolean;
  rig?: GhostRig;
  poseLandmarks?: Landmark[];
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

  const corePreset = SPECTRAL_RENDER_PRESETS[styleId];
  const fantasyEnabled = options.fantasyEffects === true && corePreset.family === "fantasy";
  const fantasyPreset = fantasyEnabled
    ? SPECTRAL_FANTASY_PRESETS[styleId as "wraith" | "phantom"]
    : undefined;
  const preset = fantasyPreset ?? corePreset;
  const fantasyStrength = fantasyPreset?.fantasyStrength ?? 0;
  const contrastOutline = fantasyPreset?.contrastOutline ?? 0;
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
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline),
    fragmentShader: spectralDepthFragmentShader,
    colorWrite: false,
    depthWrite: true,
    transparent: false,
    side: THREE.FrontSide,
  });
  depthMaterial.name = `${SPECTRAL_RENDER_VERSION}-depth`;

  const surfaceMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline),
    fragmentShader: spectralSurfaceFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  surfaceMaterial.name = `${SPECTRAL_RENDER_VERSION}-${preset.family}-surface`;

  const shellMaterial = new THREE.ShaderMaterial({
    ...commonMaterial,
    uniforms: createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline),
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
  group.userData.spectralFantasyV5 = fantasyEnabled;
  if (fantasyEnabled) group.userData.spectralFantasyVersion = SPECTRAL_FANTASY_VERSION;

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

  if (options.enableShell !== false) {
    const shell = createMesh(shellMaterial);
    shell.name = "spectral-v3-additive-back-shell";
    shell.scale.setScalar(options.shellScale ?? (fantasyEnabled ? 1.028 : 1.018));
    shell.renderOrder = 2;
    group.add(shell);
  }

  const particleCount = fantasyEnabled ? Math.max(0, Math.trunc(options.particleCount ?? 0)) : 0;
  if (particleCount > 0 && fantasyPreset) {
    const particleGeometry = sampleFantasyParticleGeometry(geometry, particleCount);
    const particleUniforms = createUniforms(preset, compositeAttenuation, runtimePose, fantasyStrength, contrastOutline);
    Object.assign(particleUniforms, {
      uParticleColor: { value: new THREE.Color(fantasyPreset.particleColor) },
      uParticleSize: { value: particleCount > 120 ? 19 : 16 },
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

  return group;
}
