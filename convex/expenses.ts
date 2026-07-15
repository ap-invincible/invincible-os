import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { appendAudit } from "./lib/audit";
import { requireProfile, requireRole } from "./lib/auth";

export const submit = mutation({
  args: { fileId: v.id("_storage") },
  handler: async (ctx, { fileId }) => {
    const user = await requireProfile(ctx);
    const requestId = await ctx.db.insert("requests", { type: "expense_batch", requesterEmail: user.email, status: "processing", createdAt: Date.now() });
    await appendAudit(ctx, requestId, "submitted", `human:${user.email}`, "Expense file received. Preparing deterministic review.");
    await ctx.scheduler.runAfter(0, internal.workflows.processExpense, { requestId, fileId });
    return requestId;
  },
});

export const persistResults = internalMutation({
  args: { requestId: v.id("requests"), items: v.array(v.object({ vendor: v.string(), amount: v.number(), category: v.string(), date: v.string(), month: v.string(), poNumber: v.union(v.string(), v.null()), employee: v.string(), anomalyFlags: v.array(v.string()), reasoning: v.string() })) },
  handler: async (ctx, { requestId, items }) => {
    for (const item of items) await ctx.db.insert("expense_items", { ...item, requestId, status: item.anomalyFlags.length ? "flagged" : "auto_cleared" });
    const flagged = items.filter((item) => item.anomalyFlags.length).length;
    const status = flagged ? "pending_approval" : "auto_cleared";
    await ctx.db.patch(requestId, { status });
    await appendAudit(ctx, requestId, "decide", "expense_agent", `${items.length - flagged} cleared; ${flagged} flagged for review.`);
    await appendAudit(ctx, requestId, status === "pending_approval" ? "human_pause" : "complete", "expense_agent", status === "pending_approval" ? "Waiting for finance review of flagged entries." : "All entries passed policy checks.");
    if (!flagged) await ctx.scheduler.runAfter(0, internal.integrations.notion.syncRequest, { requestId });
  },
});

export const decideItem = mutation({
  args: { itemId: v.id("expense_items"), decision: v.union(v.literal("approved"), v.literal("rejected")), reasoning: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, ["approver", "admin"]);
    const item = await ctx.db.get(args.itemId);
    if (!item || item.status !== "flagged") throw new Error("Expense item is not awaiting review");
    await ctx.db.patch(item._id, { status: args.decision, reasoning: args.reasoning?.trim() || item.reasoning });
    await appendAudit(ctx, item.requestId, "human_verdict", `human:${user.email}`, `${item.vendor} ${args.decision}.`);
    const unresolved = await ctx.db.query("expense_items").withIndex("by_request", (q) => q.eq("requestId", item.requestId)).filter((q) => q.eq(q.field("status"), "flagged")).collect();
    if (unresolved.length === 1) {
      await ctx.db.patch(item.requestId, { status: "approved" });
      await ctx.scheduler.runAfter(0, internal.integrations.notion.syncRequest, { requestId: item.requestId });
    }
  },
});
