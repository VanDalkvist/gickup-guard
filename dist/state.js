"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileState = void 0;
exports.appendSummary = appendSummary;
exports.hideToken = hideToken;
const policy_1 = require("./policy");
const fs = require('node:fs');
const path = require('node:path');
class FileState {
    directory;
    constructor(workspace) {
        this.directory = path.join(path.resolve(workspace), '.gickup-guard');
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    filename(name) { return path.join(this.directory, name); }
    write(name, value) {
        fs.writeFileSync(this.filename(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    }
    read(name, fallback) {
        const file = this.filename(name);
        if (!fs.existsSync(file)) {
            if (fallback !== undefined)
                return fallback;
            throw new Error('Missing state file ' + name);
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    initializePending() {
        this.write('pending.json', { version: 1, names: [] });
    }
    getPending() {
        return (0, policy_1.validatePending)(this.read('pending.json', { version: 1, names: [] }));
    }
    setPending(names) {
        this.write('pending.json', { version: 1, names: [...new Set(names)].sort() });
    }
    writePlan(plan) { this.write('plan.json', plan); }
    writeResult(result) { this.write('result.json', result); }
}
exports.FileState = FileState;
function appendSummary(message) {
    process.stdout.write(message + '\n');
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file)
        fs.appendFileSync(file, message + '\n');
}
function hideToken(token) {
    if (token)
        process.stdout.write('::add-mask::' + token + '\n');
}
