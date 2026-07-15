import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { appendAudit } from "./lib/audit";
import { requireRole } from "./lib/auth";

export const decide = mutation({
  args: { requestId: v.id("requests"), decision: v.union(v.literal("approved"), v.literal("rejected"), v.literal("edited_and_approved")), editsMade: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, ["approver", "admin"]);
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "pending_approval") throw new Error("Request is not awaiting approval");
    if (request.type === "hire_provisioning" && args.decision === "edited_and_approved") {
      try {
        const repos = JSON.parse(args.editsMade ?? "");
        if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== "string" || !repo.trim())) throw new Error();
      } catch { throw new Error("Edited repositories must be a JSON array of non-empty strings"); }
    }
    await ctx.db.insert("approvals", { requestId: args.requestId, approverEmail: user.email, decision: args.decision, editsMade: args.editsMade?.trim() || null, decidedAt: Date.now() });
    const approved = args.decision !== "rejected";
    await ctx.db.patch(args.requestId, { status: approved ? "approved" : "rejected" });
    await appendAudit(ctx, args.requestId, "human_verdict", `human:${user.email}`, `Request ${approved ? "approved" : "rejected"}.`);
    if (approved && request.type === "hire_provisioning") await ctx.scheduler.runAfter(0, internal.workflows.executeHire, { requestId: args.requestId });
    if (approved && request.type === "vendor_procurement") await ctx.scheduler.runAfter(0, internal.integrations.notion.syncRequest, { requestId: args.requestId });
  },
});
