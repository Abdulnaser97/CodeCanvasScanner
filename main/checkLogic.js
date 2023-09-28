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

  const lastReviewedSHA = codeCanvasJson.lastReviewedSHA;
  // if last reviewd SHA is equal to the immediate previous push SHA, then no need to scan again

  // first get the sha history and choose the second last sha
  const { data: shaHistory } = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha: sha,
  });

  const secondLastSHA = shaHistory[1].sha;
  console.log("shaHistory: ", shaHistory);
  console.log("lastReviewedSHA: ", lastReviewedSHA);
  console.log("secondLastSHA: ", secondLastSHA);

  if (lastReviewedSHA === secondLastSHA) {
    console.log("No need to scan again");
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion: "success",
      completed_at: new Date().toISOString(),
      output: {
        title: "CodeCanvas Diagram Review Completed",
        summary: "All cells are up to date",
        text: "",
      },
    });
    return;
  }

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
  // get the branch name
  const sourceBranch = eventPayload.pull_request.head.ref;
  let codeCanvasURL = `http://localhost:3000/?repo=${repo}&owner=${owner}&branch=${sourceBranch}&sha=${sha}`;

  if (action_required) {
    summary +=
      "### " +
      "The following CodeCanvas diagram nodes might be impacted by the PR:" +
      "\n";
    for (const issue of feedback.files) {
      summary += "**Entry:** " + issue.path + "," + "\n";
    }
  } else {
    summary += "CodeCanvas Diagram is not be impacted by this PR.";
  }
  console.log("title: ", title);
  console.log("summary: ", summary);
  console.log("feedback: ", JSON.stringify(feedback));
  console.log("conclusion: ", conclusion);
  console.log("sha: ", sha);

  // Step 1: Create a new check run with in_progress status
  const { data: newCheckRun } = await octokit.rest.checks.create({
    owner,
    repo,
    name: "CodeCanvas Scanner",
    head_sha: sha,
    status: "in_progress",
  });

  // Step 2: Get the check run ID from the response
  const checkRunId = newCheckRun.id;

  // Step 3: Update the URL to include the check run ID
  codeCanvasURL += `&checkRunId=${checkRunId}`;

  // Update the summary with the new URL
  summary += `\n\n ## [Click Here to Update Diagram](${codeCanvasURL})`;

  // Step 4: Update the check run with its final status and details
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
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
