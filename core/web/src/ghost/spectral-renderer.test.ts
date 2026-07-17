import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createSpectralRenderGroup,
  SPECTRAL_RENDER_PRESETS,
  SPECTRAL_RENDER_VERSION,
  SPECTRAL_STRUCTURAL_FRAGMENT,
  SPECTRAL_VERTEX_COMMON,
} from "./spectral-renderer";

function canonicalGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, 0, 0,
    0.5, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setAttribute("bridgeCanonical", new THREE.Float32BufferAttribute([
    0, 0, 0.5,
    1, 0, 0.5,
    0.5, 1, 0.5,
  ], 3));
  geometry.setAttribute("bridgeRegionChain", new THREE.Float32BufferAttribute([
    0, 0,
    0, 1,
    0, 0.5,
  ], 2));
  geometry.setIndex([0, 1, 2]);
  return geometry;
}

describe("Spectral Render V3 core", () => {
  it("maps the four saved ids onto two style families", () => {
    expect(SPECTRAL_RENDER_PRESETS.wraith.family).toBe("fantasy");
    expect(SPECTRAL_RENDER_PRESETS.phantom.family).toBe("fantasy");
    expect(SPECTRAL_RENDER_PRESETS.cyber.family).toBe("cyber");
    expect(SPECTRAL_RENDER_PRESETS.quantum.family).toBe("cyber");
    expect(SPECTRAL_RENDER_PRESETS.wraith.bandStrength).toBe(0);
    expect(SPECTRAL_RENDER_PRESETS.cyber.bandStrength).toBeGreaterThan(0);
  });

  it("creates ordered depth, surface and back-shell passes", () => {
    const group = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      compositeAttenuation: 0.62,
    });
    expect(group.userData.spectralRenderVersion).toBe(SPECTRAL_RENDER_VERSION);
    expect(group.children.map((child) => child.renderOrder)).toEqual([0, 1, 2]);

    const [depth, surface, shell] = group.children as THREE.Mesh[];
    const depthMaterial = depth.material as THREE.ShaderMaterial;
    const surfaceMaterial = surface.material as THREE.ShaderMaterial;
    const shellMaterial = shell.material as THREE.ShaderMaterial;
    expect(depthMaterial.colorWrite).toBe(false);
    expect(depthMaterial.depthWrite).toBe(true);
    expect(depthMaterial.side).toBe(THREE.FrontSide);
    expect(surfaceMaterial.depthWrite).toBe(false);
    expect(surfaceMaterial.side).toBe(THREE.FrontSide);
    expect(surfaceMaterial.premultipliedAlpha).toBe(true);
    expect(shellMaterial.side).toBe(THREE.BackSide);
    expect(shellMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(surfaceMaterial.uniforms.uCompositeAttenuation.value).toBeCloseTo(0.62);
  });

  it("uses identical canonical displacement and structural clipping chunks", () => {
    const group = createSpectralRenderGroup(canonicalGeometry(), "cyber");
    const [depth, surface, shell] = group.children as THREE.Mesh[];
    const materials = [depth, surface, shell].map((mesh) => mesh.material as THREE.ShaderMaterial);
    materials.forEach((material) => {
      expect(material.vertexShader).toContain(SPECTRAL_VERTEX_COMMON.trim());
      expect(material.fragmentShader).toContain(SPECTRAL_STRUCTURAL_FRAGMENT.trim());
      expect(material.vertexShader).not.toContain("modelMatrix *");
      expect(material.fragmentShader).not.toContain("Math.random");
    });
    expect(materials[0].vertexShader).toBe(materials[1].vertexShader);
    expect(materials[0].vertexShader).toBe(materials[2].vertexShader);
  });

  it("rejects legacy geometry without stable body-space attributes", () => {
    const geometry = new THREE.BufferGeometry();
    expect(() => createSpectralRenderGroup(geometry, "wraith")).toThrow(/canonical/i);
  });
});
