import { useEffect, useRef } from 'react';
import type { Waveform } from '../types';
import { sampleWave } from '../lib/music';
import { HUE_HEX, type NeonHue } from '../lib/neon';

const TWO_PI = Math.PI * 2;

/** What the scope draws: a sum of waveforms, at `ratio` × the note */
export interface ScopeVoice {
  ratio: number;
  amplitude: number;
  waveform: Waveform;
}

/**
 * Neon oscilloscope drawing the sum of the voices, each started at phase 0
 * like a partial in synthway-core (visual only, no audio). A single voice at
 * ratio 1 is the plain waveform. The sum is scaled down when it exceeds 1, so
 * that the shape stays visible.
 */
export function WaveScope({
  voices,
  hue,
  animate,
  cycles = 2.5,
  className,
}: {
  voices: ScopeVoice[];
  hue: NeonHue;
  animate: boolean;
  cycles?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const voicesRef = useRef(voices);
  const redrawRef = useRef<() => void>(() => undefined);
  voicesRef.current = voices;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    let width = 0;
    let height = 0;
    let raf = 0;
    let offset = 0;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      // Graticule
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(150, 125, 255, 0.07)';
      for (let x = 0; x < width; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      for (let y = (height / 2) % 24; y < height; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(150, 125, 255, 0.18)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(height / 2) + 0.5);
      ctx.lineTo(width, Math.round(height / 2) + 0.5);
      ctx.stroke();

      // Sum of the voices
      const current = voicesRef.current;
      const scale = 1 / Math.max(1, current.reduce((sum, voice) => sum + voice.amplitude, 0));
      const mid = height / 2;
      const amp = height * 0.36 * scale;
      ctx.beginPath();
      for (let x = 0; x <= width; x += 1) {
        const phase = (x / width) * cycles * TWO_PI + offset;
        let sample = 0;
        for (const voice of current) sample += voice.amplitude * sampleWave(voice.waveform, voice.ratio * phase);
        const y = mid - sample * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, HUE_HEX[hue]);
      gradient.addColorStop(0.55, '#c21cff');
      gradient.addColorStop(1, '#5f78ff');
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.shadowColor = HUE_HEX[hue];
      ctx.shadowBlur = 16;
      ctx.lineWidth = 3;
      ctx.strokeStyle = gradient;
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.stroke();
    };
    redrawRef.current = draw;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const tick = () => {
      offset = (offset - 0.035) % (TWO_PI * 64);
      draw();
      raf = window.requestAnimationFrame(tick);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (animate) raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      redrawRef.current = () => undefined;
    };
  }, [hue, animate, cycles]);

  // New voices: the animation picks them up by itself, a still scope is redrawn
  useEffect(() => {
    if (!animate) redrawRef.current();
  }, [voices, animate]);

  return <canvas ref={canvasRef} className={className} style={{ display: 'block', width: '100%', height: '100%' }} aria-hidden="true" />;
}
