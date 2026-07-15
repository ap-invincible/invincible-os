import { mutation } from "./_generated/server";
import { requireProfile } from "./lib/auth";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireProfile(ctx);
    return ctx.storage.generateUploadUrl();
  },
});
