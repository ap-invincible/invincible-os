import type { QueryCtx, MutationCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;
type Role = "requester" | "approver" | "admin";

export async function requireProfile(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email;
  if (!email) throw new Error("Not authenticated");
  const profile = await ctx.db.query("profiles").withIndex("by_email", (q) => q.eq("email", email)).unique();
  if (!profile) throw new Error("Profile not initialized");
  return profile;
}

export async function requireRole(ctx: Ctx, roles: Role[]) {
  const profile = await requireProfile(ctx);
  if (!roles.includes(profile.role)) throw new Error("Not authorized");
  return profile;
}
