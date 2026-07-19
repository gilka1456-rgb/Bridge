import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createHolographicMaterial, updateHolographicMaterials } from "./ghost-shader";
import { GHOST_STYLES } from "./styles";

describe("soft ghost material", () => {
  it("uses the fog-blue wraith palette and clamps emissive energy", () => {
    const material = createHolographicMaterial("wraith", { footY: -1.1 });
    expect(GHOST_STYLES.wraith.color).toBe(0xaecbeb);
    expect(GHOST_STYLES.wraith.opacity).toBe(0.55);
    expect(material.uniforms.uEmissive.value).toBeLessThanOrEqual(0.35);
    expect(material.uniforms.uScanIntensity.value).toBe(0);
    expect(material.uniforms.uFootY.value).toBe(-1.1);
    expect(material.fragmentShader).toContain(", 1.5)");
    expect(material.fragmentShader).toContain("0.12");
    expect(material.fragmentShader).toContain("colorspace_fragment");
    expect(material.fragmentShader).toContain("premultiplied_alpha_fragment");
    expect(material.vertexShader).toContain("0.008");
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.premultipliedAlpha).toBe(true);
  });

  it("keeps reduced scan lines only for the cyber style", () => {
    const cyber = createHolographicMaterial("cyber");
    const quantum = createHolographicMaterial("quantum");
    expect(cyber.uniforms.uScanIntensity.value).toBeGreaterThan(0);
    expect(cyber.uniforms.uScanIntensity.value).toBeLessThan(0.35);
    expect(quantum.uniforms.uScanIntensity.value).toBe(0);
    expect(cyber.fragmentShader).toContain("vLocalPosition.y * 10.0");
    expect(GHOST_STYLES.cyber.wireframe).not.toBe(true);
    expect(GHOST_STYLES.quantum.wireframe).not.toBe(true);
  });

  it("advances shader time on both body surfaces and spirit particles", () => {
    const root = new THREE.Group();
    const meshMaterial = createHolographicMaterial("wraith");
    const particleMaterial = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } } });
    root.add(
      new THREE.Mesh(new THREE.BufferGeometry(), meshMaterial),
      new THREE.Points(new THREE.BufferGeometry(), particleMaterial),
    );

    updateHolographicMaterials(root, 3.25);

    expect(meshMaterial.uniforms.uTime.value).toBe(3.25);
    expect(particleMaterial.uniforms.uTime.value).toBe(3.25);
  });
});
