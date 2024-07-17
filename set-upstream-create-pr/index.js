const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const excludedRepos = core.getInput('excluded-repos').split(',').map(repo => repo.trim());
    const upstreamFilePath = core.getInput('upstream-file-path')? core.getInput('upstream-file-path') : '.github/UPSTREAM';
    const newBranchName = core.getInput('new-branch-name')? core.getInput('new-branch-name') : 'update-fork-status2';
    const targetBranchToMergeTo = core.getInput('target-branch')? core.getInput('target-branch') : 'main';
    const botCommitMessage = core.getInput('bot-commit-message')? core.getInput('bot-commit-message') : 'Automatically add UPSTREAM file';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    core.info(`create-pr-action started for repo: ${owner}/${repo}`);

    const repoFullName = `${owner}/${repo}`;
    core.info(`Fetching fork parent repo info for: ${repoFullName}`);
    const forkStatus = await fetchForkParentRepoInfo(repoFullName, token, excludedRepos);

    if (forkStatus !== '{}') {
      core.info(`Creating PR for repo: ${repoFullName} with fork status: ${forkStatus}`);
      const { url: prUrl, number: prNumber, status_code, upstreamFileAlreadyExists, openPrExists } = await createPr(repoFullName, forkStatus, token, octokit, upstreamFilePath, newBranchName, targetBranchToMergeTo, botCommitMessage);
      if(openPrExists) {
        core.info(`PR to update upstream already exists: ${prUrl}`);
      }
      else if (prUrl && prNumber) {
        core.setOutput('pr-url', prUrl);
        core.info(`PR created: ${prUrl}`);
        const blockMessage = `Blocked by #${prNumber}`;
        await updateOtherPrs(owner, repo, prNumber, blockMessage, octokit);
      } else if (upstreamFileAlreadyExists) {
        core.info('.github/UPSTREAM file already exists in the target branch. No PR created.');
      } else if (status_code && status_code === 409) {
        core.info('PR already exists please review and merge the existing one.');
      }
      else {
        core.error('Failed to create PR due to an error.');
      }
    } else {
      core.info('Repository is not a fork or is the specified repository. No PR created.');
    }
  } catch (error) {
    core.error(`Action failed with error: ${error}`);
    core.setFailed(`Action failed with error: ${error}`);
  }
}

async function fetchForkParentRepoInfo(repoFullName, token, excludedRepos) {
  const fetch = (await import('node-fetch')).default;
  const api_url = `https://api.github.com/repos/${repoFullName}`;
  core.info(`Fetching repo info from GitHub API: ${api_url}`);

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
    core.info(`Repo is a fork. Parent repo is: ${parentName}`);
    if (excludedRepos.includes(repoFullName)) {
      return '{}';
    } else {
      if(data.private) {
        return `git@github.com:${parentName}.git`;
      } else {
        return `https://github.com/${parentName}.git`;
      }
      
    }
  }
  core.info('Repo is not a fork.');
  return '{}';
}

async function createPr(repoFullName, forkStatus, token, octokit, upstreamFilePath, 
  newBranchName, targetBranchToMergeTo, botCommitMessage) {
  // Split the full repository name into owner and repo
  const [owner, repo] = repoFullName.split('/');
  const newBranch = newBranchName;
  const fileName = upstreamFilePath;
  const targetBranch = targetBranchToMergeTo;
  const commitMessage = botCommitMessage;
  let upstreamFileContentOutdated = false;
  let existingFileSha;
  // Check if the file exists in the target branch
  core.info(`Checking if ${fileName} exists in ${targetBranch} branch of ${repoFullName}`);
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: fileName,
      ref: targetBranch,
    });
    core.info(`${fileName} already exists in ${targetBranch} branch with content: ${response.data.content}`);
      // Decode the content from base64
    const existingContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
    existingFileSha = response.data.sha;

    if (existingContent.trim() === forkStatus.trim()) {
      core.info(`The content of ${fileName} in ${targetBranch} branch is the same as the provided content. No PR will be created.`);
      return { url: null, number: null, upstreamFileAlreadyExists: true };
    } else {
      upstreamFileContentOutdated = true;
      core.info(`The content of ${fileName} in ${targetBranch} branch is different. Proceeding with update and upstreamFileContentOutdated is set to ${upstreamFileContentOutdated}.`);

    }
  } catch (error) {
    if (error.status === 404) {
      core.info(`${fileName} does not exist in ${targetBranch} branch. Proceeding with PR creation.`);
    } else {
      throw error;
    }
  }

  // Check for the existence of the new branch and any open PRs from it to the target branch
  core.info(`Checking if ${newBranch} exists and if there's an open PR from ${newBranch} to ${targetBranch}`);
  try {
    await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: newBranch,
    });

    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      base: targetBranch,
    });
    
    // Step 2: Filter by Title
    const matchingPRs = pullRequests.filter(pr => pr.title === commitMessage);
    
    // Debugging: Log the filtered PRs
    core.info(`Matching PRs with title '${commitMessage}':`, matchingPRs);

    if (matchingPRs.length > 0 && !upstreamFileContentOutdated) {
      core.info(`An open PR from ${newBranch} to ${targetBranch} already exists. No further action taken.`);
      return { url: matchingPRs[0].html_url, number: matchingPRs[0].number, branchExists: true, openPrExists: true };
    } else {
      core.info(`No open PR from ${newBranch} to ${targetBranch}. Deleting and recreating ${newBranch} from ${targetBranch}.`);
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${newBranch}`,
      });
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    core.info(`Branch ${newBranch} does not exist. Proceeding to create it.`);
  }

  // Create or recreate the branch from the target branch
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
  core.info(`Branch ${newBranch} created successfully from ${targetBranch}.`);

  // Create or update the file in the new branch
  const contentEncoded = Buffer.from(forkStatus).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: fileName,
    message: commitMessage,
    content: contentEncoded,
    branch: newBranch,
    sha: existingFileSha
  });

  // Create a pull request from the new branch to the target branch
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: commitMessage,
    head: newBranch,
    base: targetBranch,
    body: commitMessage,
  });

  core.info(`PR created: ${pr.html_url}`);
  return { url: pr.html_url, number: pr.number };
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
        core.info(`Checking PR #${pr.number} with body: ${pr.body}`);
        let newBody;
        // Improved regex to match variations in formatting
        const blockedByRegex = /Blocked by *#\s*\d+/g;
        let existingBlockMessages = null;
        core.info(`PR body is: ${pr.body}`);
        if(!pr.body || pr.body === '') {
          existingBlockMessages = false;
          } else {
            existingBlockMessages = pr.body.match(blockedByRegex);
          }
        
        core.info(`Existing block message match for PR #${pr.number}: ${existingBlockMessages}`);

        if (existingBlockMessages && existingBlockMessages.length > 0) {
          core.info(`Adding new block message: ${newBlockMessage}`);
          core.info(`PR body exists and is : ${pr.body}`);
          // Replace the first occurrence of the block message
          core.info(`Replacing ${existingBlockMessages} with ${newBlockMessage}`);
          newBody = pr.body.replace(existingBlockMessages, newBlockMessage);
          // Remove any additional block messages that might exist
          newBody = newBody.replace(new RegExp(existingBlockMessages, 'g'), '');
        } else {
          core.info(`Adding new block message: ${newBlockMessage}`);
          core.info(`PR body is : ${pr.body}`);
          if(!pr.body || pr.body === '') {
          newBody = `${newBlockMessage}`;
          } else {
            newBody = `${pr.body}\n\n${newBlockMessage}`;
          }
        }

        core.info(`Updating PR #${pr.number} body to: ${newBody}`);
        await updatePrBody(owner, repo, pr.number, newBody, octokit);
        core.info(`Updated PR #${pr.number} body.`);
        await postCommentToPr(owner, repo, pr.number, `This PR is now ${newBlockMessage}.`, octokit);
      }
    }
  } catch (error) {
    console.error(`Failed to update other PRs: ${error.message}`);
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