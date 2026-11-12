// Prepare npm's supported external provenance bundle in the actual build job.
// Nothing here publishes or obtains an npm credential.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { basename, join } = require('node:path');

function subjectFor(candidate, bytes) {
  assert.match(candidate.name, /^@bitspark\/ontos-[a-z-]+$/);
  assert.match(candidate.version, /^\d+\.\d+\.\d+$/);
  const digest = createHash('sha512').update(bytes).digest();
  assert.equal(candidate.integrity, `sha512-${digest.toString('base64')}`, 'archive differs from the qualified candidate');
  return { name: `pkg:npm/${candidate.name.replace(/^@/, '%40')}@${candidate.version}`, digest: { sha512: digest.toString('hex') } };
}

function contextFor(env, checkout, inputs = {}) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'sign only on the actual GitHub runner');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com');
  assert.equal(env.GITHUB_REPOSITORY, 'Bitspark/ontos');
  assert.match(checkout, /^[0-9a-f]{40}$/);
  assert.equal(checkout, env.RELEASE_SHA, 'checked-out source changed after qualification');
  assert.match(env.GITHUB_SHA, /^[0-9a-f]{40}$/);
  assert.match(env.GITHUB_REF, /^refs\/(heads|tags)\/.+/);
  const prefix = `${env.GITHUB_REPOSITORY}/`;
  assert.ok(env.GITHUB_WORKFLOW_REF?.startsWith(prefix));
  const relative = env.GITHUB_WORKFLOW_REF.slice(prefix.length);
  const split = relative.lastIndexOf('@');
  assert.ok(split > 0);
  const path = relative.slice(0, split), ref = relative.slice(split + 1);
  assert.equal(path, '.github/workflows/release.yml');
  assert.match(ref, /^refs\/(heads|tags)\/.+/);
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  return {
    repository: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
    checkout, path, ref, dispatchRef: env.GITHUB_REF, dispatchCommit: env.GITHUB_SHA,
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== '')),
    identity: `${env.GITHUB_SERVER_URL}/${env.GITHUB_WORKFLOW_REF}`,
    invocation: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    event: env.GITHUB_EVENT_NAME,
    repositoryID: env.GITHUB_REPOSITORY_ID,
    ownerID: env.GITHUB_REPOSITORY_OWNER_ID,
  };
}

function statementFor(subject, context) {
  // npm binds the first dependency to the GitHub certificate's repository ref
  // and digest. That is the dispatch input, not necessarily actions/checkout's
  // release source. Record the latter independently instead of rewriting either.
  const dependencies = [{ uri: `git+${context.repository}@${context.dispatchRef}`, digest: { gitCommit: context.dispatchCommit } }];
  if (context.checkout !== context.dispatchCommit) {
    dependencies.push({ name: 'release-checkout', uri: `git+${context.repository}@${context.checkout}`, digest: { gitCommit: context.checkout } });
  }
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [subject],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: { ref: context.ref, repository: context.repository, path: context.path }, inputs: context.inputs },
        internalParameters: { github: { event_name: context.event, repository_id: context.repositoryID, repository_owner_id: context.ownerID } },
        resolvedDependencies: dependencies,
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId: context.invocation },
      },
    },
  };
}

// Rekor answers 409 "an equivalent entry already exists" when sigstore's own HTTP retry
// re-sends an upload whose first attempt was recorded but whose response was lost (seen
// twice on 12 November 2026 while Rekor was slow). sigstore@5.0.0 does not recover from
// that. Signing again uses a fresh key and certificate, so it is a new entry, and the
// bundle is verified below as before; the lost first entry stays in the log, unused.
// Only that conflict is retried: every other failure still stops the run.
function isTlogConflict(error) {
  return error?.code === 'TLOG_CREATE_ENTRY_ERROR' && (error.cause?.statusCode === 409 || / \(409\) /.test(String(error.message)));
}

async function attestWithRetry(attest, payload, attempts = 3, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attest(payload, 'application/vnd.in-toto+json');
    } catch (error) {
      if (!isTlogConflict(error) || attempt >= attempts) throw error;
      console.log(`Rekor reported an existing entry (409) on attempt ${attempt}; signing again with a fresh certificate`);
      await pause(2000 * attempt);
    }
  }
}

async function main() {
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const context = contextFor(process.env, checkout, event.inputs);
  const { attest, verify } = createRequire(join(process.env.PROVENANCE_TOOLS, 'package.json'))('sigstore');
  const work = process.env.WORK;
  const candidateBytes = readFileSync(join(work, 'candidate.json'));
  if (process.env.EXPECTED_CANDIDATE_SHA256) {
    assert.match(process.env.EXPECTED_CANDIDATE_SHA256, /^[0-9a-f]{64}$/);
    assert.equal(createHash('sha256').update(candidateBytes).digest('hex'), process.env.EXPECTED_CANDIDATE_SHA256, 'rebuilt candidate differs from the previously qualified archives');
  }
  const candidates = JSON.parse(candidateBytes).npm;
  const identityPattern = `^${context.identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  for (const candidate of candidates) {
    assert.equal(basename(candidate.filename), candidate.filename);
    const archive = join(work, 'npm', candidate.filename);
    const subject = subjectFor(candidate, readFileSync(archive));
    const payload = Buffer.from(JSON.stringify(statementFor(subject, context)));
    const bundle = await attestWithRetry(attest, payload);
    assert.deepEqual(Buffer.from(bundle.dsseEnvelope.payload, 'base64'), payload);
    await verify(bundle, { certificateIssuer: 'https://token.actions.githubusercontent.com', certificateIdentityURI: identityPattern });
    writeFileSync(`${archive}.sigstore.json`, `${JSON.stringify(bundle)}\n`);
    console.log(`Verified provenance for ${candidate.name}@${candidate.version} at ${checkout}`);
  }
}

module.exports = { subjectFor, contextFor, statementFor, isTlogConflict, attestWithRetry };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
