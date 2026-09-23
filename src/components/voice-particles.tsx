"use client";

import { useEffect, useRef } from "react";

export type VoiceParticleMode = "idle" | "listening" | "speaking" | "processing" | "replying" | "error";

type VoiceParticlesProps = { mode: VoiceParticleMode; level: number; replyLevel?: number; callActive?: boolean; theme?: "light" | "dark"; variant?: "compact" | "stage" };
type Point = { height: number; angle: number; sheet: number; spread: number; grain: number; phase: number; sinPhase: number; sinPhase16: number; veil: boolean; scatterX: number; scatterY: number; scatterZ: number };
type ProjectedPoint = { x: number; y: number; size: number; alpha: number; colorBand: number };
type Star = { x: number; y: number; drift: number; phase: number; size: number; alpha: number };
type LogoPoint = { x: number; y: number; red: number; green: number; blue: number };
type LogoVariant = "classic" | "gold" | "dir";

const PARTICLE_COUNT = 3400;
const STAR_COUNT = 180;
const FRAME_INTERVAL_MS = 1000 / 60;
const ALPHA_BANDS = 12;
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
    const phase = random() * Math.PI * 2;
    return {
      height, angle: (random() - 0.5) * 5.15, sheet: Math.floor(random() * 3) - 1,
      spread: random(), grain: random(), phase, sinPhase: Math.sin(phase), sinPhase16: Math.sin(phase * 1.6), veil: group >= 0.87,
      scatterX: Math.cos(scatterAngle) * (0.55 + random() * 0.45),
      scatterY: (random() - 0.5) * 0.70,
      scatterZ: Math.sin(scatterAngle) * (0.45 + random() * 0.55),
    };
  });
}

function nearbyLogoTargets(projected: ProjectedPoint[], targets: LogoPoint[], count: number): LogoPoint[] {
  const indices = Array.from({ length: count }, (_, index) => index).sort((a, b) => projected[a].y - projected[b].y);
  const selected = Array.from({ length: count }, (_, index) => targets[Math.floor(index * targets.length / count)]).sort((a, b) => a.y - b.y);
  const mapped: LogoPoint[] = new Array(count);
  // Match narrow horizontal bands, then left-to-right inside each band. Random
  // cross-canvas targets caused the cloud to collapse before becoming a logo.
  const bandSize = Math.ceil(Math.sqrt(count));
  for (let offset = 0; offset < count; offset += bandSize) {
    const sourceBand = indices.slice(offset, offset + bandSize).sort((a, b) => projected[a].x - projected[b].x);
    const targetBand = selected.slice(offset, offset + bandSize).sort((a, b) => a.x - b.x);
    sourceBand.forEach((index, position) => { mapped[index] = targetBand[position]; });
  }
  return mapped;
}

function galaxyPoints(): Star[] {
  let seed = 0x7105aaf;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: STAR_COUNT }, (_, index) => {
    const prominent = index % 61 === 0;
    return {
      x: random(), y: random(), drift: 0.45 + random() * 0.55,
      phase: random() * Math.PI * 2, size: prominent ? 1.1 : 0.50 + random() * 0.60,
      alpha: prominent ? 0.76 : 0.24 + random() * 0.32,
    };
  });
}

function sampleLogo(image: HTMLImageElement, variant: LogoVariant): LogoPoint[] {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 200;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  const imageScale = 200 / Math.max(image.naturalWidth, image.naturalHeight);
  const imageWidth = image.naturalWidth * imageScale, imageHeight = image.naturalHeight * imageScale;
  context.drawImage(image, (200 - imageWidth) / 2, (200 - imageHeight) / 2, imageWidth, imageHeight);
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
      const whiteMark = minimum > 195 && saturation < 0.20;
      // Only the supplied mark: omit white/checkerboard/dark frames and, for
      // the gold variant, its solid green rounded-square background entirely.
      if (pixels[offset + 3] < 180 || !(variant === "dir" ? whiteMark : variant === "gold" ? gold : saturation > 0.32 && maximum > 90 && (gold || classicGreen))) continue;
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
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * t * (t * (t * 6 - 15) + 10); };

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
    // Select once per mount, so resize/audio never makes particle counts flicker.
    const modestDevice = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 720 || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4);
    const particleCount = modestDevice ? 1800 : window.innerWidth < 1100 ? 2600 : PARTICLE_COUNT;
    const projected: ProjectedPoint[] = points.slice(0, particleCount).map(() => ({ x: 0, y: 0, size: 0, alpha: 0, colorBand: 0 }));
    const drawBatches: number[][] = Array.from({ length: ALPHA_BANDS * 3 }, () => []);
    const starProjected = stars.map(() => ({ x: 0, y: 0 }));
    const starBatches: number[][] = Array.from({ length: 8 }, () => []);
    const logoVariants: Partial<Record<LogoVariant, LogoPoint[]>> = {};
    const logoImages: HTMLImageElement[] = [];
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    let frame: number | null = null;
    let disposed = false;
    let width = 0;
    let height = 0;
    let bounds: DOMRect | null = null;
    let dpr = 1;
    let lastTime = 0;
    let frameDeadline = 0;
    let lastStaticKey = "";
    let phase = 0;
    let galaxyTime = 0;
    let audioEnvelope = 0;
    let scatter = 0;
    let scatterVelocity = 0;
    let replyMorph = 0;
    let startBurstAge = 10;
    let activityBurstLatched = inputRef.current.callActive || inputRef.current.mode !== "idle";
    const pointer = { targetX: 0.5, targetY: 0.5, x: 0.5, y: 0.5, targetStrength: 0, strength: 0 };
    let idleSeconds = 0;
    let nextLogoAt = 10;
    let logoStartedAt: number | null = null;
    let logoTargets: LogoPoint[] | null = null;
    let logoBlend = 0;
    let logoReleaseAt: number | null = null;
    let logoReleaseFrom = 0;
    let logoColors: [number, number, number][] = [[18, 155, 108], [255, 195, 29]];
    let logoSeed = 0x21ce683;
    const logoRandom = () => { logoSeed = (Math.imul(logoSeed, 1664525) + 1013904223) >>> 0; return logoSeed / 4294967296; };
    let color = [...COLORS[inputRef.current.theme][inputRef.current.mode]] as [number, number, number];
    const staticKey = () => `${inputRef.current.mode}:${inputRef.current.theme}:${inputRef.current.variant}:${width}:${height}:${dpr}`;

    const draw = (time: number) => {
      frame = null;
      if (disposed || document.hidden || width <= 0 || height <= 0) return;
      if (!reducedMotion && frameDeadline && time + 0.8 < frameDeadline) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      if (!frameDeadline) frameDeadline = time;
      // Advance the planned deadline, retaining cadence after a late rAF instead
      // of restarting the timer and losing another whole display frame.
      frameDeadline += Math.max(1, Math.floor((time + 0.8 - frameDeadline) / FRAME_INTERVAL_MS) + 1) * FRAME_INTERVAL_MS;
      const elapsed = lastTime ? Math.max(0.001, Math.min((time - lastTime) / 1000, 0.06)) : 1 / 60;
      lastTime = time;
      const current = inputRef.current;
      // A one-shot status cue begins on the click/requesting phase, before the
      // microphone becomes active. Calibration/listening edges cannot repeat it.
      const startingActivity = current.callActive || (current.mode !== "idle" && current.mode !== "error");
      if (startingActivity && !activityBurstLatched) { startBurstAge = 0; activityBurstLatched = true; }
      if (!current.callActive && (current.mode === "idle" || current.mode === "error")) activityBurstLatched = false;
      if (!reducedMotion) startBurstAge += elapsed;
      const startBurst = reducedMotion || startBurstAge >= 1.25 ? 0 : Math.sin(Math.PI * startBurstAge / 1.25) ** 2;
      replyMorph += ((current.mode === "replying" ? 1 : 0) - replyMorph) * (reducedMotion ? 1 : 1 - Math.exp(-elapsed * 5));
      const pointerSmoothing = 1 - Math.exp(-elapsed * 10);
      pointer.x += (pointer.targetX - pointer.x) * pointerSmoothing;
      pointer.y += (pointer.targetY - pointer.y) * pointerSmoothing;
      pointer.strength = reducedMotion ? 0 : pointer.strength + (pointer.targetStrength - pointer.strength) * pointerSmoothing;
      const logoAllowed = current.mode === "idle" && !current.callActive;
      if (reducedMotion) { logoBlend = 0; logoStartedAt = null; logoReleaseAt = null; idleSeconds = 0; nextLogoAt = 10; }
      else {
        idleSeconds = logoAllowed ? idleSeconds + elapsed : 0;
        if (!logoAllowed) {
          if (logoReleaseAt === null && logoBlend > 0) { logoReleaseAt = galaxyTime; logoReleaseFrom = logoBlend; }
          logoStartedAt = null;
          nextLogoAt = 10;
        }
        if (logoReleaseAt !== null) {
          const releaseAge = galaxyTime - logoReleaseAt;
          logoBlend = logoReleaseFrom * (1 - ease(releaseAge / 0.75));
          if (releaseAge >= 0.75) { logoBlend = 0; logoReleaseAt = null; }
        } else if (logoAllowed && logoStartedAt === null && idleSeconds >= nextLogoAt) {
          const ready = (Object.keys(logoVariants) as LogoVariant[]).filter(key => logoVariants[key]?.length);
          if (ready.length) {
            const selected = logoVariants[ready[Math.floor(logoRandom() * ready.length)]];
            logoTargets = selected ? nearbyLogoTargets(projected, selected, particleCount) : null;
            if (logoTargets) {
              const sums = [[0, 0, 0, 0], [0, 0, 0, 0]];
              for (const point of logoTargets) {
                const sum = sums[point.green > point.red ? 0 : 1];
                sum[0] += point.red; sum[1] += point.green; sum[2] += point.blue; sum[3]++;
              }
              logoColors = sums.map<[number, number, number]>((sum, index) => sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : logoColors[index]);
            }
            logoStartedAt = idleSeconds;
            nextLogoAt = idleSeconds + 18 + logoRandom() * 8;
          }
        }
        if (logoAllowed && logoReleaseAt === null && logoStartedAt !== null) {
          const age = idleSeconds - logoStartedAt;
          logoBlend = age < 2.6 ? ease(age / 2.6) : age < 5.1 ? 1 : 1 - ease((age - 5.1) / 2.8);
          if (age >= 7.9) { logoBlend = 0; logoStartedAt = null; }
        }
      }
      const microphoneActive = current.mode === "listening" || current.mode === "speaking";
      const measuredLevel = microphoneActive ? normalizedLevel(current.level)
        : current.mode === "replying" ? normalizedLevel(current.replyLevel) : 0;
      // Monotonic compression exposes quiet measured sound without a dead zone
      // or minimum fake speech level: exactly zero input still gives zero.
      const responsiveLevel = Math.min(1, Math.sqrt(measuredLevel) * 1.65);
      const smoothing = 1 - Math.exp(-elapsed * 12);
      // Let the previous deformation settle when the measured source changes;
      // never reset the shape abruptly or substitute microphone data for TTS.
      if (reducedMotion) { audioEnvelope = 0; scatter = 0; scatterVelocity = 0; }
      else {
        audioEnvelope += (responsiveLevel - audioEnvelope) * (1 - Math.exp(-elapsed * (responsiveLevel > audioEnvelope ? 25 : 9)));
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
      const cloudMix = Math.min(0.78, (0.5 + Math.sin(motion * 0.47 - 0.8) * 0.5) * 0.62 + replyMorph * 0.20);
      const vortexMix = (0.5 + Math.sin(motion * 0.33 + 1.8) * 0.5) * 0.48 * (1 - replyMorph * 0.35);
      const twist = 4.8 + Math.sin(motion * 0.41) * 1.2;
      const breath = reducedMotion ? 0 : Math.sin(galaxyTime * 0.95);
      const breathX = 1 + breath * 0.026;
      const breathY = 1 + breath * 0.018;
      // The stage uses roughly 80% of its height and its central 45% width.
      // Cap horizontal expansion on ultrawide canvases to retain organic folds.
      const scale = Math.min(height * 0.43, width * 0.70);
      const stage = current.variant === "stage";
      const scaleX = (stage ? Math.min(width * 0.36, height * 0.68) : scale) * breathX * (1 - replyMorph * 0.24);
      const scaleY = (stage ? height * 0.40 : scale) * breathY * (1 - replyMorph * 0.16);
      const centerX = width / 2;
      const centerY = height / 2 + (reducedMotion ? 0 : Math.sin(galaxyTime * 0.48) * height * 0.004);
      const logoScale = stage ? Math.min(width * 0.28, height * 0.35) : Math.min(width, height) * 0.38;
      const logoWave = reducedMotion ? 0 : Math.sin(galaxyTime * 0.72) * logoScale * 0.006;
      const red = Math.round(color[0]), green = Math.round(color[1]), blue = Math.round(color[2]);
      const dark = current.theme === "dark";
      const logoColorBlend = logoAllowed ? logoBlend : 0;
      const palette = [`rgb(${red},${green},${blue})`, ...logoColors.map(channels => `rgb(${Math.round(red + (channels[0] - red) * logoColorBlend)},${Math.round(green + (channels[1] - green) * logoColorBlend)},${Math.round(blue + (channels[2] - blue) * logoColorBlend)})`)];
      const grainScale = Math.min(width, height) / 260;
      const pointerX = pointer.x * width, pointerY = pointer.y * height;
      const pointerRadius = Math.min(150, Math.max(65, Math.min(width, height) * 0.24));
      const pointerRadiusSquared = pointerRadius * pointerRadius;
      for (const batch of drawBatches) batch.length = 0;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      if (stage) {
        context.fillStyle = dark ? "rgb(213,221,229)" : "rgb(87,98,109)";
        const time = reducedMotion ? 0 : galaxyTime;
        for (const batch of starBatches) batch.length = 0;
        for (let index = 0; index < stars.length; index++) {
          const star = stars[index];
          // Pixel-based speeds stay gently visible on mobile as well as desktop.
          const x = wrapUnit(star.x + (time * 2.2 * star.drift + Math.sin(time * 0.12 + star.phase) * 5) / width);
          const y = wrapUnit(star.y + (-time * 0.8 * star.drift + Math.cos(time * 0.10 + star.phase) * 5) / height);
          // Keep the core legible without cutting a visible hole in the field.
          const distance = Math.hypot((x - 0.5) / 0.29, (y - 0.5) / 0.44);
          const centerFade = 0.20 + Math.min(1, distance) * 0.80;
          starProjected[index].x = x * width;
          starProjected[index].y = y * height;
          starBatches[Math.min(7, Math.floor(star.alpha * centerFade * 8))].push(index);
        }
        for (let band = 0; band < starBatches.length; band++) {
          if (!starBatches[band].length) continue;
          context.globalAlpha = (band + 0.5) / 8;
          context.beginPath();
          for (const index of starBatches[band]) {
            const point = starProjected[index], size = stars[index].size;
            context.moveTo(point.x + size, point.y);
            context.arc(point.x, point.y, size, 0, Math.PI * 2);
          }
          context.fill();
        }
      }

      for (let index = 0; index < particleCount; index++) {
        const point = points[index];
        const output = projected[index];
        const logo = logoTargets?.[index];
        const grain = Math.max(0.24, Math.min(0.82, grainScale * (0.28 + point.grain * 0.37)));
        if (logo && logoBlend >= 0.9999) {
          // The held logo still breathes below; skip thousands of unused
          // ribbon/cloud/vortex evaluations while their weight is zero.
          output.x = centerX;
          output.y = centerY;
          output.size = grain;
          output.alpha = 0.90;
        } else {
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
        const cloudX = spine * 0.6 + radius * density * (Math.sin(fold * 0.82 + t * 2.4) * 0.88 + point.sinPhase * 0.18);
        const cloudY = t * 0.92 + Math.sin(fold + point.phase) * radius * 0.14;
        const cloudZ = radius * density * (Math.cos(fold + t * 1.7) * 0.5 + point.sinPhase16 * 0.2);
        const vortexAngle = point.angle * 0.72 + t * twist - motion * 0.42 + point.sheet * 0.28;
        const vortexRadius = radius * (0.70 + point.spread * 0.38);
        const vortexX = spine + Math.sin(vortexAngle) * vortexRadius;
        const vortexY = t + Math.sin(vortexAngle + t * 3) * 0.06;
        const vortexZ = Math.cos(vortexAngle) * vortexRadius * 0.65;
        const mixedX = ribbonX + (cloudX - ribbonX) * cloudMix;
        const mixedY = ribbonY + (cloudY - ribbonY) * cloudMix;
        const mixedZ = ribbonZ + (cloudZ - ribbonZ) * cloudMix;
        const travel = (scatter * (0.16 + point.spread * 0.48) + startBurst * (0.28 + point.spread * 0.34)) * (point.veil ? 1.20 : 1);
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
        output.x = centerX + rotatedX * scaleX * perspective;
        output.y = centerY + rotatedY * scaleY * perspective;
        output.size = grain * perspective;
        // More fine samples and stronger front-facing folds reveal the silver
        // fabric on dark surfaces; particle radii stay tiny, without glow discs.
        const materialAlpha = dark ? 0.22 + front * 0.34 + crease * 0.38 : 0.16 + front * 0.26 + crease * 0.32;
        output.alpha = Math.min(0.94, materialAlpha) * (point.veil ? dark ? 0.46 : 0.35 : 1) * (0.76 + point.grain * 0.24);
        }
        output.colorBand = 0;
        if (logo && logoBlend > 0) {
          output.x += (centerX + logo.x * logoScale * breathX + logoWave * point.sinPhase - output.x) * logoBlend;
          output.y += (centerY + logo.y * logoScale * breathY + logoWave * point.sinPhase16 * 0.65 - output.y) * logoBlend;
          output.size += (grain - output.size) * logoBlend;
          output.alpha += (0.90 - output.alpha) * logoBlend;
          if (logoColorBlend > 0) output.colorBand = logo.green > logo.red ? 1 : 2;
        }
        output.alpha *= 1 - startBurst * 0.24;
        if (pointer.strength > 0.001) {
          const dx = output.x - pointerX, dy = output.y - pointerY;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < pointerRadiusSquared) {
            const distance = Math.sqrt(distanceSquared);
            const directionX = distance > 0.01 ? dx / distance : point.scatterX;
            const directionY = distance > 0.01 ? dy / distance : point.scatterY;
            const influence = (1 - distance / pointerRadius) ** 2 * pointer.strength;
            const push = pointerRadius * 0.30 * influence;
            const flow = pointerRadius * 0.10 * influence;
            output.x += directionX * push - directionY * flow;
            output.y += directionY * push + directionX * flow;
          }
        }
        const alphaBand = Math.min(ALPHA_BANDS - 1, Math.max(0, Math.floor(output.alpha * ALPHA_BANDS)));
        drawBatches[output.colorBand * ALPHA_BANDS + alphaBand].push(index);
      }

      // Tiny translucent grains do not need per-frame depth sorting. Stable
      // indices plus at most 36 paths replace thousands of individual fills.
      for (let batchIndex = 0; batchIndex < drawBatches.length; batchIndex++) {
        const batch = drawBatches[batchIndex];
        if (!batch.length) continue;
        context.fillStyle = palette[Math.floor(batchIndex / ALPHA_BANDS)];
        context.globalAlpha = ((batchIndex % ALPHA_BANDS) + 0.5) / ALPHA_BANDS;
        context.beginPath();
        for (const index of batch) {
          const point = projected[index];
          context.moveTo(point.x + point.size, point.y);
          context.arc(point.x, point.y, point.size, 0, Math.PI * 2);
        }
        context.fill();
      }
      context.globalAlpha = 1;
      lastStaticKey = reducedMotion ? staticKey() : "";
      if (!reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const requestFrame = () => {
      if (reducedMotion && lastStaticKey === staticKey()) return;
      if (!disposed && !document.hidden && frame === null && width > 0 && height > 0) {
        frame = window.requestAnimationFrame(draw);
      }
    };
    requestFrameRef.current = requestFrame;

    for (const variant of ["classic", "gold", "dir"] as const) {
      const image = new Image();
      logoImages.push(image);
      image.onload = () => {
        if (disposed) return;
        try { logoVariants[variant] = sampleLogo(image, variant); }
        catch { /* Keep the organic animation if local image sampling fails. */ }
        requestFrame();
      };
      image.src = variant === "dir" ? "/brand/dir-echoes-mark.png" : `/brand/halyk-mark-${variant}.png`;
    }

    const resize = () => {
      bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      dpr = Math.min(modestDevice ? 1.5 : 2, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      requestFrame();
    };
    const pointerMoved = (event: PointerEvent) => {
      if (reducedMotion || event.pointerType === "touch" || !bounds || !bounds.width || !bounds.height) return;
      const element = event.target instanceof Element ? event.target : null;
      const interactive = element?.closest("button,a,input,textarea,select,label,nav,aside,[role='button'],[role='dialog'],[data-particle-ignore],.context-rail,.chat-panel,.voice-toolbar,.voice-controls");
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      if (interactive || x < 0 || x > 1 || y < 0 || y > 1) { pointer.targetStrength = 0; return; }
      pointer.targetX = x;
      pointer.targetY = y;
      pointer.targetStrength = 1;
      requestFrame();
    };
    const pointerLeft = () => { pointer.targetStrength = 0; };
    const boundsChanged = () => { bounds = canvas.getBoundingClientRect(); pointer.targetStrength = 0; };
    const visibilityChanged = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = 0;
      frameDeadline = 0;
      pointer.targetStrength = 0;
      if (!document.hidden) requestFrame();
    };
    const motionChanged = () => {
      reducedMotion = motionQuery.matches;
      lastStaticKey = "";
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = 0;
      frameDeadline = 0;
      requestFrame();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", pointerMoved, { passive: true });
    window.addEventListener("blur", pointerLeft);
    window.addEventListener("scroll", boundsChanged, { passive: true, capture: true });
    document.addEventListener("pointerleave", pointerLeft);
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
      window.removeEventListener("pointermove", pointerMoved);
      window.removeEventListener("blur", pointerLeft);
      window.removeEventListener("scroll", boundsChanged, true);
      document.removeEventListener("pointerleave", pointerLeft);
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionQuery.removeEventListener("change", motionChanged);
    };
  }, []);

  return <canvas ref={canvasRef} className="voice-particles" aria-hidden="true" style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none" }} />;
}
