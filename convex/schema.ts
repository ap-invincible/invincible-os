import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const requestType = v.union(v.literal("expense_batch"), v.literal("hire_provisioning"), v.literal("vendor_procurement"));
const requestStatus = v.union(v.literal("processing"), v.literal("auto_cleared"), v.literal("pending_approval"), v.literal("approved"), v.literal("rejected"), v.literal("auto_rejected"), v.literal("failed"));

export default defineSchema({
  ...authTables,
  profiles: defineTable({
    email: v.string(),
    role: v.union(v.literal("requester"), v.literal("approver"), v.literal("admin")),
    department: v.string(),
  }).index("by_email", ["email"]),
  requests: defineTable({
    type: requestType,
    requesterEmail: v.string(),
    status: requestStatus,
    createdAt: v.number(),
  }).index("by_status", ["status"])
    .index("by_type_status", ["type", "status"])
    .index("by_requester", ["requesterEmail"]),
  expense_items: defineTable({
    requestId: v.id("requests"), vendor: v.string(), amount: v.number(), category: v.string(),
    date: v.string(), month: v.string(), poNumber: v.union(v.string(), v.null()), employee: v.string(),
    anomalyFlags: v.array(v.string()), status: v.union(v.literal("auto_cleared"), v.literal("flagged"), v.literal("approved"), v.literal("rejected")),
    reasoning: v.string(),
  }).index("by_request", ["requestId"])
    .index("by_status", ["status"])
    .index("by_month", ["month"]),
  hire_provisioning_requests: defineTable({
    requestId: v.id("requests"), newHireEmail: v.string(), githubUsername: v.string(),
    proposedRepos: v.array(v.string()), reasoning: v.string(), approverEdits: v.union(v.string(), v.null()),
    githubGrantStatus: v.union(v.literal("pending"), v.literal("granted"), v.literal("failed")),
  }).index("by_request", ["requestId"]),
  vendor_requests: defineTable({
    requestId: v.id("requests"), vendorName: v.string(), brochureFileId: v.id("_storage"),
    estimatedCost: v.number(), department: v.string(), purpose: v.string(),
    complianceVerdict: v.union(v.literal("pass"), v.literal("violation"), v.literal("uncertain")),
    complianceReasoning: v.string(), budgetLeftover: v.number(), budgetCovered: v.boolean(), forwardedToApprover: v.boolean(),
  }).index("by_request", ["requestId"]),
  approvals: defineTable({
    requestId: v.id("requests"), approverEmail: v.string(),
    decision: v.union(v.literal("approved"), v.literal("rejected"), v.literal("edited_and_approved")),
    editsMade: v.union(v.string(), v.null()), decidedAt: v.number(),
  }).index("by_request", ["requestId"]),
  audit_log: defineTable({
    requestId: v.id("requests"), step: v.string(), actor: v.string(), detail: v.string(), timestamp: v.number(),
  }).index("by_request", ["requestId", "timestamp"]),
  company_rules: defineTable({
    text: v.string(), embedding: v.array(v.float64()), sourceDoc: v.string(),
  }).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536 }),
  monthly_budgets: defineTable({ department: v.string(), month: v.string(), amount: v.number() })
    .index("by_department_month", ["department", "month"]),
  notion_sync: defineTable({ requestId: v.id("requests"), notionPageId: v.string(), lastSyncedAt: v.number() })
    .index("by_request", ["requestId"]),
  llm_usage: defineTable({ requestId: v.id("requests"), node: v.string(), model: v.string(), inputTokens: v.number(), outputTokens: v.number(), createdAt: v.number() })
    .index("by_request", ["requestId"]),
});
