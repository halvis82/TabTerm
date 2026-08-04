import { describe, expect, it } from 'vitest';
import { isSensitive, matches } from './launcher-data.js';

describe('secret detection', () => {
  const secrets = [
    'export AWS_SECRET_ACCESS_KEY=abc123',
    'export GITHUB_TOKEN=ghp_xxx',
    'export MY_API_KEY=zzz',
    'curl -H "Authorization: Bearer sk-live-123" https://api.example.com',
    'deploy --api-key abcdef',
    'psql --password=hunter2',
    'curl -u alice:s3cret https://example.com',
    'ssh-add ~/.ssh/id_rsa',
    'security add-generic-password -a me -s svc -w pw',
    'run --token 12345',
  ];

  it('refuses to record anything that looks like a credential', () => {
    for (const s of secrets) expect(isSensitive(s), s).toBe(true);
  });

  const ordinary = [
    'git status',
    'npm run build',
    'cd ~/Projects/eeg && ls -la',
    'grep -r "keyboard" docs/',
    'vim src/main.ts',
    'docker compose up -d',
    // Mentions a key without carrying one.
    'ls ~/.ssh',
    'echo "the api key is stored in 1password"',
  ];

  it('does not discard ordinary commands', () => {
    for (const s of ordinary) expect(isSensitive(s), s).toBe(false);
  });
});

describe('fuzzy matching', () => {
  it('matches a plain substring', () => {
    expect(matches('git checkout main', 'checkout')).toBe(true);
  });

  it('matches an initialism, so gco finds git checkout', () => {
    expect(matches('git checkout main', 'gco')).toBe(true);
    expect(matches('npm run build', 'nrb')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(matches('Git Checkout', 'git')).toBe(true);
  });

  it('rejects a query whose characters are out of order', () => {
    expect(matches('git checkout', 'ocg')).toBe(false);
  });

  it('treats an empty query as matching everything', () => {
    expect(matches('anything at all', '')).toBe(true);
    expect(matches('anything at all', '   ')).toBe(true);
  });

  it('does not match characters that are absent', () => {
    expect(matches('git status', 'zzz')).toBe(false);
  });
});
