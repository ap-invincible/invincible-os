import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { appendAudit } from "./lib/audit";
import { requireProfile } from "./lib/auth";
import { DEFAULT_REPOS } from "./lib/values";

export const submit = mutation({
  args: { newHireEmail: v.string(), githubUsername: v.string() },
  handler: async (ctx, args) => {
    const user = await requireProfile(ctx);
    const requestId = await ctx.db.insert("requests", { type: "hire_provisioning", requesterEmail: user.email, status: "processing", createdAt: Date.now() });
    await appendAudit(ctx, requestId, "submitted", `human:${user.email}`, "New-hire access request received.");
    await ctx.scheduler.runAfter(0, internal.workflows.processHire, { requestId, ...args });
    return requestId;
  },
});

export const saveProposal = internalMutation({
  args: { requestId: v.id("requests"), newHireEmail: v.string(), githubUsername: v.string(), proposedRepos: v.array(v.string()), reasoning: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("hire_provisioning_requests", { ...args, approverEdits: null, githubGrantStatus: "pending" });
    await ctx.db.patch(args.requestId, { status: "pending_approval" });
    await appendAudit(ctx, args.requestId, "decide_access", "hire_agent", args.reasoning);
    await appendAudit(ctx, args.requestId, "human_pause", "hire_agent", "GitHub access requires an approver decision.");
  },
});

export const approvedGrant = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const [approval, hire] = await Promise.all([
      ctx.db.query("approvals").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").first(),
      ctx.db.query("hire_provisioning_requests").withIndex("by_request", (q) => q.eq("requestId", requestId)).unique(),
    ]);
    if (!hire || !approval || !["approved", "edited_and_approved"].includes(approval.decision)) return null;
    return { githubUsername: hire.githubUsername, repos: hire.approverEdits ? JSON.parse(hire.approverEdits) as string[] : hire.proposedRepos };
  },
});

export const markGrant = internalMutation({
  args: { requestId: v.id("requests"), status: v.union(v.literal("granted"), v.literal("failed")), detail: v.string() },
  handler: async (ctx, args) => {
    const hire = await ctx.db.query("hire_provisioning_requests").withIndex("by_request", (q) => q.eq("requestId", args.requestId)).unique();
    if (!hire) throw new Error("Hire request missing");
    await ctx.db.patch(hire._id, { githubGrantStatus: args.status });
    await appendAudit(ctx, args.requestId, "execute", "hire_agent", args.detail);
  },
});

export const defaultRepos = query({ args: {}, handler: () => DEFAULT_REPOS });
