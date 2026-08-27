import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { deleteSeoRunsForProject, enqueueScheduledRun } from "./seoRuns";

/**
 * Phase 6 — a MONITORED SITE (seoProject). USER-private (the chat trust model): every
 * read/write is gated on `getAuthUserId === row.userId`, and a non-owner (or missing id)
 * gets the same "Not found" — never an existence oracle. A project owns its schedules,
 * connections, monitoring runs, reports and diffs; deleting it cascades all of them.
 */

const MAX_PROJECTS_PER_USER = 25;
const DEFAULT_RETENTION_DAYS = 90;
const DELETE_BATCH = 100;
const SEO_RUN_PURGE_BATCH = 20; // mirrors seoRuns.SEO_RUN_PURGE_BATCH

async function requireProject(
  ctx: QueryCtx | MutationCtx,
  projectId: string,
): Promise<Doc<"seoProjects">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  const id = ctx.db.normalizeId("seoProjects", projectId);
  const project = id ? await ctx.db.get(id) : null;
  if (!project || project.userId !== userId) throw new ConvexError("Not found");
  return project;
}

export const createProject = mutation({
  args: {
    target: v.string(),
    scope: v.optional(v.string()),
    maxUrls: v.optional(v.number()),
    retentionDays: v.optional(v.number()),
    workspaceId: v.id("workspaces"),
    baselineRunId: v.optional(v.string()), // an owned, completed run to anchor the baseline
  },
  handler: async (ctx, a) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const target = a.target.trim().slice(0, 2048);
    if (!target) throw new ConvexError("A target URL is required.");

    const existing = await ctx.db
      .query("seoProjects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PROJECTS_PER_USER + 1);
    if (existing.length >= MAX_PROJECTS_PER_USER)
      throw new ConvexError("You have reached the maximum number of monitored sites.");

    // If a baseline run is provided, it must be owned, terminal-successful, and reported.
    let baselineRunId: string | undefined;
    let baselineReportId: string | undefined;
    let methodologyVersion: string | undefined;
    let scope = (a.scope ?? "site").trim() || "site";
    let maxUrls = Math.max(1, Math.min(a.maxUrls ?? 500, 5000));
    if (a.baselineRunId) {
      const run = await ctx.db
        .query("seoRuns")
        .withIndex("by_run", (q) => q.eq("runId", a.baselineRunId as string))
        .unique();
      if (run && run.userId === userId && run.reportId) {
        baselineRunId = run.runId;
        baselineReportId = run.reportId;
        scope = run.scope;
        maxUrls = run.maxUrls;
        const rep = await ctx.db
          .query("seoReports")
          .withIndex("by_report_id", (q) => q.eq("reportId", run.reportId as string))
          .first();
        methodologyVersion = rep?.methodologyVersion;
      }
    }

    const now = Date.now();
    const projectId = await ctx.db.insert("seoProjects", {
      userId,
      workspaceId: a.workspaceId,
      target,
      scope,
      maxUrls,
      status: "active",
      baselineRunId,
      baselineReportId,
      methodologyVersion,
      retentionDays: Math.max(7, Math.min(a.retentionDays ?? DEFAULT_RETENTION_DAYS, 365)),
      createdAt: now,
      updatedAt: now,
    });
    return { projectId };
  },
});

function publicProject(p: Doc<"seoProjects">) {
  return {
    projectId: p._id,
    target: p.target,
    scope: p.scope,
    status: p.status,
    hasBaseline: Boolean(p.baselineReportId),
    baselineReportId: p.baselineReportId ?? null,
    retentionDays: p.retentionDays,
    lastRunId: p.lastRunId ?? null,
    lastRunAt: p.lastRunAt ?? null,
    createdAt: p.createdAt,
  };
}

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const projects = await ctx.db
      .query("seoProjects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    const out = [];
    for (const p of projects) {
      const schedule = await ctx.db
        .query("seoSchedules")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .first();
      out.push({
        ...publicProject(p),
        schedule: schedule
          ? {
              scheduleId: schedule._id,
              cadence: schedule.cadence,
              status: schedule.status,
              nextRunAt: schedule.nextRunAt,
              timezone: schedule.timezone,
            }
          : null,
      });
    }
    return out;
  },
});

export const getProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await requireProject(ctx, projectId);
    const schedules = await ctx.db
      .query("seoSchedules")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    const connections = await ctx.db
      .query("seoConnections")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    const recentDiffs = await ctx.db
      .query("seoRunDiffs")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(10);
    return {
      ...publicProject(project),
      schedules: schedules.map((s) => ({
        scheduleId: s._id,
        cadence: s.cadence,
        timezone: s.timezone,
        minuteOfDay: s.minuteOfDay,
        dayOfWeek: s.dayOfWeek ?? null,
        intervalDays: s.intervalDays ?? null,
        status: s.status,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt ?? null,
      })),
      connections: connections.map((c) => ({
        connectionId: c._id,
        provider: c.provider,
        propertyId: c.propertyId,
      })),
      recentDiffs: recentDiffs.map((d) => ({
        runId: d.runId,
        counts: d.counts,
        meaningful: d.meaningful,
        degraded: d.degraded,
        createdAt: d.createdAt,
      })),
    };
  },
});

async function setProjectAndSchedules(
  ctx: MutationCtx,
  project: Doc<"seoProjects">,
  status: "active" | "paused",
) {
  const now = Date.now();
  await ctx.db.patch(project._id, { status, updatedAt: now });
  const schedules = await ctx.db
    .query("seoSchedules")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .collect();
  for (const s of schedules)
    await ctx.db.patch(s._id, { status, updatedAt: now });
}

export const pauseProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await requireProject(ctx, projectId);
    await setProjectAndSchedules(ctx, project, "paused");
    return { ok: true };
  },
});

export const resumeProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await requireProject(ctx, projectId);
    await setProjectAndSchedules(ctx, project, "active");
    return { ok: true };
  },
});

export const setBaseline = mutation({
  args: { projectId: v.string(), runId: v.string() },
  handler: async (ctx, { projectId, runId }) => {
    const project = await requireProject(ctx, projectId);
    const run = await ctx.db
      .query("seoRuns")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    if (!run || run.userId !== project.userId || run.projectId !== project._id || !run.reportId)
      throw new ConvexError("Not found");
    const rep = await ctx.db
      .query("seoReports")
      .withIndex("by_report_id", (q) => q.eq("reportId", run.reportId as string))
      .first();
    await ctx.db.patch(project._id, {
      baselineRunId: run.runId,
      baselineReportId: run.reportId,
      methodologyVersion: rep?.methodologyVersion,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const rerunNow = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await requireProject(ctx, projectId);
    return await enqueueScheduledRun(
      ctx,
      project._id as Id<"seoProjects">,
      "manual",
    );
  },
});

// ── Connections ───────────────────────────────────────────────────────────────

export const addConnection = mutation({
  args: {
    projectId: v.string(),
    provider: v.union(v.literal("gsc"), v.literal("ga4"), v.literal("psi")),
    propertyId: v.string(),
    connectorAccountId: v.optional(v.id("connectorAccounts")),
  },
  handler: async (ctx, a) => {
    const project = await requireProject(ctx, a.projectId);
    // A connectorAccount, if given, must belong to the caller.
    if (a.connectorAccountId) {
      const acct = await ctx.db.get(a.connectorAccountId);
      if (!acct || acct.userId !== project.userId)
        throw new ConvexError("Not found");
    }
    const connectionId = await ctx.db.insert("seoConnections", {
      userId: project.userId,
      projectId: project._id as Id<"seoProjects">,
      provider: a.provider,
      propertyId: a.propertyId.slice(0, 512),
      connectorAccountId: a.connectorAccountId,
      createdAt: Date.now(),
    });
    return { connectionId };
  },
});

export const removeConnection = mutation({
  args: { connectionId: v.id("seoConnections") },
  handler: async (ctx, { connectionId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const conn = await ctx.db.get(connectionId);
    if (!conn || conn.userId !== userId) throw new ConvexError("Not found");
    await ctx.db.delete(connectionId);
    return { ok: true };
  },
});

// ── Delete (cascade) ─────────────────────────────────────────────────────────

/** Delete a project's row + its small child sets (schedules/connections) immediately (so
 *  it vanishes from the UI), then fan out the bounded run purge. */
async function deleteProjectRow(
  ctx: MutationCtx,
  project: Doc<"seoProjects">,
): Promise<void> {
  for (const table of ["seoSchedules", "seoConnections"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(DELETE_BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
  }
  await ctx.db.delete(project._id);
  await ctx.scheduler.runAfter(0, internal.seoProjects.purgeProjectRuns, {
    projectId: project._id as Id<"seoProjects">,
  });
}

export const deleteProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await requireProject(ctx, projectId);
    await deleteProjectRow(ctx, project);
    return { ok: true };
  },
});

/** Cascade the (now-orphaned) runs of a deleted project — runs + steps + artifact blobs +
 *  reports + diffs. Self-scheduling, one bounded batch per tick. The project row is
 *  already gone (deleteProjectRow), so this never touches it. */
export const purgeProjectRuns = internalMutation({
  args: { projectId: v.id("seoProjects") },
  handler: async (ctx, { projectId }) => {
    const n = await deleteSeoRunsForProject(ctx, projectId);
    if (n === SEO_RUN_PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.seoProjects.purgeProjectRuns, {
        projectId,
      });
      return;
    }
    // deleteSeoRunsForProject reclaims each run's diff; sweep any straggler for safety.
    const diffs = await ctx.db
      .query("seoRunDiffs")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(DELETE_BATCH);
    for (const d of diffs) await ctx.db.delete(d._id);
  },
});

/** Delete every project (and cascade) for a user — wired into users.deleteUserAccount. */
export async function deleteProjectsForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const projects = await ctx.db
    .query("seoProjects")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(DELETE_BATCH);
  for (const p of projects) await deleteProjectRow(ctx, p);
}
