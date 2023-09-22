const fs = require("fs");

// Read the event payload
const payload = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
);

// Logic: Check if PR title starts with "Feature"
if (payload.pull_request.title.startsWith("Feature")) {
  console.log("::set-output name=status::success");
  console.log("::set-output name=summary::check passed!!");
} else {
  console.log("::set-output name=status::failure");
  console.log("::set-output name=summary::check failed!!");
}
