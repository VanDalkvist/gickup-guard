"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
exports.readConfig = readConfig;
const fs = require('node:fs');
const path = require('node:path');
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const FULL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
function validateConfig(raw) {
    if (!raw || typeof raw !== 'object')
        throw new Error('Configuration must be an object');
    const x = raw;
    if (x.version !== 1)
        throw new Error('Unsupported config version (expected 1)');
    const source = x.source?.github;
    if (!Array.isArray(source?.owners) || !source.owners.length)
        throw new Error('source.github.owners must be a nonempty array');
    if (source.excludeForks !== true)
        throw new Error('For safety, source.github.excludeForks must be true');
    if (!Array.isArray(source.exclude ?? []) || !(source.exclude ?? []).every((v) => typeof v === 'string' && FULL.test(v))) {
        throw new Error('source.github.exclude must contain owner/repo strings');
    }
    const seen = new Set();
    let users = 0;
    for (const owner of source.owners) {
        if (typeof owner.name !== 'string' || !NAME.test(owner.name) || !['user', 'org'].includes(owner.kind) ||
            !Number.isSafeInteger(owner.minVisible) || owner.minVisible < 0) {
            throw new Error('Invalid owner; expected name, kind: user|org, minVisible >= 0');
        }
        const key = owner.name.toLowerCase();
        if (seen.has(key))
            throw new Error('Duplicate configured owner: ' + owner.name);
        seen.add(key);
        if (owner.kind === 'user')
            users++;
    }
    if (users !== 1)
        throw new Error('Exactly one GitHub personal user is required in v0.1');
    if (x.destination?.gitlab?.visibility !== 'private')
        throw new Error('Only private GitLab destinations are supported');
    const hours = x.sync?.activityHours;
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720)
        throw new Error('sync.activityHours must be between 1 and 720');
    return {
        version: 1,
        source: { github: { owners: source.owners, excludeForks: true, exclude: source.exclude ?? [] } },
        destination: { gitlab: { visibility: 'private' } },
        sync: { activityHours: hours },
    };
}
function readConfig(filename, workspace) {
    const base = path.resolve(workspace);
    const absolute = path.resolve(base, filename);
    if (absolute !== base && !absolute.startsWith(base + path.sep))
        throw new Error('Configuration must be inside the checked-out workspace');
    if (path.extname(absolute) !== '.json')
        throw new Error('The v0.1 config format is JSON (.json)');
    return validateConfig(JSON.parse(fs.readFileSync(absolute, 'utf8')));
}
