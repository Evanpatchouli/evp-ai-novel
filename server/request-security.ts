import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Middleware } from "koa";
import { AppError } from "./errors.js";

export const WORKBENCH_SESSION_HEADER = "X-Workbench-Session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEVELOPMENT_PORT = 6173;

export interface SessionTokenManager {
  current(): string;
  matches(candidate: string): boolean;
  rotate(): string;
}

export interface RequestSecurityOptions {
  /** 默认复用进程级 token；测试可注入隔离的 manager。 */
  sessionTokens?: SessionTokenManager;
  mode?: "development" | "production";
  developmentPort?: number;
  /** 生产环境默认从当前请求推导同源地址；测试可固定预期 origin。 */
  productionOrigin?: string;
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/** 创建可注入固定初值的 token manager；轮换后旧 token 立即失效。 */
export function createSessionTokenManager(
  initialToken = generateSessionToken(),
): SessionTokenManager {
  if (!initialToken) throw new Error("工作台 session token 不能为空");
  let token = initialToken;
  return {
    current: () => token,
    matches: (candidate) => sameSecret(token, candidate),
    rotate: () => {
      token = generateSessionToken();
      return token;
    },
  };
}

const processSessionTokens = createSessionTokenManager();

/** 返回当前进程级 session token，供启动页或受控端点注入前端。 */
export function getWorkbenchSessionToken(): string {
  return processSessionTokens.current();
}

/** 轮换进程级 session token，并返回新值。 */
export function rotateWorkbenchSessionToken(): string {
  return processSessionTokens.rotate();
}

function parseAuthority(authority: string): URL | undefined {
  if (!authority || /[\s,/@]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`http://${authority}`);
    return parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Host 只允许 localhost、127.0.0.0/8 与 IPv6 loopback。 */
export function isLoopbackHost(hostHeader: string): boolean {
  const parsed = parseAuthority(hostHeader);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function parseOrigin(origin: string): URL | undefined {
  try {
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function normalizedOrigin(origin: string): string | undefined {
  return parseOrigin(origin)?.origin;
}

/**
 * 生产只接受请求同源；开发额外接受来自 loopback:6173（可配置端口）的
 * Vite 页面。直接访问 Koa 地址时，同源请求在两种模式下都有效。
 */
export function isAllowedWorkbenchOrigin(
  origin: string,
  requestOrigin: string,
  options: Pick<
    RequestSecurityOptions,
    "mode" | "developmentPort" | "productionOrigin"
  > = {},
): boolean {
  const candidate = parseOrigin(origin);
  if (!candidate) return false;
  const expected = normalizedOrigin(options.productionOrigin ?? requestOrigin);
  if (expected && candidate.origin === expected) return true;
  const mode =
    options.mode ??
    (process.env.NODE_ENV === "production" ? "production" : "development");
  if (mode !== "development" || candidate.protocol !== "http:") return false;
  const port = options.developmentPort ?? DEFAULT_DEVELOPMENT_PORT;
  return candidate.port === String(port) && isLoopbackHost(candidate.host);
}

/**
 * 加固本地 Koa 服务：所有请求校验 loopback Host；写请求再校验 Origin 与
 * session header。应放在统一错误处理中间件之后、body parser 之前。
 */
export function createRequestSecurityMiddleware(
  options: RequestSecurityOptions = {},
): Middleware {
  const sessionTokens = options.sessionTokens ?? processSessionTokens;
  return async (ctx, next) => {
    if (!isLoopbackHost(ctx.host)) {
      throw new AppError("HOST_NOT_ALLOWED", "请求 Host 不是本机回环地址", 403);
    }
    if (!SAFE_METHODS.has(ctx.method.toUpperCase())) {
      const origin = ctx.get("Origin");
      if (!origin || !isAllowedWorkbenchOrigin(origin, ctx.origin, options)) {
        throw new AppError(
          "ORIGIN_NOT_ALLOWED",
          "写请求必须来自受信任的工作台页面",
          403,
        );
      }
      const presentedToken = ctx.get(WORKBENCH_SESSION_HEADER);
      if (!presentedToken || !sessionTokens.matches(presentedToken)) {
        throw new AppError(
          "INVALID_SESSION_TOKEN",
          "工作台 session token 无效或已轮换",
          403,
        );
      }
    }
    await next();
  };
}
