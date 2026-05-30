/**
 * GitHub integration via Octokit (TRD §11). PAT validation and PR creation.
 * The token comes from the env var named in the task; it is never logged.
 */
import { Octokit } from "@octokit/rest";

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(opts: GitHubClientOptions) {
    this.octokit = new Octokit({ auth: opts.token });
    this.owner = opts.owner;
    this.repo = opts.repo;
  }

  /** Verify the PAT can see the target repo. Throws GitHubError on failure. */
  async validateAccess(): Promise<void> {
    try {
      await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    } catch (err) {
      throw new GitHubError(
        `GitHub PAT cannot access ${this.owner}/${this.repo}: ${(err as Error).message}`,
      );
    }
  }

  /** Open a PR. Returns the html_url and number. */
  async createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }> {
    try {
      const res = await this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: input.draft ?? false,
      });
      return { url: res.data.html_url, number: res.data.number };
    } catch (err) {
      throw new GitHubError(`Failed to open PR: ${(err as Error).message}`);
    }
  }
}
