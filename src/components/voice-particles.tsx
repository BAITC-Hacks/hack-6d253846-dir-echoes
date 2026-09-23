"use client";

import { useEffect, useRef } from "react";

export type VoiceParticleMode = "idle" | "listening" | "speaking" | "processing" | "replying" | "error";

type VoiceParticlesProps = { mode: VoiceParticleMode; level: number; theme?: "light" | "dark" };
type Point = { height: number; angle: number; sheet: number; spread: number; grain: number; phase: number; veil: boolean };
type ProjectedPoint = { x: number; y: number; depth: number; size: number; alpha: number };

const PARTICLE_COUNT = 3400;
const FRAME_INTERVAL_MS = 1000 / 30;
const COLORS: Record<"light" | "dark", Record<VoiceParticleMode, readonly [number, number, number]>> = {
  light: {
    idle: [67, 77, 82], listening: [26, 139, 129], speaking: [27, 168, 105],
    processing: [171, 117, 37], replying: [55, 119, 185], error: [191, 66, 74],
  },
  dark: {
    idle: [237, 241, 244], listening: [127, 224, 212], speaking: [148, 237, 184],
    processing: [239, 193, 115], replying: [144, 195, 246], error: [242, 140, 150],
  },
};

function flowPoints(): Point[] {
  // Reproducible scattered samples of several open, folded sheets. No latitude
  // grid, closed sphere or random repositioning between animation frames.
  let seed = 0x16e09b7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const group = random();
    const height = group < 0.61 ? -0.62 + random() * 1.18
      : group < 0.73 ? -0.99 + random() * 0.32
      : group < 0.87 ? 0.65 + random() * 0.34 : random() * 2 - 1;
    return {
      height, angle: (random() - 0.5) * 5.15, sheet: Math.floor(random() * 3) - 1,
      spread: random(), grain: random(), phase: random() * Math.PI * 2, veil: group >= 0.87,
    };
  });
}

const gaussian = (value: number) => Math.exp(-value * value);

/** Decorative state indicator. `level` is a normalized microphone measurement,
 * used only while listening/speaking; replying motion does not measure TTS audio.
 * The containing UI owns the accessible status text and a nonzero canvas height.
 */
export function VoiceParticles({ mode, level, theme = "light" }: VoiceParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef({ mode, level, theme });
  const requestFrameRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    inputRef.current = { mode, level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0, theme };
    requestFrameRef.current?.();
  }, [mode, level, theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const points = flowPoints();
    const projected: ProjectedPoint[] = points.map(() => ({ x: 0, y: 0, depth: 0, size: 0, alpha: 0 }));
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    let frame: number | null = null;
    let disposed = false;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let lastTime = 0;
    let phase = 0;
    let microphoneLevel = 0;
    let color = [...COLORS[inputRef.current.theme][inputRef.current.mode]] as [number, number, number];

    const draw = (time: number) => {
      frame = null;
      if (disposed || document.hidden || width <= 0 || height <= 0) return;
      if (!reducedMotion && lastTime && time - lastTime < FRAME_INTERVAL_MS - 0.5) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      const elapsed = lastTime ? Math.min((time - lastTime) / 1000, 0.08) : 1 / 30;
      lastTime = time;
      const current = inputRef.current;
      const microphoneActive = current.mode === "listening" || current.mode === "speaking";
      const measuredLevel = microphoneActive && Number.isFinite(current.level)
        ? Math.max(0, Math.min(1, current.level)) : 0;
      const smoothing = 1 - Math.exp(-elapsed * 12);
      microphoneLevel = reducedMotion || !microphoneActive ? 0 : microphoneLevel + (measuredLevel - microphoneLevel) * smoothing;
      const targetColor = COLORS[current.theme][current.mode];
      color = color.map((channel, index) => reducedMotion ? targetColor[index] : channel + (targetColor[index] - channel) * smoothing) as [number, number, number];

      // This slow material drift is decorative. Only microphoneLevel changes
      // the audio deformation; processing/replying do not imitate TTS amplitude.
      const speed = current.mode === "processing" ? 0.46 : current.mode === "replying" ? 0.33 : 0.23;
      if (!reducedMotion) phase += elapsed * speed;
      const motion = reducedMotion ? 0 : phase;
      const angle = 0.32 + Math.sin(motion * 0.43) * 0.24;
      const tilt = -0.04 + Math.sin(motion * 0.31) * 0.035;
      const cosY = Math.cos(angle), sinY = Math.sin(angle);
      const cosX = Math.cos(tilt), sinX = Math.sin(tilt);
      // A tall silhouette, about half as wide as it is high, with room for wisps.
      const scale = Math.min(height * 0.43, width * 0.70);
      const centerX = width / 2;
      const centerY = height / 2;
      const red = Math.round(color[0]), green = Math.round(color[1]), blue = Math.round(color[2]);
      const dark = current.theme === "dark";

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const t = point.height + Math.sin(point.height * 5 + motion * 0.8) * 0.018;
        // Three unequal billows joined by thin waists, with small detached veils.
        const envelope = 0.055 + 0.43 * gaussian((t + 0.035) / 0.34)
          + 0.19 * gaussian((t + 0.855) / 0.115) + 0.22 * gaussian((t - 0.825) / 0.145);
        const fold = point.angle + t * 3.4 + Math.sin(t * 7 + motion * 0.7) * 0.52 + point.sheet * 0.23;
        const ripple = Math.sin(t * 12 - motion * 1.1 + point.sheet) * 0.055
          + Math.sin(fold * 2 + t * 8 + motion * 0.6) * 0.065;
        const audioFold = microphoneLevel * (0.20 + Math.sin(t * 9 - motion * 6 + point.phase) * 0.13);
        const radius = envelope * (1 + ripple + audioFold + point.sheet * 0.095);
        const veil = point.veil ? 1.16 + point.spread * 0.44 : 0.97 + point.spread * 0.055;
        const spine = Math.sin(t * 5.8 + motion * 0.38) * 0.065 + Math.sin(t * 10 - motion * 0.3) * 0.028;
        const x = spine + radius * veil * (Math.sin(fold) + Math.sin(fold * 2 + t * 3) * 0.19);
        const y = t + Math.sin(fold + t * 4) * radius * 0.11;
        const z = radius * veil * (Math.cos(fold) * 0.61 + Math.sin(fold * 3 + motion * 0.4) * 0.12);
        const rotatedX = x * cosY + z * sinY;
        const rotatedZ = z * cosY - x * sinY;
        const rotatedY = y * cosX - rotatedZ * sinX;
        const depth = y * sinX + rotatedZ * cosX;
        const perspective = 3.8 / (3.8 - depth);
        const front = Math.max(0, Math.min(1, (depth + 0.6) / 1.2));
        const crease = Math.pow(Math.abs(Math.cos(fold * 1.25 + t * 3)), 5);
        const output = projected[index];
        output.x = centerX + rotatedX * scale * perspective;
        output.y = centerY + rotatedY * scale * perspective;
        output.depth = depth;
        output.size = Math.max(0.24, Math.min(0.82, Math.min(width, height) / 260 * (0.28 + point.grain * 0.37))) * perspective;
        // More fine samples and stronger front-facing folds reveal the silver
        // fabric on dark surfaces; particle radii stay tiny, without glow discs.
        const materialAlpha = dark ? 0.22 + front * 0.34 + crease * 0.38 : 0.16 + front * 0.26 + crease * 0.32;
        output.alpha = Math.min(0.94, materialAlpha) * (point.veil ? dark ? 0.46 : 0.35 : 1) * (0.76 + point.grain * 0.24);
      }

      projected.sort((a, b) => a.depth - b.depth);
      for (const point of projected) {
        context.beginPath();
        context.arc(point.x, point.y, point.size, 0, Math.PI * 2);
        context.fillStyle = `rgba(${red},${green},${blue},${point.alpha.toFixed(3)})`;
        context.fill();
      }
      if (!reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const requestFrame = () => {
      if (!disposed && !document.hidden && frame === null && width > 0 && height > 0) {
        frame = window.requestAnimationFrame(draw);
      }
    };
    requestFrameRef.current = requestFrame;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      requestFrame();
    };
    const visibilityChanged = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = 0;
      if (!document.hidden) requestFrame();
    };
    const motionChanged = () => {
      reducedMotion = motionQuery.matches;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = 0;
      requestFrame();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibilityChanged);
    motionQuery.addEventListener("change", motionChanged);
    resize();

    return () => {
      disposed = true;
      requestFrameRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionQuery.removeEventListener("change", motionChanged);
    };
  }, []);

  return <canvas ref={canvasRef} className="voice-particles" aria-hidden="true" style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none" }} />;
}
