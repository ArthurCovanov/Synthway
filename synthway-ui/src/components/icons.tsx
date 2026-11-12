import type { SVGProps } from 'react';
import type { Waveform } from '../types';
import { wavePath } from '../lib/music';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function iconProps({ size = 22, ...props }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  };
}

/** Instrument Creator: a sine wave being sculpted into a square, with a spark */
export function InstrumentIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2 14c1.4-4.6 3.6-4.6 5 0s3.6 4.6 5 0" />
      <path d="M12 14v-4h4v8h4v-4h2" />
      <path d="M19.5 2v5M17 4.5h5" />
    </svg>
  );
}

/** Composer: a piano-roll pattern */
export function ComposerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" />
      <path d="M6 15.5h3.5" strokeWidth={2.6} />
      <path d="M9.5 11h4.5" strokeWidth={2.6} />
      <path d="M14 7.5h4" strokeWidth={2.6} />
      <path d="M15.5 13.5h2.5" strokeWidth={2.6} />
    </svg>
  );
}

/** Analyzer: a waveform going through a lens that reveals its partials */
export function AnalyzerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2 12h1.5l1.8-4.5 2.6 9 1.8-4.5H11" />
      <circle cx="16" cy="10" r="5" />
      <path d="M19.6 13.6 22 16" />
      <path d="M14.2 11.5v1M16 8.5v4M17.8 10v2.5" strokeWidth={1.5} />
    </svg>
  );
}

/** Decomposer: a waveform splitting into its stems */
export function DecomposerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2 12h1.5l1.6-4 2.3 8 1.6-4H11" />
      <path d="M11 12c2.5 0 3-5.5 6-5.5h5" />
      <path d="M11 12h11" />
      <path d="M11 12c2.5 0 3 5.5 6 5.5h5" />
      <path d="M19 2.5v2.5M17.75 3.75h2.5" strokeWidth={1.5} />
    </svg>
  );
}

/** Miniature of a spectrum: one bar per partial, at its ratio, in its colour */
export function SpectrumGlyph({
  partials,
  width = 36,
  height = 18,
  className,
}: {
  partials: { ratio: number; amplitude: number; color: string }[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const maxRatio = Math.max(4, ...partials.map((partial) => partial.ratio)) * 1.1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden="true">
      <path d={`M0 ${height - 0.5}H${width}`} stroke="color-mix(in srgb, var(--grid) 35%, transparent)" strokeWidth={1} />
      {partials.map((partial, index) => {
        const x = 1.5 + (partial.ratio / maxRatio) * (width - 3);
        return (
          <path
            key={index}
            d={`M${x.toFixed(2)} ${height - 0.5}V${(height - 0.5 - partial.amplitude * (height - 2)).toFixed(2)}`}
            stroke={partial.color}
            strokeWidth={2}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 2px ${partial.color})` }}
          />
        );
      })}
    </svg>
  );
}

/** Miniature of a waveform, for cards and selectors */
export function WaveGlyph({
  waveform,
  width = 36,
  height = 18,
  cycles = 1.5,
  ...props
}: SVGProps<SVGSVGElement> & { waveform: Waveform; width?: number; height?: number; cycles?: number }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={`-2 -2 ${width + 4} ${height + 4}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={wavePath(waveform, width, height, cycles)} />
    </svg>
  );
}

/**
 * Shared gradient for active icons (`stroke: url(#sw-neon-stroke)` in CSS).
 * userSpaceOnUse: an objectBoundingBox gradient would hide straight lines.
 */
export function NeonDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sw-neon-stroke" gradientUnits="userSpaceOnUse" x1="2" y1="3" x2="22" y2="21">
          <stop offset="0" stopColor="var(--curve-start)" />
          <stop offset="0.5" stopColor="var(--curve-mid)" />
          <stop offset="1" stopColor="var(--curve-end)" />
        </linearGradient>
      </defs>
    </svg>
  );
}
