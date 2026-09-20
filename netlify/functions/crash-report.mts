import { createHash } from "node:crypto";

import { getDeployStore, getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BACKTRACE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const GITHUB_REPO = "rthinkel/Deck-Tracker";
const CRASH_LABEL = "crash-report";

interface CrashReport {
  schema: 1;
  app_version: string;
  build: string;
  occurred_at: string;
  platform: string;
  signature: string;
  message: string;
  location: string | null;
  backtrace: string;
}

interface RateLimitState {
  window_start: number;
  count: number;
}

interface GitHubIssue {
  number: number;
  state: "open" | "closed";
  title: string;
  pull_request?: unknown;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRfc3339(value: string): boolean {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  return pattern.test(value) && !Number.isNaN(Date.parse(value));
}

function validateCrashReport(value: unknown): CrashReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const report = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schema",
    "app_version",
    "build",
    "occurred_at",
    "platform",
    "signature",
    "message",
    "location",
    "backtrace",
  ]);

  const keys = Object.keys(report);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    return null;
  }

  if (report.schema !== 1) {
    return null;
  }

  if (
    typeof report.app_version !== "string" ||
    report.app_version.length === 0 ||
    typeof report.build !== "string" ||
    report.build.length === 0 ||
    typeof report.platform !== "string" ||
    report.platform.length === 0 ||
    typeof report.occurred_at !== "string" ||
    !isRfc3339(report.occurred_at) ||
    typeof report.signature !== "string" ||
    !/^[0-9a-f]{64}$/.test(report.signature) ||
    typeof report.message !== "string" ||
    report.message.trim().length === 0
  ) {
    return null;
  }

  if (report.location !== null && typeof report.location !== "string") {
    return null;
  }

  if (report.backtrace !== null && typeof report.backtrace !== "string") {
    return null;
  }

  const backtrace = typeof report.backtrace === "string" ? report.backtrace : "";
  if (byteLength(backtrace) > MAX_BACKTRACE_BYTES) {
    return null;
  }

  return {
    schema: 1,
    app_version: report.app_version,
    build: report.build,
    occurred_at: report.occurred_at,
    platform: report.platform,
    signature: report.signature,
    message: report.message,
    location: report.location as string | null,
    backtrace,
  };
}

function getRateLimitStore(context: Context) {
  if (context.deploy?.published && context.deploy.context === "production") {
    return getStore("crash-report-rate-limit", { consistency: "strong" });
  }

  return getDeployStore("crash-report-rate-limit");
}

async function rateLimitAllows(context: Context): Promise<boolean> {
  const ip = context.ip?.trim() || "unknown";
  const key = createHash("sha256").update(ip).digest("hex");
  const store = getRateLimitStore(context);
  const now = Date.now();

  let state = (await store.get(key, { type: "json" })) as RateLimitState | null;
  if (
    !state ||
    typeof state.window_start !== "number" ||
    typeof state.count !== "number" ||
    now - state.window_start >= RATE_LIMIT_WINDOW_MS ||
    now < state.window_start
  ) {
    state = { window_start: now, count: 0 };
  }

  if (state.count >= RATE_LIMIT_MAX) {
    return false;
  }

  state.count += 1;
  await store.setJSON(key, state);
  return true;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "decktracker-crash-reporter",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status})`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function ensureCrashLabel(token: string): Promise<void> {
  const labelPath = `/repos/${GITHUB_REPO}/labels/${encodeURIComponent(CRASH_LABEL)}`;
  const existing = await fetch(`https://api.github.com${labelPath}`, {
    headers: githubHeaders(token),
  });

  if (existing.ok) {
    return;
  }

  if (existing.status !== 404) {
    throw new Error(`GitHub API request failed (${existing.status})`);
  }

  await githubRequest(token, `/repos/${GITHUB_REPO}/labels`, {
    method: "POST",
    body: JSON.stringify({
      name: CRASH_LABEL,
      color: "b60205",
      description: "Automatically filed Deck Tracker crash reports",
    }),
  });
}

function firstMessageLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  return (line || "panic").slice(0, 80);
}

function markdownFence(value: string): string {
  const runs = value.match(/`+/g) || [];
  const fenceLength = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = "`".repeat(fenceLength);
  return `${fence}text\n${value}\n${fence}`;
}

function markdownInline(value: string): string {
  return value.replace(/`/g, "\\`").replace(/\r?\n/g, " ");
}

function occurrenceComment(report: CrashReport): string {
  return [
    "### Additional crash occurrence",
    "",
    `- App version: \`${markdownInline(report.app_version)}\``,
    `- Build: \`${markdownInline(report.build)}\``,
    `- Occurred at: \`${markdownInline(report.occurred_at)}\``,
    `- Platform: \`${markdownInline(report.platform)}\``,
  ].join("\n");
}

function issueBody(report: CrashReport): string {
  return [
    "## Crash report",
    "",
    `- Schema: \`${report.schema}\``,
    `- App version: \`${markdownInline(report.app_version)}\``,
    `- Build: \`${markdownInline(report.build)}\``,
    `- Occurred at: \`${markdownInline(report.occurred_at)}\``,
    `- Platform: \`${markdownInline(report.platform)}\``,
    `- Signature: \`${report.signature}\``,
    `- Location: ${report.location ? `\`${markdownInline(report.location)}\`` : "_(none)_"}`,
    "",
    "## Message",
    "",
    markdownFence(report.message),
    "",
    "## Backtrace",
    "",
    markdownFence(report.backtrace),
  ].join("\n");
}

async function findMatchingIssue(token: string, sig12: string): Promise<GitHubIssue | null> {
  const query = `repo:${GITHUB_REPO} is:issue label:${CRASH_LABEL} \"sig:${sig12}\" in:title`;
  const result = await githubRequest<{ items: GitHubIssue[] }>(
    token,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=10`,
  );

  const matches = result.items.filter(
    (issue) =>
      !issue.pull_request &&
      issue.title.includes(`[sig:${sig12}]`) &&
      (issue.state === "open" || issue.state === "closed"),
  );

  return matches.find((issue) => issue.state === "open") || matches[0] || null;
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return json(400, { ok: false, error: "POST required" });
  }

  const contentType = req.headers.get("content-type") || "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json(400, { ok: false, error: "application/json required" });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: "request too large" });
    }
  }

  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "request too large" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return json(400, { ok: false, error: "malformed JSON" });
  }

  const report = validateCrashReport(parsed);
  if (!report) {
    return json(400, { ok: false, error: "invalid crash report" });
  }

  try {
    if (!(await rateLimitAllows(context))) {
      return json(429, { ok: false, error: "rate limit exceeded" });
    }

    const token = process.env.GITHUB_CRASH_REPORT_TOKEN;
    if (!token) {
      throw new Error("GitHub token is not configured");
    }

    const sig12 = report.signature.slice(0, 12);
    const existing = await findMatchingIssue(token, sig12);
    const comment = occurrenceComment(report);

    if (existing) {
      let action: "commented" | "reopened" = "commented";

      if (existing.state === "closed") {
        await githubRequest(token, `/repos/${GITHUB_REPO}/issues/${existing.number}`, {
          method: "PATCH",
          body: JSON.stringify({ state: "open" }),
        });
        action = "reopened";
      }

      await githubRequest(token, `/repos/${GITHUB_REPO}/issues/${existing.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      });

      return json(200, {
        ok: true,
        action,
        issue_number: existing.number,
      });
    }

    await ensureCrashLabel(token);

    const created = await githubRequest<{ number: number }>(token, `/repos/${GITHUB_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `Crash: ${firstMessageLine(report.message)} [sig:${sig12}]`,
        body: issueBody(report),
        labels: [CRASH_LABEL],
      }),
    });

    return json(200, {
      ok: true,
      action: "created",
      issue_number: created.number,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Crash report processing failed: ${message}`);
    return json(502, { ok: false, error: "crash report processing failed" });
  }
};

export const config: Config = {
  path: "/api/crash-report",
};
