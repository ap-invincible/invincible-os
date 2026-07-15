"use node";

export async function grantRepositoryAccess(username: string, repos: string[]) {
  const token = process.env.GITHUB_PAT;
  const org = process.env.GITHUB_ORG;
  if (!token || !org) return { ok: false, detail: "GitHub integration is not configured." };
  try {
    for (const repo of repos) {
      const name = repo.includes("/") ? repo.split("/")[1] : repo;
      const response = await fetch(`https://api.github.com/repos/${org}/${name}/collaborators/${encodeURIComponent(username)}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }, body: JSON.stringify({ permission: "pull" }),
      });
      if (!response.ok && response.status !== 204 && response.status !== 201) throw new Error(`GitHub returned ${response.status}`);
    }
    return { ok: true, detail: `Granted repository access for ${repos.length} repositories.` };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "GitHub grant failed." }; }
}
