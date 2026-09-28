/**
 * The source of public/og-image.png, at /og-preview. It shadows
 * src/pages/OgImagePreview.tsx through ci/sovtech/shadow-map.tsv.
 *
 * #sovtech-og is exactly 1200×630 and ignores the theme: fixed hex in inline
 * styles, inline SVG only, no network and no animation. The page covers the
 * app shell, so a 1200×630 viewport screenshot of /og-preview is the image.
 * data-og-ready turns "true" once the fonts have loaded.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { BrandMark } from "@/sovtech/brand/BrandMark";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.OgImagePreview"), true);

const WIDTH = 1200;
const HEIGHT = 630;

// Every text colour is at least 5.7:1 on INK.
const INK = "#0A0A0A";
const ORANGE = "#F7931A";
const WHITE = "#FAFAFA";
const MUTED = "#A3A3A3";
const DIM = "#8A8A8A";

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
const SANS = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';

/** Covers the header and footer; centres the image in larger windows. */
const page: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  overflow: "auto",
  background: INK,
};

const frame: CSSProperties = {
  position: "relative",
  flexShrink: 0,
  width: WIDTH,
  height: HEIGHT,
  margin: "auto",
  overflow: "hidden",
  background: INK,
  fontFamily: SANS,
};

// The safe area is x 80 to 1120 and y 60 to 570.
const host: CSSProperties = {
  position: "absolute",
  left: 80,
  top: 60,
  fontFamily: MONO,
  fontSize: 24,
  color: ORANGE,
};

const hero: CSSProperties = {
  position: "absolute",
  left: 80,
  top: 170,
  fontFamily: MONO,
  fontSize: 88,
  fontWeight: 700,
  lineHeight: 1.1,
  letterSpacing: -2,
  color: WHITE,
};

const subline: CSSProperties = {
  position: "absolute",
  left: 80,
  top: 386,
  fontSize: 30,
  color: MUTED,
};

const footer: CSSProperties = {
  position: "absolute",
  left: 80,
  right: 80,
  bottom: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const tile: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 56,
  height: 56,
  borderRadius: 12,
  background: ORANGE,
  color: INK,
};

const wordmark: CSSProperties = {
  marginLeft: 20,
  fontFamily: MONO,
  fontSize: 40,
  fontWeight: 700,
  letterSpacing: -1,
  color: WHITE,
};

const tags: CSSProperties = {
  fontFamily: MONO,
  fontSize: 22,
  color: DIM,
};

function Backdrop() {
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      style={{ position: "absolute", inset: 0 }}
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="sovtech-og-grid"
          width="40"
          height="40"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 40 0 L 0 0 0 40"
            fill="none"
            stroke={ORANGE}
            strokeOpacity="0.06"
          />
        </pattern>
        <radialGradient id="sovtech-og-glow" cx="88%" cy="8%" r="55%">
          <stop offset="0%" stopColor={ORANGE} stopOpacity="0.1" />
          <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={WIDTH} height={HEIGHT} fill="url(#sovtech-og-grid)" />
      <rect width={WIDTH} height={HEIGHT} fill="url(#sovtech-og-glow)" />
      <rect width="6" height={HEIGHT} fill={ORANGE} />
    </svg>
  );
}

export default function OgImagePreview() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    async function waitForFonts() {
      await document.fonts.load('30px "Inter Variable"');
      await document.fonts.ready;
      if (live) setReady(true);
    }
    void waitForFonts();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div style={page}>
      <div
        id="sovtech-og"
        data-og-ready={ready ? "true" : undefined}
        style={frame}
      >
        <Backdrop />
        <div style={host}>git.sovtech.pro</div>
        <div style={hero}>
          <div>Your keys.</div>
          <div style={{ color: ORANGE }}>Your code.</div>
        </div>
        <div style={subline}>
          Git collaboration over Nostr, run from El Salvador.
        </div>
        <div style={footer}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={tile}>
              <BrandMark className="h-9 w-9" />
            </div>
            <div style={wordmark}>
              SovTech<span style={{ color: ORANGE }}> Git</span>
            </div>
          </div>
          <div style={tags}>NIP-34 · GRASP · ngit</div>
        </div>
      </div>
    </div>
  );
}
