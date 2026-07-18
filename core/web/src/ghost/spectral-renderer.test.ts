import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SPECTRAL_ARM_JOINT_VOLUME_RESPONSE,
  SPECTRAL_ARM_SWEEP_RESPONSE,
} from "./body-skinning";
import { GHOST_BODY_REGIONS } from "./body-model";
import {
  applySpectralTint,
  createSpectralRenderGroup,
  sampleSpectralCyberSignalMotion,
  sampleSpectralCyberPhasePulse,
  sampleSpectralFantasyParticleMotion,
  sampleSpectralHighlightCompression,
  sampleSpectralWrappedDiffuse,
  SPECTRAL_COLOR_OUTPUT_FRAGMENT,
  SPECTRAL_AUXILIARY_EFFECT_TIERS,
  SPECTRAL_CYBER_CARRIER_AA,
  SPECTRAL_CYBER_CARRIER_AA_FRAGMENT,
  SPECTRAL_CYBER_GLYPH_RESOLUTION,
  SPECTRAL_CYBER_PHASE_DURATION_SECONDS,
  SPECTRAL_CYBER_PHASE_MAX_OFFSET_METERS,
  SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS,
  SPECTRAL_CYBER_PHASE_PERIOD_SECONDS,
  SPECTRAL_CYBER_PRESETS,
  SPECTRAL_CYBER_VERSION,
  SPECTRAL_EFFECT_HAND_EXCLUSION_CHAIN,
  SPECTRAL_EFFECT_MOTION_LIMITS,
  SPECTRAL_FANTASY_PRESETS,
  SPECTRAL_FANTASY_VERSION,
  SPECTRAL_FANTASY_PARTICLE_COUNTS,
  SPECTRAL_FANTASY_PARTICLE_RESOLUTION,
  SPECTRAL_FANTASY_CONTRAST_RESPONSE,
  SPECTRAL_FORM_LIGHTING,
  SPECTRAL_HAND_SILHOUETTE_STABILITY,
  SPECTRAL_HIGHLIGHT_COMPRESSION,
  SPECTRAL_MATERIAL_RESPONSE,
  SPECTRAL_NORMAL_OFFSETS_METERS,
  SPECTRAL_RENDER_PRESETS,
  SPECTRAL_RENDER_VERSION,
  SPECTRAL_STRUCTURAL_CUT,
  SPECTRAL_STRUCTURAL_FRAGMENT,
  SPECTRAL_SHELL_RESPONSE_FLOORS,
  SPECTRAL_STYLE_SHELL_TIERS,
  SPECTRAL_SURFACE_SAMPLING_VERSION,
  SPECTRAL_TINT_LIGHTNESS_RANGE,
  SPECTRAL_SURFACE_OCCLUSION_FLOORS,
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
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
}

function unevenAreaGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    10, 0, 0,
    20, 0, 0,
    10, 10, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, () => [0, 0, 1]).flat(),
    3,
  ));
  geometry.setAttribute("bridgeCanonical", new THREE.Float32BufferAttribute([
    0, 0, 0.5,
    0.1, 0, 0.5,
    0, 0.1, 0.5,
    0.5, 0, 0.5,
    1, 0, 0.5,
    0.5, 1, 0.5,
  ], 3));
  geometry.setAttribute("bridgeRegionChain", new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, (_, index) => [0, index / 5]).flat(),
    2,
  ));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(
    Array.from({ length: 6 }, (_, index) => [index % 2, (index + 1) % 2, 0, 0]).flat(),
    4,
  ));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, () => [0.75, 0.25, 0, 0]).flat(),
    4,
  ));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  return geometry;
}

function bodyAndDistalHandGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    10, 0, 0,
    20, 0, 0,
    10, 10, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, () => [0, 0, 1]).flat(),
    3,
  ));
  geometry.setAttribute("bridgeCanonical", new THREE.Float32BufferAttribute([
    0, 0, 0.5,
    0.1, 0, 0.5,
    0, 0.1, 0.5,
    0.5, 0, 0.5,
    1, 0, 0.5,
    0.5, 1, 0.5,
  ], 3));
  geometry.setAttribute("bridgeRegionChain", new THREE.Uint8BufferAttribute([
    GHOST_BODY_REGIONS.core, Math.round(0.4 * 255),
    GHOST_BODY_REGIONS.core, Math.round(0.5 * 255),
    GHOST_BODY_REGIONS.core, Math.round(0.6 * 255),
    GHOST_BODY_REGIONS.leftArm, Math.round(0.94 * 255),
    GHOST_BODY_REGIONS.leftArm, Math.round(0.97 * 255),
    GHOST_BODY_REGIONS.leftArm, 255,
  ], 2, true));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(
    Array.from({ length: 6 }, () => [0, 0, 0, 0]).flat(),
    4,
  ));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(),
    4,
  ));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  return geometry;
}

function expandThreeShaderChunks(source: string): string {
  const includePattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
  let expanded = source;
  for (let pass = 0; pass < 64; pass += 1) {
    let replaced = false;
    expanded = expanded.replace(includePattern, (_match, chunkName: string) => {
      const chunk = (THREE.ShaderChunk as Record<string, string | undefined>)[chunkName];
      if (chunk === undefined) throw new Error(`Missing Three.js shader chunk: ${chunkName}`);
      replaced = true;
      return chunk;
    });
    if (!replaced) return expanded;
  }
  throw new Error("Three.js shader chunks contain a recursive include chain.");
}

function expectStructurallyClosedShader(source: string): void {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  expect(withoutComments).not.toContain("#include <");
  expect((withoutComments.match(/\bvoid\s+main\s*\(/g) ?? [])).toHaveLength(1);
  for (const [open, close] of [["{", "}"], ["(", ")"], ["[", "]"]] as const) {
    let depth = 0;
    for (const token of withoutComments) {
      if (token === open) depth += 1;
      if (token === close) depth -= 1;
      if (depth < 0) throw new Error(`Shader closes ${close} before opening ${open}.`);
    }
    if (depth !== 0) throw new Error(`Shader has ${depth} unclosed ${open} token(s).`);
  }
}

describe("Spectral Render V3 core", () => {
  it("maps the four saved ids onto two style families", () => {
    expect(SPECTRAL_RENDER_PRESETS.wraith.family).toBe("fantasy");
    expect(SPECTRAL_RENDER_PRESETS.phantom.family).toBe("fantasy");
    expect(SPECTRAL_RENDER_PRESETS.cyber.family).toBe("cyber");
    expect(SPECTRAL_RENDER_PRESETS.quantum.family).toBe("cyber");
    expect(SPECTRAL_RENDER_PRESETS.wraith.bandStrength).toBe(0);
    expect(SPECTRAL_RENDER_PRESETS.cyber.bandStrength).toBeGreaterThan(0);
    expect(SPECTRAL_FANTASY_PRESETS.wraith.displacementMeters).toBeGreaterThan(0.007);
    expect(SPECTRAL_FANTASY_PRESETS.phantom.displacementMeters).toBeGreaterThan(0.006);
  });

  it("derives a readable palette from any user tint without changing the style family", () => {
    const fantasy = applySpectralTint(SPECTRAL_FANTASY_PRESETS.wraith, "#35d07f");
    expect(fantasy.family).toBe("fantasy");
    expect(fantasy.baseColor).toBe(0x35d07f);
    expect(fantasy.shadowColor).not.toBe(fantasy.baseColor);
    expect(fantasy.rimColor).not.toBe(fantasy.baseColor);
    expect(fantasy.particleColor).not.toBe(SPECTRAL_FANTASY_PRESETS.wraith.particleColor);
    const neutral = applySpectralTint(SPECTRAL_FANTASY_PRESETS.wraith, "#eeeeee");
    const neutralShadowHsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(neutral.shadowColor).getHSL(neutralShadowHsl);
    expect(neutralShadowHsl.s).toBeCloseTo(0);
    const darkest = applySpectralTint(SPECTRAL_FANTASY_PRESETS.wraith, "#000000");
    const darkestBaseHsl = { h: 0, s: 0, l: 0 };
    const darkestShadowHsl = { h: 0, s: 0, l: 0 };
    const darkestRimHsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(darkest.baseColor).getHSL(darkestBaseHsl);
    new THREE.Color(darkest.shadowColor).getHSL(darkestShadowHsl);
    new THREE.Color(darkest.rimColor).getHSL(darkestRimHsl);
    expect(darkestBaseHsl.l).toBeGreaterThanOrEqual(SPECTRAL_TINT_LIGHTNESS_RANGE.minimum - 0.002);
    expect(darkestShadowHsl.l).toBeLessThan(darkestBaseHsl.l);
    expect(darkestRimHsl.l - darkestBaseHsl.l).toBeGreaterThan(0.6);
    const brightest = applySpectralTint(SPECTRAL_FANTASY_PRESETS.phantom, "#ffffff");
    const brightestBaseHsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(brightest.baseColor).getHSL(brightestBaseHsl);
    expect(brightestBaseHsl.l).toBeLessThanOrEqual(SPECTRAL_TINT_LIGHTNESS_RANGE.maximum + 0.002);
    expect(brightest.rimColor).not.toBe(brightest.baseColor);
    const neutralCyber = applySpectralTint(SPECTRAL_CYBER_PRESETS.cyber, "#777777");
    expect(neutralCyber.accentColor).toBe(SPECTRAL_CYBER_PRESETS.cyber.accentColor);
    expect(applySpectralTint(SPECTRAL_FANTASY_PRESETS.wraith, "invalid"))
      .toBe(SPECTRAL_FANTASY_PRESETS.wraith);
    const group = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      tintHex: "#35d07f",
    });
    const surface = group.getObjectByName("spectral-v3-main-surface") as THREE.Mesh;
    expect((surface.material as THREE.ShaderMaterial).uniforms.uBaseColor.value.getHex()).toBe(0x35d07f);
  });

  it("uses a soft shared form light while keeping both primary surfaces dense", () => {
    expect(sampleSpectralWrappedDiffuse(-1, SPECTRAL_FORM_LIGHTING.keyWrap)).toBe(0);
    expect(sampleSpectralWrappedDiffuse(-0.2, SPECTRAL_FORM_LIGHTING.keyWrap)).toBeGreaterThan(0);
    expect(sampleSpectralWrappedDiffuse(0.4, SPECTRAL_FORM_LIGHTING.keyWrap))
      .toBeGreaterThan(sampleSpectralWrappedDiffuse(0, SPECTRAL_FORM_LIGHTING.keyWrap));
    expect(sampleSpectralWrappedDiffuse(1, SPECTRAL_FORM_LIGHTING.fillWrap)).toBe(1);
    expect(SPECTRAL_SURFACE_OCCLUSION_FLOORS.fantasy).toBeGreaterThanOrEqual(0.96);
    expect(SPECTRAL_SURFACE_OCCLUSION_FLOORS.cyber).toBeGreaterThanOrEqual(0.92);
    expect(SPECTRAL_SURFACE_OCCLUSION_FLOORS.fantasy)
      .toBeGreaterThan(SPECTRAL_SURFACE_OCCLUSION_FLOORS.cyber);
    expect(SPECTRAL_SHELL_RESPONSE_FLOORS.fantasy)
      .toBeLessThan(SPECTRAL_SHELL_RESPONSE_FLOORS.cyber);
    expect(SPECTRAL_MATERIAL_RESPONSE.fantasy.scatteringWeight)
      .toBeGreaterThan(SPECTRAL_MATERIAL_RESPONSE.fantasy.directFormWeight);
    expect(SPECTRAL_MATERIAL_RESPONSE.fantasy.scatteringWeight
      + SPECTRAL_MATERIAL_RESPONSE.fantasy.directFormWeight).toBeCloseTo(1);
    expect(SPECTRAL_MATERIAL_RESPONSE.cyber.emissionWeight)
      .toBeGreaterThan(SPECTRAL_MATERIAL_RESPONSE.cyber.directFormWeight * 8);
    expect(SPECTRAL_MATERIAL_RESPONSE.cyber.emissionWeight
      + SPECTRAL_MATERIAL_RESPONSE.cyber.directFormWeight).toBeCloseTo(1);

    const fantasy = createSpectralRenderGroup(canonicalGeometry(), "wraith", { fantasyEffects: true });
    const cyber = createSpectralRenderGroup(canonicalGeometry(), "cyber", { cyberEffects: true });
    const fantasyShader = ((fantasy.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .material as THREE.ShaderMaterial).fragmentShader;
    const cyberShader = ((cyber.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .material as THREE.ShaderMaterial).fragmentShader;
    [fantasyShader, cyberShader].forEach((shader) => {
      expect(shader).toContain("spectralWrappedDiffuse");
      expect(shader).toContain("hemisphereLight");
      expect(shader).toContain("vSpectralWorldNormal");
      expect(shader).toContain("vSpectralWorldPosition");
      expect(shader).toContain("worldFormNormal");
      expect(shader).toContain("keyWorldDirection");
      expect(shader).toContain("fillWorldDirection");
      expect(shader).not.toContain("mat3(viewMatrix)");
      expect(shader).toContain("cyberProjectionDensity");
      expect(shader).toContain(`* (${SPECTRAL_SURFACE_OCCLUSION_FLOORS.cyber.toFixed(2)}`);
    });

    const fantasySurface = fantasy.getObjectByName("spectral-v3-main-surface") as THREE.Mesh;
    const fantasyVertexShader = (fantasySurface.material as THREE.ShaderMaterial).vertexShader;
    expect(fantasyVertexShader).toContain("mat3(modelMatrix) * posedNormal");
    expect(fantasyVertexShader).toContain("modelMatrix * vec4(spectralPosition, 1.0)");
    expect(SPECTRAL_FORM_LIGHTING.keyWorldDirection).toHaveLength(3);
    expect(SPECTRAL_FORM_LIGHTING.fillWorldDirection).toHaveLength(3);
  });

  it("compresses open-domain highlights before sRGB conversion and premultiplication", () => {
    expect(sampleSpectralHighlightCompression(0.5)).toBe(0.5);
    expect(sampleSpectralHighlightCompression(SPECTRAL_HIGHLIGHT_COMPRESSION.threshold))
      .toBeCloseTo(SPECTRAL_HIGHLIGHT_COMPRESSION.threshold);
    expect(sampleSpectralHighlightCompression(1)).toBeGreaterThan(0.8);
    expect(sampleSpectralHighlightCompression(1)).toBeLessThan(1);
    expect(sampleSpectralHighlightCompression(4))
      .toBeGreaterThan(sampleSpectralHighlightCompression(1));
    expect(sampleSpectralHighlightCompression(4)).toBeLessThan(1);
    expect(SPECTRAL_COLOR_OUTPUT_FRAGMENT).toContain("spectralCompressHighlight");
    expect(SPECTRAL_COLOR_OUTPUT_FRAGMENT).toContain("colorspace_fragment");
    expect(SPECTRAL_COLOR_OUTPUT_FRAGMENT).toContain("premultiplied_alpha_fragment");

    const groups = [
      createSpectralRenderGroup(canonicalGeometry(), "wraith", {
        fantasyEffects: true,
        particleCount: 24,
        groundInteraction: true,
      }),
      createSpectralRenderGroup(canonicalGeometry(), "cyber", {
        cyberEffects: true,
        cyberSignalCount: 24,
        groundInteraction: true,
      }),
    ];
    groups.forEach((group) => group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
      if (!(object.material instanceof THREE.ShaderMaterial) || object.material.colorWrite === false) return;
      expect(object.material.fragmentShader).toContain("spectralWriteDisplayColor");
      expect(object.material.premultipliedAlpha).toBe(true);
    }));
  });

  it("expands every enabled material against the installed Three.js shader registry", () => {
    const groups = [
      createSpectralRenderGroup(canonicalGeometry(), "wraith", {
        fantasyEffects: true,
        particleCount: 24,
        groundInteraction: true,
      }),
      createSpectralRenderGroup(canonicalGeometry(), "phantom", {
        fantasyEffects: true,
        particleCount: 24,
        groundInteraction: true,
      }),
      createSpectralRenderGroup(canonicalGeometry(), "cyber", {
        cyberEffects: true,
        cyberSignalCount: 24,
        groundInteraction: true,
      }),
      createSpectralRenderGroup(canonicalGeometry(), "quantum", {
        cyberEffects: true,
        cyberSignalCount: 24,
        groundInteraction: true,
      }),
      createSpectralRenderGroup(canonicalGeometry(), "wraith", { enableShell: false }),
      createSpectralRenderGroup(canonicalGeometry(), "cyber", { enableShell: false }),
    ];

    let checkedMaterials = 0;
    groups.forEach((group) => group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
      if (!(object.material instanceof THREE.ShaderMaterial)) return;
      const vertexShader = expandThreeShaderChunks(object.material.vertexShader);
      const fragmentShader = expandThreeShaderChunks(object.material.fragmentShader);
      expectStructurallyClosedShader(vertexShader);
      expectStructurallyClosedShader(fragmentShader);
      if (object.material.colorWrite !== false) {
        expect(object.material.fragmentShader).toContain("spectralWriteDisplayColor");
        expect(object.material.fragmentShader.indexOf("colorspace_fragment"))
          .toBeLessThan(object.material.fragmentShader.indexOf("premultiplied_alpha_fragment"));
        expect(object.material.premultipliedAlpha).toBe(true);
      }
      checkedMaterials += 1;
    }));
    expect(checkedMaterials).toBeGreaterThanOrEqual(30);
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
    expect(surfaceMaterial.transparent).toBe(true);
    expect(shellMaterial.side).toBe(THREE.BackSide);
    expect(shellMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(shell.scale.x).toBe(1);
    expect(shell.userData.spectralNormalOffsetMeters).toBe(SPECTRAL_NORMAL_OFFSETS_METERS.sharedShell);
    expect(shellMaterial.uniforms.uNormalOffset.value).toBe(SPECTRAL_NORMAL_OFFSETS_METERS.sharedShell);
    expect(shellMaterial.fragmentShader).toContain("fantasyShellErosion");
    expect(shellMaterial.fragmentShader).toContain("fantasyShellResponse");
    expect(shellMaterial.fragmentShader).toContain("cyberCarrier");
    expect(shellMaterial.fragmentShader).toContain("spectralCyberAntialiasedCrest");
    expect(shellMaterial.fragmentShader).toContain("cyberShellResponse");
    expect(shellMaterial.fragmentShader).toContain("cyberChromaSide");
    expect(surfaceMaterial.uniforms.uCompositeAttenuation.value).toBeCloseTo(0.62);

    const reduced = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      enableShell: false,
      surfaceDetailLevel: 0,
    });
    expect(reduced.children.map((child) => child.renderOrder)).toEqual([0, 1]);
    expect(reduced.getObjectByName("spectral-v3-additive-back-shell")).toBeUndefined();
    expect(((reduced.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .material as THREE.ShaderMaterial).defines).toMatchObject({
      SPECTRAL_FANTASY_BRANCH: 0,
      SPECTRAL_CYBER_BRANCH: 0,
      SPECTRAL_DETAIL_LEVEL: 0,
    });
    expect(reduced.userData.spectralSurfaceDetailLevel).toBe(0);
  });

  it("uses identical canonical displacement and structural clipping chunks", () => {
    const group = createSpectralRenderGroup(canonicalGeometry(), "cyber");
    const [depth, surface, shell] = group.children as THREE.Mesh[];
    const materials = [depth, surface, shell].map((mesh) => mesh.material as THREE.ShaderMaterial);
    materials.forEach((material) => {
      expect(material.vertexShader).toContain(SPECTRAL_VERTEX_COMMON.trim());
      expect(material.fragmentShader).toContain(SPECTRAL_STRUCTURAL_FRAGMENT.trim());
      expect(material.uniforms.uStructuralCut.value).toBe(SPECTRAL_STRUCTURAL_CUT);
      expect(material.vertexShader).toContain("spectralVertexWave(bridgeCanonical");
      expect(material.fragmentShader).not.toContain("Math.random");
    });
    expect(SPECTRAL_VERTEX_COMMON).not.toContain("modelMatrix");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralVertexWave(vec3 canonical");
    expect(SPECTRAL_STRUCTURAL_CUT).toBeLessThan(0);
    expect(SPECTRAL_STRUCTURAL_FRAGMENT).toContain("smoothstep(-0.016, -0.002");
    expect(materials[0].vertexShader).toBe(materials[1].vertexShader);
    expect(materials[0].vertexShader).toBe(materials[2].vertexShader);
  });

  it("adds deterministic V5 fantasy palettes and tiered GPU particles without changing the body passes", () => {
    expect(SPECTRAL_FANTASY_PARTICLE_COUNTS).toEqual([300, 120, 0]);
    expect(SPECTRAL_STYLE_SHELL_TIERS).toEqual([true, true, false]);
    expect(SPECTRAL_AUXILIARY_EFFECT_TIERS).toEqual([true, false, false]);
    const high = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      particleCount: 300,
      groundInteraction: true,
    });
    const medium = createSpectralRenderGroup(canonicalGeometry(), "phantom", {
      fantasyEffects: true,
      particleCount: 120,
      enableShell: true,
      enableAuxiliaryEffects: false,
      groundInteraction: true,
    });
    const low = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      particleCount: 0,
      enableShell: false,
      enableAuxiliaryEffects: false,
    });
    const outlined = createSpectralRenderGroup(canonicalGeometry(), "phantom", {
      fantasyEffects: true,
      particleCount: 0,
      groundInteraction: true,
    });
    expect(high.children).toHaveLength(7);
    expect(medium.children).toHaveLength(5);
    expect(low.children).toHaveLength(2);
    expect(outlined.children).toHaveLength(7);
    const highParticles = high.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points;
    const mediumParticles = medium.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points;
    expect(highParticles).toBeInstanceOf(THREE.Points);
    expect(highParticles.geometry.getAttribute("position").count).toBe(300);
    expect(highParticles.userData.spectralDepthOccluded).toBe(true);
    expect((highParticles.material as THREE.ShaderMaterial).depthTest).toBe(true);
    expect((highParticles.material as THREE.ShaderMaterial).depthFunc).toBe(THREE.LessEqualDepth);
    expect(mediumParticles.geometry.getAttribute("position").count).toBe(120);
    expect(medium.getObjectByName("spectral-v3-additive-back-shell")).toBeInstanceOf(THREE.Mesh);
    expect(medium.getObjectByName("spectral-v5-fantasy-inner-soul-current")).toBeUndefined();
    expect(medium.getObjectByName("spectral-v5-fantasy-aura-shell")).toBeUndefined();
    expect(medium.getObjectByName("spectral-v5-fantasy-contrast-outline")).toBeUndefined();
    expect(medium.userData.spectralAuxiliaryEffects).toBe(false);
    expect(high.userData.spectralFantasyV5).toBe(true);
    expect(high.userData.spectralFantasyVersion).toBe(SPECTRAL_FANTASY_VERSION);
    const aura = high.getObjectByName("spectral-v5-fantasy-aura-shell") as THREE.Mesh;
    expect(aura).toBeInstanceOf(THREE.Mesh);
    expect(aura.scale.x).toBe(1);
    expect(aura.userData.spectralNormalOffsetMeters).toBe(SPECTRAL_NORMAL_OFFSETS_METERS.fantasyAura);
    expect((aura.material as THREE.ShaderMaterial).uniforms.uNormalOffset.value)
      .toBe(SPECTRAL_NORMAL_OFFSETS_METERS.fantasyAura);
    expect((aura.material as THREE.ShaderMaterial).uniforms.uShellOpacity.value).toBeLessThan(0.13);
    expect((aura.material as THREE.ShaderMaterial).vertexShader).toContain("auraLift");
    expect((aura.material as THREE.ShaderMaterial).vertexShader).toContain("vFantasyAuraLick");
    expect((aura.material as THREE.ShaderMaterial).fragmentShader).toContain("auraErosion");
    expect((aura.material as THREE.ShaderMaterial).fragmentShader).toContain("silhouetteGate");
    expect((aura.material as THREE.ShaderMaterial).depthTest).toBe(true);
    const innerCurrent = high.getObjectByName("spectral-v5-fantasy-inner-soul-current") as THREE.Mesh;
    expect(innerCurrent).toBeInstanceOf(THREE.Mesh);
    expect(innerCurrent.scale.x).toBe(1);
    expect(innerCurrent.userData.spectralNormalOffsetMeters).toBe(SPECTRAL_NORMAL_OFFSETS_METERS.fantasyCore);
    expect(innerCurrent.userData.spectralSurfaceAttached).toBe(true);
    expect((innerCurrent.material as THREE.ShaderMaterial).depthTest).toBe(true);
    expect((innerCurrent.material as THREE.ShaderMaterial).fragmentShader).toContain("longitudinalCurrent");
    expect((innerCurrent.material as THREE.ShaderMaterial).fragmentShader).toContain("mistPocket");
    expect((innerCurrent.material as THREE.ShaderMaterial).fragmentShader)
      .not.toContain("vSpectralRegionChain.y");
    const groundMist = high.getObjectByName("spectral-v5-fantasy-ground-mist") as THREE.Mesh;
    expect(groundMist).toBeInstanceOf(THREE.Mesh);
    expect(groundMist.position.y).toBeGreaterThan(-0.9);
    expect(groundMist.userData.spectralGroundAnchorY).toBe(-0.895);
    expect((groundMist.material as THREE.ShaderMaterial).fragmentShader).toContain("angularWisp");
    expect((groundMist.material as THREE.ShaderMaterial).fragmentShader).not.toContain("outerRing");
    const outline = outlined.getObjectByName("spectral-v5-fantasy-contrast-outline") as THREE.Mesh;
    expect(outline).toBeInstanceOf(THREE.Mesh);
    expect((outline.material as THREE.ShaderMaterial).blending).toBe(THREE.NormalBlending);
    expect((outline.material as THREE.ShaderMaterial).fragmentShader)
      .toContain("* uCompositeAttenuation;");
    expect((high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh).material)
      .toHaveProperty("uniforms.uFantasyStrength.value", 1);
    const fantasySurface = (high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    expect(fantasySurface.defines).toMatchObject({
      SPECTRAL_FANTASY_BRANCH: 1,
      SPECTRAL_CYBER_BRANCH: 0,
      SPECTRAL_DETAIL_LEVEL: 2,
    });
    expect(fantasySurface.fragmentShader).toContain("fantasyCavity");
    expect(fantasySurface.fragmentShader).toContain("innerDensity");
    expect(fantasySurface.fragmentShader).toContain("keyWorldDirection");
    expect(fantasySurface.fragmentShader).toContain("smokeVeil");
    expect(fantasySurface.fragmentShader).toContain("fantasySurfaceExtinction");
    expect(fantasySurface.fragmentShader).toContain("soulVein");
    expect(fantasySurface.fragmentShader).toContain("fantasyPorosity");
    expect(fantasySurface.fragmentShader).toContain("fantasyOpticalAbsorption");
    expect(fantasySurface.fragmentShader).toContain("fantasyFringeErosion");
    expect(fantasySurface.fragmentShader).toContain("soulSurface");
    expect(fantasySurface.fragmentShader).toContain("soulVolumeLight");
    expect(fantasySurface.fragmentShader).toContain("fantasyMaterialLight");
    expect(fantasySurface.fragmentShader).toContain("soulScattering");
    expect(fantasySurface.fragmentShader).toContain("soulScatteringColor");
    expect(fantasySurface.fragmentShader).toContain("soulPatina");
    expect(fantasySurface.fragmentShader).toContain("surfaceRipple");
    expect(fantasySurface.fragmentShader).toContain("fantasyVoid");
    expect(fantasySurface.fragmentShader).toContain("fantasyCurrent");
    expect(fantasySurface.fragmentShader).toContain("fantasyAsh");
    expect(fantasySurface.fragmentShader).toContain("fantasyRelief");
    expect(fantasySurface.fragmentShader).toContain("fantasyMicro");
    expect(fantasySurface.fragmentShader).toContain("fantasySurfaceHeight");
    expect(fantasySurface.fragmentShader).toContain("#if SPECTRAL_DETAIL_LEVEL >= 1");
    expect(fantasySurface.fragmentShader).toContain("#if SPECTRAL_DETAIL_LEVEL >= 2");
    expect(fantasySurface.fragmentShader).not.toContain("vec3 reliefVector");
    expect(fantasySurface.fragmentShader).toContain("soulFlame");
    expect(fantasySurface.fragmentShader).toContain("reliefStrength");
    expect(fantasySurface.fragmentShader).toContain("shadedWorldNormal");
    expect(fantasySurface.fragmentShader).toContain("ashCrust");
    expect(fantasySurface.fragmentShader).toContain("capturedRelief");
    expect(fantasySurface.fragmentShader).toContain("capturedFold");
    expect(fantasySurface.fragmentShader).toContain("spectralPerturbNormalFromHeight");
    expect(fantasySurface.fragmentShader).toContain("capturedHeight");
    expect(fantasySurface.fragmentShader).toContain("geometricFacing");
    expect(fantasySurface.fragmentShader).toContain("fantasySurfaceOcclusion");
    expect(fantasySurface.fragmentShader).not.toContain("shoulderEnergy");
    expect(fantasySurface.fragmentShader).not.toContain("abs(vSpectralCanonical.y - 0.70)");
    expect(high.getObjectByName("spectral-v3-main-surface")).toBeDefined();
    expect((fantasySurface as THREE.ShaderMaterial).vertexShader).toContain("bridgeAppearance");
    expect((fantasySurface as THREE.ShaderMaterial).vertexShader)
      .toContain("bridgeAppearanceRelief");
    expect((high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .geometry.getAttribute("bridgeAppearanceRelief").getX(0)).toBe(0.5);
    expect(SPECTRAL_FANTASY_PRESETS.wraith.opacity).toBeGreaterThanOrEqual(0.75);
    expect(SPECTRAL_FANTASY_PRESETS.phantom.shellOpacity).toBeLessThan(0.23);
    expect(SPECTRAL_FANTASY_PRESETS.phantom.baseColor).toBeLessThan(0xeeeeee);
    expect(SPECTRAL_FANTASY_PRESETS.phantom.rimStrength).toBeLessThan(1);
    expect(SPECTRAL_FANTASY_CONTRAST_RESPONSE.maximumShadowMix).toBeGreaterThanOrEqual(0.3);
    expect(fantasySurface.fragmentShader).toContain("fantasyContrastStructure");
    expect(fantasySurface.fragmentShader).toContain("opaqueSurfaceFloor");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("vParticleSeed");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("surfaceUp");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("surfaceSide");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("surfaceRise");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("normalDrift");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("vParticlePixelSize");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("particlePixelSize");
    expect((highParticles.material as THREE.ShaderMaterial).fragmentShader).toContain("tail");
    expect((highParticles.material as THREE.ShaderMaterial).fragmentShader).toContain("6.2");
    expect((highParticles.material as THREE.ShaderMaterial).fragmentShader).toContain("resolvedParticle");
    expect(SPECTRAL_FANTASY_PARTICLE_RESOLUTION.fadeStartPixels).toBeGreaterThan(1);
    expect(SPECTRAL_FANTASY_PARTICLE_RESOLUTION.fullyResolvedPixels)
      .toBeGreaterThan(SPECTRAL_FANTASY_PARTICLE_RESOLUTION.fadeStartPixels);
    expect((medium.getObjectByName("spectral-v3-main-surface") as THREE.Mesh).material)
      .toHaveProperty("uniforms.uContrastOutline.value", 0.90);
    expect(outline.scale.x).toBe(1);
    expect(outline.userData.spectralNormalOffsetMeters)
      .toBe(SPECTRAL_NORMAL_OFFSETS_METERS.fantasyContrastOutline);
  });

  it("samples surface effects deterministically by triangle area with normalized four-bone weights", () => {
    const source = unevenAreaGeometry();
    const first = createSpectralRenderGroup(source, "wraith", {
      fantasyEffects: true,
      particleCount: 100,
      enableShell: false,
    });
    const second = createSpectralRenderGroup(source.clone(), "wraith", {
      fantasyEffects: true,
      particleCount: 100,
      enableShell: false,
    });
    const firstGeometry = (first.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points).geometry;
    const secondGeometry = (second.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points).geometry;
    const sampledPositions = firstGeometry.getAttribute("position");
    const sampledWeights = firstGeometry.getAttribute("skinWeight");
    expect(firstGeometry.userData.spectralSurfaceSamplingVersion)
      .toBe(SPECTRAL_SURFACE_SAMPLING_VERSION);
    expect(firstGeometry.userData.spectralSampledArea).toBeCloseTo(50.5);
    expect(Array.from(sampledPositions.array))
      .toEqual(Array.from(secondGeometry.getAttribute("position").array));
    let largeTriangleSamples = 0;
    let interiorSamples = 0;
    for (let sample = 0; sample < sampledPositions.count; sample += 1) {
      const x = sampledPositions.getX(sample);
      const y = sampledPositions.getY(sample);
      if (x > 5) largeTriangleSamples += 1;
      const isSourceVertex = (x === 0 && y === 0)
        || (x === 1 && y === 0)
        || (x === 0 && y === 1)
        || (x === 10 && y === 0)
        || (x === 20 && y === 0)
        || (x === 10 && y === 10);
      if (!isSourceVertex) interiorSamples += 1;
      const weightTotal = sampledWeights.getX(sample)
        + sampledWeights.getY(sample)
        + sampledWeights.getZ(sample)
        + sampledWeights.getW(sample);
      expect(weightTotal).toBeCloseTo(1, 5);
    }
    expect(largeTriangleSamples).toBeGreaterThanOrEqual(98);
    expect(interiorSamples).toBe(100);
  });

  it("redistributes fantasy particles and cyber signals away from the distal hand", () => {
    const source = bodyAndDistalHandGeometry();
    const fantasy = createSpectralRenderGroup(source, "wraith", {
      fantasyEffects: true,
      particleCount: 64,
      enableShell: false,
    });
    const cyber = createSpectralRenderGroup(source.clone(), "cyber", {
      cyberEffects: true,
      cyberSignalCount: 64,
      enableShell: false,
    });
    const effectGeometries = [
      (fantasy.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points).geometry,
      (cyber.getObjectByName("spectral-v6-cyber-signal-glyphs") as THREE.Points).geometry,
    ];
    for (const geometry of effectGeometries) {
      const sampledRegions = geometry.getAttribute("bridgeRegionChain");
      expect(sampledRegions.count).toBe(64);
      expect(geometry.userData.spectralDistalHandExclusionChain)
        .toBe(SPECTRAL_EFFECT_HAND_EXCLUSION_CHAIN);
      expect(geometry.userData.spectralExcludedDistalHandTriangleCount).toBe(1);
      expect(geometry.userData.spectralSampledArea).toBeCloseTo(0.5);
      for (let sample = 0; sample < sampledRegions.count; sample += 1) {
        const region = Math.round(sampledRegions.getX(sample));
        const chain = sampledRegions.getY(sample);
        const distalArm = (region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm)
          && chain >= SPECTRAL_EFFECT_HAND_EXCLUSION_CHAIN;
        expect(distalArm).toBe(false);
      }
    }
  });

  it("converges all displaced style layers back onto the distal hand silhouette", () => {
    expect(SPECTRAL_HAND_SILHOUETTE_STABILITY.fadeStartChain)
      .toBeLessThan(SPECTRAL_EFFECT_HAND_EXCLUSION_CHAIN);
    expect(SPECTRAL_HAND_SILHOUETTE_STABILITY.fadeEndChain).toBeLessThan(1);
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralHandSilhouetteStability");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralProjectedArmChain");
    expect(SPECTRAL_VERTEX_COMMON).toContain("regionChain.x * 255.0");
    expect(SPECTRAL_VERTEX_COMMON).toContain(
      SPECTRAL_HAND_SILHOUETTE_STABILITY.fadeStartChain.toFixed(2),
    );
    expect(SPECTRAL_VERTEX_COMMON).toContain(
      SPECTRAL_HAND_SILHOUETTE_STABILITY.fadeEndChain.toFixed(2),
    );
  });

  it("keeps fantasy particles in a rising surface flow and cyber glyphs locked to the projection", () => {
    const fantasySamples = Array.from({ length: 2_001 }, (_, index) => (
      sampleSpectralFantasyParticleMotion(index / 100, 0.73)
    ));
    const cyberSamples = Array.from({ length: 2_001 }, (_, index) => (
      sampleSpectralCyberSignalMotion(index / 100, 0.73)
    ));
    expect(Math.max(...fantasySamples.map((sample) => sample.tangentOffsetMeters)))
      .toBeLessThanOrEqual(SPECTRAL_EFFECT_MOTION_LIMITS.fantasy.tangentRiseMeters);
    expect(Math.max(...fantasySamples.map((sample) => sample.normalOffsetMeters)))
      .toBeLessThanOrEqual(SPECTRAL_EFFECT_MOTION_LIMITS.fantasy.normalOffsetMeters);
    expect(Math.max(...fantasySamples.map((sample) => Math.abs(sample.lateralOffsetMeters))))
      .toBeLessThanOrEqual(SPECTRAL_EFFECT_MOTION_LIMITS.fantasy.lateralOffsetMeters);
    expect(Math.max(...fantasySamples.map((sample) => sample.tangentOffsetMeters))).toBeGreaterThan(0.08);
    expect(cyberSamples.every((sample) => sample.tangentOffsetMeters === 0)).toBe(true);
    expect(Math.max(...cyberSamples.map((sample) => sample.normalOffsetMeters)))
      .toBeLessThanOrEqual(SPECTRAL_EFFECT_MOTION_LIMITS.cyber.normalOffsetMeters);
    expect(Math.max(...cyberSamples.map((sample) => Math.abs(sample.lateralOffsetMeters))))
      .toBeLessThanOrEqual(SPECTRAL_EFFECT_MOTION_LIMITS.cyber.lateralEventMeters);
    expect(Math.min(...cyberSamples.map((sample) => sample.visibility))).toBeGreaterThanOrEqual(0.20);
    expect(Math.max(...cyberSamples.map((sample) => sample.visibility))).toBeGreaterThan(0.95);
  });

  it("adds deterministic V6 projection styling within the tiered draw budget", () => {
    const high = createSpectralRenderGroup(canonicalGeometry(), "cyber", {
      cyberEffects: true,
      groundInteraction: true,
      cyberSignalCount: 96,
    });
    const medium = createSpectralRenderGroup(canonicalGeometry(), "quantum", {
      cyberEffects: true,
      groundInteraction: true,
      enableShell: true,
      enableAuxiliaryEffects: false,
      cyberSignalCount: 40,
    });
    const low = createSpectralRenderGroup(canonicalGeometry(), "cyber", {
      cyberEffects: true,
      groundInteraction: false,
      enableShell: false,
      enableAuxiliaryEffects: false,
    });
    expect([high.children.length, medium.children.length, low.children.length]).toEqual([6, 5, 2]);
    expect(high.userData.spectralCyberV6).toBe(true);
    expect(high.userData.spectralCyberVersion).toBe(SPECTRAL_CYBER_VERSION);
    const disc = high.getObjectByName("spectral-v6-cyber-ground-disc") as THREE.Mesh;
    expect(disc).toBeInstanceOf(THREE.Mesh);
    expect(disc.material).toHaveProperty("blending", THREE.AdditiveBlending);
    expect(disc.position.y).toBeGreaterThan(-0.9);
    expect(disc.userData.spectralGroundAnchorY).toBe(-0.895);
    expect(disc.material).toHaveProperty("polygonOffset", true);
    expect(disc.material).toHaveProperty("depthTest", false);
    expect(disc.renderOrder).toBe(0.5);
    const echo = high.getObjectByName("spectral-v6-cyber-phase-echo") as THREE.Mesh;
    expect(echo).toBeInstanceOf(THREE.Mesh);
    expect(echo.scale.x).toBe(1);
    expect(echo.userData.spectralNormalOffsetMeters).toBe(SPECTRAL_NORMAL_OFFSETS_METERS.cyberPhaseEcho);
    expect((echo.material as THREE.ShaderMaterial).uniforms.uNormalOffset.value)
      .toBe(SPECTRAL_NORMAL_OFFSETS_METERS.cyberPhaseEcho);
    expect(SPECTRAL_NORMAL_OFFSETS_METERS.cyberPhaseEcho).toBeLessThan(0);
    expect(echo.userData.spectralDepthOccluded).toBe(true);
    expect((echo.material as THREE.ShaderMaterial).depthTest).toBe(true);
    expect((echo.material as THREE.ShaderMaterial).depthFunc).toBe(THREE.LessDepth);
    expect((echo.material as THREE.ShaderMaterial).vertexShader).toContain("echoOffset");
    expect((echo.material as THREE.ShaderMaterial).fragmentShader).toContain("vPhaseEcho");
    expect((echo.material as THREE.ShaderMaterial).fragmentShader.match(/uniform float uCyberStrength;/g))
      .toHaveLength(1);
    expect(medium.getObjectByName("spectral-v3-additive-back-shell")).toBeInstanceOf(THREE.Mesh);
    expect(medium.getObjectByName("spectral-v6-cyber-phase-echo")).toBeUndefined();
    expect(medium.userData.spectralAuxiliaryEffects).toBe(false);
    const signals = high.getObjectByName("spectral-v6-cyber-signal-glyphs") as THREE.Points;
    expect(signals).toBeInstanceOf(THREE.Points);
    expect(signals.geometry.getAttribute("position").count).toBe(96);
    expect(signals.userData.signalCount).toBe(96);
    expect(signals.userData.spectralDepthOccluded).toBe(true);
    expect((signals.material as THREE.ShaderMaterial).depthTest).toBe(true);
    expect((signals.material as THREE.ShaderMaterial).depthFunc).toBe(THREE.LessEqualDepth);
    expect(signals.geometry.userData.spectralSurfaceSamplingVersion)
      .toBe(SPECTRAL_SURFACE_SAMPLING_VERSION);
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("packet");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("eventEnvelope");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("signalTimeline");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("eventIndex");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("surfaceOffset");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("stableCarrier");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("vSignalPixelSize");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("signalPixelSize");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).not.toContain("float rise");
    expect((signals.material as THREE.ShaderMaterial).vertexShader).not.toContain("floor(uTime * 0.82");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("verticalPacket");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("horizontalPacket");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("pointPacket");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("packetGlyph");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("resolvedGlyph");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).not.toContain("crossGlyph");
    expect(SPECTRAL_CYBER_GLYPH_RESOLUTION.fadeStartPixels)
      .toBeLessThan(SPECTRAL_CYBER_GLYPH_RESOLUTION.fullyResolvedPixels);
    expect(high.getObjectByName("spectral-v5-fantasy-particles")).toBeUndefined();
    const surface = high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh;
    const material = surface.material as THREE.ShaderMaterial;
    expect(material.defines).toMatchObject({
      SPECTRAL_FANTASY_BRANCH: 0,
      SPECTRAL_CYBER_BRANCH: 1,
      SPECTRAL_DETAIL_LEVEL: 2,
    });
    expect(material.uniforms.uCyberStrength.value).toBe(1);
    expect(material.uniforms.uCyberSeed.value).toBeCloseTo(0.173);
    expect(material.fragmentShader).toContain("fineBand");
    expect(material.fragmentShader).toContain("fineBandPhase");
    expect(material.fragmentShader).toContain("mainBand");
    expect(material.fragmentShader).toContain("scanLocality");
    expect(material.fragmentShader).toContain("fineBand *= cyberScanStrength");
    expect(material.fragmentShader).not.toContain("band * uBandStrength");
    expect(material.fragmentShader).toContain("dataStreak");
    expect(material.fragmentShader).toContain("carrierLine");
    expect(material.fragmentShader).toContain("carrierLinePhase");
    expect(material.fragmentShader).toContain("signalNoise");
    expect(material.fragmentShader).toContain("packetSpark");
    expect(material.fragmentShader).toContain("microCarrier");
    expect(material.fragmentShader).toContain("columnCarrier");
    expect(material.fragmentShader).toContain("microCarrierPhase");
    expect(material.fragmentShader).toContain("columnCarrierPhase");
    expect(material.fragmentShader).toContain("spectralCyberAntialiasedCrest");
    expect(material.fragmentShader).not.toContain("fineBand = smoothstep(0.90");
    expect(material.fragmentShader).toContain("signalIntegrity");
    expect(material.fragmentShader).toContain("cyberSignalExtinction");
    expect(material.fragmentShader).toContain("projectionVeil");
    expect(material.fragmentShader).toContain("scanWarp");
    expect(material.fragmentShader).toContain("projectorRise");
    expect(material.fragmentShader).toContain("sourceLock");
    expect(material.fragmentShader).toContain("projectionColumn");
    expect(material.fragmentShader).toContain("cyberEmissionField");
    expect(material.fragmentShader).toContain("broadSignal");
    expect(material.fragmentShader).toContain("fineSignal");
    expect(material.fragmentShader).toContain("spectralPerturbNormalFromHeight");
    expect(material.fragmentShader).not.toContain(
      "floor(vSpectralCanonical * vec3(10.0, 18.0, 10.0))",
    );
    expect(material.fragmentShader).toContain("chromaFringe");
    expect(material.fragmentShader).toContain("spectralTemporalHash");
    expect(material.fragmentShader).toContain("surfaceGrain = spectralValueNoise");
    expect(material.fragmentShader).not.toContain("surfaceGrain = spectralHash13(floor");
    expect(material.fragmentShader).not.toContain("floor(uTime * 8.0");
    expect(material.vertexShader).toContain("vec3 cyberOffset = vec3(0.0)");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("ringSegments");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("ringPhase");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).not.toContain("floor(uTime * 0.5)");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("sourceCore");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("uplinkCells");
    expect(SPECTRAL_CYBER_CARRIER_AA.fadeStartRadiansPerPixel)
      .toBeLessThan(SPECTRAL_CYBER_CARRIER_AA.fadeEndRadiansPerPixel);
    expect(SPECTRAL_CYBER_CARRIER_AA_FRAGMENT).toContain("fwidth(phase)");
    expect(SPECTRAL_CYBER_CARRIER_AA_FRAGMENT).toContain("unresolvedEnergy");
  });

  it("keeps the short cyber phase event bounded and fully recoverable", () => {
    expect(SPECTRAL_CYBER_PHASE_PERIOD_SECONDS).toBe(3.2);
    expect(SPECTRAL_CYBER_PHASE_DURATION_SECONDS).toBe(0.12);
    expect(SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS).toBe(0.02);
    expect(SPECTRAL_CYBER_PHASE_MAX_OFFSET_METERS).toBe(0.05);
    const eventStart = SPECTRAL_CYBER_PHASE_PERIOD_SECONDS - 0.173 * 2.31;
    expect(sampleSpectralCyberPhasePulse(eventStart + 0.05, 0.173)).toBeGreaterThan(0.99);
    expect(sampleSpectralCyberPhasePulse(eventStart + 0.15, 0.173)).toBe(0);
    expect(sampleSpectralCyberPhasePulse(eventStart + 0.2, 0.173)).toBe(0);
    expect(SPECTRAL_VERTEX_COMMON).not.toContain("spectralCyberPhaseOffset");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralShoulderVolume");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralArmJointVolumes");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralAxisVolume");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uRestJoints[17]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uTargetJoints[17]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uRestHandEnds[2]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uTargetHandEnds[2]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uRestHandLaterals[2]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform vec3 uTargetHandLaterals[2]");
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform mat4 uPoseMatrices[17]");
    expect(SPECTRAL_VERTEX_COMMON.match(/uPoseMatrices\[int\(skinIndex\./g)).toHaveLength(4);
    for (const value of Object.values(SPECTRAL_ARM_JOINT_VOLUME_RESPONSE)) {
      expect(SPECTRAL_VERTEX_COMMON).toContain(value.toFixed(2));
    }
    for (const value of Object.values(SPECTRAL_ARM_SWEEP_RESPONSE)) {
      expect(SPECTRAL_VERTEX_COMMON).toContain(value.toFixed(2));
    }
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralArmCurve");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralArmFrameNormal");
    expect(SPECTRAL_VERTEX_COMMON).toContain("spectralArmChainSweep");
    expect(SPECTRAL_VERTEX_COMMON).not.toContain("spectralShoulderProximity");
    expect(SPECTRAL_STRUCTURAL_FRAGMENT).not.toContain("cyberMissing");
  });

  it("rejects legacy geometry without stable body-space attributes", () => {
    const geometry = new THREE.BufferGeometry();
    expect(() => createSpectralRenderGroup(geometry, "wraith")).toThrow(/canonical/i);
  });
});
