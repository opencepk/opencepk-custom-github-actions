const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    const { owner, repo, number: currentPRNumber } = github.context.issue;

    // Fetch all comments of the PR
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: currentPRNumber,
    });

    if (comments.length === 0) {
      core.info(`No comments found in the PR #${currentPRNumber}.`);
      // core.setFailed('No comments found in the PR.');
      return;
    }

    const blockedByRegex = /blocked by #(\d+)/i;
    let isBlocked = false;

    for (const comment of comments) {
      const match = blockedByRegex.exec(comment.body);
      if (match) {
        const blockingPRNumber = match[1];

        // Check if the blocking PR is merged
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: blockingPRNumber,
        });

        if (!(pr.merged || pr.state === 'closed')) {
          core.setFailed(`PR is blocked by an unmerged PR #${blockingPRNumber}.`);
          isBlocked = true;
          break; // Exit the loop as we found a blocker
        } else {
          core.info(`Found a blocking comment: PR is blocked by #${blockingPRNumber} but it is closed. So it is not blocking.`);
        }
      }
    }

    if (!isBlocked) {
      core.info('PR is not blocked by any PR mentioned in comments.');
    }
    
  } catch (error) {
    core.setFailed(`Action failed with error ${error}`);
  }
}

run();