'use strict'
// loader.js — permanent stub that never changes, lives inside the signed asar.
// All real app logic lives in main-real.js (also in asar) but can be overridden
// by dropping main-override.js into the app's userData directory.
// This means future patches only write to userData and NEVER touch the asar,
// so the code-signature is stable and macOS never re-prompts for Screen Recording.

const path = require('path')
const fs   = require('fs')
const { app } = require('electron')

const override = path.join(app.getPath('userData'), 'main-override.js')
if (fs.existsSync(override)) {
  require(override)
} else {
  require('./main-real.js')
}
