'use strict';
// The mock's rollback must pick what the website's rollback.yml picks, or a mock-backed run shows a
// rollback the real workflow would not do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMockGitHub } = require('../../scripts/mock-github');
const { createGitHubClient } = require('../../lib/github');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'site');
const FILES = {
  'data/site.json': fs.readFileSync(path.join(FIXTURES, 'site.json'), 'utf8'),
  'data/site.schema.json': fs.readFileSync(path.join(FIXTURES, 'site.schema.json'), 'utf8'),
  'outputs/data/credentials.json': fs.readFileSync(path.join(FIXTURES, 'credentials.json'), 'utf8'),
};

test('rollback steps back from the live deployment, past redeploys of its commit, and never rolls forward', async () => {
  const mock = await startMockGitHub({ autoProgress: false, files: FILES });
  try {
    const gh = createGitHubClient({ token: 't', repo: mock.state.repo, baseUrl: mock.url, fetch: globalThis.fetch });
    const live = () => mock.state.live.get('main').commit;
    const seed = live();
    const publish = (message) => {
      const sha = mock.pushCommit({ files: { 'data/notes.txt': message }, message });
      mock.completeRun(mock.runsFor(sha)[0].id, 'success');
      return sha;
    };
    const dispatched = async (workflow, inputs) => {
      const { runId } = await gh.dispatch(workflow, 'main', inputs);
      mock.completeRun(runId, 'success');
    };
    const rollBack = () => dispatched('rollback.yml', { deployment_id: '', dry_run: 'false' });

    const c1 = publish('one');
    const c2 = publish('two');
    // "Redeploy live site": a second production deployment of the same commit
    await dispatched('site.yml', {});
    assert.equal(live(), c2);

    await rollBack();
    assert.equal(live(), c1, 'the redeploy of the live commit is skipped');
    await rollBack();
    assert.equal(live(), seed, 'a second rollback goes further back, not forward to the newer deployment');
    await rollBack();
    assert.equal(live(), seed, 'with nothing older, nothing changes');

    await dispatched('rollback.yml', { deployment_id: '', dry_run: 'true' });
    assert.equal(live(), seed, 'a dry run changes nothing');
  } finally {
    await mock.close();
  }
});
