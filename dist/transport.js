"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GICKUP_IMAGE = void 0;
exports.gitEnv = gitEnv;
exports.refs = refs;
exports.quoteYaml = quoteYaml;
exports.gickupConfig = gickupConfig;
exports.runGickup = runGickup;
const child = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
exports.GICKUP_IMAGE = 'ghcr.io/cooperspencer/gickup@sha256:03426055edc52f21cca38ff1f40d357924d9e2fee10f5567b66b562b18c39e2a';
function gitEnv(ghToken, glToken) {
    const basic = (user, pass) => 'AUTHORIZATION: basic ' + Buffer.from(user + ':' + pass).toString('base64');
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: basic('x-access-token', ghToken),
        GIT_CONFIG_KEY_1: 'http.https://gitlab.com/.extraheader',
        GIT_CONFIG_VALUE_1: basic('oauth2', glToken),
    };
}
async function refs(url, env) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const result = child.spawnSync('git', ['ls-remote', url], { env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
        if (result.status === 0) {
            const found = {};
            for (const line of result.stdout.split('\n')) {
                if (!line.includes('\t'))
                    continue;
                const [sha, ref] = line.split('\t');
                if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
                    found[ref] = sha;
            }
            return found;
        }
        const msg = String(result.stderr || result.error?.message || 'git ls-remote failed').split('\n')[0].slice(0, 180);
        if (attempt < 3 && /429|too many requests|502|503|504|timeout|connection reset/i.test(msg)) {
            await new Promise(resolve => setTimeout(resolve, 5000 * 2 ** attempt));
            continue;
        }
        throw new Error('Git remote inspection failed: ' + msg.replace(/\/\/[^\s@]+@/g, '//[redacted]@'));
    }
    throw new Error('Git retries exhausted');
}
function quoteYaml(value) {
    return JSON.stringify(value);
}
function gickupConfig(owner, namespace, names, excludes) {
    const include = JSON.stringify(names);
    const ignored = JSON.stringify(excludes.filter(x => x.split('/')[0].toLowerCase() === owner.toLowerCase()).map(x => x.split('/')[1]));
    return `source:\n  github:\n    - token: GH_SOURCE_TOKEN\n      include: ${include}\n      includeorgs:\n        - ${quoteYaml(owner)}\n      exclude: ${ignored}\n      filter:\n        excludeforks: true\ndestination:\n  gitlab:\n    - token: GITLAB_TOKEN\n      user: ${quoteYaml(namespace)}\n      visibility:\n        repositories: private\n      force: false\n      mirror:\n        enabled: true\n`;
}
function runGickup(owner, namespace, names, excludes, workspace, ghToken, glToken) {
    const directory = path.join(workspace, '.gickup-guard');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const configPath = path.join(directory, 'gickup-' + owner.toLowerCase() + '.yml');
    fs.writeFileSync(configPath, gickupConfig(owner, namespace, names, excludes), { mode: 0o600 });
    try {
        const result = child.spawnSync('docker', ['run', '--rm',
            '-e', 'GH_SOURCE_TOKEN', '-e', 'GITLAB_TOKEN',
            '--mount', 'type=bind,source=' + configPath + ',target=/gickup/conf.yml,readonly',
            exports.GICKUP_IMAGE, '/gickup/conf.yml'], {
            stdio: 'inherit', timeout: 30 * 60 * 1000,
            env: { ...process.env, GH_SOURCE_TOKEN: ghToken, GITLAB_TOKEN: glToken },
        });
        if (result.error || result.status !== 0)
            throw new Error('Gickup failed for ' + owner + ' (exit ' + String(result.status) + ')');
    }
    finally {
        fs.rmSync(configPath, { force: true });
    }
}
