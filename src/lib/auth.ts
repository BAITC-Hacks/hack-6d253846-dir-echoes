import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { Role } from "./types";
import { AiServiceError } from "./ai";
export type Viewer = { id: string; role: Role; exp: number };
const cookieName = "echoes_session";
function secret() { const value = process.env.SESSION_SECRET; if (!value || value.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters."); return value; }
function signature(payload: string) { return createHmac("sha256", secret()).update(payload).digest("base64url"); }
export function safeEqual(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function encode(value: Viewer) { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); return payload + "." + signature(payload); }
function decode(value: string): Viewer | null {
  try { const [payload, sig, extra] = value.split("."); if (!payload || !sig || extra || !safeEqual(signature(payload),sig)) return null;
    const decoded = JSON.parse(Buffer.from(payload,"base64url").toString()) as Viewer;
    return ["participant","supervisor"].includes(decoded.role) && typeof decoded.id === "string" && decoded.exp > Date.now() ? decoded : null;
  } catch { return null; }
}
export async function viewer(): Promise<Viewer | null> { return decode((await cookies()).get(cookieName)?.value || ""); }
export async function requireViewer(role?: Role): Promise<Viewer> { const result = await viewer(); if (!result) throw new ApiError(401,"Войдите, чтобы открыть рабочее пространство."); if (role && result.role !== role) throw new ApiError(403,"Доступно только супервизору."); return result; }
export async function signIn(code: string, role: Role) {
  const expected = role === "supervisor" ? process.env.SUPERVISOR_ACCESS_CODE : process.env.PARTICIPANT_ACCESS_CODE;
  if (!expected || expected.length < 8 || !safeEqual(code, expected)) throw new ApiError(401,"Неверный код доступа.");
  const jar = await cookies(); const existing = decode(jar.get("echoes_browser")?.value || "");
  const value: Viewer = { id: existing?.id || randomUUID(), role, exp: Date.now()+12*60*60*1000 };
  const options = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/" };
  jar.set(cookieName,encode(value),{...options,maxAge:12*60*60});
  jar.set("echoes_browser",encode({...value,exp:Date.now()+30*24*60*60*1000}),{...options,maxAge:30*24*60*60});
  return value;
}
export async function signOut() { (await cookies()).delete(cookieName); }
export function checkOrigin(request: Request) {
  const origin=request.headers.get("origin");
  // Next may reconstruct request.url with its internal listener hostname.
  // Host is the public authority addressed by the browser, including its port.
  const host=request.headers.get("host") || new URL(request.url).host;
  let valid=false;
  try { const source=new URL(origin || ""); valid=["http:","https:"].includes(source.protocol) && source.host===host; } catch { /* Reject missing or malformed Origin. */ }
  if (!valid) throw new ApiError(403,"Запрос должен исходить из этого приложения.");
}
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export function errorResponse(error: unknown) {
  if (error instanceof ApiError) return Response.json({error:error.message},{status:error.status});
  if (error instanceof AiServiceError) return Response.json({error:error.message},{status:error.status});
  const message = error instanceof Error ? error.message : "";
  if (message.includes("DATASET_NOT_IMPORTED")) return Response.json({error:"Данные ещё не импортированы. Выполните настройку по README."},{status:503});
  if (message.includes("DATABASE_NOT_CONFIGURED")) return Response.json({error:"Постоянная база данных ещё не настроена."},{status:503});
  console.error("API failure", error instanceof Error ? error.name : "UnknownError");
  return Response.json({error:"Не удалось завершить запрос. Попробуйте ещё раз; если ошибка повторяется, обратитесь к супервизору."},{status:500});
}
