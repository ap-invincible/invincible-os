"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

export const syncRequest = internalAction({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const token = process.env.NOTION_TOKEN;
    const parent = process.env.NOTION_PARENT_PAGE_ID;
    if (!token || !parent) return;
    const report = await ctx.runQuery(internal.workflows.reportData, { requestId });
    if (!report) return;
    const existing = await ctx.runQuery(internal.workflows.notionSync, { requestId });
    const body = existing
      ? { properties: { title: { title: [{ text: { content: `${report.type}: ${report.status}` } }] } } }
      : { parent: { page_id: parent }, properties: { title: { title: [{ text: { content: `${report.type}: ${report.status}` } }] } }, children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: report.summary } }] } }] };
    const response = await fetch(existing ? `https://api.notion.com/v1/pages/${existing.notionPageId}` : "https://api.notion.com/v1/pages", {
      method: existing ? "PATCH" : "POST", headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) return;
    const page = await response.json() as { id: string };
    await ctx.runMutation(internal.workflows.recordNotionSync, { requestId, notionPageId: page.id });
  },
});
