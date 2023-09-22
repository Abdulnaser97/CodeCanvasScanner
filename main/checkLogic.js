const { Octokit } = require("@octokit/rest");
const fs = require("fs");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

// Read event payload
const eventPayload = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
);
const prNumber = eventPayload.number;

async function handlePullRequestChange() {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  let feedback = { files: [], lines: [] };

  for (const file of files) {
    const addedlines = file.patch.match(/(\n\+)+\s*[^\d\+](.*)/g);
    feedback.files.push(file.filename);

    if (addedlines) {
      for (const line of addedlines) {
        feedback.lines.push({ file: file.filename, code: line });
      }
    }
  }

  const action_required = feedback.files.length > 0;
  const conclusion = action_required ? "action_required" : "success";
  const title = action_required
    ? feedback.files.length + " files need update on CodeGram"
    : "No issues found";
  let summary = "";

  if (action_required) {
    summary += "### " + "The following files need update on CodeGram" + "\n";
    for (const issue of feedback.files) {
      summary += "**File:** " + issue + "," + "\n";
    }

    summary += `\n\n ## [Click Here to Update Diagram](http://localhost:3001?pr=${prNumber}&repo=${repo}&branch=${process.env.GITHUB_REF.split(
      "/"
    ).pop()}&sha=${process.env.GITHUB_SHA})`;
  }

  await octokit.rest.checks.create({
    owner,
    repo,
    name: "CodeGram Scanner",
    head_sha: process.env.GITHUB_SHA,
    status: "completed",
    conclusion: conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: title,
      summary: summary,
      text: feedback.files.join(" "),
    },
  });
}

handlePullRequestChange().catch((err) => console.error(err));
