const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const excludedRepos = core.getInput('excluded-repos').split(',').map(repo => repo.trim());
    const upstreamFilePath = core.getInput('upstream-file-path')? core.getInput('upstream-file-path') : '.github/UPSTREAM';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    console.log(`create-pr-action started for repo: ${owner}/${repo}`);

    const repoFullName = `${owner}/${repo}`;
    console.log(`Fetching fork parent repo info for: ${repoFullName}`);
    const forkStatus = await fetchForkParentRepoInfo(repoFullName, token, excludedRepos);

    if (forkStatus !== '{}') {
      console.log(`Creating PR for repo: ${repoFullName} with fork status: ${forkStatus}`);
      const { url: prUrl, number: prNumber } = await createPr(repoFullName, forkStatus, token, octokit, upstreamFilePath);
      if (prUrl && prNumber) {
        core.setOutput('pr-url', prUrl);
        console.log(`PR created: ${prUrl}`);

        const blockMessage = `Blocked by #${prNumber}`;
        await updateOtherPrs(owner, repo, prNumber, blockMessage, octokit);
      } else {
        console.log('Failed to create PR due to an error.');
      }
    } else {
      console.log('Repository is not a fork or is the specified repository. No PR created.');
    }
  } catch (error) {
    console.log(`Action failed with error: ${error}`);
    core.setFailed(`Action failed with error: ${error}`);
  }
}

async function fetchForkParentRepoInfo(repoFullName, token, excludedRepos) {
  const fetch = (await import('node-fetch')).default;
  const api_url = `https://api.github.com/repos/${repoFullName}`;
  console.log(`Fetching repo info from GitHub API: ${api_url}`);
  const response = await fetch(api_url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const data = await response.json();
  if (data.fork) {
    const parentName = data.parent.full_name;
    console.log(`Repo is a fork. Parent repo is: ${parentName}`);
    if (excludedRepos.includes(repoFullName)) {
      return '{}';
    } else {
      return `{"parent": "${parentName}"}`;
    }
  }
  console.log('Repo is not a fork.');
  return '{}';
}

async function createPr(repoFullName, forkStatus, token, octokit, upstreamFilePath) {
  const [owner, repo] = repoFullName.split('/');
  const newBranch = `update-fork-status-2`;
  const fileName = upstreamFilePath;
  const targetBranch = 'main';
  const commitMessage = 'Update fork status';

  console.log(`Starting PR creation process for ${repoFullName}`);

  try {
    let branchExists = true;
    try {
      await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: newBranch,
      });
      console.log(`Branch ${newBranch} already exists.`);
    } catch (error) {
      if (error.status === 404) {
        branchExists = false;
        console.log(`Branch ${newBranch} does not exist. Creating new branch.`);
        const { data: baseBranchData } = await octokit.rest.repos.getBranch({
          owner,
          repo,
          branch: targetBranch,
        });
        const branchSha = baseBranchData.commit.sha;

        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${newBranch}`,
          sha: branchSha,
        });
        console.log(`Branch ${newBranch} created successfully.`);
      } else {
        throw error;
      }
    }

    let fileSha = '';
    if (branchExists) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: fileName,
          ref: newBranch,
        });
        fileSha = fileData.sha;
      } catch (error) {
        if (error.status !== 404) {
          throw error; // Rethrow if error is not due to file non-existence
        }
      }
    }

    const contentEncoded = Buffer.from(forkStatus).toString('base64');
    const fileParams = {
      owner,
      repo,
      path: fileName,
      message: commitMessage,
      content: contentEncoded,
      branch: newBranch,
    };
    if (fileSha) fileParams.sha = fileSha; // Only include SHA if file exists

    await octokit.rest.repos.createOrUpdateFileContents(fileParams);

    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: commitMessage,
      head: newBranch,
      base: targetBranch,
      body: 'Automatically updating fork status',
    });

    console.log(`PR created: ${pr.html_url}`);
    return { url: pr.html_url, number: pr.number };

  } catch (error) {
    console.log(`Failed to create PR: ${error.message}`);
    core.setFailed(`Failed to create PR: ${error.message}`);
    return { url: null, number: null };
  }
}


async function updateOtherPrs(owner, repo, excludedPrNumber, newBlockRefNum, octokit) {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
    });

    const newBlockMessage = `Blocked by #${excludedPrNumber}`;

    for (const pr of prs) {
      if (pr.number !== excludedPrNumber) {
        console.log(`Checking PR #${pr.number} with body: ${pr.body}`);
        let newBody;
        // Improved regex to match variations in formatting
        const blockedByRegex = /Blocked by *#\s*\d+/g;
        let existingBlockMessages = null;
        console.log(`PR body is xxxx: ${pr.body}`);
        if(!pr.body || pr.body === '') {
          existingBlockMessages = false;
          } else {
            existingBlockMessages = pr.body.match(blockedByRegex);
          }
        
        console.log(`Existing block message match for PR #${pr.number}: ${existingBlockMessages}`);

        if (existingBlockMessages && existingBlockMessages.length > 0) {
          console.log(`Adding new block message: ${newBlockMessage}`);
          console.log(`PR body exists and is : ${pr.body}`);
          // Replace the first occurrence of the block message
          console.log(`Replacing ${existingBlockMessages} with ${newBlockMessage}`);
          newBody = pr.body.replace(existingBlockMessages, newBlockMessage);
          // Remove any additional block messages that might exist
          newBody = newBody.replace(new RegExp(existingBlockMessages, 'g'), '');
        } else {
          console.log(`Adding new block message: ${newBlockMessage}`);
          console.log(`PR body is : ${pr.body}`);
          if(!pr.body || pr.body === '') {
          newBody = `${newBlockMessage}`;
          } else {
            newBody = `${pr.body}\n\n${newBlockMessage}`;
          }
        }

        console.log(`Updating PR #${pr.number} body to: ${newBody}`);
        await updatePrBody(owner, repo, pr.number, newBody, octokit);
        console.log(`Updated PR #${pr.number} body.`);
        await postCommentToPr(owner, repo, pr.number, `This PR is now ${newBlockMessage}.`, octokit);
      }
    }
  } catch (error) {
    console.log(`Failed to update other PRs: ${error.message}`);
    core.setFailed(`Failed to update other PRs: ${error.message}`);
  }
}

async function postCommentToPr(owner, repo, prNumber, comment, octokit) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: comment,
  });
}

async function updatePrBody(owner, repo, prNumber, newBody, octokit) {
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: newBody,
  });
}

run();