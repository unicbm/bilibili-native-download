'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { startBiliDownloader } = require('../main.js');

// Bilibili's video page uses Vue 2.6.14 to hydrate the server-rendered page.
// Its header component loads a separate bundle asynchronously and subsequently
// looks up #biliMainHeader again, rather than retaining its own component node.
// Exercise real Vue hydration here; only that later header load is simulated.
const vueRuntime = fs.readFileSync(require.resolve('vue/dist/vue.runtime.min.js'), 'utf8');
const releaseBundle = fs.readFileSync(require.resolve('../dist/bilibili-native-download.user.js'), 'utf8');
const SSR_HTML = '<div id="app" data-server-rendered="true">' +
  '<div id="biliMainHeader"><nav>首页 番剧 直播</nav></div>' +
  '<main><div class="video-toolbar-container"><div class="video-toolbar-left-main">' +
  '<button class="video-share">分享</button></div></div>' +
  '<p id="video-description">视频简介</p></main></div>';

function setup(t) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${SSR_HTML}</body></html>`, {
    url: 'https://www.bilibili.com/video/BV1icx865Exu/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const doc = win.document;
  win.eval(vueRuntime);
  assert.equal(win.Vue.version, '2.6.14');
  const mountedHeaders = [];
  const initializedTargets = [];
  const pendingHeaderLoads = [];
  const Header = {
    render(h) {
      return h('div', { attrs: { id: 'biliMainHeader' } }, [h('nav', '首页 番剧 直播')]);
    },
    mounted() {
      mountedHeaders.push(this.$el);
      pendingHeaderLoads.push(Promise.resolve().then(() => {
        initializedTargets.push(doc.getElementById('biliMainHeader'));
      }));
    },
  };
  const page = new win.Vue({
    render(h) {
      return h('div', { attrs: { id: 'app' } }, [
        h(Header),
        h('main', [
          h('div', { class: 'video-toolbar-container' }, [
            h('div', { class: 'video-toolbar-left-main' }, [
              h('button', { class: 'video-share' }, '分享'),
            ]),
          ]),
          h('p', { attrs: { id: 'video-description' } }, '视频简介'),
        ]),
      ]);
    },
  });
  let downloader;
  let networkRequests = 0;
  t.after(() => {
    downloader?.dispose();
    page.$destroy();
    win.close();
  });
  return {
    win, doc, page, mountedHeaders, initializedTargets,
    async hydrate() {
      page.$mount('#app');
      await Promise.all(pendingHeaderLoads);
    },
    startDownloader() {
      downloader = startBiliDownloader({ win, doc, core: {}, getValue: () => 4 });
      return downloader;
    },
    startBundle() {
      const unexpectedNetwork = () => {
        networkRequests++;
        throw new Error('Script startup must not request media before the download panel is opened');
      };
      win.fetch = unexpectedNetwork;
      win.GM_xmlhttpRequest = unexpectedNetwork;
      win.GM_getValue = (_key, fallback) => fallback;
      win.GM_setValue = () => {};
      win.GM_registerMenuCommand = () => {};
      win.unsafeWindow = win;
      win.eval(releaseBundle);
    },
    get networkRequests() { return networkRequests; },
  };
}

async function until(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('early toolbar insertion makes real Vue 2 hydration rebuild the page and initialize the header twice', async t => {
  const h = setup(t);
  const originalRoot = h.doc.getElementById('app');
  h.doc.querySelector('.video-toolbar-left-main').append(h.doc.createElement('button'));

  await h.hydrate();

  assert.notEqual(h.page.$el, originalRoot, 'a child mismatch discards the server-rendered root');
  assert.equal(h.mountedHeaders.length, 2, 'both the abandoned and replacement header run mounted');
  assert.equal(h.mountedHeaders[0].isConnected, false);
  assert.equal(h.mountedHeaders[1].isConnected, true);
  assert.equal(h.initializedTargets.length, 2);
  assert.equal(h.initializedTargets[0], h.initializedTargets[1], 'both async callbacks target the surviving header');
});

for (const entryPoint of ['source module', 'release bundle']) {
test(`${entryPoint} preserves SSR hydration and mounts after the root marker is removed`, async t => {
  const h = setup(t);
  const originalRoot = h.doc.getElementById('app');
  const originalHeader = h.doc.getElementById('biliMainHeader');
  const originalHeaderHTML = originalHeader.outerHTML;
  if (entryPoint === 'source module') h.startDownloader();
  else h.startBundle();

  // Hydrate even when testing the old implementation: its failure should expose
  // the real double initialization, not just an implementation-specific gate.
  await h.hydrate();

  assert.equal(h.mountedHeaders.length, 1, 'downloader must not trigger a second header initialization');
  assert.equal(h.page.$el, originalRoot, 'the original server-rendered root must be retained');
  assert.equal(h.doc.getElementById('biliMainHeader'), originalHeader);
  assert.equal(originalHeader.outerHTML, originalHeaderHTML);
  assert.deepEqual(h.initializedTargets, [originalHeader]);
  assert.equal(originalRoot.hasAttribute('data-server-rendered'), false);

  // The matching Vue tree makes no child insertions. Removing the root's SSR
  // attribute must itself wake the downloader; waiting only on childList stalls.
  await until(() => h.doc.getElementById('bnd-download-entry')?.isConnected, 'download entry after hydration');
  assert.equal(h.doc.querySelectorAll('#bnd-download-entry').length, 1);
  const host = h.doc.getElementById('bnd-panel-host');
  assert.equal(h.doc.querySelector('.video-toolbar-container').nextElementSibling, host);
  assert.equal(host.hidden, true);
  assert.equal(h.doc.getElementById('biliMainHeader'), originalHeader);
  assert.equal(originalHeader.outerHTML, originalHeaderHTML);
  assert.equal(h.networkRequests, 0);
});
}
