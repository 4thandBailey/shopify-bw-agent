'use strict';
/**
 * utils/stateStore.js
 * Simple JSON file-based key-value state store.
 * Each sync flow gets its own named store file so cursors and
 * "last run" timestamps persist across service restarts.
 */

const fs   = require('fs');
const path = require('path');

// State files live alongside logs by default
const STATE_DIR = path.join(
  process.env.LOG_DIR || path.join(__dirname, '../../logs'),
  'state'
);

class StateStore {
  constructor(name) {
    this.name     = name;
    this.filePath = path.join(STATE_DIR, `${name}.json`);
    this._data    = this._load();
  }

  _load() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
  }

  get(key) {
    return this._data[key];
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  delete(key) {
    delete this._data[key];
    this._save();
  }

  reset() {
    this._data = {};
    this._save();
  }
}

module.exports = StateStore;
