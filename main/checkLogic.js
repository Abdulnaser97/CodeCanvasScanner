import { Octokit } from "@octokit/rest";
import fs from "fs";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MAX_GEMINI_VALIDATIONS = 5;
let geminiValidationCount = 0;

// Read event payload
const eventPayload = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
);
const prNumber = eventPayload.number;
const sha = eventPayload.pull_request.head.sha;

const normalizeLineNumber = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const resolveEntryFilePath = (entry) => {
  if (!entry) {
    return "";
  }
  if (typeof entry.parentPath === "string" && entry.parentPath) {
    return entry.parentPath;
  }
  if (typeof entry.path === "string") {
    return entry.path;
  }
  return "";
};

const extractDiffHunks = (patch) => {
  if (!patch) {
    return [];
  }
  const hunks = [];
  const regex = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g;
  let match = null;
  while ((match = regex.exec(patch)) !== null) {
    const oldStart = Number.parseInt(match[1], 10);
    const oldLines = Number.parseInt(match[2] || "1", 10);
    const newStart = Number.parseInt(match[3], 10);
    const newLines = Number.parseInt(match[4] || "1", 10);
    hunks.push({ oldStart, oldLines, newStart, newLines });
  }
  return hunks;
};

const classifyLineShift = (startLine, endLine, hunks) => {
  let offset = 0;

  for (const hunk of hunks) {
    const oldEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;

    if (endLine < hunk.oldStart) {
      break;
    }

    if (startLine > oldEnd) {
      offset += hunk.newLines - hunk.oldLines;
      continue;
    }

    return {
      action: "regenerate",
      reason: "diff-overlap",
      delta: offset,
    };
  }

  return {
    action: "lineShift",
    reason: "diff-offset",
    delta: offset,
    startLine: startLine + offset,
    endLine: endLine + offset,
  };
};

const extractJsonPayload = (text) => {
  if (!text || typeof text !== "string") {
    return null;
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
};

const maybeValidateLineUpdateWithGemini = async ({
  cellId,
  filePath,
  patch,
  originalRange,
  proposedRange,
}) => {
  if (!GEMINI_API_KEY) {
    console.log("DEBUG_CHECKRUN_LINE_GEMINI_SKIPPED", {
      cellId,
      filePath,
      reason: "missing_key",
    });
    return null;
  }

  if (!patch) {
    console.log("DEBUG_CHECKRUN_LINE_GEMINI_SKIPPED", {
      cellId,
      filePath,
      reason: "missing_patch",
    });
    return null;
  }

  if (geminiValidationCount >= MAX_GEMINI_VALIDATIONS) {
    console.log("DEBUG_CHECKRUN_LINE_GEMINI_SKIPPED", {
      cellId,
      filePath,
      reason: "max_validations_reached",
      max: MAX_GEMINI_VALIDATIONS,
    });
    return null;
  }

  geminiValidationCount += 1;

  const prompt = `You are validating CodeCanvas diagram linkages after a PR.\n\nReturn JSON only with:\n{ "action": "lineShift" | "regenerate", "startLine": number, "endLine": number, "reason": string }\n\nIf unsure, return action "regenerate".\n\nFile: ${filePath}\nOriginal range: L${originalRange.startLine}-L${originalRange.endLine}\nProposed range: L${proposedRange.startLine}-L${proposedRange.endLine}\n\nDiff patch:\n${patch}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            response_mime_type: "application/json",
          },
        }),
      }
    );

    if (!response.ok) {
      console.log("DEBUG_CHECKRUN_LINE_GEMINI_ERROR", {
        cellId,
        filePath,
        status: response.status,
      });
      return null;
    }

    const responseJson = await response.json();
    const text =
      responseJson?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = extractJsonPayload(text);
    if (!parsed) {
      console.log("DEBUG_CHECKRUN_LINE_GEMINI_PARSE_FAILED", {
        cellId,
        filePath,
        text,
      });
      return null;
    }

    return parsed;
  } catch (error) {
    console.log("DEBUG_CHECKRUN_LINE_GEMINI_ERROR", {
      cellId,
      filePath,
      message: error?.message || "unknown_error",
    });
    return null;
  }
};

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

  let feedback = { files: [], lineUpdates: [] };

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
  // if last reviewed SHA is equal to the immediate previous push SHA, then no need to scan again

  // first get the sha history and choose the second last sha
  const { data: shaHistory } = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha: sha,
  });

  const secondLastSHA = shaHistory[1].sha;

  if (lastReviewedSHA === secondLastSHA) {
    console.log("No need to scan again");
    await octokit.rest.checks.create({
      owner,
      repo,
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

  const impactedEntries = [];
  const seenCellIds = new Set();

  for (const entry of Object.values(repoData)) {
    if (!entry?.cellId) {
      continue;
    }
    const entryFilePath = resolveEntryFilePath(entry);
    const matchedFile = filesChanged.find(
      (file) =>
        entryFilePath === file.filename ||
        entryFilePath.includes(file.filename) ||
        file.filename.includes(entryFilePath)
    );

    if (!matchedFile) {
      continue;
    }

    if (seenCellIds.has(entry.cellId)) {
      continue;
    }

    seenCellIds.add(entry.cellId);
    impactedEntries.push({ entry, file: matchedFile });
  }

  console.log("DEBUG_CHECKRUN_LINE_SHIFT_START", {
    impactedCellCount: impactedEntries.length,
    changedFileCount: filesChanged.length,
  });

  for (const impacted of impactedEntries) {
    const entry = impacted.entry;
    const fileChange = impacted.file;
    const filePath = resolveEntryFilePath(entry) || fileChange.filename;
    const rawStartLine = normalizeLineNumber(entry?.startLine);
    const rawEndLine = normalizeLineNumber(entry?.endLine);

    if (fileChange.status === "removed") {
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        reason: "file-removed",
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason: "file-removed",
      });
      continue;
    }

    if (rawStartLine === null || rawEndLine === null) {
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        reason: "missing-line-range",
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason: "missing-line-range",
      });
      continue;
    }

    if (!fileChange.patch) {
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        reason: "missing-diff",
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason: "missing-diff",
      });
      continue;
    }

    const startLine = Math.min(rawStartLine, rawEndLine);
    const endLine = Math.max(rawStartLine, rawEndLine);
    const hunks = extractDiffHunks(fileChange.patch);
    let classification = classifyLineShift(startLine, endLine, hunks);

    if (classification.action === "lineShift") {
      const proposedRange = {
        startLine: Math.max(1, classification.startLine),
        endLine: Math.max(1, classification.endLine),
      };

      const geminiResult = await maybeValidateLineUpdateWithGemini({
        cellId: entry.cellId,
        filePath,
        patch: fileChange.patch,
        originalRange: { startLine, endLine },
        proposedRange,
      });

      if (geminiResult?.action === "regenerate") {
        classification = {
          action: "regenerate",
          reason: geminiResult.reason || "gemini-regenerate",
        };
      } else if (geminiResult?.action === "lineShift") {
        const geminiStart = normalizeLineNumber(geminiResult.startLine);
        const geminiEnd = normalizeLineNumber(geminiResult.endLine);
        if (geminiStart !== null && geminiEnd !== null) {
          classification = {
            action: "lineShift",
            reason: geminiResult.reason || "gemini-lineshift",
            startLine: Math.min(geminiStart, geminiEnd),
            endLine: Math.max(geminiStart, geminiEnd),
            delta: classification.delta,
          };
        }
      }

      if (classification.action === "lineShift") {
        feedback.lineUpdates.push({
          path: entry.path,
          cellId: entry.cellId,
          cellName: entry?.cellName,
          filePath,
          startLine: proposedRange.startLine,
          endLine: proposedRange.endLine,
          reason: classification.reason,
        });
        console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
          cellId: entry.cellId,
          path: entry.path,
          filePath,
          action: "lineShift",
          startLine: proposedRange.startLine,
          endLine: proposedRange.endLine,
          reason: classification.reason,
          delta: classification.delta,
        });
        continue;
      }
    }

    feedback.files.push({
      path: entry.path,
      cellId: entry.cellId,
      cellName: entry?.cellName,
      reason: classification.reason || "diff-overlap",
    });
    console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
      cellId: entry.cellId,
      path: entry.path,
      filePath,
      action: "regenerate",
      reason: classification.reason || "diff-overlap",
    });
  }

  const action_required = feedback.files.length > 0;
  const conclusion = action_required ? "action_required" : "success";
  let title = "No issues found";
  if (action_required) {
    title = `${feedback.files.length} simulations need regeneration`;
  } else if (feedback.lineUpdates.length > 0) {
    title = `${feedback.lineUpdates.length} linkages updated`;
  }

  let summary = "";
  // get the branch name
  const sourceBranch = eventPayload.pull_request.head.ref;
  let codeCanvasURL = `https://dev.code-canvas.com/?session=github&repo=${repo}&owner=${owner}&branch=${sourceBranch}&sha=${sha}`;

  if (feedback.lineUpdates.length > 0) {
    summary +=
      "### Linkage line updates applied\n" +
      feedback.lineUpdates
        .map(
          (update) =>
            `**Cell ID:** ${update.cellId} → L${update.startLine}-${update.endLine}`
        )
        .join("\n") +
      "\n\n";
  }

  if (action_required) {
    summary +=
      "### The following CodeCanvas diagram nodes might be impacted by the PR:\n";
    for (const issue of feedback.files) {
      summary += `**Cell ID:** ${issue.cellId} ${
        issue?.cellName ? `, **cell Title:** ${issue?.cellName}` : ``
      }\n`;
    }
  } else if (feedback.lineUpdates.length === 0) {
    summary += "CodeCanvas Diagram is not impacted by this PR.";
  }

  console.log("title: ", title);
  console.log("summary: ", summary);
  console.log("feedback: ", JSON.stringify(feedback));
  console.log("conclusion: ", conclusion);
  console.log("sha: ", sha);

  let prURL = eventPayload.pull_request.html_url;
  codeCanvasURL += `&prURL=${encodeURIComponent(prURL)}`;

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

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      const stepSummary = [
        "## CodeCanvas Scanner",
        "",
        `**Result:** ${title}`,
        `**Conclusion:** ${conclusion}`,
        "",
        summary,
        "",
      ].join("\n");
      await fs.promises.appendFile(stepSummaryPath, stepSummary, "utf8");
    } catch (error) {
      console.log("DEBUG_STEP_SUMMARY_WRITE_FAILED", {
        error: error?.message || String(error),
      });
    }
  }

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

  if (action_required) {
    console.error("CodeCanvas Scanner requires action; failing job.");
    process.exitCode = 1;
  }
}

handlePullRequestChange().catch((err) => console.error(err));
