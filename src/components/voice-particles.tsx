"use client";

import { useEffect, useRef } from "react";

export type VoiceParticleMode = "idle" | "listening" | "speaking" | "processing" | "replying" | "error";

type VoiceParticlesProps = { mode: VoiceParticleMode; level: number; replyLevel?: number; callActive?: boolean; theme?: "light" | "dark"; variant?: "compact" | "stage" };
type Point = { unitX: number; unitY: number; unitZ: number; radius: number; spread: number; grain: number; phase: number; sinPhase: number; sinPhase16: number; veil: boolean; scatterX: number; scatterY: number; scatterZ: number };
type ProjectedPoint = { x: number; y: number; size: number; alpha: number; colorBand: number };
type LogoPoint = { x: number; y: number; red: number; green: number; blue: number };
type LogoVariant = "classic" | "gold" | "dir";

const PARTICLE_COUNT = 3400;
const FRAME_INTERVAL_MS = 1000 / 60;
const ALPHA_BANDS = 12;
const COLORS: Record<"light" | "dark", Record<VoiceParticleMode, readonly [number, number, number]>> = {
  light: {
    idle: [28, 36, 42], listening: [14, 105, 55], speaking: [10, 112, 55],
    processing: [143, 91, 25], replying: [157, 62, 20], error: [176, 47, 58],
  },
  dark: {
    idle: [237, 241, 244], listening: [128, 237, 164], speaking: [144, 247, 176],
    processing: [239, 193, 115], replying: [255, 174, 100], error: [242, 140, 150],
  },
};

function flowPoints(): Point[] {
  // Uniform directions keep a round silhouette without visible latitude rows.
  // Most particles define the shell; a smaller interior population adds depth.
  // Every sample keeps its identity through sound, cursor and logo transitions.
  let seed = 0x16e09b7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const group = random();
    const unitY = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - unitY * unitY);
    const unitX = Math.cos(angle) * ring, unitZ = Math.sin(angle) * ring;
    const veil = group >= 0.93;
    const radius = veil ? 1.02 + random() * 0.06 : group < 0.78 ? 0.88 + random() * 0.12 : Math.cbrt(random()) * 0.86;
    const phase = random() * Math.PI * 2;
    return {
      unitX, unitY, unitZ, radius,
      spread: random(), grain: random(), phase, sinPhase: Math.sin(phase), sinPhase16: Math.sin(phase * 1.6), veil,
      scatterX: unitX, scatterY: unitY, scatterZ: unitZ,
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
    // Select once per mount, so resize/audio never makes particle counts flicker.
    const modestDevice = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 720 || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4);
    const particleCount = modestDevice ? 1800 : window.innerWidth < 1100 ? 2600 : PARTICLE_COUNT;
    const projected: ProjectedPoint[] = points.slice(0, particleCount).map(() => ({ x: 0, y: 0, size: 0, alpha: 0, colorBand: 0 }));
    const drawBatches: number[][] = Array.from({ length: ALPHA_BANDS * 3 }, () => []);
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
    let activeMorph = 0;
    let startBurstAge = 10;
    let activityBurstLatched = inputRef.current.callActive || inputRef.current.mode !== "idle";
    const pointer = { clientX: 0, clientY: 0, targetStrength: 0, strength: 0 };
    let idleSeconds = 0;
    let nextLogoAt = 10;
    let logoStartedAt: number | null = null;
    let logoTargets: LogoPoint[] | null = null;
    let activeLogoVariant: LogoVariant | null = null;
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
      const audibleState = current.mode === "listening" || current.mode === "speaking" || current.mode === "replying";
      activeMorph += ((audibleState ? 1 : 0) - activeMorph) * (reducedMotion ? 1 : 1 - Math.exp(-elapsed * 5));
      const pointerSmoothing = 1 - Math.exp(-elapsed * 10);
      // Size observers do not fire when layout merely translates a same-size
      // canvas. Map the real cursor through its current viewport rectangle;
      // smooth force strength only, never drag the hit centre behind the cursor.
      if (pointer.targetStrength > 0 || pointer.strength > 0.001) {
        bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height || pointer.clientX < bounds.left || pointer.clientX > bounds.right || pointer.clientY < bounds.top || pointer.clientY > bounds.bottom) pointer.targetStrength = 0;
      }
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
            const selectedVariant = ready[Math.floor(logoRandom() * ready.length)];
            const selected = logoVariants[selectedVariant];
            logoTargets = selected ? nearbyLogoTargets(projected, selected, particleCount) : null;
            activeLogoVariant = logoTargets ? selectedVariant : null;
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
          logoBlend = age < 4 ? ease(age / 4) : age < 6.5 ? 1 : 1 - ease((age - 6.5) / 4);
          if (age >= 10.5) { logoBlend = 0; logoStartedAt = null; }
        }
      }
      const microphoneActive = current.mode === "listening" || current.mode === "speaking";
      const measuredLevel = microphoneActive ? normalizedLevel(current.level)
        : current.mode === "replying" ? normalizedLevel(current.replyLevel) : 0;
      // Monotonic compression exposes quiet measured sound without a dead zone
      // or minimum fake speech level: exactly zero input still gives zero.
      const responsiveLevel = Math.min(1, Math.sqrt(measuredLevel) * 1.80);
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

      // Slow rotation and breathing are decorative; amplitude comes only from the
      // selected measured audio source above, including real AI output audio.
      const speed = current.mode === "processing" ? 0.46 : current.mode === "replying" ? 0.33 : 0.23;
      if (!reducedMotion) {
        phase += elapsed * speed;
        // Breathing/logo time stays independent of mode and measured loudness.
        galaxyTime += elapsed;
      }
      const motion = reducedMotion ? 0 : phase;
      const angle = 0.32 + motion * 0.22;
      const tilt = -0.08 + Math.sin(motion * 0.31) * 0.06;
      const cosY = Math.cos(angle), sinY = Math.sin(angle);
      const cosX = Math.cos(tilt), sinX = Math.sin(tilt);
      const breath = reducedMotion ? 0 : Math.sin(galaxyTime * 0.95);
      const breathX = 1 + breath * 0.026;
      const breathY = 1 + breath * 0.018;
      const stage = current.variant === "stage";
      // Equal base axes retain a sphere at every viewport aspect ratio. Leave
      // space around the core for measured reply audio to release outer grains.
      const sphereScale = Math.min(width * (stage ? 0.34 : 0.36), height * 0.31);
      const pulse = 1 + activeMorph * 0.045 + audioEnvelope * 0.045;
      const scaleX = sphereScale * breathX * pulse;
      const scaleY = sphereScale * breathY * pulse;
      const centerX = width / 2;
      const centerY = height / 2 + (reducedMotion ? 0 : Math.sin(galaxyTime * 0.48) * height * 0.004);
      const logoScale = stage ? Math.min(width * 0.28, height * 0.35) : Math.min(width, height) * 0.38;
      const logoWave = reducedMotion ? 0 : Math.sin(galaxyTime * 0.72) * logoScale * 0.006;
      const red = Math.round(color[0]), green = Math.round(color[1]), blue = Math.round(color[2]);
      const dark = current.theme === "dark";
      const logoColorBlend = logoAllowed ? logoBlend : 0;
      const palette = [`rgb(${red},${green},${blue})`, ...logoColors.map(source => {
        // Contrast is a rendering choice; source mark assets remain untouched.
        const channels = dark ? source : activeLogoVariant === "dir" ? COLORS.light.idle : source.map(channel => channel * 0.72);
        return `rgb(${Math.round(red + (channels[0] - red) * logoColorBlend)},${Math.round(green + (channels[1] - green) * logoColorBlend)},${Math.round(blue + (channels[2] - blue) * logoColorBlend)})`;
      })];
      const grainScale = Math.min(width, height) / 260;
      // Projection and logo morph finish in drawing units. Hit testing below is
      // in viewport CSS pixels, including CSS scale; DPR affects rasterization only.
      const screenScaleX = bounds?.width ? bounds.width / width : 1;
      const screenScaleY = bounds?.height ? bounds.height / height : 1;
      const pointerX = (pointer.clientX - (bounds?.left ?? 0)) / screenScaleX;
      const pointerY = (pointer.clientY - (bounds?.top ?? 0)) / screenScaleY;
      const pointerRadius = Math.min(150, Math.max(65, Math.min(bounds?.width ?? width, bounds?.height ?? height) * 0.24));
      const pointerRadiusSquared = pointerRadius * pointerRadius;
      for (const batch of drawBatches) batch.length = 0;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      for (let index = 0; index < particleCount; index++) {
        const point = points[index];
        const output = projected[index];
        const logo = logoTargets?.[index];
        const grain = Math.max(0.24, Math.min(0.82, grainScale * (0.28 + point.grain * 0.37))) * (1 + activeMorph * 0.20 + audioEnvelope * 0.12) * (dark ? 1 : 1.22);
        if (logo && logoBlend >= 0.9999) {
          // The held logo still breathes below; skip thousands of unused
          // sphere evaluations while their weight is zero.
          output.x = centerX;
          output.y = centerY;
          output.size = grain;
          output.alpha = 0.90;
        } else {
        // The shell stays round; small travelling ripples provide organic life
        // without collapsing either axis into the old folded ribbon silhouette.
        const ripple = Math.sin(point.unitY * 5 + motion * 0.7 + point.phase * 0.25) * 0.015;
        const radius = point.radius * (1 + ripple * (1 - activeMorph * 0.45));
        const flight = Math.max(0, (point.spread - 0.62) / 0.38);
        // The majority forms a stable core. Only a fixed minority travels far
        // on actual reply RMS, then the existing damped spring gathers it back.
        // Microphone energy gently pulses a cohesive green listening sphere.
        const travel = scatter * (0.025 + replyMorph * flight * 0.32)
          + replyMorph * flight * 0.04 + startBurst * (0.025 + flight * 0.055);
        const x = point.unitX * radius + point.scatterX * travel;
        const y = point.unitY * radius + point.scatterY * travel;
        const z = point.unitZ * radius + point.scatterZ * travel;
        const rotatedX = x * cosY + z * sinY;
        const rotatedZ = z * cosY - x * sinY;
        const rotatedY = y * cosX - rotatedZ * sinX;
        const depth = y * sinX + rotatedZ * cosX;
        const perspective = 6 / (6 - depth);
        const front = Math.max(0, Math.min(1, (depth + 1.15) / 2.3));
        output.x = centerX + rotatedX * scaleX * perspective;
        output.y = centerY + rotatedY * scaleY * perspective;
        output.size = grain * perspective;
        // Front/back opacity and perspective show real volume without a glow
        // layer. Darker, slightly larger grains keep the light theme legible.
        const materialAlpha = dark ? 0.24 + front * 0.61 : 0.69 + front * 0.25;
        const interiorAlpha = point.radius < 0.86 ? 0.68 : 1;
        output.alpha = Math.min(0.95, materialAlpha) * interiorAlpha * (point.veil ? dark ? 0.55 : 0.65 : 1) * (dark ? 0.80 + point.grain * 0.20 : 0.91 + point.grain * 0.09);
        }
        output.colorBand = 0;
        if (logo && logoBlend > 0) {
          output.x += (centerX + logo.x * logoScale * breathX + logoWave * point.sinPhase - output.x) * logoBlend;
          output.y += (centerY + logo.y * logoScale * breathY + logoWave * point.sinPhase16 * 0.65 - output.y) * logoBlend;
          const arc = Math.sin(Math.PI * logoBlend) * logoScale * 0.025;
          output.x += point.scatterY * arc;
          output.y -= point.scatterX * arc;
          output.size += (grain - output.size) * logoBlend;
          output.alpha += (0.90 - output.alpha) * logoBlend;
          if (logoColorBlend > 0) output.colorBand = logo.green > logo.red ? 1 : 2;
        }
        output.alpha *= 1 - startBurst * 0.24;
        if (pointer.strength > 0.001) {
          const dx = (output.x - pointerX) * screenScaleX, dy = (output.y - pointerY) * screenScaleY;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < pointerRadiusSquared) {
            const distance = Math.sqrt(distanceSquared);
            const directionX = distance > 0.01 ? dx / distance : point.scatterX;
            const directionY = distance > 0.01 ? dy / distance : point.scatterY;
            const influence = (1 - distance / pointerRadius) ** 2 * pointer.strength;
            const push = pointerRadius * 0.30 * influence;
            const flow = pointerRadius * 0.10 * influence;
            output.x += (directionX * push - directionY * flow) / screenScaleX;
            output.y += (directionY * push + directionX * flow) / screenScaleY;
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
      if (reducedMotion || event.pointerType === "touch") return;
      pointer.clientX = event.clientX;
      pointer.clientY = event.clientY;
      bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { pointer.targetStrength = 0; return; }
      const element = event.target instanceof Element ? event.target : null;
      const interactive = element?.closest("button,a,input,textarea,select,label,nav,aside,[role='button'],[role='dialog'],[data-particle-ignore],.context-rail,.chat-panel,.voice-toolbar,.voice-controls");
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      if (interactive || x < 0 || x > 1 || y < 0 || y > 1) { pointer.targetStrength = 0; return; }
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
