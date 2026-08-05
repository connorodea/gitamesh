import { ImageResponse } from "next/og";

export const alt =
  "Gitamesh — The coordination mesh for autonomous coding agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand tokens, mirrored from tailwind.config.ts (ink/mesh/claim) and the
// exact node/edge geometry of components/Mark.tsx — next/og's Satori
// renderer can't import project source, so both are inlined here by hand.
const ink950 = "#05070a";
const ink800 = "#0d121a";
const line = "#1c232e";
const mesh = "#4fd1c5";
const meshDim = "#2c5a56";
const claim = "#FF6B35";
const fg = "#e8ecf1";
const fgMuted = "#93a1b3";

function MarkLarge() {
  return (
    <svg
      viewBox="0 0 32 32"
      width={96}
      height={96}
      fill="none"
      style={{ display: "block" }}
    >
      <rect width="32" height="32" rx="7" fill={ink950} />
      <path
        d="M16 7 L25 13 V22 L16 28 L7 22 V13 Z"
        stroke={meshDim}
        strokeWidth="1.4"
        fill="none"
      />
      <line x1="16" y1="7" x2="16" y2="16" stroke={mesh} strokeWidth="1.4" />
      <line x1="25" y1="13" x2="16" y2="16" stroke={mesh} strokeWidth="1.4" />
      <line x1="7" y1="13" x2="16" y2="16" stroke={meshDim} strokeWidth="1.4" />
      <line x1="25" y1="22" x2="16" y2="16" stroke={meshDim} strokeWidth="1.4" />
      <line x1="7" y1="22" x2="16" y2="16" stroke={meshDim} strokeWidth="1.4" />
      <circle cx="16" cy="7" r="2.6" fill={claim} />
      <circle cx="25" cy="13" r="2.2" fill={mesh} />
      <circle cx="25" cy="22" r="2.2" fill={ink800} stroke={mesh} strokeWidth="1" />
      <circle cx="16" cy="28" r="2.2" fill={ink800} stroke={meshDim} strokeWidth="1" />
      <circle cx="7" cy="22" r="2.2" fill={ink800} stroke={meshDim} strokeWidth="1" />
      <circle cx="7" cy="13" r="2.2" fill={ink800} stroke={meshDim} strokeWidth="1" />
      <circle cx="16" cy="16" r="2" fill={ink950} stroke={fg} strokeWidth="1" />
    </svg>
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: ink950,
          backgroundImage: `linear-gradient(to right, ${line}22 1px, transparent 1px), linear-gradient(to bottom, ${line}22 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <MarkLarge />
          <span
            style={{
              fontSize: 40,
              fontWeight: 600,
              color: fg,
              letterSpacing: "-0.02em",
            }}
          >
            gitamesh
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              display: "flex",
              fontSize: 60,
              fontWeight: 600,
              color: fg,
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              maxWidth: 980,
            }}
          >
            The coordination mesh for autonomous coding agents
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: fgMuted,
              maxWidth: 880,
            }}
          >
            Atomic claims, fencing tokens, leases, and an append-only event
            log — so AI agents never duplicate or clobber each other's work.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              display: "flex",
              width: 10,
              height: 10,
              borderRadius: 999,
              backgroundColor: mesh,
            }}
          />
          <span style={{ fontSize: 22, color: fgMuted, letterSpacing: "0.02em" }}>
            gitamesh.com
          </span>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
