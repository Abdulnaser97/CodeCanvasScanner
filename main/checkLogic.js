const { GitHub, context } = require("@actions/github");
const fs = require("fs");

const octokit = new GitHub(process.env.GITHUB_TOKEN);
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

// Read event payload
const eventPayload = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
);
const prNumber = eventPayload.number;
const sha = eventPayload.pull_request.head.sha;

async function handlePullRequestChange() {
  let feedback = { files: [], lines: [] };

  // Fetch tree of the root level of the branch to get a list of all files
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: sha,
  });
  console.log("tree: ", tree);
  // Find a file with the .CodeCanvas extension from the tree
  const codeCanvasFile = tree.tree.find(
    (item) => item.path.endsWith(".CodeCanvas") && item.type === "blob"
  );

  console.log("codeCanvasFile: ", codeCanvasFile);
  let codeCanvasContent;
  if (codeCanvasFile) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: codeCanvasFile.path,
        ref: sha,
      });
      const contentBuffer = Buffer.from(data.content, "base64");
      codeCanvasContent = JSON.parse(contentBuffer.toString("utf8"));
      console.log("Parsed .CodeCanvas content:", codeCanvasContent);
    } catch (error) {
      throw error;
    }
  } else {
    console.log("No file with .CodeCanvas extension found in the root level.");
  }

  const action_required = feedback.files.length > 0;
  const conclusion = action_required ? "action_required" : "success";
  const title = action_required
    ? feedback.files.length + " files need update on CodeCanvas"
    : "No issues found";
  let summary = "";

  if (action_required) {
    summary += "### " + "The following files need update on CodeCanvas" + "\n";
    for (const issue of feedback.files) {
      summary += "**File:** " + issue + "," + "\n";
    }

    summary += `\n\n ## [Click Here to Update Diagram](http://localhost:3001?pr=${prNumber}&repo=${repo}&branch=${process.env.GITHUB_REF.split(
      "/"
    ).pop()}&sha=${sha})`;
  }
  console.log("title: ", title);
  console.log("summary: ", summary);
  console.log("feedback: ", feedback.files.join(" "));
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
      text: feedback.files.join(" "),
    },
  });
}

handlePullRequestChange().catch((err) => console.error(err));
