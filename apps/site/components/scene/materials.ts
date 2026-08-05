import { shaderMaterial } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import * as THREE from "three";
import { SIMPLEX_NOISE_3D } from "./noiseGlsl";

/**
 * NodeGlowMaterial — fresnel rim-lit glow for constellation nodes.
 *
 * Rather than a flat emissive sphere, the rim brightens with view-angle
 * (classic fresnel term) and the whole surface shimmers with a low-amplitude
 * 3D simplex noise sampled in world space, so even an "idle" (unclaimed)
 * node reads as alive rather than a static lit ball. `uActive` sweeps the
 * material from its resting teal glow to a hot, near-white-gold core when a
 * node wins a claim.
 */
export const NodeGlowMaterial = shaderMaterial(
  {
    uTime: 0,
    uActive: 0,
    uBaseColor: new THREE.Color("#4fd1c5"),
    uActiveColor: new THREE.Color("#f5b942"),
  },
  /* vertex */ `
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying vec3 vWorldPos;

    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      vNormal = normalize(normalMatrix * normal);
      vViewDir = normalize(cameraPosition - worldPos.xyz);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  /* fragment */ `
    ${SIMPLEX_NOISE_3D}

    uniform float uTime;
    uniform float uActive;
    uniform vec3 uBaseColor;
    uniform vec3 uActiveColor;

    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying vec3 vWorldPos;

    void main() {
      float fresnel = pow(1.0 - clamp(dot(vNormal, vViewDir), 0.0, 1.0), 2.4);
      float shimmer = 0.5 + 0.5 * snoise(vWorldPos * 2.2 + uTime * 0.25);

      vec3 color = mix(uBaseColor, uActiveColor, uActive);
      float core = mix(0.35, 1.6, uActive) + shimmer * mix(0.08, 0.25, uActive);
      float rim = fresnel * mix(0.9, 2.6, uActive);

      vec3 outColor = color * (core + rim);
      gl_FragColor = vec4(outColor, 1.0);
    }
  `
);

/**
 * EdgeGlowMaterial — the coordination graph's connective tissue.
 *
 * Each edge line carries a per-vertex `aProgress` attribute (0 at its start
 * node, 1 at its end node). When a node wins a claim, the edges touching it
 * fire a travelling energy pulse — a bright band that visibly moves from the
 * claimed node outward along the wire, rather than the whole edge just
 * flipping color. `uDir` lets the pulse travel start->end or end->start
 * depending on which endpoint just claimed.
 */
export const EdgeGlowMaterial = shaderMaterial(
  {
    uTime: 0,
    uActive: 0,
    uPulseStart: -10,
    uPulseDuration: 0.9,
    uDir: 1,
    uBaseColor: new THREE.Color("#2c5a56"),
    uActiveColor: new THREE.Color("#f5b942"),
  },
  /* vertex */ `
    attribute float aProgress;
    varying float vProgress;
    void main() {
      vProgress = aProgress;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  /* fragment */ `
    uniform float uTime;
    uniform float uActive;
    uniform float uPulseStart;
    uniform float uPulseDuration;
    uniform float uDir;
    uniform vec3 uBaseColor;
    uniform vec3 uActiveColor;
    varying float vProgress;

    void main() {
      float baseOpacity = mix(0.32, 0.85, uActive);
      vec3 color = mix(uBaseColor, uActiveColor, uActive * 0.6);

      float t = (uTime - uPulseStart) / uPulseDuration;
      float pulseGlow = 0.0;
      if (t >= 0.0 && t <= 1.0) {
        float pulsePos = uDir > 0.0 ? t : 1.0 - t;
        float dist = abs(vProgress - pulsePos);
        float band = smoothstep(0.16, 0.0, dist);
        float fade = 1.0 - smoothstep(0.7, 1.0, t);
        pulseGlow = band * fade;
      }

      vec3 outColor = color + uActiveColor * pulseGlow * 2.2;
      float opacity = clamp(baseOpacity + pulseGlow * 0.9, 0.0, 1.0);
      gl_FragColor = vec4(outColor, opacity);
    }
  `
);

/**
 * AmbientFieldMaterial — a deep background particle field.
 *
 * Drives per-vertex position drift with 3D simplex noise entirely on the
 * GPU (no per-frame CPU position writes), and renders each point as a soft,
 * additive-blended dot so the field reads as diffuse depth haze rather than
 * hard dots — the parallax layer behind the constellation.
 */
export const AmbientFieldMaterial = shaderMaterial(
  {
    uTime: 0,
    uPixelRatio: 1,
    uColorA: new THREE.Color("#4fd1c5"),
    uColorB: new THREE.Color("#8fb8ff"),
  },
  /* vertex */ `
    ${SIMPLEX_NOISE_3D}
    attribute float aSeed;
    attribute float aSize;
    uniform float uTime;
    uniform float uPixelRatio;
    varying float vSeed;
    varying float vDepthFade;

    void main() {
      vSeed = aSeed;
      vec3 pos = position;
      float t = uTime * 0.05 + aSeed * 37.0;
      pos.x += snoise(vec3(pos.x * 0.15, pos.y * 0.15, t)) * 0.6;
      pos.y += snoise(vec3(pos.y * 0.15, pos.z * 0.15, t + 11.0)) * 0.6;
      pos.z += snoise(vec3(pos.z * 0.15, pos.x * 0.15, t + 23.0)) * 0.6;

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      vDepthFade = clamp(1.0 - (-mvPosition.z) / 16.0, 0.05, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = aSize * uPixelRatio * (140.0 / -mvPosition.z);
    }
  `,
  /* fragment */ `
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    varying float vSeed;
    varying float vDepthFade;

    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      float alpha = smoothstep(0.5, 0.0, d);
      vec3 color = mix(uColorA, uColorB, vSeed);
      gl_FragColor = vec4(color, alpha * vDepthFade * 0.75);
    }
  `
);

extend({ NodeGlowMaterial, EdgeGlowMaterial, AmbientFieldMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    nodeGlowMaterial: ThreeElements["shaderMaterial"] & {
      uTime?: number;
      uActive?: number;
      uBaseColor?: THREE.Color | string;
      uActiveColor?: THREE.Color | string;
    };
    edgeGlowMaterial: ThreeElements["shaderMaterial"] & {
      uTime?: number;
      uActive?: number;
      uPulseStart?: number;
      uPulseDuration?: number;
      uDir?: number;
      uBaseColor?: THREE.Color | string;
      uActiveColor?: THREE.Color | string;
    };
    ambientFieldMaterial: ThreeElements["shaderMaterial"] & {
      uTime?: number;
      uPixelRatio?: number;
      uColorA?: THREE.Color | string;
      uColorB?: THREE.Color | string;
    };
  }
}
