import * as THREE from "three";
import type { GhostStyleId } from "../models/types";
import { GHOST_STYLES } from "./styles";

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uOuter;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vLocalPosition;
  varying float vWorldY;

  void main() {
    float cycle = uTime * 0.78539816339;
    float waveA = sin(position.y * 4.0 + cycle);
    float waveB = sin(position.x * 6.3 - position.z * 4.7 + cycle * 1.37);
    float displacement = (waveA + waveB * 0.5) / 1.5 * 0.008;
    vec3 ghostPosition = position + normal * displacement;
    vLocalPosition = ghostPosition;
    vWorldY = (modelMatrix * vec4(ghostPosition, 1.0)).y;
    vec4 mvPosition = modelViewMatrix * vec4(ghostPosition, 1.0);
    vViewPosition = -mvPosition.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uEmissive;
  uniform float uQuantum;
  uniform float uOuter;
  uniform float uScanIntensity;
  uniform float uFootY;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vLocalPosition;
  varying float vWorldY;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 1.5);
    float scan = sin(vLocalPosition.y * 10.0 - uTime * 2.0) * 0.5 + 0.5;
    scan = smoothstep(0.86, 1.0, scan);
    float band = sin(vLocalPosition.y * 7.0 - uTime * 1.05) * 0.5 + 0.5;
    float noise = hash(floor(vLocalPosition * 38.0) + uTime * 0.3);
    float breathing = 0.92 + sin(uTime * 1.15 + vLocalPosition.y * 2.0) * 0.08;
    float flicker = uQuantum > 0.5 ? (0.96 + noise * 0.08) : breathing;

    vec3 coolRim = mix(uColor, vec3(0.78, 0.9, 1.0), 0.3);
    vec3 base = uColor * (0.48 + band * 0.2);
    vec3 glow = coolRim * min(uEmissive, 0.35) * (0.55 + fresnel * 1.15 + scan * uScanIntensity);
    vec3 finalColor = mix(base + glow, coolRim * (1.2 + fresnel), uOuter);

    float heightAboveFoot = vWorldY - uFootY;
    float footNoise = (noise - 0.5) * 0.035;
    float footZone = 1.0 - smoothstep(0.0 + footNoise, 0.12 + footNoise, heightAboveFoot);
    float erosion = 1.0 - footZone * step(noise, 0.72);
    float footFade = mix(0.15, 1.0, 1.0 - footZone) * erosion;
    float innerAlpha = uOpacity * (0.42 + fresnel * 0.58 + scan * uScanIntensity * 0.3);
    float outerAlpha = uOpacity * fresnel * 0.38;
    float alpha = mix(innerAlpha, outerAlpha, uOuter) * footFade * flicker;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(finalColor * flicker, alpha);
  }
`;

export function createHolographicMaterial(
  styleId: GhostStyleId,
  options: { outer?: boolean; opacityScale?: number; footY?: number } = {},
): THREE.ShaderMaterial {
  const style = GHOST_STYLES[styleId];
  const outer = options.outer ?? false;
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(style.color) },
      uOpacity: { value: style.opacity * (options.opacityScale ?? 1) },
      uTime: { value: 0 },
      uEmissive: { value: Math.min(style.emissive, 0.35) },
      uQuantum: { value: styleId === "quantum" ? 1 : 0 },
      uOuter: { value: outer ? 1 : 0 },
      uScanIntensity: { value: styleId === "cyber" ? 0.18 : 0 },
      uFootY: { value: options.footY ?? -1.3 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: outer ? THREE.BackSide : THREE.DoubleSide,
    blending: outer ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export function updateHolographicMaterials(root: THREE.Object3D, time: number): void {
  root.traverse((child) => {
    if ((child instanceof THREE.Mesh || child instanceof THREE.Points)
      && child.material instanceof THREE.ShaderMaterial) {
      if (child.material.uniforms.uTime) child.material.uniforms.uTime.value = time;
    }
  });
}
