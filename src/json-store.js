'use strict';

const fs = require('fs');
const path = require('path');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class JsonStore {
    constructor(filePath, initialValue = {}) {
        this.filePath = filePath;
        this.initialValue = initialValue;
        this.data = this.load();
    }

    ensureParentDirectory() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return clone(this.initialValue);
            }

            const raw = fs.readFileSync(this.filePath, 'utf8').trim();

            if (!raw) {
                return clone(this.initialValue);
            }

            const parsed = JSON.parse(raw);

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return clone(this.initialValue);
            }

            return parsed;
        } catch (error) {
            return clone(this.initialValue);
        }
    }

    save() {
        this.ensureParentDirectory();
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
        return value;
    }

    delete(key) {
        delete this.data[key];
        this.save();
    }

    clear() {
        this.data = clone(this.initialValue);
        this.save();
    }
}

module.exports = {
    JsonStore,
};
