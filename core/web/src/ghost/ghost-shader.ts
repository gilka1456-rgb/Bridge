import * as THREE from "three";
import type { GhostStyleId } from "../models/types";
import { GHOST_STYLES } from "./styles";

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uOuter;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vLocalPosition;

  void main() {
    float flow = sin(position.y * 7.0 + uTime * 0.75)
      * sin(position.x * 5.0 - uTime * 0.42)
      * sin(position.z * 6.0 + uTime * 0.31);
    float displacement = flow * mix(0.004, 0.009, uOuter);
    vec3 ghostPosition = position + normal * displacement;
    vLocalPosition = ghostPosition;
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
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vLocalPosition;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 1.6);
    float scan = sin(vLocalPosition.y * 34.0 - uTime * 3.2) * 0.5 + 0.5;
    scan = smoothstep(0.86, 1.0, scan);
    float band = sin(vLocalPosition.y * 7.0 - uTime * 1.05) * 0.5 + 0.5;
    float noise = hash(floor(vLocalPosition * 38.0) + uTime * 0.3);
    float breathing = 0.92 + sin(uTime * 1.15 + vLocalPosition.y * 2.0) * 0.08;
    float flicker = uQuantum > 0.5 ? (0.82 + noise * 0.18) : breathing;

    vec3 coolRim = mix(uColor, vec3(0.78, 0.9, 1.0), 0.3);
    vec3 base = uColor * (0.48 + band * 0.2);
    vec3 glow = coolRim * uEmissive * (0.55 + fresnel * 1.15 + scan * 0.35);
    vec3 finalColor = mix(base + glow, coolRim * (1.2 + fresnel), uOuter);

    float footNoise = (noise - 0.5) * 0.11;
    float footFade = smoothstep(-0.94 + footNoise, -0.5 + footNoise, vLocalPosition.y);
    float innerAlpha = uOpacity * (0.42 + fresnel * 0.58 + scan * 0.1);
    float outerAlpha = uOpacity * fresnel * 0.38;
    float alpha = mix(innerAlpha, outerAlpha, uOuter) * footFade * flicker;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(finalColor * flicker, alpha);
  }
`;

export function createHolographicMaterial(
  styleId: GhostStyleId,
  options: { outer?: boolean; opacityScale?: number } = {},
): THREE.ShaderMaterial {
  const style = GHOST_STYLES[styleId];
  const outer = options.outer ?? false;
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(style.color) },
      uOpacity: { value: style.opacity * (options.opacityScale ?? 1) },
      uTime: { value: 0 },
      uEmissive: { value: style.emissive },
      uQuantum: { value: styleId === "quantum" ? 1 : 0 },
      uOuter: { value: outer ? 1 : 0 },
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
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) {
      if (child.material.uniforms.uTime) child.material.uniforms.uTime.value = time;
    }
  });
}
