"use client";

import { useEffect, useRef } from "react";

export type VoiceParticleMode = "idle" | "listening" | "speaking" | "processing" | "replying" | "error";

type VoiceParticlesProps = { mode: VoiceParticleMode; level: number; replyLevel?: number; callActive?: boolean; theme?: "light" | "dark"; variant?: "compact" | "stage" };
type Point = { height: number; angle: number; sheet: number; spread: number; grain: number; phase: number; veil: boolean; scatterX: number; scatterY: number; scatterZ: number };
type ProjectedPoint = { x: number; y: number; depth: number; size: number; alpha: number; red: number; green: number; blue: number };
type Star = { x: number; y: number; drift: number; phase: number; size: number; alpha: number };
type LogoPoint = { x: number; y: number; red: number; green: number; blue: number };
type LogoVariant = "classic" | "gold";

const PARTICLE_COUNT = 3400;
const STAR_COUNT = 180;
const FRAME_INTERVAL_MS = 1000 / 30;
const COLORS: Record<"light" | "dark", Record<VoiceParticleMode, readonly [number, number, number]>> = {
  light: {
    idle: [67, 77, 82], listening: [29, 154, 88], speaking: [25, 174, 88],
    processing: [171, 117, 37], replying: [210, 108, 37], error: [191, 66, 74],
  },
  dark: {
    idle: [237, 241, 244], listening: [128, 237, 164], speaking: [144, 247, 176],
    processing: [239, 193, 115], replying: [255, 174, 100], error: [242, 140, 150],
  },
};

function flowPoints(): Point[] {
  // Reproducible scattered samples of several open, folded sheets. No latitude
  // grid, closed sphere or random repositioning between animation frames.
  let seed = 0x16e09b7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const group = random();
    // A continuous plume avoids three fixed, stacked round lobes.
    const height = group < 0.78 ? (random() + random() - 1) * 0.99 : random() * 1.98 - 0.99;
    const scatterAngle = random() * Math.PI * 2;
    return {
      height, angle: (random() - 0.5) * 5.15, sheet: Math.floor(random() * 3) - 1,
      spread: random(), grain: random(), phase: random() * Math.PI * 2, veil: group >= 0.87,
      scatterX: Math.cos(scatterAngle) * (0.55 + random() * 0.45),
      scatterY: (random() - 0.5) * 0.70,
      scatterZ: Math.sin(scatterAngle) * (0.45 + random() * 0.55),
    };
  });
}

function galaxyPoints(): Star[] {
  let seed = 0x7105aaf;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: STAR_COUNT }, () => ({
    x: random(), y: random(), drift: 0.45 + random() * 0.55,
    phase: random() * Math.PI * 2, size: 0.28 + random() * 0.45, alpha: 0.16 + random() * 0.30,
  }));
}

function sampleLogo(image: HTMLImageElement, variant: LogoVariant): LogoPoint[] {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 200;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, 200, 200);
  const pixels = context.getImageData(0, 0, 200, 200).data;
  const candidates: LogoPoint[] = [];
  let minX = 200, maxX = 0, minY = 200, maxY = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const offset = (y * 200 + x) * 4;
      const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
      const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
      const saturation = maximum ? (maximum - minimum) / maximum : 0;
      const gold = red > 150 && green > 100 && blue < 100;
      const classicGreen = green > 70 && green > red * 1.12 && green > blue * 1.12;
      // Only the supplied mark: omit white/checkerboard/dark frames and, for
      // the gold variant, its solid green rounded-square background entirely.
      if (pixels[offset + 3] < 180 || !(variant === "gold" ? gold : saturation > 0.32 && maximum > 90 && (gold || classicGreen))) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      candidates.push({ x, y, red, green, blue });
    }
  }
  if (!candidates.length) return [];
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  const halfSize = Math.max(maxX - minX, maxY - minY, 1) / 2;
  let seed = variant === "classic" ? 0x416bca7 : 0x79afb04;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let index = candidates.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  // Each main particle retains the same target index throughout a gathering.
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
    const point = candidates[Math.floor(index * candidates.length / PARTICLE_COUNT)];
    return { ...point, x: (point.x - centerX) / halfSize, y: (point.y - centerY) / halfSize };
  });
}

const wrapUnit = (value: number) => ((value % 1) + 1) % 1;
const normalizedLevel = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** `level` measures the microphone while listening/speaking; optional `replyLevel`
 * measures actual output audio while replying. Missing replyLevel means silence,
 * never microphone fallback or a fabricated speech waveform. Slow shape drift
 * remains decorative; the separate background galaxy never reacts to audio.
 * Supplied local marks appear occasionally only in idle with callActive=false.
 * The containing UI owns the accessible status text and a nonzero canvas height.
 */
export function VoiceParticles({ mode, level, replyLevel = 0, callActive = false, theme = "light", variant = "compact" }: VoiceParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef({ mode, level, replyLevel, callActive, theme, variant });
  const requestFrameRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    inputRef.current = { mode, level: normalizedLevel(level), replyLevel: normalizedLevel(replyLevel), callActive, theme, variant };
    requestFrameRef.current?.();
  }, [mode, level, replyLevel, callActive, theme, variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const points = flowPoints();
    const stars = galaxyPoints();
    const projected: ProjectedPoint[] = points.map(() => ({ x: 0, y: 0, depth: 0, size: 0, alpha: 0, red: 0, green: 0, blue: 0 }));
    const logoVariants: Partial<Record<LogoVariant, LogoPoint[]>> = {};
    const logoImages: HTMLImageElement[] = [];
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    let frame: number | null = null;
    let disposed = false;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let lastTime = 0;
    let phase = 0;
    let galaxyTime = 0;
    let audioEnvelope = 0;
    let scatter = 0;
    let scatterVelocity = 0;
    let audioSource = "none";
    let idleSeconds = 0;
    let nextLogoAt = 10;
    let logoStartedAt: number | null = null;
    let logoTargets: LogoPoint[] | null = null;
    let logoBlend = 0;
    let logoSeed = 0x21ce683;
    const logoRandom = () => { logoSeed = (Math.imul(logoSeed, 1664525) + 1013904223) >>> 0; return logoSeed / 4294967296; };
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
      if (reducedMotion) { logoBlend = 0; logoStartedAt = null; idleSeconds = 0; nextLogoAt = 10; }
      else if (current.mode === "idle" && !current.callActive) {
        idleSeconds += elapsed;
        if (logoStartedAt === null && idleSeconds >= nextLogoAt) {
          const ready = (Object.keys(logoVariants) as LogoVariant[]).filter(key => logoVariants[key]?.length);
          if (ready.length) {
            logoTargets = logoVariants[ready[Math.floor(logoRandom() * ready.length)]] ?? null;
            logoStartedAt = idleSeconds;
            nextLogoAt = idleSeconds + 18 + logoRandom() * 8;
          }
        }
        if (logoStartedAt !== null) {
          const age = idleSeconds - logoStartedAt;
          logoBlend = age < 2 ? ease(age / 2) : age < 4.5 ? 1 : 1 - ease((age - 4.5) / 2);
          if (age >= 6.5) { logoBlend = 0; logoStartedAt = null; }
        } else logoBlend *= Math.exp(-elapsed * 24);
      } else {
        // Leave the mark in a fraction of a second when a call becomes active;
        // the active state color wins immediately, even during this release.
        logoBlend *= Math.exp(-elapsed * 24);
        logoStartedAt = null;
        idleSeconds = 0;
        nextLogoAt = 10;
      }
      const microphoneActive = current.mode === "listening" || current.mode === "speaking";
      const source = microphoneActive ? "microphone" : current.mode === "replying" ? "reply" : "none";
      const measuredLevel = microphoneActive ? normalizedLevel(current.level)
        : current.mode === "replying" ? normalizedLevel(current.replyLevel) : 0;
      const smoothing = 1 - Math.exp(-elapsed * 12);
      if (source !== audioSource) { audioEnvelope = 0; audioSource = source; }
      if (reducedMotion) { audioEnvelope = 0; scatter = 0; scatterVelocity = 0; }
      else {
        audioEnvelope += (measuredLevel - audioEnvelope) * (1 - Math.exp(-elapsed * (measuredLevel > audioEnvelope ? 22 : 9)));
        const targetScatter = Math.pow(audioEnvelope, 0.72);
        // Stable fixed-direction particle travel follows a damped spring. It
        // expands on measured sound, then gathers gently when the level falls.
        const steps = Math.ceil(elapsed / 0.016);
        const step = elapsed / steps;
        for (let index = 0; index < steps; index++) {
          scatterVelocity += (targetScatter - scatter) * 150 * step;
          scatterVelocity *= Math.exp(-20 * step);
          scatter = Math.max(0, Math.min(1.12, scatter + scatterVelocity * step));
        }
      }
      const targetColor = COLORS[current.theme][current.mode];
      color = color.map((channel, index) => reducedMotion ? targetColor[index] : channel + (targetColor[index] - channel) * smoothing) as [number, number, number];

      // Slow freeform morphing is decorative; amplitude comes only from the
      // selected measured audio source above, including real AI output audio.
      const speed = current.mode === "processing" ? 0.46 : current.mode === "replying" ? 0.33 : 0.23;
      if (!reducedMotion) {
        phase += elapsed * speed;
        // Background time is deliberately independent of mode and audio level.
        galaxyTime += elapsed;
      }
      const motion = reducedMotion ? 0 : phase;
      const angle = 0.32 + Math.sin(motion * 0.43) * 0.24;
      const tilt = -0.04 + Math.sin(motion * 0.31) * 0.035;
      const cosY = Math.cos(angle), sinY = Math.sin(angle);
      const cosX = Math.cos(tilt), sinX = Math.sin(tilt);
      const cloudMix = (0.5 + Math.sin(motion * 0.47 - 0.8) * 0.5) * 0.62;
      const vortexMix = (0.5 + Math.sin(motion * 0.33 + 1.8) * 0.5) * 0.48;
      const twist = 4.8 + Math.sin(motion * 0.41) * 1.2;
      // The stage uses roughly 80% of its height and its central 45% width.
      // Cap horizontal expansion on ultrawide canvases to retain organic folds.
      const scale = Math.min(height * 0.43, width * 0.70);
      const stage = current.variant === "stage";
      const scaleX = stage ? Math.min(width * 0.36, height * 0.68) : scale;
      const scaleY = stage ? height * 0.40 : scale;
      const centerX = width / 2;
      const centerY = height / 2;
      const logoScale = stage ? Math.min(width * 0.28, height * 0.35) : Math.min(width, height) * 0.38;
      const red = Math.round(color[0]), green = Math.round(color[1]), blue = Math.round(color[2]);
      const dark = current.theme === "dark";

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      if (stage) {
        const starColor = dark ? "213,221,229" : "87,98,109";
        const time = reducedMotion ? 0 : galaxyTime;
        for (const star of stars) {
          const x = wrapUnit(star.x + time * 0.0008 * star.drift + Math.sin(time * 0.045 + star.phase) * 0.007);
          const y = wrapUnit(star.y - time * 0.00035 * star.drift + Math.cos(time * 0.038 + star.phase) * 0.009);
          // Keep the core legible without cutting a visible hole in the field.
          const distance = Math.hypot((x - 0.5) / 0.29, (y - 0.5) / 0.44);
          const centerFade = 0.20 + Math.min(1, distance) * 0.80;
          context.beginPath();
          context.arc(x * width, y * height, star.size, 0, Math.PI * 2);
          context.fillStyle = `rgba(${starColor},${(star.alpha * centerFade).toFixed(3)})`;
          context.fill();
        }
      }

      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const t = point.height + Math.sin(point.height * 5 + motion * 0.8) * 0.018;
        // Moving waists and an uneven continuous envelope: neither a sphere
        // nor stacked balls. Each sample keeps its identity through the morph.
        const taper = Math.pow(Math.max(0, 1 - t * t), 0.6);
        const envelope = (0.07 + taper * 0.36) * (0.86 + Math.sin(t * 4.7 - motion * 0.68) * 0.16 + Math.cos(t * 8.1 + motion * 0.43) * 0.09);
        const fold = point.angle + t * 3.4 + Math.sin(t * 7 + motion * 0.7) * 0.52 + point.sheet * 0.23;
        const ripple = Math.sin(t * 12 - motion * 1.1 + point.sheet) * 0.055
          + Math.sin(fold * 2 + t * 8 + motion * 0.6) * 0.065;
        const audioFold = audioEnvelope * (0.16 + Math.sin(t * 9 - motion * 3 + point.phase) * 0.08);
        const radius = envelope * (1 + ripple + audioFold + point.sheet * 0.095);
        const veil = point.veil ? 1.16 + point.spread * 0.44 : 0.97 + point.spread * 0.055;
        const spine = Math.sin(t * 5.8 + motion * 0.38) * 0.065 + Math.sin(t * 10 - motion * 0.3) * 0.028;
        const ribbonX = spine + radius * veil * (Math.sin(fold) + Math.sin(fold * 2 + t * 3) * 0.19);
        const ribbonY = t + Math.sin(fold + t * 4) * radius * 0.11;
        const ribbonZ = radius * veil * (Math.cos(fold) * 0.61 + Math.sin(fold * 3 + motion * 0.4) * 0.12);
        const density = 0.55 + point.spread * 0.55;
        const cloudX = spine * 0.6 + radius * density * (Math.sin(fold * 0.82 + t * 2.4) * 0.88 + Math.sin(point.phase) * 0.18);
        const cloudY = t * 0.92 + Math.sin(fold + point.phase) * radius * 0.14;
        const cloudZ = radius * density * (Math.cos(fold + t * 1.7) * 0.5 + Math.sin(point.phase * 1.6) * 0.2);
        const vortexAngle = point.angle * 0.72 + t * twist - motion * 0.42 + point.sheet * 0.28;
        const vortexRadius = radius * (0.70 + point.spread * 0.38);
        const vortexX = spine + Math.sin(vortexAngle) * vortexRadius;
        const vortexY = t + Math.sin(vortexAngle + t * 3) * 0.06;
        const vortexZ = Math.cos(vortexAngle) * vortexRadius * 0.65;
        const mixedX = ribbonX + (cloudX - ribbonX) * cloudMix;
        const mixedY = ribbonY + (cloudY - ribbonY) * cloudMix;
        const mixedZ = ribbonZ + (cloudZ - ribbonZ) * cloudMix;
        const travel = scatter * (0.13 + point.spread * 0.43) * (point.veil ? 1.20 : 1);
        const x = mixedX + (vortexX - mixedX) * vortexMix + point.scatterX * travel;
        const y = mixedY + (vortexY - mixedY) * vortexMix + point.scatterY * travel;
        const z = mixedZ + (vortexZ - mixedZ) * vortexMix + point.scatterZ * travel;
        const rotatedX = x * cosY + z * sinY;
        const rotatedZ = z * cosY - x * sinY;
        const rotatedY = y * cosX - rotatedZ * sinX;
        const depth = y * sinX + rotatedZ * cosX;
        const perspective = 3.8 / (3.8 - depth);
        const front = Math.max(0, Math.min(1, (depth + 0.6) / 1.2));
        const crease = Math.pow(Math.abs(Math.cos(fold * 1.25 + t * 3)), 5);
        const output = projected[index];
        output.x = centerX + rotatedX * scaleX * perspective;
        output.y = centerY + rotatedY * scaleY * perspective;
        output.depth = depth;
        output.size = Math.max(0.24, Math.min(0.82, Math.min(width, height) / 260 * (0.28 + point.grain * 0.37))) * perspective;
        // More fine samples and stronger front-facing folds reveal the silver
        // fabric on dark surfaces; particle radii stay tiny, without glow discs.
        const materialAlpha = dark ? 0.22 + front * 0.34 + crease * 0.38 : 0.16 + front * 0.26 + crease * 0.32;
        output.alpha = Math.min(0.94, materialAlpha) * (point.veil ? dark ? 0.46 : 0.35 : 1) * (0.76 + point.grain * 0.24);
        const logo = logoTargets?.[index];
        const logoColorBlend = current.mode === "idle" && !current.callActive ? logoBlend : 0;
        output.red = red;
        output.green = green;
        output.blue = blue;
        if (logo && logoBlend > 0.001) {
          output.x += (centerX + logo.x * logoScale - output.x) * logoBlend;
          output.y += (centerY + logo.y * logoScale - output.y) * logoBlend;
          output.depth *= 1 - logoBlend;
          output.alpha += (0.90 - output.alpha) * logoBlend;
          output.red += (logo.red - red) * logoColorBlend;
          output.green += (logo.green - green) * logoColorBlend;
          output.blue += (logo.blue - blue) * logoColorBlend;
        }
      }

      projected.sort((a, b) => a.depth - b.depth);
      for (const point of projected) {
        context.beginPath();
        context.arc(point.x, point.y, point.size, 0, Math.PI * 2);
        context.fillStyle = `rgba(${Math.round(point.red)},${Math.round(point.green)},${Math.round(point.blue)},${point.alpha.toFixed(3)})`;
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

    for (const variant of ["classic", "gold"] as const) {
      const image = new Image();
      logoImages.push(image);
      image.onload = () => {
        if (disposed) return;
        try { logoVariants[variant] = sampleLogo(image, variant); }
        catch { /* Keep the organic animation if local image sampling fails. */ }
        requestFrame();
      };
      image.src = `/brand/halyk-mark-${variant}.png`;
    }

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
      logoImages.forEach(image => { image.onload = null; image.onerror = null; });
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionQuery.removeEventListener("change", motionChanged);
    };
  }, []);

  return <canvas ref={canvasRef} className="voice-particles" aria-hidden="true" style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none" }} />;
}
