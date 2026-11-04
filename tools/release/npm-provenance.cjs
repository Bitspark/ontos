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

function contextFor(env, checkout) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'sign only on the actual GitHub runner');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com');
  assert.equal(env.GITHUB_REPOSITORY, 'Bitspark/ontos');
  assert.match(checkout, /^[0-9a-f]{40}$/);
  assert.equal(checkout, env.RELEASE_SHA, 'checked-out source changed after qualification');
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
    checkout, path, ref,
    identity: `${env.GITHUB_SERVER_URL}/${env.GITHUB_WORKFLOW_REF}`,
    invocation: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    event: env.GITHUB_EVENT_NAME,
    repositoryID: env.GITHUB_REPOSITORY_ID,
    ownerID: env.GITHUB_REPOSITORY_OWNER_ID,
  };
}

function statementFor(subject, context) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [subject],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: { ref: context.ref, repository: context.repository, path: context.path } },
        internalParameters: { github: { event_name: context.event, repository_id: context.repositoryID, repository_owner_id: context.ownerID } },
        // The dispatch workflow and checked-out release source may differ. Name
        // the source actually built, never substitute the dispatch's GITHUB_SHA.
        resolvedDependencies: [{ uri: `git+${context.repository}@${context.checkout}`, digest: { gitCommit: context.checkout } }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId: context.invocation },
      },
    },
  };
}

async function main() {
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const context = contextFor(process.env, checkout);
  const { attest, verify } = createRequire(join(process.env.PROVENANCE_TOOLS, 'package.json'))('sigstore');
  const work = process.env.WORK;
  const candidates = JSON.parse(readFileSync(join(work, 'candidate.json'), 'utf8')).npm;
  const identityPattern = `^${context.identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  for (const candidate of candidates) {
    assert.equal(basename(candidate.filename), candidate.filename);
    const archive = join(work, 'npm', candidate.filename);
    const subject = subjectFor(candidate, readFileSync(archive));
    const payload = Buffer.from(JSON.stringify(statementFor(subject, context)));
    const bundle = await attest(payload, 'application/vnd.in-toto+json');
    assert.deepEqual(Buffer.from(bundle.dsseEnvelope.payload, 'base64'), payload);
    await verify(bundle, { certificateIssuer: 'https://token.actions.githubusercontent.com', certificateIdentityURI: identityPattern });
    writeFileSync(`${archive}.sigstore.json`, `${JSON.stringify(bundle)}\n`);
    console.log(`Verified provenance for ${candidate.name}@${candidate.version} at ${checkout}`);
  }
}

module.exports = { subjectFor, contextFor, statementFor };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
