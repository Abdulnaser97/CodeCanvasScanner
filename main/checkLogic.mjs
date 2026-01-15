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

const UNKNOWN_RANGE = "UNKNOWN";
const REGEN_REQUIRED_RANGE = "SIM_REGEN_REQ";
const MAX_REASON_SNIPPET_LENGTH = 120;

const formatRange = (startLine, endLine) => {
  const normalizedStart = normalizeLineNumber(startLine);
  const normalizedEnd = normalizeLineNumber(endLine);
  if (normalizedStart === null || normalizedEnd === null) {
    return UNKNOWN_RANGE;
  }
  const start = Math.min(normalizedStart, normalizedEnd);
  const end = Math.max(normalizedStart, normalizedEnd);
  return `L${start}-${end}`;
};

const truncatePatchContent = (value, maxLength = MAX_REASON_SNIPPET_LENGTH) => {
  if (!value) {
    return "";
  }
  const trimmed = String(value).trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
};

const resolveSimulationName = (entry, simulations) => {
  if (!entry?.simSteps || !Array.isArray(entry.simSteps)) {
    return null;
  }
  const names = [];
  for (const step of entry.simSteps) {
    const key = typeof step?.simulationKey === "string" ? step.simulationKey : "";
    if (!key) {
      continue;
    }
    const simName =
      typeof simulations?.[key]?.name === "string" && simulations[key].name
        ? simulations[key].name
        : key;
    if (!names.includes(simName)) {
      names.push(simName);
    }
  }
  if (names.length === 0) {
    return null;
  }
  return names.join(", ");
};

const isSimStepPath = (value) => {
  if (!value) {
    return false;
  }
  return (
    String(value).includes("-simstep-") ||
    String(value).startsWith("generated-simstep-") ||
    String(value).startsWith("generated-edge-simstep-")
  );
};

const resolveEntryFilePath = (entry) => {
  if (!entry) {
    return "";
  }
  if (
    typeof entry.parentPath === "string" &&
    entry.parentPath &&
    typeof entry.path === "string" &&
    entry.path &&
    isSimStepPath(entry.path)
  ) {
    console.log("DEBUG_CHECKRUN_MATCH_PARENT_PATH", {
      cellId: entry?.cellId,
      entryPath: entry.path,
      parentPath: entry.parentPath,
      reason: "simstep-entry",
    });
    return entry.parentPath;
  }
  if (typeof entry.path === "string" && entry.path) {
    return entry.path;
  }
  if (typeof entry.parentPath === "string" && entry.parentPath) {
    return entry.parentPath;
  }
  return "";
};

const normalizeRepoPath = (value) => {
  if (!value) {
    return "";
  }
  return String(value).replace(/^\/+|\/+$/g, "");
};

const resolveEntryType = (entry) => {
  if (!entry) {
    return "unknown";
  }
  if (entry.type === "tree" || entry.type === "blob") {
    return entry.type;
  }
  if (Array.isArray(entry?.children) && entry.children.length > 0) {
    return "tree";
  }
  if (
    typeof entry?.startLine === "number" ||
    typeof entry?.endLine === "number"
  ) {
    return "blob";
  }
  return "unknown";
};

const isPathPrefix = (folderPath, filePath) => {
  if (!folderPath || !filePath) {
    return false;
  }
  if (folderPath === filePath) {
    return true;
  }
  return filePath.startsWith(`${folderPath}/`);
};

const buildCandidateFilePaths = (fileChange) => {
  const candidates = [];
  if (typeof fileChange?.filename === "string" && fileChange.filename) {
    candidates.push(fileChange.filename);
  }
  if (
    typeof fileChange?.previous_filename === "string" &&
    fileChange.previous_filename
  ) {
    candidates.push(fileChange.previous_filename);
  }
  return candidates;
};

const findMatchedFile = ({ entry, filesChanged }) => {
  const entryPath = normalizeRepoPath(resolveEntryFilePath(entry));
  const entryType = resolveEntryType(entry);

  if (!entryPath) {
    console.log("DEBUG_CHECKRUN_MATCH_SKIPPED_EMPTY", {
      cellId: entry?.cellId,
      entryType,
    });
    return null;
  }

  let broadCandidate = null;

  for (const file of filesChanged) {
    const candidates = buildCandidateFilePaths(file).map(normalizeRepoPath);
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const matchType =
        entryType === "tree"
          ? isPathPrefix(entryPath, candidate)
          : candidate === entryPath;
      if (matchType) {
        console.log("DEBUG_CHECKRUN_MATCH_HIT", {
          cellId: entry?.cellId,
          entryType,
          entryPath,
          filePath: file.filename,
          previousFilename: file.previous_filename,
          matchType: entryType === "tree" ? "prefix" : "exact",
        });
        return file;
      }
      if (
        !broadCandidate &&
        (entryPath.includes(candidate) || candidate.includes(entryPath))
      ) {
        broadCandidate = file;
      }
    }
  }

  if (broadCandidate) {
    console.log("DEBUG_CHECKRUN_MATCH_SKIPPED_BROAD", {
      cellId: entry?.cellId,
      entryType,
      entryPath,
      filePath: broadCandidate.filename,
      previousFilename: broadCandidate.previous_filename,
      reason: "substring_rejected",
    });
  }

  return null;
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

const extractPatchLines = (patch) => {
  if (!patch) {
    return [];
  }
  const lines = patch.split("\n");
  const diffLines = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkIndex = -1;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[3], 10);
        hunkIndex += 1;
      }
      continue;
    }

    if (hunkIndex < 0) {
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === "+") {
      diffLines.push({ type: "add", oldLine, newLine, content, hunkIndex });
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      diffLines.push({ type: "del", oldLine, newLine, content, hunkIndex });
      oldLine += 1;
      continue;
    }

    if (prefix === " ") {
      oldLine += 1;
      newLine += 1;
    }
  }

  return diffLines;
};

const findOverlapDetail = ({ startLine, endLine, hunks, patchLines }) => {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return null;
  }

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    const oldEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;

    if (endLine < hunk.oldStart) {
      break;
    }

    if (startLine > oldEnd) {
      continue;
    }

    const overlapStart = Math.max(startLine, hunk.oldStart);
    const overlapEnd = Math.min(endLine, oldEnd);
    const linesForHunk = patchLines.filter(
      (line) => line.hunkIndex === hunkIndex
    );
    const addedLine = linesForHunk.find(
      (line) =>
        line.type === "add" &&
        line.oldLine >= overlapStart &&
        line.oldLine <= overlapEnd
    );
    if (addedLine) {
      return { line: addedLine, overlapStart, overlapEnd };
    }

    const removedLine = linesForHunk.find(
      (line) =>
        line.type === "del" &&
        line.oldLine >= overlapStart &&
        line.oldLine <= overlapEnd
    );
    if (removedLine) {
      return { line: removedLine, overlapStart, overlapEnd };
    }

    return { line: null, overlapStart, overlapEnd };
  }

  return null;
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

const buildLineShiftReasonDetail = ({
  reason,
  beforeRange,
  afterRange,
  delta,
  geminiReason,
}) => {
  if (reason === "gemini-lineshift") {
    if (geminiReason) {
      return `Gemini validated linkage update: ${geminiReason}`;
    }
    return `Gemini validated linkage update to ${afterRange}.`;
  }

  if (delta === 0) {
    return `Diff hunks do not overlap linked range ${beforeRange}; range unchanged (${afterRange}).`;
  }

  const shiftLabel = delta > 0 ? `+${delta}` : `${delta}`;
  return `Diff hunks do not overlap linked range ${beforeRange}; shifted by ${shiftLabel} lines to ${afterRange}.`;
};

const buildRegenerateReasonDetail = ({
  reason,
  entry,
  fileChange,
  beforeRange,
  startLine,
  endLine,
  hunks,
  patchLines,
  geminiReason,
}) => {
  const cellTitle = entry?.cellName || entry?.cellId || "Unknown cell";
  const filePath = fileChange?.filename || entry?.path || "unknown path";

  if (reason === "file-removed") {
    return `File "${filePath}" was removed in this PR, so the linked range ${beforeRange} for "${cellTitle}" cannot be auto-updated.`;
  }

  if (reason === "file-renamed") {
    const previousPath =
      fileChange?.previous_filename || entry?.path || "unknown path";
    return `File was renamed from "${previousPath}" to "${filePath}", so the linked range ${beforeRange} for "${cellTitle}" needs regeneration to confirm the new linkage.`;
  }

  if (reason === "missing-line-range") {
    return `Cell "${cellTitle}" has no stored line range, so auto-linkage updates cannot be computed.`;
  }

  if (reason === "missing-diff") {
    return `GitHub did not provide a diff patch for "${filePath}", so the linked range ${beforeRange} for "${cellTitle}" cannot be validated automatically.`;
  }

  if (reason === "gemini-regenerate") {
    if (geminiReason) {
      return `Gemini flagged ambiguity within linked range ${beforeRange} for "${cellTitle}": ${geminiReason}`;
    }
    return `Gemini flagged ambiguity within linked range ${beforeRange} for "${cellTitle}", so regeneration is required.`;
  }

  if (reason === "diff-overlap") {
    if (
      startLine === null ||
      endLine === null ||
      !Array.isArray(hunks) ||
      hunks.length === 0
    ) {
      return `Diff overlaps linked range ${beforeRange} for "${cellTitle}", so auto-linkage cannot safely determine the updated boundaries.`;
    }

    const overlapDetail = findOverlapDetail({
      startLine,
      endLine,
      hunks,
      patchLines,
    });

    if (overlapDetail?.line) {
      const lineNumber =
        overlapDetail.line.type === "add"
          ? overlapDetail.line.newLine
          : overlapDetail.line.oldLine;
      const lineAction =
        overlapDetail.line.type === "add" ? "added" : "removed";
      const snippet = truncatePatchContent(overlapDetail.line.content);
      const snippetLabel = snippet ? ` "${snippet}"` : "";
      return `A line was ${lineAction}${snippetLabel} at L${lineNumber} inside linked range ${beforeRange} for "${cellTitle}", so auto-linkage cannot decide if the change belongs to the cell.`;
    }

    return `Diff overlaps linked range ${beforeRange} for "${cellTitle}", so auto-linkage cannot safely determine the updated boundaries.`;
  }

  return `Auto-linkage could not safely update linked range ${beforeRange} for "${cellTitle}".`;
};

const formatSummaryEntry = (entry, includeReasonDetail = false) => {
  const title = entry?.cellTitle || entry?.cellName;
  const parts = [`**Cell ID:** ${entry.cellId}`];
  if (title) {
    parts.push(`**Cell Title:** ${title}`);
  }
  if (entry?.simulationName) {
    parts.push(`**Simulation:** ${entry.simulationName}`);
  }
  if (entry?.beforeRange) {
    parts.push(`**Before:** ${entry.beforeRange}`);
  }
  if (entry?.afterRange) {
    parts.push(`**After:** ${entry.afterRange}`);
  }
  let line = parts.join(" | ");
  if (includeReasonDetail && entry?.reasonDetail) {
    line += `\n> ${entry.reasonDetail}`;
  }
  return line;
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
    const matchedFile = findMatchedFile({ entry, filesChanged });

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
    const beforeStartLine = rawStartLine;
    const beforeEndLine = rawEndLine;
    const beforeRange = formatRange(beforeStartLine, beforeEndLine);
    const simulationName = resolveSimulationName(
      entry,
      codeCanvasJson.simulations
    );
    console.log("DEBUG_CHECKRUN_PLAN_STEP1_CONTEXT_READY", {
      cellId: entry.cellId,
      simulationName,
      beforeRange,
      filePath,
    });
    const hasChildren =
      Array.isArray(entry?.children) && entry.children.length > 0;
    const isContainerWithoutLines =
      hasChildren && rawStartLine === null && rawEndLine === null;

    if (
      isContainerWithoutLines &&
      fileChange.status !== "removed" &&
      fileChange.status !== "renamed"
    ) {
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_SKIPPED", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        status: fileChange.status,
        reason: "container-no-lines",
      });
      continue;
    }

    if (fileChange.status === "removed" || fileChange.status === "renamed") {
      const reason =
        fileChange.status === "removed" ? "file-removed" : "file-renamed";
      const reasonDetail = buildRegenerateReasonDetail({
        reason,
        entry,
        fileChange,
        beforeRange,
        startLine: beforeStartLine,
        endLine: beforeEndLine,
        hunks: [],
        patchLines: [],
        geminiReason: null,
      });
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        cellTitle: entry?.cellName,
        simulationName,
        filePath,
        beforeRange,
        beforeStartLine,
        beforeEndLine,
        afterRange: REGEN_REQUIRED_RANGE,
        reason,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_REASON_DETAIL_BUILT", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_PLAN_STEP2_REASON_READY", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        afterRange: REGEN_REQUIRED_RANGE,
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason,
      });
      continue;
    }

    if (rawStartLine === null || rawEndLine === null) {
      const reason = "missing-line-range";
      const reasonDetail = buildRegenerateReasonDetail({
        reason,
        entry,
        fileChange,
        beforeRange,
        startLine: beforeStartLine,
        endLine: beforeEndLine,
        hunks: [],
        patchLines: [],
        geminiReason: null,
      });
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        cellTitle: entry?.cellName,
        simulationName,
        filePath,
        beforeRange,
        beforeStartLine,
        beforeEndLine,
        afterRange: REGEN_REQUIRED_RANGE,
        reason,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_REASON_DETAIL_BUILT", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_PLAN_STEP2_REASON_READY", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        afterRange: REGEN_REQUIRED_RANGE,
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason,
      });
      continue;
    }

    if (!fileChange.patch) {
      const reason = "missing-diff";
      const reasonDetail = buildRegenerateReasonDetail({
        reason,
        entry,
        fileChange,
        beforeRange,
        startLine: beforeStartLine,
        endLine: beforeEndLine,
        hunks: [],
        patchLines: [],
        geminiReason: null,
      });
      feedback.files.push({
        path: entry.path,
        cellId: entry.cellId,
        cellName: entry?.cellName,
        cellTitle: entry?.cellName,
        simulationName,
        filePath,
        beforeRange,
        beforeStartLine,
        beforeEndLine,
        afterRange: REGEN_REQUIRED_RANGE,
        reason,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_REASON_DETAIL_BUILT", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        reasonDetail,
      });
      console.log("DEBUG_CHECKRUN_PLAN_STEP2_REASON_READY", {
        cellId: entry.cellId,
        reason,
        beforeRange,
        afterRange: REGEN_REQUIRED_RANGE,
      });
      console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
        cellId: entry.cellId,
        path: entry.path,
        filePath,
        action: "regenerate",
        reason,
      });
      continue;
    }

    const startLine = Math.min(rawStartLine, rawEndLine);
    const endLine = Math.max(rawStartLine, rawEndLine);
    const hunks = extractDiffHunks(fileChange.patch);
    const patchLines = extractPatchLines(fileChange.patch);
    let classification = classifyLineShift(startLine, endLine, hunks);
    let geminiReasonDetail = null;

    if (classification.action === "lineShift") {
      let proposedRange = {
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
        geminiReasonDetail = geminiResult.reason || null;
        classification = {
          action: "regenerate",
          reason: "gemini-regenerate",
        };
      } else if (geminiResult?.action === "lineShift") {
        const geminiStart = normalizeLineNumber(geminiResult.startLine);
        const geminiEnd = normalizeLineNumber(geminiResult.endLine);
        if (geminiStart !== null && geminiEnd !== null) {
          classification = {
            action: "lineShift",
            reason: "gemini-lineshift",
            startLine: Math.min(geminiStart, geminiEnd),
            endLine: Math.max(geminiStart, geminiEnd),
            delta: classification.delta,
          };
          geminiReasonDetail = geminiResult.reason || null;
          proposedRange = {
            startLine: Math.max(1, classification.startLine),
            endLine: Math.max(1, classification.endLine),
          };
        }
      }

      if (classification.action === "lineShift") {
        const afterRange = formatRange(
          proposedRange.startLine,
          proposedRange.endLine
        );
        const reasonDetail = buildLineShiftReasonDetail({
          reason: classification.reason,
          beforeRange,
          afterRange,
          delta: classification.delta,
          geminiReason: geminiReasonDetail,
        });
        feedback.lineUpdates.push({
          path: entry.path,
          cellId: entry.cellId,
          cellName: entry?.cellName,
          cellTitle: entry?.cellName,
          simulationName,
          filePath,
          beforeRange,
          beforeStartLine: startLine,
          beforeEndLine: endLine,
          afterRange,
          startLine: proposedRange.startLine,
          endLine: proposedRange.endLine,
          reason: classification.reason,
          reasonDetail,
        });
        console.log("DEBUG_CHECKRUN_REASON_DETAIL_BUILT", {
          cellId: entry.cellId,
          reason: classification.reason,
          beforeRange,
          afterRange,
          reasonDetail,
        });
        console.log("DEBUG_CHECKRUN_PLAN_STEP2_REASON_READY", {
          cellId: entry.cellId,
          reason: classification.reason,
          beforeRange,
          afterRange,
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

    const regenReason = classification.reason || "diff-overlap";
    const regenReasonDetail = buildRegenerateReasonDetail({
      reason: regenReason,
      entry,
      fileChange,
      beforeRange,
      startLine,
      endLine,
      hunks,
      patchLines,
      geminiReason: geminiReasonDetail,
    });
    feedback.files.push({
      path: entry.path,
      cellId: entry.cellId,
      cellName: entry?.cellName,
      cellTitle: entry?.cellName,
      simulationName,
      filePath,
      beforeRange,
      beforeStartLine: startLine,
      beforeEndLine: endLine,
      afterRange: REGEN_REQUIRED_RANGE,
      reason: regenReason,
      reasonDetail: regenReasonDetail,
    });
    console.log("DEBUG_CHECKRUN_REASON_DETAIL_BUILT", {
      cellId: entry.cellId,
      reason: regenReason,
      beforeRange,
      reasonDetail: regenReasonDetail,
    });
    console.log("DEBUG_CHECKRUN_PLAN_STEP2_REASON_READY", {
      cellId: entry.cellId,
      reason: regenReason,
      beforeRange,
      afterRange: REGEN_REQUIRED_RANGE,
    });
    console.log("DEBUG_CHECKRUN_LINE_SHIFT_ENTRY", {
      cellId: entry.cellId,
      path: entry.path,
      filePath,
      action: "regenerate",
      reason: regenReason,
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
        .map((update) => formatSummaryEntry(update))
        .join("\n") +
      "\n\n";
  }

  if (action_required) {
    summary +=
      "### The following CodeCanvas diagram nodes might be impacted by the PR:\n";
    for (const issue of feedback.files) {
      summary += `${formatSummaryEntry(issue, true)}\n`;
    }
  } else if (feedback.lineUpdates.length === 0) {
    summary += "CodeCanvas Diagram is not impacted by this PR.";
  }

  console.log("DEBUG_CHECKRUN_OUTPUT_ENRICHED", {
    lineUpdates: feedback.lineUpdates.length,
    regenCount: feedback.files.length,
    lineUpdatesWithDetails: feedback.lineUpdates.filter(
      (update) => update.reasonDetail
    ).length,
    regenWithDetails: feedback.files.filter((issue) => issue.reasonDetail)
      .length,
  });
  console.log("DEBUG_CHECKRUN_PLAN_STEP3_SUMMARY_READY", {
    lineUpdates: feedback.lineUpdates.length,
    regenCount: feedback.files.length,
  });

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
