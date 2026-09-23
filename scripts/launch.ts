import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { getDataset, importDataset } from "../src/lib/dataset";
import { closeDatabase } from "../src/lib/db";

const root = process.cwd();
const hostname = "127.0.0.1";
let child: ChildProcess | undefined;
let shutdownSignal: "SIGINT" | "SIGTERM" | undefined;
let forcedStop: ReturnType<typeof setTimeout> | undefined;

class LaunchError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

function checkInterrupted() {
  if (shutdownSignal) throw new LaunchError("Запуск остановлен.", shutdownSignal === "SIGINT" ? 130 : 143);
}

function stop(signal: "SIGINT" | "SIGTERM") {
  shutdownSignal ??= signal;
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  current.kill(signal);
  if (!forcedStop) {
    forcedStop = setTimeout(() => {
      if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
    }, 5000);
    forcedStop.unref();
  }
}
const onInterrupt = () => stop("SIGINT");
const onTerminate = () => stop("SIGTERM");

function configuration(): number {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new LaunchError("Нужен Node.js 22 или новее.");
  const required: [string, number][] = [
    ["OPENAI_API_KEY", 1], ["SESSION_SECRET", 32],
    ["PARTICIPANT_ACCESS_CODE", 8], ["SUPERVISOR_ACCESS_CODE", 8],
  ];
  for (const [name, minimum] of required) {
    const value = process.env[name];
    if (!value?.trim() || value.length < minimum) throw new LaunchError(`Заполните ${name} в .env.local (минимум ${minimum} символов).`);
  }
  if (process.env.PARTICIPANT_ACCESS_CODE === process.env.SUPERVISOR_ACCESS_CODE) {
    throw new LaunchError("Коды участника и супервизора должны различаться.");
  }
  const cap = Number(process.env.MAX_AI_SPEND_USD ?? "5");
  if (!Number.isFinite(cap) || cap < 0.05 || cap > 50) throw new LaunchError("MAX_AI_SPEND_USD должен быть от 0.05 до 50.");
  const requestedPort = process.env.PORT?.trim() || "13300";
  const port = Number(requestedPort);
  if (!/^\d+$/.test(requestedPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LaunchError("PORT должен быть целым числом от 1 до 65535.");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl?.trim()) {
    try {
      const parsed = new URL(databaseUrl);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch { throw new LaunchError("DATABASE_URL должен содержать корректный адрес PostgreSQL. Значение скрыто."); }
  } else {
    if (process.env.VERCEL) throw new LaunchError("На Vercel требуется DATABASE_URL; pnpm launch предназначен для локального запуска.");
    delete process.env.DATABASE_URL;
    // Explicitly pass durable local storage to the production Next child as well.
    process.env.LOCAL_DATABASE_PATH = path.resolve(root, process.env.LOCAL_DATABASE_PATH?.trim() || ".data/postgres");
  }
  process.env.PORT = String(port);
  Object.assign(process.env, { NODE_ENV: "production" });
  return port;
}

async function reservePort(port: number): Promise<Server> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new LaunchError(error.code === "EADDRINUSE"
        ? `Порт ${hostname}:${port} занят. Освободите его самостоятельно или задайте другой PORT в .env.local.`
        : `Не удалось открыть ${hostname}:${port}. Проверьте PORT и разрешение на прослушивание порта.`));
    });
    server.listen({ host: hostname, port, exclusive: true }, resolve);
  });
  return server;
}

async function releasePort(server: Server | undefined) {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function prepareDataset() {
  let failure: LaunchError | undefined;
  try {
    const directory = process.env.DATASET_PATH?.trim();
    if (directory) {
      console.log("Проверяем и импортируем официальный набор; существующие записи сохраняются.");
      await importDataset(path.resolve(root, directory));
    }
    const dataset = await getDataset();
    if (dataset.scenarios.length !== 40 || dataset.slots.length !== 43 || dataset.actions.length !== 31) {
      throw new LaunchError("Сохранённый каталог не соответствует кейсу: нужны 40 сценариев, 43 поля и 31 действие.");
    }
    console.log("База доступна. Каталог подтверждён: 40 сценариев, 43 поля, 31 действие.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    failure = error instanceof LaunchError ? error
      : message.includes("DATASET_NOT_IMPORTED") ? new LaunchError("В базе нет каталога. Задайте DATASET_PATH в .env.local и повторите pnpm launch.")
      : /different dataset|Concurrent import/.test(message) ? new LaunchError("В базе уже находится другой набор. Автоматическая замена запрещена; согласуйте миграцию данных.")
      : new LaunchError("Не удалось подготовить базу и каталог. Проверьте DATABASE_URL или доступ к локальной базе и JSON-файлам DATASET_PATH. Подробности подключения скрыты.");
  } finally {
    // PGlite must release its files before next build/start opens the database.
    try { await closeDatabase(); }
    catch { failure ??= new LaunchError("Не удалось закрыть соединение подготовки БД. Сервер не запущен."); }
  }
  if (failure) throw failure;
}

async function runNext(nextCli: string, args: string[], label: string) {
  checkInterrupted();
  await new Promise<void>((resolve, reject) => {
    const current = spawn(process.execPath, [nextCli, ...args], {
      cwd: root, env: { ...process.env }, stdio: "inherit", shell: false, windowsHide: true,
    });
    child = current;
    current.once("error", () => reject(new LaunchError(`Не удалось запустить ${label}. Проверьте установку зависимостей через pnpm install.`)));
    current.once("close", (code, signal) => {
      if (child === current) child = undefined;
      if (forcedStop) { clearTimeout(forcedStop); forcedStop = undefined; }
      if (shutdownSignal) reject(new LaunchError("Запуск остановлен.", shutdownSignal === "SIGINT" ? 130 : 143));
      else if (code === 0) resolve();
      else reject(new LaunchError(`${label} завершился с ошибкой (${signal ? "сигнал " + signal : "код " + (code ?? "неизвестен")}). Проверьте вывод Next.js выше.`, code && code > 0 ? code : 1));
    });
  });
}

async function main() {
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let reserved: Server | undefined;
  try {
    const port = configuration();
    const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
    try { await access(nextCli); }
    catch { throw new LaunchError("Next.js не установлен. Сначала выполните pnpm install в корне проекта."); }
    checkInterrupted();
    // Hold the port through bootstrap/build; release it immediately before start.
    reserved = await reservePort(port);
    checkInterrupted();
    await prepareDataset();
    checkInterrupted();
    console.log("Собираем Next.js…");
    await runNext(nextCli, ["build"], "Сборщик Next.js");
    checkInterrupted();
    await releasePort(reserved); reserved = undefined;
    console.log(`Запускаем http://${hostname}:${port}. Для остановки нажмите Ctrl+C.`);
    await runNext(nextCli, ["start", "--hostname", hostname, "--port", String(port)], "Сервер Next.js");
  } finally {
    await releasePort(reserved);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

main().catch(error => {
  const known = error instanceof LaunchError;
  console.error(known ? error.message : "Запуск не завершён. Проверьте конфигурацию и доступ к локальным файлам; подробности подключения скрыты.");
  process.exitCode = known ? error.exitCode : 1;
});
