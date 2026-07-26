import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = resolve(frontendDir, "..");
const python = join(repositoryDir, ".venv", "bin", "python");
const manage = join(repositoryDir, "backend", "manage.py");
const databaseUrl = process.env.VC_DATABASE_URL ?? "";
const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT ?? "8000";

if (!existsSync(python)) {
  throw new Error(`Django virtual environment not found at ${python}`);
}
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  throw new Error("Real-backend E2E requires VC_DATABASE_URL for a dedicated PostgreSQL database");
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.split("/").filter(Boolean).at(-1) ?? "");
if (
  process.env.VC_E2E_ALLOW_SEED !== "1"
  || !/(?:^|[_-])(?:e2e|test)(?:$|[_-])/i.test(databaseName)
) {
  throw new Error(
    "Refusing to seed PostgreSQL: set VC_E2E_ALLOW_SEED=1 and use a database name containing an e2e/test segment",
  );
}

const environment = {
  ...process.env,
  DJANGO_SETTINGS_MODULE: "vessel_caller.settings.development",
  VC_DATABASE_URL: databaseUrl,
  VC_SECRET_KEY: "e2e-only-secret-not-production",
  VC_SESSION_COOKIE_SECURE: "false",
  VC_CELERY_EAGER: "true",
  VC_EMAIL_DELIVERY_BACKEND: "memory",
  VC_E2E_PASSWORD: process.env.VC_E2E_PASSWORD ?? process.env.E2E_PASSWORD,
  VC_ALLOWED_HOSTS: "127.0.0.1,localhost",
  VC_CSRF_TRUSTED_ORIGINS: "http://127.0.0.1:5173,http://localhost:5173",
};

const run = (...args) => {
  const result = spawnSync(python, [manage, ...args], {
    cwd: repositoryDir,
    env: environment,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("migrate", "--noinput");
run("seed_e2e");

const server = spawn(
  python,
  [manage, "runserver", `127.0.0.1:${backendPort}`, "--noreload"],
  {
    cwd: repositoryDir,
    env: environment,
    stdio: "inherit",
  },
);

const stop = (signal) => {
  server.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("exit", (code) => process.exit(code ?? 0));
