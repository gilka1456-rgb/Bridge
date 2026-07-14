import * as THREE from "three";
import type { GhostStyleId } from "../models/types";
import { GHOST_STYLES } from "./styles";

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
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
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec2 vUv;

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 2.2);

    float scan = sin((vUv.y * 28.0) - uTime * 3.5) * 0.5 + 0.5;
    scan = smoothstep(0.82, 1.0, scan);

    float band = sin((vUv.y * 6.0) - uTime * 1.2) * 0.5 + 0.5;
    float noise = fract(sin(dot(vUv * 120.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    float flicker = uQuantum > 0.5 ? (0.85 + noise * 0.15) : 1.0;

    vec3 base = uColor * (0.55 + band * 0.25);
    vec3 glow = uColor * uEmissive * (0.6 + fresnel * 0.9 + scan * 0.5);
    vec3 finalColor = (base + glow) * flicker;

    float alpha = uOpacity * (0.55 + fresnel * 0.45 + scan * 0.15) * flicker;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

export function createHolographicMaterial(styleId: GhostStyleId): THREE.ShaderMaterial {
  const style = GHOST_STYLES[styleId];
  const color = new THREE.Color(style.color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uOpacity: { value: style.opacity },
      uTime: { value: 0 },
      uEmissive: { value: style.emissive },
      uQuantum: { value: styleId === "quantum" ? 1 : 0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function updateHolographicMaterials(root: THREE.Object3D, time: number): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) {
      if (child.material.uniforms.uTime) {
        child.material.uniforms.uTime.value = time;
      }
    }
  });
}
