import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { appendAudit } from "./lib/audit";
import { requireProfile, requireRole } from "./lib/auth";

export const submit = mutation({
  args: { vendorName: v.string(), brochureFileId: v.id("_storage"), estimatedCost: v.number(), department: v.string(), purpose: v.string() },
  handler: async (ctx, args) => {
    const user = await requireProfile(ctx);
    if (args.estimatedCost <= 0) throw new Error("Cost must be positive");
    const requestId = await ctx.db.insert("requests", { type: "vendor_procurement", requesterEmail: user.email, status: "processing", createdAt: Date.now() });
    await appendAudit(ctx, requestId, "submitted", `human:${user.email}`, "Vendor brochure received. Running compliance and budget checks.");
    await ctx.scheduler.runAfter(0, internal.workflows.processVendor, { requestId, ...args });
    return requestId;
  },
});

export const persistDecision = internalMutation({
  args: { requestId: v.id("requests"), vendorName: v.string(), brochureFileId: v.id("_storage"), estimatedCost: v.number(), department: v.string(), purpose: v.string(), complianceVerdict: v.union(v.literal("pass"), v.literal("violation"), v.literal("uncertain")), complianceReasoning: v.string(), budgetLeftover: v.number(), budgetCovered: v.boolean() },
  handler: async (ctx, args) => {
    const forwardedToApprover = args.complianceVerdict !== "violation" && args.budgetCovered;
    await ctx.db.insert("vendor_requests", { ...args, forwardedToApprover });
    await ctx.db.patch(args.requestId, { status: forwardedToApprover ? "pending_approval" : "auto_rejected" });
    await appendAudit(ctx, args.requestId, "check_budget", "vendor_agent", `Budget available: ${args.budgetLeftover.toFixed(2)}; request cost: ${args.estimatedCost.toFixed(2)}.`);
    await appendAudit(ctx, args.requestId, "gate", "vendor_agent", forwardedToApprover ? "Compliance and budget checks passed. Waiting for approval." : args.budgetCovered ? "Rejected: vendor policy violation." : "Rejected: insufficient budget.");
  },
});

export const budgetContext = internalQuery({
  args: { department: v.string(), month: v.string() },
  handler: async (ctx, args) => {
    const budget = await ctx.db.query("monthly_budgets").withIndex("by_department_month", (q) => q.eq("department", args.department).eq("month", args.month)).unique();
    const expenses = await ctx.db.query("expense_items").withIndex("by_month", (q) => q.eq("month", args.month)).collect();
    return { budget: budget?.amount ?? 0, spent: expenses.reduce((total, item) => total + item.amount, 0) };
  },
});

export const fallbackRules = internalQuery({ args: {}, handler: (ctx) => ctx.db.query("company_rules").take(20) });

export const setBudget = mutation({
  args: { department: v.string(), month: v.string(), amount: v.number() },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);
    const previous = await ctx.db.query("monthly_budgets").withIndex("by_department_month", (q) => q.eq("department", args.department).eq("month", args.month)).unique();
    if (previous) await ctx.db.patch(previous._id, { amount: args.amount });
    else await ctx.db.insert("monthly_budgets", args);
  },
});

export const addRule = mutation({
  args: { text: v.string(), sourceDoc: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);
    const ruleId = await ctx.db.insert("company_rules", { ...args, embedding: Array.from({ length: 1536 }, () => 0) });
    await ctx.scheduler.runAfter(0, internal.workflows.embedRule, { ruleId });
    return ruleId;
  },
});
