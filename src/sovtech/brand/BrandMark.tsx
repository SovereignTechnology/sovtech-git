/**
 * The Sovereign Technology mark: a terminal prompt chevron followed by the
 * Bitcoin B. A port of www.sovtech.pro's src/components/BrandMark.jsx with the
 * same paths and viewBox. It strokes with currentColor, so callers colour it
 * with text-*, and it is decorative: always next to the name or a label.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="4 4.5 23.5 23.5"
      className={className}
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M 5.5 11 L 9.8 16 L 5.5 21"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M 13 9 V 23" />
        <path d="M 13 9.6 H 18.2 a 3.1 3.1 0 0 1 0 6.2 H 13" />
        <path d="M 13 15.8 H 19 a 3.5 3.5 0 0 1 0 7 H 13" />
      </g>
      <g strokeWidth="2.02" strokeLinecap="round">
        <path d="M 16 6 V 9.6" />
        <path d="M 19.4 6 V 9.6" />
        <path d="M 16 22.8 V 26.4" />
        <path d="M 19.4 22.8 V 26.4" />
      </g>
    </svg>
  );
}
