import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applySpectralTint,
  createSpectralRenderGroup,
  sampleSpectralCyberPhasePulse,
  SPECTRAL_CYBER_PHASE_DURATION_SECONDS,
  SPECTRAL_CYBER_PHASE_MAX_OFFSET_METERS,
  SPECTRAL_CYBER_PHASE_MIN_OFFSET_METERS,
  SPECTRAL_CYBER_PHASE_PERIOD_SECONDS,
  SPECTRAL_CYBER_VERSION,
  SPECTRAL_FANTASY_PRESETS,
  SPECTRAL_FANTASY_VERSION,
  SPECTRAL_NORMAL_OFFSETS_METERS,
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
    expect(applySpectralTint(SPECTRAL_FANTASY_PRESETS.wraith, "invalid"))
      .toBe(SPECTRAL_FANTASY_PRESETS.wraith);
    const group = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      tintHex: "#35d07f",
    });
    const surface = group.getObjectByName("spectral-v3-main-surface") as THREE.Mesh;
    expect((surface.material as THREE.ShaderMaterial).uniforms.uBaseColor.value.getHex()).toBe(0x35d07f);
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
    expect(surfaceMaterial.uniforms.uCompositeAttenuation.value).toBeCloseTo(0.62);

    const reduced = createSpectralRenderGroup(canonicalGeometry(), "wraith", { enableShell: false });
    expect(reduced.children.map((child) => child.renderOrder)).toEqual([0, 1]);
    expect(reduced.getObjectByName("spectral-v3-additive-back-shell")).toBeUndefined();
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

  it("adds deterministic V5 fantasy palettes and tiered GPU particles without changing the body passes", () => {
    const high = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      particleCount: 300,
      groundInteraction: true,
    });
    const medium = createSpectralRenderGroup(canonicalGeometry(), "phantom", {
      fantasyEffects: true,
      particleCount: 120,
      enableShell: false,
      groundInteraction: true,
    });
    const low = createSpectralRenderGroup(canonicalGeometry(), "wraith", {
      fantasyEffects: true,
      particleCount: 0,
      enableShell: false,
    });
    const outlined = createSpectralRenderGroup(canonicalGeometry(), "phantom", {
      fantasyEffects: true,
      particleCount: 0,
      groundInteraction: true,
    });
    expect(high.children).toHaveLength(7);
    expect(medium.children).toHaveLength(4);
    expect(low.children).toHaveLength(2);
    expect(outlined.children).toHaveLength(7);
    const highParticles = high.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points;
    const mediumParticles = medium.getObjectByName("spectral-v5-fantasy-particles") as THREE.Points;
    expect(highParticles).toBeInstanceOf(THREE.Points);
    expect(highParticles.geometry.getAttribute("position").count).toBe(300);
    expect(mediumParticles.geometry.getAttribute("position").count).toBe(120);
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
    expect((high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh).material)
      .toHaveProperty("uniforms.uFantasyStrength.value", 1);
    const fantasySurface = (high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    expect(fantasySurface.fragmentShader).toContain("fantasyCavity");
    expect(fantasySurface.fragmentShader).toContain("innerDensity");
    expect(fantasySurface.fragmentShader).toContain("keyDirection");
    expect(fantasySurface.fragmentShader).toContain("smokeVeil");
    expect(fantasySurface.fragmentShader).toContain("soulVein");
    expect(fantasySurface.fragmentShader).toContain("fantasyPorosity");
    expect(fantasySurface.fragmentShader).toContain("fantasyOpticalAbsorption");
    expect(fantasySurface.fragmentShader).toContain("fantasyFringeErosion");
    expect(fantasySurface.fragmentShader).toContain("soulSurface");
    expect(fantasySurface.fragmentShader).toContain("soulPatina");
    expect(fantasySurface.fragmentShader).toContain("surfaceRipple");
    expect(fantasySurface.fragmentShader).toContain("fantasyVoid");
    expect(fantasySurface.fragmentShader).toContain("fantasyCurrent");
    expect(fantasySurface.fragmentShader).toContain("fantasyAsh");
    expect(fantasySurface.fragmentShader).toContain("fantasyRelief");
    expect(fantasySurface.fragmentShader).toContain("fantasyMicro");
    expect(fantasySurface.fragmentShader).toContain("soulFlame");
    expect(fantasySurface.fragmentShader).toContain("reliefStrength");
    expect(fantasySurface.fragmentShader).toContain("shadedNormal");
    expect(fantasySurface.fragmentShader).toContain("ashCrust");
    expect(fantasySurface.fragmentShader).toContain("capturedRelief");
    expect(fantasySurface.fragmentShader).toContain("capturedFold");
    expect(fantasySurface.fragmentShader).toContain("spectralPerturbNormalFromHeight");
    expect(fantasySurface.fragmentShader).toContain("capturedHeight");
    expect(fantasySurface.fragmentShader).toContain("geometricFacing");
    expect(fantasySurface.fragmentShader).toContain("fantasySurfaceOcclusion");
    expect(high.getObjectByName("spectral-v3-main-surface")).toBeDefined();
    expect((fantasySurface as THREE.ShaderMaterial).vertexShader).toContain("bridgeAppearance");
    expect((fantasySurface as THREE.ShaderMaterial).vertexShader)
      .toContain("bridgeAppearanceRelief");
    expect((high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh)
      .geometry.getAttribute("bridgeAppearanceRelief").getX(0)).toBe(0.5);
    expect(SPECTRAL_FANTASY_PRESETS.wraith.opacity).toBeGreaterThanOrEqual(0.75);
    expect(SPECTRAL_FANTASY_PRESETS.phantom.shellOpacity).toBeLessThan(0.23);
    expect(fantasySurface.fragmentShader).toContain("opaqueSurfaceFloor");
    expect((highParticles.material as THREE.ShaderMaterial).vertexShader).toContain("vParticleSeed");
    expect((highParticles.material as THREE.ShaderMaterial).fragmentShader).toContain("tail");
    expect((highParticles.material as THREE.ShaderMaterial).fragmentShader).toContain("6.2");
    expect((medium.getObjectByName("spectral-v3-main-surface") as THREE.Mesh).material)
      .toHaveProperty("uniforms.uContrastOutline.value", 0.78);
    expect(outline.scale.x).toBe(1);
    expect(outline.userData.spectralNormalOffsetMeters)
      .toBe(SPECTRAL_NORMAL_OFFSETS_METERS.fantasyContrastOutline);
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
      enableShell: false,
      cyberSignalCount: 40,
    });
    const low = createSpectralRenderGroup(canonicalGeometry(), "cyber", {
      cyberEffects: true,
      groundInteraction: false,
      enableShell: false,
    });
    expect([high.children.length, medium.children.length, low.children.length]).toEqual([6, 4, 2]);
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
    expect((echo.material as THREE.ShaderMaterial).vertexShader).toContain("echoOffset");
    expect((echo.material as THREE.ShaderMaterial).fragmentShader).toContain("vPhaseEcho");
    expect((echo.material as THREE.ShaderMaterial).fragmentShader.match(/uniform float uCyberStrength;/g))
      .toHaveLength(1);
    const signals = high.getObjectByName("spectral-v6-cyber-signal-glyphs") as THREE.Points;
    expect(signals).toBeInstanceOf(THREE.Points);
    expect(signals.geometry.getAttribute("position").count).toBe(96);
    expect(signals.userData.signalCount).toBe(96);
    expect((signals.material as THREE.ShaderMaterial).vertexShader).toContain("packet");
    expect((signals.material as THREE.ShaderMaterial).fragmentShader).toContain("crossGlyph");
    expect(high.getObjectByName("spectral-v5-fantasy-particles")).toBeUndefined();
    const surface = high.getObjectByName("spectral-v3-main-surface") as THREE.Mesh;
    const material = surface.material as THREE.ShaderMaterial;
    expect(material.uniforms.uCyberStrength.value).toBe(1);
    expect(material.uniforms.uCyberSeed.value).toBeCloseTo(0.173);
    expect(material.fragmentShader).toContain("fineBand");
    expect(material.fragmentShader).toContain("mainBand");
    expect(material.fragmentShader).toContain("dataStreak");
    expect(material.fragmentShader).toContain("carrierLine");
    expect(material.fragmentShader).toContain("signalNoise");
    expect(material.fragmentShader).toContain("packetSpark");
    expect(material.fragmentShader).toContain("microCarrier");
    expect(material.fragmentShader).toContain("columnCarrier");
    expect(material.fragmentShader).toContain("signalIntegrity");
    expect(material.fragmentShader).toContain("projectionVeil");
    expect(material.fragmentShader).toContain("scanWarp");
    expect(material.fragmentShader).toContain("projectorRise");
    expect(material.fragmentShader).toContain("sourceLock");
    expect(material.fragmentShader).toContain("projectionColumn");
    expect(material.fragmentShader).toContain("broadSignal");
    expect(material.fragmentShader).toContain("fineSignal");
    expect(material.fragmentShader).toContain("spectralPerturbNormalFromHeight");
    expect(material.fragmentShader).not.toContain(
      "floor(vSpectralCanonical * vec3(10.0, 18.0, 10.0))",
    );
    expect(material.fragmentShader).toContain("chromaFringe");
    expect(material.fragmentShader).toContain("spectralTemporalHash");
    expect(material.fragmentShader).not.toContain("floor(uTime * 8.0");
    expect(material.vertexShader).toContain("vec3 cyberOffset = vec3(0.0)");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("ringSegments");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("sourceCore");
    expect((disc.material as THREE.ShaderMaterial).fragmentShader).toContain("uplinkCells");
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
    expect(SPECTRAL_VERTEX_COMMON).toContain("uniform mat4 uPoseMatrices[17]");
    expect(SPECTRAL_VERTEX_COMMON.match(/uPoseMatrices\[int\(skinIndex\./g)).toHaveLength(4);
    expect(SPECTRAL_VERTEX_COMMON).not.toContain("spectralShoulderProximity");
    expect(SPECTRAL_STRUCTURAL_FRAGMENT).not.toContain("cyberMissing");
  });

  it("rejects legacy geometry without stable body-space attributes", () => {
    const geometry = new THREE.BufferGeometry();
    expect(() => createSpectralRenderGroup(geometry, "wraith")).toThrow(/canonical/i);
  });
});
