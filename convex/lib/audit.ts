import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Only helper allowed to write audit_log. It never patches or deletes rows. */
export function appendAudit(ctx: MutationCtx, requestId: Id<"requests">, step: string, actor: string, detail: string) {
  return ctx.db.insert("audit_log", { requestId, step, actor, detail, timestamp: Date.now() });
}
