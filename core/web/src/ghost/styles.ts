import type { GhostStyle, GhostStyleId } from "../models/types";

export const GHOST_STYLES: Record<GhostStyleId, GhostStyle> = {
  wraith: {
    id: "wraith",
    name: "奇幻灵体",
    color: 0xaecbeb,
    opacity: 0.55,
    emissive: 0.35,
    metalness: 0.05,
    roughness: 0.4,
    rimGlow: 0.55,
    holographic: true,
  },
  phantom: {
    id: "phantom",
    name: "幽灵",
    color: 0xd8deef,
    opacity: 0.22,
    emissive: 0.4,
    metalness: 0.02,
    roughness: 0.95,
    rimGlow: 0.35,
    holographic: true,
  },
  cyber: {
    id: "cyber",
    name: "赛博投影",
    color: 0x33f2d0,
    opacity: 0.5,
    emissive: 0.85,
    metalness: 0.85,
    roughness: 0.2,
    rimGlow: 0.7,
    holographic: true,
  },
  quantum: {
    id: "quantum",
    name: "量子",
    color: 0x9b6dff,
    opacity: 0.42,
    emissive: 0.95,
    metalness: 0.55,
    roughness: 0.12,
    rimGlow: 0.85,
    holographic: true,
  },
};

export const GHOST_STYLE_LIST = Object.values(GHOST_STYLES);
