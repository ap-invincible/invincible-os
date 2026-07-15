"use node";

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import * as XLSX from "xlsx";
import parsePdf from "pdf-parse";
import { monthFromDate, expenseReason } from "./lib/values";
import { draftReason, embedText, judgeCompliance } from "./integrations/openrouter";
import { grantRepositoryAccess } from "./integrations/github";
import { notifyTeams } from "./integrations/teams";

type ExpenseRow = { vendor: string; amount: number; category: string; date: string; month: string; poNumber: string | null; employee: string; anomalyFlags: string[]; reasoning: string };
const stringCell = (row: Record<string, unknown>, key: string) => String(row[key] ?? row[key.toLowerCase()] ?? "").trim();

export const logStep = internalMutation({
  args: { requestId: v.id("requests"), step: v.string(), actor: v.string(), detail: v.string() },
  handler: (ctx, args) => ctx.db.insert("audit_log", { ...args, timestamp: Date.now() }),
});

export const fail = internalMutation({
  args: { requestId: v.id("requests"), detail: v.string() },
  handler: async (ctx, args) => { await ctx.db.patch(args.requestId, { status: "failed" }); await ctx.db.insert("audit_log", { requestId: args.requestId, step: "failed", actor: "system", detail: args.detail, timestamp: Date.now() }); },
});

export const processExpense = internalAction({
  args: { requestId: v.id("requests"), fileId: v.id("_storage") },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.workflows.logStep, { requestId: args.requestId, step: "extract", actor: "expense_agent", detail: "Extracting spreadsheet rows." });
      const url = await ctx.storage.getUrl(args.fileId);
      if (!url) throw new Error("Uploaded file no longer exists.");
      const workbook = XLSX.read(await (await fetch(url)).arrayBuffer(), { type: "array" });
      const source = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
      if (!source.length) throw new Error("Spreadsheet contains no expense rows.");
      const normalized = source.map((row) => ({ vendor: stringCell(row, "Vendor"), amount: Number(stringCell(row, "Amount")), category: stringCell(row, "Category"), date: stringCell(row, "Date"), poNumber: stringCell(row, "PO Number") || null, employee: stringCell(row, "Employee") }));
      if (normalized.some((row) => !row.vendor || !Number.isFinite(row.amount) || !row.category || !row.date)) throw new Error("Required columns: Vendor, Amount, Category, Date. PO Number and Employee are optional.");
      const groups = new Map<string, number[]>();
      normalized.forEach((row) => groups.set(row.category, [...(groups.get(row.category) ?? []), row.amount]));
      const items: ExpenseRow[] = await Promise.all(normalized.map(async (row, index) => {
        const amounts = groups.get(row.category) ?? [];
        const mean = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
        const deviation = Math.sqrt(amounts.reduce((sum, amount) => sum + (amount - mean) ** 2, 0) / amounts.length);
        const duplicate = normalized.some((other, otherIndex) => otherIndex !== index && other.vendor.toLowerCase() === row.vendor.toLowerCase() && other.amount === row.amount && Math.abs(Date.parse(other.date) - Date.parse(row.date)) <= 31 * 86400000);
        const flags = [duplicate && "duplicate", amounts.length > 2 && deviation > 0 && row.amount > mean + 2 * deviation && "over_category_average", row.amount >= 500 && !row.poNumber && "missing_po"].filter(Boolean) as string[];
        const fallback = expenseReason(flags);
        return { ...row, month: monthFromDate(row.date), anomalyFlags: flags, reasoning: await draftReason(`Facts: ${fallback}`, fallback) };
      }));
      await ctx.runMutation(internal.expenses.persistResults, { requestId: args.requestId, items });
      await notifyTeams("Expense review completed", `${items.filter((item) => item.anomalyFlags.length).length} items need review.`, args.requestId);
    } catch (error) { await ctx.runMutation(internal.workflows.fail, { requestId: args.requestId, detail: error instanceof Error ? error.message : "Expense processing failed." }); }
  },
});

export const processHire = internalAction({
  args: { requestId: v.id("requests"), newHireEmail: v.string(), githubUsername: v.string() },
  handler: async (ctx, args) => {
    const reasoning = "Standard engineering onboarding repositories proposed; GitHub access remains approval-gated.";
    await ctx.runMutation(internal.hires.saveProposal, { ...args, proposedRepos: ["invincible/onboarding", "invincible/engineering-handbook"], reasoning });
    await notifyTeams("Access approval needed", `GitHub access requested for ${args.newHireEmail}.`, args.requestId);
  },
});

export const processVendor = internalAction({
  args: { requestId: v.id("requests"), vendorName: v.string(), brochureFileId: v.id("_storage"), estimatedCost: v.number(), department: v.string(), purpose: v.string() },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.workflows.logStep, { requestId: args.requestId, step: "extract", actor: "vendor_agent", detail: "Extracting vendor brochure text." });
      const url = await ctx.storage.getUrl(args.brochureFileId);
      if (!url) throw new Error("Uploaded brochure no longer exists.");
      const response = await fetch(url);
      const bytes = Buffer.from(await response.arrayBuffer());
      const raw = bytes.subarray(0, 4).toString() === "%PDF" ? (await parsePdf(bytes)).text : new TextDecoder().decode(bytes);
      const brochure = raw.replace(/\s+/g, " ").slice(0, 16000) || `${args.vendorName} ${args.purpose}`;
      const embedding = await embedText(brochure);
      const matches = embedding ? await ctx.vectorSearch("company_rules", "by_embedding", { vector: embedding, limit: 3 }) : [];
      const rules = matches.length ? await Promise.all(matches.map(async (match) => (await ctx.runQuery(internal.workflows.ruleText, { ruleId: match._id }))?.text ?? "")) : (await ctx.runQuery(internal.vendors.fallbackRules, {})).map((rule) => rule.text);
      await ctx.runMutation(internal.workflows.logStep, { requestId: args.requestId, step: "retrieve_rules", actor: "vendor_agent", detail: `Retrieved ${rules.filter(Boolean).length} relevant policy rules.` });
      const compliance = await judgeCompliance(brochure, rules.filter(Boolean));
      const month = new Date().toISOString().slice(0, 7);
      const budget = await ctx.runQuery(internal.vendors.budgetContext, { department: args.department, month });
      await ctx.runMutation(internal.vendors.persistDecision, { ...args, complianceVerdict: compliance.verdict, complianceReasoning: compliance.reasoning, budgetLeftover: budget.budget - budget.spent, budgetCovered: args.estimatedCost <= budget.budget - budget.spent });
      await notifyTeams("Vendor assessment completed", `${args.vendorName}: ${compliance.verdict}.`, args.requestId);
    } catch (error) { await ctx.runMutation(internal.workflows.fail, { requestId: args.requestId, detail: error instanceof Error ? error.message : "Vendor processing failed." }); }
  },
});

export const embedRule = internalAction({
  args: { ruleId: v.id("company_rules") },
  handler: async (ctx, { ruleId }) => {
    const rule = await ctx.runQuery(internal.workflows.ruleText, { ruleId });
    if (!rule) return;
    const embedding = await embedText(rule.text);
    if (embedding) await ctx.runMutation(internal.workflows.saveRuleEmbedding, { ruleId, embedding });
  },
});

export const saveRuleEmbedding = internalMutation({
  args: { ruleId: v.id("company_rules"), embedding: v.array(v.float64()) },
  handler: (ctx, { ruleId, embedding }) => ctx.db.patch(ruleId, { embedding }),
});

export const executeHire = internalAction({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const grant = await ctx.runQuery(internal.hires.approvedGrant, { requestId });
    if (!grant) { await ctx.runMutation(internal.hires.markGrant, { requestId, status: "failed", detail: "Execution blocked: no approved access record." }); return; }
    const outcome = await grantRepositoryAccess(grant.githubUsername, grant.repos);
    await ctx.runMutation(internal.hires.markGrant, { requestId, status: outcome.ok ? "granted" : "failed", detail: outcome.detail });
    if (outcome.ok) await ctx.scheduler.runAfter(0, internal.integrations.notion.syncRequest, { requestId });
  },
});

export const ruleText = internalQuery({ args: { ruleId: v.id("company_rules") }, handler: (ctx, { ruleId }) => ctx.db.get(ruleId) });

export const reportData = internalQuery({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    const audit = await ctx.db.query("audit_log").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("asc").collect();
    return { type: request.type, status: request.status, summary: audit.map((entry) => `${entry.step}: ${entry.detail}`).join("\n").slice(0, 1800) };
  },
});

export const recordNotionSync = internalMutation({
  args: { requestId: v.id("requests"), notionPageId: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.db.query("notion_sync").withIndex("by_request", (q) => q.eq("requestId", args.requestId)).unique();
    if (current) await ctx.db.patch(current._id, { notionPageId: args.notionPageId, lastSyncedAt: Date.now() });
    else await ctx.db.insert("notion_sync", { ...args, lastSyncedAt: Date.now() });
  },
});

export const notionSync = internalQuery({
  args: { requestId: v.id("requests") },
  handler: (ctx, { requestId }) => ctx.db.query("notion_sync").withIndex("by_request", (q) => q.eq("requestId", requestId)).unique(),
});
