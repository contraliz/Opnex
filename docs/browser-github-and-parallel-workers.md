# Browser and local GitHub workspaces

## Browser and annotations

The **Browser** workspace uses sandboxed Electron `WebContentsView` tabs with no Node integration or remote-page preload. Its compact tab/address bar supports navigation, URL editing, reload, multiple tabs, split panes, and a **Commenting** mode modeled on Codex’s browser chrome. The normal web app can display the browser controls, but native site rendering requires `npm run desktop`.

Website cookies and storage stay in Electron’s persistent local profile. On Windows this profile is stored under `%LOCALAPPDATA%\Pseudoharness\browser-profile`; on macOS and Linux it is under the app’s OS user-data directory. Temporary smoke runs use a separate disposable profile. Pseudoharness does not export browser cookies, site storage, auth headers, or browser session files to its Node API, task state, AgentMem, Codex prompts, logs, or a remote service. A site still receives its own normal authenticated browser requests. Device backup, profile redirection, or folder-sync software configured outside Pseudoharness can affect files in those locations.

To annotate a page, turn on **Commenting** and click the page target. The app captures only the clicked element’s short text, current text selection, page title, and a URL with credentials, query, and fragment removed. It redacts common token, bearer, password, API-key, and cookie-shaped text patterns as a second boundary. It does not capture a screenshot or read the rest of the page. Add a comment and choose **Add to message**; the annotation is appended to the current composer draft and then follows the normal user-message path for a new task or follow-up. Page-derived text is labeled untrusted reference data. A user comment remains the user’s instruction. Pseudoharness does not promise that agents can see page pixels; they receive only the text included in the submitted message.

Use **Clear local browser data** to clear website data from this device’s Pseudoharness profile. A website may expire or revoke its own cookies; Pseudoharness does not extend them. Website sign-in and GitHub CLI sign-in are separate.

## Native GitHub and local Git

The **GitHub** workspace is a local React interface. It does not load `github.com` in the embedded browser. It reads the selected project/task repository with argument-array `git` calls and, when available, runs read-only `gh` commands for repository, pull-request, and issue metadata. Run `gh auth login` in a local terminal to enable GitHub metadata. `gh` keeps its credential in its configured local credential store; Pseudoharness returns only a bounded account label and selected repository metadata, never token contents. Network failure, missing Git/GitHub CLI, missing authentication, and folders outside a Git repository leave local status visible with a useful explanation.

The Overview, Branches, Worktrees, History, Pull requests, and Issues views show local branch and remote-ref names, all reported linked worktrees, and local commit relationships, with branch and history pagination. The native GitHub views are read-only: they do not push branches, create or edit pull requests, or change issues. Selecting a task’s stored GitHub repository or pull-request command opens this local metadata view. Links can be copied for opening elsewhere.

The local GitHub workspace and its API are read-only; they do not push branches or modify pull requests or issues. Existing agent shell commands remain governed by the task’s configured runtime approval policy. Browser content and cookies are not exposed to worker workspace tools. All other operations are local read-only inspection except ordinary network requests made by `gh` to retrieve GitHub metadata and normal page requests made by the browser. Browser cookies are not GitHub CLI credentials and are not included in the local-Git API response or task prompt.

Run `npm run desktop` for the Electron app. Run `npm run dev` for UI iteration; the browser page itself remains a desktop-only feature. GitHub CLI can be installed separately from [cli.github.com](https://cli.github.com/).

## Implementation references

- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [persistent session partitions](https://www.electronjs.org/docs/latest/api/structures/web-preferences), [Electron session data paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security/)
- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login), [repository view](https://cli.github.com/manual/gh_repo_view), [pull request list](https://cli.github.com/manual/gh_pr_list), [issue list](https://cli.github.com/manual/gh_issue_list)
- [Codex app-server dynamic tools](https://developers.openai.com/codex/app-server/)
