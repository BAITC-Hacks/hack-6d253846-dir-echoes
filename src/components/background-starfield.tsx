"use client";

import { useEffect, useRef } from "react";

type Star = { x: number; y: number; speed: number; phase: number; radius: number; alpha: number };
const FRAME_MS = 1000 / 30;
const wrap = (value: number) => ((value % 1) + 1) % 1;

/** Viewport decoration only: no audio, pointer or conversation state input. */
export function BackgroundStarfield({ theme = "dark" }: { theme?: "light" | "dark" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef(theme);
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => { themeRef.current = theme; repaintRef.current?.(); }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;
    const mobile = window.innerWidth < 720 || window.matchMedia("(pointer: coarse)").matches;
    let seed = 0x7105aaf;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const stars: Star[] = Array.from({ length: mobile ? 110 : 180 }, (_, index) => ({
      x: random(), y: random(), speed: 0.60 + random() * 0.65, phase: random() * Math.PI * 2,
      radius: index % 61 === 0 ? 1.45 : 0.60 + random() * 0.65,
      alpha: index % 61 === 0 ? 0.82 : 0.25 + random() * 0.36,
    }));
    const projected = stars.map(() => ({ x: 0, y: 0 }));
    const batches: number[][] = Array.from({ length: 8 }, () => []);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = preference.matches;
    let width = 0, height = 0, dpr = 1;
    let frame: number | null = null;
    let last = 0, deadline = 0, elapsedTime = 0;
    let disposed = false;

    const draw = (time: number) => {
      frame = null;
      if (disposed || document.hidden || !width || !height) return;
      if (!reduced && deadline && time + 0.8 < deadline) { frame = requestAnimationFrame(draw); return; }
      if (!deadline) deadline = time;
      deadline += Math.max(1, Math.floor((time + 0.8 - deadline) / FRAME_MS) + 1) * FRAME_MS;
      if (!reduced) elapsedTime += last ? Math.max(0, Math.min((time - last) / 1000, 0.1)) : 1 / 30;
      last = time;
      const driftTime = reduced ? 0 : elapsedTime;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = themeRef.current === "dark" ? "rgb(220,227,234)" : "rgb(82,96,110)";
      for (const batch of batches) batch.length = 0;
      for (let index = 0; index < stars.length; index++) {
        const star = stars[index];
        projected[index].x = wrap(star.x + (driftTime * 2.1 * star.speed + Math.sin(driftTime * 0.12 + star.phase) * 7) / width) * width;
        projected[index].y = wrap(star.y + (-driftTime * 0.85 * star.speed + Math.cos(driftTime * 0.10 + star.phase) * 7) / height) * height;
        batches[Math.min(7, Math.floor(star.alpha * 8))].push(index);
      }
      for (let band = 0; band < batches.length; band++) {
        if (!batches[band].length) continue;
        context.globalAlpha = (band + 0.5) / 8 * (themeRef.current === "light" ? 0.78 : 1);
        context.beginPath();
        for (const index of batches[band]) {
          const point = projected[index], radius = stars[index].radius;
          context.moveTo(point.x + radius, point.y);
          context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        }
        context.fill();
      }
      context.globalAlpha = 1;
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    const repaint = () => {
      if (!disposed && !document.hidden && frame === null && width > 0 && height > 0) frame = requestAnimationFrame(draw);
    };
    repaintRef.current = repaint;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width; height = bounds.height;
      dpr = Math.min(mobile ? 1.25 : 1.5, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      repaint();
    };
    const visibility = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; last = 0; deadline = 0;
      repaint();
    };
    const motion = () => { reduced = preference.matches; visibility(); };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    preference.addEventListener("change", motion);
    resize();

    return () => {
      disposed = true; repaintRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      preference.removeEventListener("change", motion);
    };
  }, []);

  return <canvas ref={canvasRef} className="background-starfield" aria-hidden="true" style={{ position: "fixed", inset: 0, display: "block", width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }} />;
}
