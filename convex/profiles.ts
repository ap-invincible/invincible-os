import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProfile, requireRole } from "./lib/auth";

export const me = query({ args: {}, handler: (ctx) => requireProfile(ctx) });

/** First sign-in may only establish requester access. Role elevation is admin-only. */
export const initialize = mutation({
  args: { department: v.string() },
  handler: async (ctx, { department }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.email) throw new Error("Not authenticated");
    const existing = await ctx.db.query("profiles").withIndex("by_email", (q) => q.eq("email", identity.email!)).unique();
    if (existing) return existing._id;
    const initialAdmin = process.env.INITIAL_ADMIN_EMAIL?.toLowerCase();
    const role = initialAdmin && identity.email.toLowerCase() === initialAdmin ? "admin" : "requester";
    return ctx.db.insert("profiles", { email: identity.email, department: department.trim() || "General", role });
  },
});

export const setRole = mutation({
  args: { email: v.string(), role: v.union(v.literal("requester"), v.literal("approver"), v.literal("admin")) },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);
    const profile = await ctx.db.query("profiles").withIndex("by_email", (q) => q.eq("email", args.email)).unique();
    if (!profile) throw new Error("Profile not found");
    await ctx.db.patch(profile._id, { role: args.role });
  },
});
