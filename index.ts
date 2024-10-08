/* eslint-disable camelcase */
import * as core from '@actions/core'
import {getInput} from '@actions/core'
import * as github from '@actions/github'
// eslint-disable-next-line node/no-unpublished-import
import {Deployment} from '@octokit/graphql-schema'
import {run, sleep} from './lib/actions.js'
// see https://github.com/actions/toolkit for more github actions libraries
import {fileURLToPath} from 'url'
import * as process from 'node:process'

export const action = () => run(async () => {
  const context = github.context
  const enhancedContext = {
    repository: `${context.repo.owner}/${context.repo.repo}`,
    runAttempt: parseInt(process.env.GITHUB_RUN_ATTEMPT!, 10),
    runnerName: process.env.RUNNER_NAME!,
  }

  const inputs = {
    token: getInput('token', {required: true})!,
    matrix: getInput('__matrix') ? JSON.parse(getInput('__matrix')) : undefined,
  }

  const octokit = github.getOctokit(inputs.token)

  // --- due to some eventual consistency issues with the GitHub API, we need to take a sort break
  await sleep(2000)
  const currentJob = await getCurrentJob(octokit, {
    repo: context.repo,
    runId: context.runId,
    runAttempt: enhancedContext.runAttempt,
    runnerName: enhancedContext.runnerName,
    job: context.job,
    matrix: inputs.matrix,
  })

  const currentDeployment = await getCurrentDeployment(octokit, {
    serverUrl: context.serverUrl,
    repo: context.repo,
    sha: context.sha,
    runId: context.runId,
    runJobId: currentJob.id,
  })

  if (!currentDeployment) {
    core.warning('Could not determine environment deployment.')
    return
  }

  await octokit.rest.repos.createDeploymentStatus({
    ...context.repo,
    deployment_id: currentDeployment.id,
    state: 'inactive',
    environment: currentDeployment.environment,
    environment_url: currentDeployment.environmentUrl,
    log_url: currentDeployment.logUrl,
  })

  core.info(`Delete environment deployment ${currentDeployment.id}.\n${currentDeployment.url}`)
  await octokit.rest.repos.deleteDeployment({
    ...context.repo,
    deployment_id: currentDeployment.id,
  })
})

/**
 * Get the current job from the workflow run
 * @param octokit - octokit instance
 * @param context - github context
 * @returns the current job
 */
async function getCurrentJob(octokit: ReturnType<typeof github.getOctokit>, context: {
  repo: { owner: string; repo: string };
  runId: number;
  runAttempt: number;
  runnerName: string;
  job: string;
  matrix?: Record<string, string>;
}) {
  const workflowRunJobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRunAttempt, {
    ...context.repo,
    run_id: context.runId,
    attempt_number: context.runAttempt,
  })

  let effectiveJobName = context.job
  if (context.matrix) {
    effectiveJobName = effectiveJobName + ` (${flatValues(context.matrix).join(', ')})`
  }
  // As of now (Aug 2024) it is not possible to reconstruct job name for reusable workflows,
  // therefore, we verify the runner name as well.
  // Note: runner name is no unique identifier, however it decreases the probability of ambiguous job matches.
  const potentialCurrentJobs = workflowRunJobs.filter((job) => {
    const match = job.name === effectiveJobName || job.name.endsWith(' / ' + effectiveJobName)
    if (!match) return false

    if (job.runner_name === null) {
      core.debug(`job.runner_name is null for job ${job.name}`)
      return true
    }

    return job.runner_name === context.runnerName
  })

  if (potentialCurrentJobs.length === 0) {
    throw new Error(`Job ${effectiveJobName} not found in workflow run.`)
  }
  if (potentialCurrentJobs.length > 1) {
    throw new Error(`Job ${effectiveJobName} could not be determined with certainty.\n` +
        `Ambiguous jobs: ${JSON.stringify(potentialCurrentJobs.map((job) => job.name), null, 2)}`)
  }

  return potentialCurrentJobs[0]
}

/**
 * Get the current deployment from the workflow run
 * @param octokit - octokit instance
 * @param context - github context
 * @returns the current deployment or undefined
 */
async function getCurrentDeployment(octokit: ReturnType<typeof github.getOctokit>, context: {
  serverUrl: string;
  repo: { owner: string; repo: string };
  sha: string;
  runId: number;
  runJobId: number;
}) {
  // --- get deployments for current sha
  const potentialDeploymentsFromRestApi = await octokit.rest.repos.listDeployments({
    ...context.repo,
    sha: context.sha,
    task: 'deploy',
    per_page: 100,
  }).then(({data: deployments}) => deployments
      .filter((deployment) => deployment.performed_via_github_app?.slug === 'github-actions'))

  console.log('potentialDeploymentsFromRestApi.length', potentialDeploymentsFromRestApi.length)
  // --- get deployment workflow job run id
  // noinspection GraphQLUnresolvedReference
  const potentialDeploymentsFromGrapqlApi = await octokit.graphql<{ nodes: Deployment[] }>(`
    query ($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Deployment {
          databaseId
          commitOid
          createdAt
          task
          state
          latestEnvironment
          latestStatus {
            logUrl
            environmentUrl
          }
        }
      }
    }`, {
    ids: potentialDeploymentsFromRestApi.map(({node_id}) => node_id),
  }).then(({nodes: deployments}) => deployments)

  console.log('potentialDeploymentsFromGrapqlApi.length', potentialDeploymentsFromGrapqlApi.length)
  const currentDeployment = potentialDeploymentsFromGrapqlApi.find((deployment) => {
    console.log('logUrl', deployment.latestStatus?.logUrl)
    if (!deployment.latestStatus?.logUrl) return false
    const logUrl = new URL(deployment.latestStatus.logUrl)

    console.log('  logUrl.origin !== context.serverUrl', logUrl.origin !== context.serverUrl)
    if (logUrl.origin !== context.serverUrl) return false

    const pathnameMatch = logUrl.pathname
        .match(/\/(?<repository>[^/]+\/[^/]+)\/actions\/runs\/(?<run_id>[^/]+)\/job\/(?<run_job_id>[^/]+)/)
    console.log('  pathnameMatch', !!pathnameMatch)
    if (pathnameMatch) {
      console.log('  repository', pathnameMatch.groups?.repository === `${context.repo.owner}/${context.repo.repo}`)
      console.log('  run_id', pathnameMatch.groups?.run_id === context.runId.toString())
      console.log('  run_job_id`', pathnameMatch.groups?.run_job_id === context.runJobId.toString())
    }
    return pathnameMatch &&
        pathnameMatch.groups?.repository === `${context.repo.owner}/${context.repo.repo}` &&
        pathnameMatch.groups?.run_id === context.runId.toString() &&
        pathnameMatch.groups?.run_job_id === context.runJobId.toString()
  })

  if (!currentDeployment) return undefined

  const currentDeploymentUrl =
      // eslint-disable-next-line max-len
      `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/deployments/${currentDeployment.latestEnvironment}`
  const currentDeploymentWorkflowUrl =
      `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

  return {
    ...currentDeployment,
    databaseId: undefined,
    id: currentDeployment.databaseId!,
    url: currentDeploymentUrl,
    workflowUrl: currentDeploymentWorkflowUrl,
    logUrl: currentDeployment.latestStatus!.logUrl! as string,
    environment: currentDeployment.latestEnvironment!,
    environmentUrl: currentDeployment.latestStatus!.environmentUrl! as string,
  }
}

/**
 * Flatten objects and arrays to all its values including nested objects and arrays
 * @param values - value(s)
 * @returns flattened values
 */
function flatValues(values: unknown): unknown[] {
  if (typeof values !== 'object' || values == null) {
    return [values]
  }

  if (Array.isArray(values)) {
    return values.flatMap(flatValues)
  }

  return flatValues(Object.values(values))
}

// Execute the action, if running as main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  action()
}
