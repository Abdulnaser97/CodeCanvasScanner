const { Octokit } = require("@octokit/rest");
const fs = require("fs");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

// Read event payload
const eventPayload = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
);
const prNumber = eventPayload.number;
const sha = eventPayload.pull_request.head.sha;

async function handlePullRequestChange() {
  // Get file list from the PR's branch
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: sha,
    recursive: "1",
  });

  const codeCanvasFile = tree.tree.find((file) =>
    file.path.endsWith(".CodeCanvas")
  );

  let feedback = { files: [] };

  if (!codeCanvasFile) {
    console.log("no CodeCanvas file found in root");
    return;
  }

  // Retrieve the file content
  const { data: fileContent } = await octokit.rest.git.getBlob({
    owner,
    repo,
    file_sha: codeCanvasFile.sha,
  });

  const codeCanvasJson = JSON.parse(
    Buffer.from(fileContent.content, "base64").toString("utf8")
  );

  const repoData = codeCanvasJson.repoData;

  // Get list of changed files in PR
  const { data: filesChanged } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  const changedFiles = filesChanged.map((file) => file.filename);
  console.log("changedFiles: ", changedFiles);
  for (const entry of Object.values(repoData)) {
    // Exclude line-of-code entries
    for (const file of changedFiles) {
      if (entry.path.includes(file) && entry?.cellId) {
        feedback.files.push({
          path: entry.path,
          cellId: entry.cellId,
        });
      }
    }
  }

  const action_required = feedback.files.length > 0;
  const conclusion = action_required ? "action_required" : "success";
  const title = action_required
    ? feedback.files.length + " files need update on CodeCanvas"
    : "No issues found";
  let summary = "";

  if (action_required) {
    summary +=
      "### " +
      "The following entries in repoData are impacted by the PR:" +
      "\n";
    for (const issue of feedback.files) {
      summary += "**Entry:** " + issue.path + "," + "\n";
    }

    summary += `\n\n ## [Click Here to Update Diagram](http://localhost:3001?pr=${prNumber}&repo=${repo}&branch=${process.env.GITHUB_REF.split(
      "/"
    ).pop()}&sha=${sha})`;
  }
  console.log("title: ", title);
  console.log("summary: ", summary);
  console.log("feedback: ", JSON.stringify(feedback));
  console.log("conclusion: ", conclusion);
  console.log("sha: ", sha);

  await octokit.rest.checks.create({
    owner,
    repo,
    name: "CodeCanvas Scanner",
    head_sha: sha,
    status: "completed",
    conclusion: conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: title,
      summary: summary,
      text: JSON.stringify(feedback),
    },
  });
}

handlePullRequestChange().catch((err) => console.error(err));
