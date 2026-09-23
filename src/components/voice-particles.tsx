"use client";

import { useEffect, useRef } from "react";

export type VoiceParticleMode = "idle" | "listening" | "speaking" | "processing" | "replying" | "error";

type VoiceParticlesProps = { mode: VoiceParticleMode; level: number };
type Point = { x: number; y: number; z: number; phase: number };
type ProjectedPoint = { x: number; y: number; depth: number; size: number; alpha: number };

const PARTICLE_COUNT = 640;
const COLORS: Record<VoiceParticleMode, readonly [number, number, number]> = {
  idle: [114, 122, 128],
  listening: [22, 154, 143],
  speaking: [43, 201, 117],
  processing: [196, 139, 44],
  replying: [67, 133, 208],
  error: [213, 82, 83],
};

function spherePoints(): Point[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
    const y = 1 - 2 * (index + 0.5) / PARTICLE_COUNT;
    const radial = Math.sqrt(1 - y * y);
    const angle = index * goldenAngle;
    return { x: Math.cos(angle) * radial, y, z: Math.sin(angle) * radial, phase: angle };
  });
}

/** Decorative state indicator. `level` is a normalized microphone measurement,
 * used only while listening/speaking; replying motion does not measure TTS audio.
 * The containing UI owns the accessible status text and a nonzero canvas height.
 */
export function VoiceParticles({ mode, level }: VoiceParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef({ mode, level });
  const requestFrameRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    inputRef.current = { mode, level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0 };
    requestFrameRef.current?.();
  }, [mode, level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const points = spherePoints();
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
    let color = [...COLORS[inputRef.current.mode]] as [number, number, number];

    const draw = (time: number) => {
      frame = null;
      if (disposed || document.hidden || width <= 0 || height <= 0) return;
      const elapsed = lastTime ? Math.min((time - lastTime) / 1000, 0.064) : 1 / 60;
      lastTime = time;
      const current = inputRef.current;
      const microphoneActive = current.mode === "listening" || current.mode === "speaking";
      const measuredLevel = microphoneActive && Number.isFinite(current.level)
        ? Math.max(0, Math.min(1, current.level)) : 0;
      const smoothing = 1 - Math.exp(-elapsed * 12);
      microphoneLevel = reducedMotion || !microphoneActive ? 0 : microphoneLevel + (measuredLevel - microphoneLevel) * smoothing;
      const targetColor = COLORS[current.mode];
      color = color.map((channel, index) => reducedMotion ? targetColor[index] : channel + (targetColor[index] - channel) * smoothing) as [number, number, number];

      // Processing/replying are deliberately status rhythms, not audio amplitude.
      const speed = current.mode === "processing" ? 0.30 : current.mode === "replying" ? 0.15 : 0.075;
      if (!reducedMotion) phase += elapsed * speed;
      const angle = reducedMotion ? 0.4 : phase + 0.4;
      const tilt = reducedMotion ? -0.18 : -0.18 + Math.sin(phase * 0.6) * 0.035;
      const cosY = Math.cos(angle), sinY = Math.sin(angle);
      const cosX = Math.cos(tilt), sinX = Math.sin(tilt);
      const statusPulse = !reducedMotion && (current.mode === "processing" || current.mode === "replying")
        ? Math.sin(phase * (current.mode === "processing" ? 9 : 11)) * 0.022 : 0;
      const radius = Math.min(width, height) * 0.34 * (1 + microphoneLevel * 0.28 + statusPulse);
      const centerX = width / 2;
      const centerY = height / 2;
      const red = Math.round(color[0]), green = Math.round(color[1]), blue = Math.round(color[2]);

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const halo = context.createRadialGradient(centerX, centerY, radius * 0.15, centerX, centerY, radius * 1.6);
      halo.addColorStop(0, `rgba(${red},${green},${blue},0.055)`);
      halo.addColorStop(0.6, `rgba(${red},${green},${blue},0.018)`);
      halo.addColorStop(1, `rgba(${red},${green},${blue},0)`);
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);

      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        // Deformation strength comes from the actual microphone level. With no
        // input level there is no imitation of speech in the listening shell.
        const deformation = microphoneLevel * (Math.sin(point.phase * 0.7 + phase * 18) * 0.105 + Math.sin(point.y * 8 - phase * 13) * 0.07);
        const shell = 1 + deformation;
        const rotatedX = point.x * cosY + point.z * sinY;
        const rotatedZ = point.z * cosY - point.x * sinY;
        const rotatedY = point.y * cosX - rotatedZ * sinX;
        const depth = point.y * sinX + rotatedZ * cosX;
        const perspective = 3.5 / (3.5 - depth);
        const front = (depth + 1) / 2;
        const output = projected[index];
        output.x = centerX + rotatedX * radius * perspective * shell;
        output.y = centerY + rotatedY * radius * perspective * shell;
        output.depth = depth;
        output.size = Math.max(0.65, Math.min(width, height) / 340 * (0.65 + front * 0.95)) * perspective;
        output.alpha = 0.17 + front * 0.70;
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
