import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireProfile, requireRole } from "./lib/auth";

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireProfile(ctx);
    return ctx.db.query("requests").withIndex("by_requester", (q) => q.eq("requesterEmail", user.email)).order("desc").take(30);
  },
});

export const detail = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const user = await requireProfile(ctx);
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    if (request.requesterEmail !== user.email && !["approver", "admin"].includes(user.role)) throw new Error("Not authorized");
    const [audit, expenses, hire, vendor] = await Promise.all([
      ctx.db.query("audit_log").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("asc").collect(),
      ctx.db.query("expense_items").withIndex("by_request", (q) => q.eq("requestId", requestId)).collect(),
      ctx.db.query("hire_provisioning_requests").withIndex("by_request", (q) => q.eq("requestId", requestId)).unique(),
      ctx.db.query("vendor_requests").withIndex("by_request", (q) => q.eq("requestId", requestId)).unique(),
    ]);
    return { request, audit, expenses, hire, vendor };
  },
});

export const queue = query({
  args: { type: v.union(v.literal("expense_batch"), v.literal("hire_provisioning"), v.literal("vendor_procurement")) },
  handler: async (ctx, { type }) => {
    await requireRole(ctx, ["approver", "admin"]);
    const requests = await ctx.db.query("requests").withIndex("by_type_status", (q) => q.eq("type", type).eq("status", "pending_approval")).order("desc").take(50);
    return Promise.all(requests.map(async (request) => ({
      request,
      hire: type === "hire_provisioning" ? await ctx.db.query("hire_provisioning_requests").withIndex("by_request", (q) => q.eq("requestId", request._id)).unique() : null,
      vendor: type === "vendor_procurement" ? await ctx.db.query("vendor_requests").withIndex("by_request", (q) => q.eq("requestId", request._id)).unique() : null,
      expenses: type === "expense_batch" ? await ctx.db.query("expense_items").withIndex("by_request", (q) => q.eq("requestId", request._id)).filter((q) => q.eq(q.field("status"), "flagged")).collect() : [],
      audit: await ctx.db.query("audit_log").withIndex("by_request", (q) => q.eq("requestId", request._id)).order("asc").collect(),
    })));
  },
});

export const audit = query({
  args: { requestId: v.optional(v.id("requests")) },
  handler: async (ctx, { requestId }) => {
    await requireRole(ctx, ["approver", "admin"]);
    if (requestId) return ctx.db.query("audit_log").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").take(100);
    return ctx.db.query("audit_log").order("desc").take(100);
  },
});
