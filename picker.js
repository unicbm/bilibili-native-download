'use strict';

/**
 * WebIDL file pickers require the page's real Window as their receiver.
 * Tampermonkey's sandbox window may be a Proxy, so binding that wrapper still
 * throws "Illegal invocation". Pass unsafeWindow (or document.defaultView).
 * Keep invocation synchronous to preserve the download click's activation.
 */
function createSaveFilePicker(pageWindow) {
  const picker = pageWindow?.showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  return options => Reflect.apply(picker, pageWindow, [options]);
}

module.exports = { createSaveFilePicker };
