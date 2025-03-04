const fetch = require('node-fetch');
const FormData = require('form-data');
const { URL, URLSearchParams } = require('url');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fse = require('fs-extra');
const { resolve } = require('path');
const ProxyAgent = require('proxy-agent');
const { backOff } = require('exponential-backoff');
const winston = require('winston');

const { fetchUploadData, download, gpuPresent } = require('../utils');

const { CI_JOB_ID, CI_PIPELINE_ID, IN_DOCKER } = process.env;

const API_VER = 'v4';
class Gitlab {
  constructor(opts = {}) {
    const { repo, token } = opts;

    if (!token) throw new Error('token not found');
    if (!repo) throw new Error('repo not found');

    this.token = token;
    this.repo = repo;
  }

  async projectPath() {
    const repoBase = await this.repoBase();
    const projectPath = encodeURIComponent(
      this.repo.replace(repoBase, '').substr(1)
    );

    return projectPath;
  }

  async repoBase() {
    if (this.detectedBase) return this.detectedBase;

    const { origin, pathname } = new URL(this.repo);
    const possibleBases = await Promise.all(
      pathname
        .split('/')
        .filter(Boolean)
        .map(async (_, index, array) => {
          const components = [origin, ...array.slice(0, index)];
          const path = components.join('/');
          try {
            if (
              (await this.request({ url: `${path}/api/${API_VER}/version` }))
                .version
            )
              return path;
          } catch (error) {
            return error;
          }
        })
    );

    this.detectedBase = possibleBases.find((base) => typeof base === 'string');
    if (!this.detectedBase) {
      if (possibleBases.length) throw possibleBases[0];
      throw new Error('Invalid repository address');
    }

    return this.detectedBase;
  }

  async commentCreate(opts = {}) {
    const { commitSha, report } = opts;

    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}/repository/commits/${commitSha}/comments`;
    const body = new URLSearchParams();
    body.append('note', report);

    await this.request({ endpoint, method: 'POST', body });

    return `${this.repo}/-/commit/${commitSha}`;
  }

  async commentUpdate(opts = {}) {
    throw new Error('GitLab does not support comment updates!');
  }

  async commitComments(opts = {}) {
    const { commitSha } = opts;

    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}/repository/commits/${commitSha}/comments`;

    const comments = await this.request({ endpoint, method: 'GET' });

    return comments.map(({ id, note: body }) => {
      return { id, body };
    });
  }

  async commitPrs(opts = {}) {
    const { commitSha } = opts;

    const projectPath = await this.projectPath();

    const endpoint = `/projects/${projectPath}/repository/commits/${commitSha}/merge_requests`;
    const prs = await this.request({ endpoint, method: 'GET' });

    return prs
      .filter((pr) => pr.state === 'opened')
      .map((pr) => {
        const {
          web_url: url,
          source_branch: source,
          target_branch: target
        } = pr;
        return {
          url,
          source,
          target
        };
      });
  }

  async checkCreate() {
    throw new Error('Gitlab does not support check!');
  }

  async upload(opts = {}) {
    const { repo } = this;

    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}/uploads`;
    const { size, mime, data } = await fetchUploadData(opts);
    const body = new FormData();
    body.append('file', data);

    const { url } = await this.request({ endpoint, method: 'POST', body });

    return { uri: `${repo}${url}`, mime, size };
  }

  async runnerToken() {
    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}`;

    const { runners_token: runnersToken } = await this.request({ endpoint });

    return runnersToken;
  }

  async registerRunner(opts = {}) {
    const { tags, name } = opts;

    const token = await this.runnerToken();
    const endpoint = `/runners`;
    const body = new URLSearchParams();
    body.append('description', name);
    body.append('tag_list', tags);
    body.append('token', token);
    body.append('locked', 'true');
    body.append('run_untagged', 'true');
    body.append('access_level', 'not_protected');

    return await this.request({ endpoint, method: 'POST', body });
  }

  async unregisterRunner(opts = {}) {
    const { runnerId } = opts;
    const endpoint = `/runners/${runnerId}`;

    return await this.request({ endpoint, method: 'DELETE', raw: true });
  }

  async startRunner(opts) {
    const {
      workdir,
      idleTimeout,
      single,
      labels,
      name,
      dockerVolumes = []
    } = opts;

    const gpu = await gpuPresent();

    try {
      const bin = resolve(workdir, 'gitlab-runner');
      if (!(await fse.pathExists(bin))) {
        const arch = process.platform === 'darwin' ? 'darwin' : 'linux';
        const url = `https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-${arch}-amd64`;
        await download({ url, path: bin });
        await fs.chmod(bin, '777');
      }

      const { protocol, host } = new URL(this.repo);
      const { token } = await this.registerRunner({ tags: labels, name });

      let dockerVolumesTpl = '';
      dockerVolumes.forEach((vol) => {
        dockerVolumesTpl += `--docker-volumes ${vol} `;
      });
      const command = `${bin} --log-format="json" run-single \
        --builds-dir "${workdir}" \
        --cache-dir "${workdir}" \
        --url "${protocol}//${host}" \
        --name "${name}" \
        --token "${token}" \
        --wait-timeout ${idleTimeout} \
        --executor "${IN_DOCKER ? 'shell' : 'docker'}" \
        --docker-image "iterativeai/cml:${gpu ? 'latest-gpu' : 'latest'}" \
        ${gpu ? '--docker-runtime nvidia' : ''} \
        ${dockerVolumesTpl} \
        ${single ? '--max-builds 1' : ''}`;

      return spawn(command, { shell: true });
    } catch (err) {
      if (err.message === 'Forbidden')
        err.message +=
          ', check the permissions (scopes) of your GitLab token.\nSee https://cml.dev/doc/self-hosted-runners?tab=GitLab#personal-access-token';
      throw new Error(`Failed preparing Gitlab runner: ${err.message}`);
    }
  }

  async runners(opts = {}) {
    const endpoint = `/runners?per_page=100`;
    const runners = await this.request({ endpoint, method: 'GET' });
    return await Promise.all(
      runners.map(async ({ id, description, online }) => ({
        id,
        name: description,
        busy:
          (
            await this.request({
              endpoint: `/runners/${id}/jobs`,
              method: 'GET'
            })
          ).filter((job) => job.status === 'running').length > 0,
        labels: (
          await this.request({ endpoint: `/runners/${id}`, method: 'GET' })
        ).tag_list,
        online
      }))
    );
  }

  async runnerById({ id } = {}) {
    const {
      description,
      online,
      tag_list: labels
    } = await this.request({
      endpoint: `/runners/${id}`,
      method: 'GET'
    });

    return {
      id,
      name: description,
      labels,
      online
    };
  }

  runnerLogPatterns() {
    return {
      ready: /Starting runner for/,
      job_started: /"job":.+received/,
      job_ended: /"duration_s":/,
      job_ended_succeded: /"duration_s":.+Job succeeded/,
      job: /"job":([0-9]+),"/
    };
  }

  async prCreate(opts = {}) {
    const projectPath = await this.projectPath();
    const { source, target, title, description, skipCi, autoMerge } = opts;

    const prTitle = skipCi ? title + ' [skip ci]' : title;
    const endpoint = `/projects/${projectPath}/merge_requests`;
    const body = new URLSearchParams();
    body.append('source_branch', source);
    body.append('target_branch', target);
    body.append('title', prTitle);
    body.append('description', description);

    const { web_url: url, iid } = await this.request({
      endpoint,
      method: 'POST',
      body
    });

    if (autoMerge)
      await this.prAutoMerge({ pullRequestId: iid, mergeMode: autoMerge });
    return url;
  }

  /**
   * @param {{ pullRequestId: string }} param0
   * @returns {Promise<void>}
   */
  async prAutoMerge({ pullRequestId, mergeMode, mergeMessage }) {
    if (mergeMode === 'rebase')
      throw new Error(`Rebase auto-merge mode not implemented for GitLab`);

    const projectPath = await this.projectPath();

    const endpoint = `/projects/${projectPath}/merge_requests/${pullRequestId}/merge`;
    const body = new URLSearchParams();
    body.set('merge_when_pipeline_succeeds', true);
    body.set('squash', mergeMode === 'squash');
    if (mergeMessage) body.set(`${mergeMode}_commit_message`, mergeMessage);

    try {
      await backOff(() =>
        this.request({
          endpoint,
          method: 'PUT',
          body
        })
      );
    } catch ({ message }) {
      winston.warn(
        `Failed to enable auto-merge: ${message}. Trying to merge immediately...`
      );
      body.set('merge_when_pipeline_succeeds', false);
      this.request({
        endpoint,
        method: 'PUT',
        body
      });
    }
  }

  async prCommentCreate(opts = {}) {
    const projectPath = await this.projectPath();
    const { report, prNumber } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests/${prNumber}/notes`;
    const body = new URLSearchParams();
    body.append('body', report);

    const { id } = await this.request({
      endpoint,
      method: 'POST',
      body
    });

    return `${this.repo}/-/merge_requests/${prNumber}#note_${id}`;
  }

  async prCommentUpdate(opts = {}) {
    const projectPath = await this.projectPath();
    const { report, prNumber, id: commentId } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests/${prNumber}/notes/${commentId}`;
    const body = new URLSearchParams();
    body.append('body', report);

    const { id } = await this.request({
      endpoint,
      method: 'PUT',
      body
    });

    return `${this.repo}/-/merge_requests/${prNumber}#note_${id}`;
  }

  async prComments(opts = {}) {
    const projectPath = await this.projectPath();
    const { prNumber } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests/${prNumber}/notes`;

    const comments = await this.request({
      endpoint,
      method: 'GET'
    });

    return comments.map(({ id, body }) => {
      return { id, body };
    });
  }

  async prs(opts = {}) {
    const projectPath = await this.projectPath();
    const { state = 'opened' } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests?state=${state}`;
    const prs = await this.request({ endpoint, method: 'GET' });

    return prs.map((pr) => {
      const { web_url: url, source_branch: source, target_branch: target } = pr;
      return {
        url,
        source,
        target
      };
    });
  }

  async pipelineRerun({ id = CI_PIPELINE_ID, jobId } = {}) {
    const projectPath = await this.projectPath();

    if (!id && jobId) {
      ({
        pipeline: { id }
      } = await this.request({
        endpoint: `/projects/${projectPath}/jobs/${jobId}`
      }));
    }

    const { status } = await this.request({
      endpoint: `/projects/${projectPath}/pipelines/${id}`,
      method: 'GET'
    });

    if (status === 'running') {
      await this.request({
        endpoint: `/projects/${projectPath}/pipelines/${id}/cancel`,
        method: 'POST'
      });
    }

    await this.request({
      endpoint: `/projects/${projectPath}/pipelines/${id}/retry`,
      method: 'POST'
    });
  }

  async pipelineJobs(opts = {}) {
    throw new Error('Not implemented');
  }

  async updateGitConfig({ userName, userEmail, remote } = {}) {
    const repo = new URL(this.repo);
    repo.password = this.token;
    repo.username = 'token';

    const command = `
    git config user.name "${userName || this.userName}" &&
    git config user.email "${userEmail || this.userEmail}" &&
    git remote set-url ${remote} "${repo.toString()}${
      repo.toString().endsWith('.git') ? '' : '.git'
    }"`;

    return command;
  }

  get workflowId() {
    return CI_PIPELINE_ID;
  }

  get runId() {
    return CI_JOB_ID;
  }

  get sha() {
    return process.env.CI_COMMIT_SHA;
  }

  get branch() {
    return process.env.CI_BUILD_REF_NAME;
  }

  get userEmail() {
    return process.env.GITLAB_USER_EMAIL;
  }

  get userName() {
    return process.env.GITLAB_USER_NAME;
  }

  async request(opts = {}) {
    const { token } = this;
    const { endpoint, method = 'GET', body, raw } = opts;
    let { url } = opts;

    if (endpoint) {
      url = `${await this.repoBase()}/api/${API_VER}${endpoint}`;
    }
    if (!url) throw new Error('Gitlab API endpoint not found');

    const headers = { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
    const response = await fetch(url, {
      method,
      headers,
      body,
      agent: new ProxyAgent()
    });
    if (response.status > 300) throw new Error(response.statusText);
    if (raw) return response;

    return await response.json();
  }
}

module.exports = Gitlab;
