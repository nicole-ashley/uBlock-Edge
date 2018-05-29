/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-2018 The uBlock Origin authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// For background page

'use strict';

/******************************************************************************/

(function() {

/******************************************************************************/
/******************************************************************************/

var vAPI = self.vAPI = self.vAPI || {};

var browser = self.browser;
var manifest = browser.runtime.getManifest();

vAPI.cantWebsocket =
    browser.webRequest.ResourceType instanceof Object === false  ||
    browser.webRequest.ResourceType.WEBSOCKET !== 'websocket';

vAPI.lastError = function() {
    return browser.runtime.lastError;
};

// https://github.com/gorhill/uBlock/issues/875
// https://code.google.com/p/chromium/issues/detail?id=410868#c8
//   Must not leave `lastError` unchecked.
vAPI.resetLastError = function() {
    void browser.runtime.lastError;
};

vAPI.supportsUserStylesheets = vAPI.webextFlavor.soup.has('user_stylesheet');
// The real actual webextFlavor value may not be set in stone, so listen
// for possible future changes.
window.addEventListener('webextFlavor', function() {
    vAPI.supportsUserStylesheets =
        vAPI.webextFlavor.soup.has('user_stylesheet');
}, { once: true });

vAPI.insertCSS = function(tabId, details) {
    return browser.tabs.insertCSS(tabId, details, vAPI.resetLastError);
};

var noopFunc = function(){};

/******************************************************************************/

vAPI.app = {
    name: manifest.name.replace(' dev build', ''),
    version: manifest.version
};

/******************************************************************************/

vAPI.app.restart = function() {
    browser.runtime.reload && browser.runtime.reload();
};

/******************************************************************************/
/******************************************************************************/

// browser.storage.local.get(null, function(bin){ console.debug('%o', bin); });

vAPI.storage = browser.storage.local;

// Edge got unlimited local storage at the same time as it got sync storage
var hasUnlimitedLocalStorage = browser.storage.sync instanceof Object;
vAPI.cacheStorage = hasUnlimitedLocalStorage ? browser.storage.local : (function() {
    const STORAGE_NAME = 'uBlockStorage';
    const db = getDb();

    return {get, set, remove, clear, getBytesInUse};

    function get(key, callback) {
        let promise;

        if (key === null) {
            promise = getAllFromDb();
        } else if (typeof key === 'string') {
            promise = getFromDb(key).then(result => [result]);
        } else if (typeof key === 'object') {
            const keys = Array.isArray(key) ? [].concat(key) : Object.keys(key);
            const requests = keys.map(key => getFromDb(key));
            promise = Promise.all(requests);
        } else {
            promise = Promise.resolve([]);
        }

        promise.then(results => convertResultsToHash(results))
            .then((converted) => {
                if (typeof key === 'object' && !Array.isArray(key)) {
                    callback(Object.assign({}, key, converted));
                } else {
                    callback(converted);
                }
            })
            .catch((e) => {
                browser.runtime.lastError = e;
                callback(null);
            });
    }

    function set(data, callback) {
        const requests = Object.keys(data).map(
            key => putToDb(key, data[key])
        );

        Promise.all(requests)
            .then(() => callback && callback())
            .catch(e => (browser.runtime.lastError = e, callback && callback()));
    }

    function remove(key, callback) {
        const keys = [].concat(key);
        const requests = keys.map(key => deleteFromDb(key));

        Promise.all(requests)
            .then(() => callback && callback())
            .catch(e => (browser.runtime.lastError = e, callback && callback()));
    }

    function clear(callback) {
        clearDb()
            .then(() => callback && callback())
            .catch(e => (browser.runtime.lastError = e, callback && callback()));
    }

    function getBytesInUse(keys, callback) {
        // TODO: implement this
        callback(0);
    }

    function getDb() {
        const openRequest = window.indexedDB.open(STORAGE_NAME, 1);
        openRequest.onupgradeneeded = upgradeSchema;
        return convertToPromise(openRequest).then((db) => {
            db.onerror = console.error;
            return db;
        });
    }

    function upgradeSchema(event) {
        const db = event.target.result;
        db.onerror = (error) => console.error('[storage] Error updating IndexedDB schema:', error);

        const objectStore = db.createObjectStore(STORAGE_NAME, {keyPath: 'key'});
        objectStore.createIndex('value', 'value', {unique: false});
    }

    function getNewTransaction(mode = 'readonly') {
        return db.then(db => db.transaction(STORAGE_NAME, mode).objectStore(STORAGE_NAME));
    }

    function getFromDb(key) {
        return getNewTransaction()
            .then(store => store.get(key))
            .then(request => convertToPromise(request));
    }

    function getAllFromDb() {
        return getNewTransaction()
            .then((store) => {
                return new Promise((resolve, reject) => {
                    const request = store.openCursor();
                    const output = [];

                    request.onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (cursor) {
                            output.push(cursor.value);
                            cursor.continue();
                        } else {
                            resolve(output);
                        }
                    };

                    request.onerror = reject;
                });
            });
    }

    function putToDb(key, value) {
        return getNewTransaction('readwrite')
            .then(store => store.put({key, value}))
            .then(request => convertToPromise(request));
    }

    function deleteFromDb(key) {
        return getNewTransaction('readwrite')
            .then(store => store.delete(key))
            .then(request => convertToPromise(request));
    }

    function clearDb() {
        return getNewTransaction('readwrite')
            .then(store => store.clear())
            .then(request => convertToPromise(request));
    }

    function convertToPromise(eventTarget) {
        return new Promise((resolve, reject) => {
            eventTarget.onsuccess = () => resolve(eventTarget.result);
            eventTarget.onerror = reject;
        });
    }

    function convertResultsToHash(results) {
        return results.reduce((output, item) => {
            if (item) {
                output[item.key] = item.value;
            }
            return output;
        }, {});
    }
}());

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uMatrix/issues/234
// https://developer.chrome.com/extensions/privacy#property-network

// 2015-08-12: Wrapped Chrome API in try-catch statements. I had a fluke
// event in which it appeared Chrome 46 decided to restart uBlock (for
// unknown reasons) and again for unknown reasons the browser acted as if
// uBlock did not declare the `privacy` permission in its manifest, putting
// uBlock in a bad, non-functional state -- because call to `browser.privacy`
// API threw an exception.

// https://github.com/gorhill/uBlock/issues/2048 
//   Do not mess up with existing settings if not assigning them stricter 
//   values. 

vAPI.browserSettings = (function() {
    // Not all platforms support `browser.privacy`.
    if ( browser.privacy instanceof Object === false ) {
        return;
    }

    return {
        webRTCSupported: !!self.RTCPeerConnection,

        // https://github.com/gorhill/uBlock/issues/875
        // Must not leave `lastError` unchecked.
        noopCallback: function() {
            void browser.runtime.lastError;
        },

        // Calling with `true` means IP address leak is not prevented.
        // https://github.com/gorhill/uBlock/issues/533
        //   We must first check wether this Chromium-based browser was compiled
        //   with WebRTC support. To do this, we use an iframe, this way the
        //   empty RTCPeerConnection object we create to test for support will
        //   be properly garbage collected. This prevents issues such as
        //   a computer unable to enter into sleep mode, as reported in the
        //   Chrome store:
        // https://github.com/gorhill/uBlock/issues/533#issuecomment-167931681
        setWebrtcIPAddress: function(setting) {
            // We don't know yet whether this browser supports WebRTC: find out.
            if ( this.webRTCSupported === undefined ) {
                // If asked to leave WebRTC setting alone at this point in the
                // code, this means we never grabbed the setting in the first
                // place.
                if ( setting ) { return; }
                this.webRTCSupported = { setting: setting };
                var iframe = document.createElement('iframe');
                var me = this;
                var messageHandler = function(ev) {
                    if ( ev.origin !== self.location.origin ) {
                        return;
                    }
                    window.removeEventListener('message', messageHandler);
                    var setting = me.webRTCSupported.setting;
                    me.webRTCSupported = ev.data === 'webRTCSupported';
                    me.setWebrtcIPAddress(setting);
                    iframe.parentNode.removeChild(iframe);
                    iframe = null;
                };
                window.addEventListener('message', messageHandler);
                iframe.src = 'is-webrtc-supported.html';
                document.body.appendChild(iframe);
                return;
            }

            // We are waiting for a response from our iframe. This makes the code
            // safe to re-entrancy.
            if ( typeof this.webRTCSupported === 'object' ) {
                this.webRTCSupported.setting = setting;
                return;
            }

            // https://github.com/gorhill/uBlock/issues/533
            // WebRTC not supported: `webRTCMultipleRoutesEnabled` can NOT be
            // safely accessed. Accessing the property will cause full browser
            // crash.
            if ( this.webRTCSupported !== true ) {
                return;
            }

            var cp = browser.privacy,
                cpn = cp.network;

            // Older version of Chromium do not support this setting, and is
            // marked as "deprecated" since Chromium 48.
            if ( typeof cpn.webRTCMultipleRoutesEnabled === 'object' ) {
                try {
                    if ( setting ) {
                        cpn.webRTCMultipleRoutesEnabled.clear({
                            scope: 'regular'
                        }, vAPI.resetLastError);
                    } else {
                        cpn.webRTCMultipleRoutesEnabled.set({
                            value: false,
                            scope: 'regular'
                        }, vAPI.resetLastError);
                    }
                } catch(ex) {
                    console.error(ex);
                }
            }

            // This setting became available in Chromium 48.
            if ( typeof cpn.webRTCIPHandlingPolicy === 'object' ) {
                try {
                    if ( setting ) {
                        cpn.webRTCIPHandlingPolicy.clear({
                            scope: 'regular'
                        }, vAPI.resetLastError);
                    } else {
                        // https://github.com/uBlockOrigin/uAssets/issues/333#issuecomment-289426678
                        // - Leverage virtuous side-effect of strictest setting.
                        cpn.webRTCIPHandlingPolicy.set({
                            value: 'disable_non_proxied_udp',
                            scope: 'regular'
                        }, vAPI.resetLastError);
                    }
                } catch(ex) {
                    console.error(ex);
                }
            }
        },

        set: function(details) {
            for ( var setting in details ) {
                if ( details.hasOwnProperty(setting) === false ) {
                    continue;
                }
                switch ( setting ) {
                case 'prefetching':
                    try {
                        if ( !!details[setting] ) {
                            browser.privacy.network.networkPredictionEnabled.clear({
                                scope: 'regular'
                            }, vAPI.resetLastError);
                        } else {
                            browser.privacy.network.networkPredictionEnabled.set({
                                value: false,
                                scope: 'regular'
                            }, vAPI.resetLastError);
                        }
                    } catch(ex) {
                        console.error(ex);
                    }
                    break;

                case 'hyperlinkAuditing':
                    try {
                        if ( !!details[setting] ) {
                            browser.privacy.websites.hyperlinkAuditingEnabled.clear({
                                scope: 'regular'
                            }, vAPI.resetLastError);
                        } else {
                            browser.privacy.websites.hyperlinkAuditingEnabled.set({
                                value: false,
                                scope: 'regular'
                            }, vAPI.resetLastError);
                        }
                    } catch(ex) {
                        console.error(ex);
                    }
                    break;

                case 'webrtcIPAddress':
                    this.setWebrtcIPAddress(!!details[setting]);
                    break;

                default:
                    break;
                }
            }
        }
    };
})();

/******************************************************************************/
/******************************************************************************/

vAPI.tabs = {};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3546
//   Added a new flavor of behind-the-scene tab id: vAPI.anyTabId.
//   vAPI.anyTabId will be used for network requests which can be filtered,
//   because they comes with enough contextual information. It's just not
//   possible to pinpoint exactly from which tab it comes from. For example,
//   with Firefox/webext, the `documentUrl` property is available for every
//   network requests.

vAPI.isBehindTheSceneTabId = function(tabId) {
    return tabId < 0;
};

vAPI.unsetTabId = 0;
vAPI.noTabId = -1;      // definitely not any existing tab
vAPI.anyTabId = -2;     // one of the existing tab

/******************************************************************************/

// To remove when tabId-as-integer has been tested enough.

var toEdgeTabId = function(tabId) {
    return typeof tabId === 'number' && !isNaN(tabId) && tabId > 0 ?
        tabId :
        0;
};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    var onNavigationClient = this.onNavigation || noopFunc;
    var onUpdatedClient = this.onUpdated || noopFunc;

    // https://developer.chrome.com/extensions/webNavigation
    // [onCreatedNavigationTarget ->]
    //  onBeforeNavigate ->
    //  onCommitted ->
    //  onDOMContentLoaded ->
    //  onCompleted

    // The browser.webRequest.onBeforeRequest() won't be called for everything
    // else than `http`/`https`. Thus, in such case, we will bind the tab as
    // early as possible in order to increase the likelihood of a context
    // properly setup if network requests are fired from within the tab.
    // Example: Chromium + case #6 at
    //          http://raymondhill.net/ublock/popup.html
    var reGoodForWebRequestAPI = /^https?:\/\//;

    // https://forums.lanik.us/viewtopic.php?f=62&t=32826 
    //   Chromium-based browsers: sanitize target URL. I've seen data: URI with
    //   newline characters in standard fields, possibly as a way of evading
    //   filters. As per spec, there should be no whitespaces in a data: URI's
    //   standard fields.
    var sanitizeURL = function(url) {
        if ( url.startsWith('data:') === false ) { return url; }
        var pos = url.indexOf(',');
        if ( pos === -1 ) { return url; }
        var s = url.slice(0, pos);
        if ( s.search(/\s/) === -1 ) { return url; }
        return s.replace(/\s+/, '') + url.slice(pos);
    }; 

    var onCreatedNavigationTarget = function(details) {
        if ( typeof details.url !== 'string' ) {
            details.url = '';
        }
        if ( reGoodForWebRequestAPI.test(details.url) === false ) {
            details.frameId = 0;
            details.url = sanitizeURL(details.url);
            onNavigationClient(details);
        }
        if ( typeof vAPI.tabs.onPopupCreated === 'function' ) {
            vAPI.tabs.onPopupCreated(
                details.tabId,
                details.sourceTabId
            );
        }
    };

    var onBeforeNavigate = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
    };

    var onCommitted = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
        details.url = sanitizeURL(details.url);
        onNavigationClient(details);
    };

    var onActivated = function(details) {
        if ( vAPI.contextMenu instanceof Object ) {
            vAPI.contextMenu.onMustUpdate(details.tabId);
        }
    };

    // https://github.com/gorhill/uBlock/issues/3073
    // - Fall back to `tab.url` when `changeInfo.url` is not set.
    var onUpdated = function(tabId, changeInfo, tab) {
        if ( typeof changeInfo.url !== 'string' ) {
            changeInfo.url = tab && tab.url;
        }
        if ( changeInfo.url ) {
            changeInfo.url = sanitizeURL(changeInfo.url);
        }
        onUpdatedClient(tabId, changeInfo, tab);
    };

    browser.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    browser.webNavigation.onCommitted.addListener(onCommitted);
    // Not supported on Firefox WebExtensions yet.
    if ( browser.webNavigation.onCreatedNavigationTarget instanceof Object ) {
        browser.webNavigation.onCreatedNavigationTarget.addListener(onCreatedNavigationTarget);
    }
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);

    if ( typeof this.onClosed === 'function' ) {
        browser.tabs.onRemoved.addListener(this.onClosed);
    }

};

/******************************************************************************/

// Caller must be prepared to deal with nil tab argument.

// https://code.google.com/p/chromium/issues/detail?id=410868#c8

vAPI.tabs.get = function(tabId, callback) {
    if ( tabId === null ) {
        browser.tabs.query(
            { active: true, currentWindow: true },
            function(tabs) {
                void browser.runtime.lastError;
                callback(
                    Array.isArray(tabs) && tabs.length !== 0 ? tabs[0] : null
                );
            }
        );
        return;
    }

    tabId = toEdgeTabId(tabId);
    if ( tabId === 0 ) {
        callback(null);
        return;
    }

    browser.tabs.get(tabId, function(tab) {
        void browser.runtime.lastError;
        callback(tab);
    });
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true, // if a tab is already opened with that url, then select it instead of opening a new one
//   popup: true // open in a new window

vAPI.tabs.open = function(details) {
    var targetURL = details.url;
    if ( typeof targetURL !== 'string' || targetURL === '' ) {
        return null;
    }

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    // dealing with Chrome's asynchronous API
    var wrapper = function() {
        if ( details.active === undefined ) {
            details.active = true;
        }

        var subWrapper = function() {
            var _details = {
                url: targetURL,
                active: !!details.active
            };

            // Opening a tab from incognito window won't focus the window
            // in which the tab was opened
            var focusWindow = function(tab) {
                if ( tab.active ) {
                    browser.windows.update(tab.windowId, { focused: true });
                }
            };

            if ( !details.tabId ) {
                if ( details.index !== undefined ) {
                    _details.index = details.index;
                }

                browser.tabs.create(_details, focusWindow);
                return;
            }

            // update doesn't accept index, must use move
            browser.tabs.update(toEdgeTabId(details.tabId), _details, function(tab) {
                // if the tab doesn't exist
                if ( vAPI.lastError() ) {
                    browser.tabs.create(_details, focusWindow);
                } else if ( details.index !== undefined ) {
                    browser.tabs.move(tab.id, {index: details.index});
                }
            });
        };

        // Open in a standalone window
        if ( details.popup === true ) {
            browser.windows.create({ url: details.url, type: 'popup' });
            return;
        }

        if ( details.index !== -1 ) {
            subWrapper();
            return;
        }

        vAPI.tabs.get(null, function(tab) {
            if ( tab ) {
                details.index = tab.index + 1;
            } else {
                delete details.index;
            }

            subWrapper();
        });
    };

    if ( !details.select ) {
        wrapper();
        return;
    }

    // https://github.com/gorhill/uBlock/issues/3053#issuecomment-332276818
    // - Do not try to lookup uBO's own pages with FF 55 or less.
    if (
        vAPI.webextFlavor.soup.has('firefox') &&
        vAPI.webextFlavor.major < 56
    ) {
        wrapper();
        return;
    }

    // https://developer.chrome.com/extensions/tabs#method-query
    // "Note that fragment identifiers are not matched."
    // It's a lie, fragment identifiers ARE matched. So we need to remove the
    // fragment.
    var pos = targetURL.indexOf('#'),
        targetURLWithoutHash = pos === -1 ? targetURL : targetURL.slice(0, pos);

    browser.tabs.query({ url: targetURLWithoutHash }, function(tabs) {
        void browser.runtime.lastError;
        var tab = Array.isArray(tabs) && tabs[0];
        if ( !tab ) {
            wrapper();
            return;
        }
        var _details = {
            active: true,
            url: undefined
        };
        if ( targetURL !== tab.url ) {
            _details.url = targetURL;
        }
        browser.tabs.update(tab.id, _details, function(tab) {
            browser.windows.update(tab.windowId, { focused: true });
        });
    });
};

/******************************************************************************/

// Replace the URL of a tab. Noop if the tab does not exist.

vAPI.tabs.replace = function(tabId, url) {
    tabId = toEdgeTabId(tabId);
    if ( tabId === 0 ) { return; }

    var targetURL = url;

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    browser.tabs.update(tabId, { url: targetURL }, vAPI.resetLastError);
};

/******************************************************************************/

vAPI.tabs.remove = function(tabId) {
    tabId = toEdgeTabId(tabId);
    if ( tabId === 0 ) { return; }

    browser.tabs.remove(tabId, vAPI.resetLastError);
};

/******************************************************************************/

vAPI.tabs.reload = function(tabId, bypassCache) {
    tabId = toEdgeTabId(tabId);
    if ( tabId === 0 ) { return; }

    if ( typeof browser.tabs.reload === 'function' ) {
        browser.tabs.reload(
            tabId,
            { bypassCache: bypassCache === true },
            vAPI.resetLastError
        );
    } else {
        // Workaround for Edge 16
        // see: https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/reload#Browser_compatibility
        // and: https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/9107382/
        browser.tabs.get(tabId, function (tab) {
            if ( browser.tabs.lastError ) {
                vAPI.resetLastError();
                return;
            }
            if ( !tab ) {
                return;
            }
            vAPI.tabs.injectScript(tabId, {code: `window.location.reload(${!!bypassCache})`});
        });
    }
};

/******************************************************************************/

// Select a specific tab.

vAPI.tabs.select = function(tabId) {
    tabId = toEdgeTabId(tabId);
    if ( tabId === 0 ) { return; }

    browser.tabs.update(tabId, { active: true }, function(tab) {
        void browser.runtime.lastError;
        if ( !tab ) { return; }
        browser.windows.update(tab.windowId, { focused: true });
    });
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {
    var onScriptExecuted = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        void browser.runtime.lastError;
        if ( typeof callback === 'function' ) {
            callback();
        }
    };
    if ( tabId ) {
        browser.tabs.executeScript(toEdgeTabId(tabId), details, onScriptExecuted);
    } else {
        browser.tabs.executeScript(details, onScriptExecuted);
    }
};

/******************************************************************************/
/******************************************************************************/

// Must read: https://code.google.com/p/chromium/issues/detail?id=410868#c8

// https://github.com/chrisaljoudi/uBlock/issues/19
// https://github.com/chrisaljoudi/uBlock/issues/207
// Since we may be called asynchronously, the tab id may not exist
// anymore, so this ensures it does still exist.

// https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/browserAction#Browser_compatibility
//   Firefox for Android does no support browser.browserAction.setIcon().
//   Performance: use ImageData for platforms supporting it.

// https://github.com/uBlockOrigin/uBlock-issues/issues/32
//   Ensure ImageData for toolbar icon is valid before use.

vAPI.setIcon = (function() {
    let browserAction = browser.browserAction,
        titleTemplate = browser.runtime.getManifest().name + ' ({badge})';
    let icons = [
        // Yes, the mis-matches sizes are intentional. Edge only allows 19 and 38 as properties,
        // but 16 and 32 images work just fine.
        {
            path: { '19': 'img/icon_16-off.png', '38': 'img/icon_32-off.png' }
        },
        {
            path: { '19': 'img/icon_16.png', '38': 'img/icon_32.png' }
        }
    ];

    (function() {
        if ( browserAction.setIcon === undefined ) { return; }

        // The global badge background color.
        if ( browserAction.setBadgeBackgroundColor !== undefined ) {
            browserAction.setBadgeBackgroundColor({
                color: [ 0x66, 0x66, 0x66, 0xFF ]
            });
        }

        // As of 2018-05, benchmarks show that only Chromium benefits for sure
        // from using ImageData.
        //
        // Chromium creates a new ImageData instance every call to setIcon
        // with paths:
        // https://cs.chromium.org/chromium/src/extensions/renderer/resources/set_icon.js?l=56&rcl=99be185c25738437ecfa0dafba72a26114196631
        //
        // Firefox uses an internal cache for each setIcon's paths:
        // https://searchfox.org/mozilla-central/rev/5ff2d7683078c96e4b11b8a13674daded935aa44/browser/components/extensions/parent/ext-browserAction.js#631
        if ( vAPI.webextFlavor.soup.has('chromium') === false ) { return; }

        let imgs = [
            { i: 0, p: '16' }, { i: 0, p: '32' },
            { i: 1, p: '16' }, { i: 1, p: '32' },
        ];
        let onLoaded = function() {
            for ( let img of imgs ) {
                if ( img.r.complete === false ) { return; }
            }
            let ctx = document.createElement('canvas').getContext('2d');
            let iconData = [ null, null ];
            for ( let img of imgs ) {
                let w = img.r.naturalWidth, h = img.r.naturalHeight;
                ctx.width = w; ctx.height = h;
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(img.r, 0, 0);
                if ( iconData[img.i] === null ) { iconData[img.i] = {}; }
                let imgData = ctx.getImageData(0, 0, w, h);
                if (
                    imgData instanceof Object === false ||
                    imgData.data instanceof Uint8ClampedArray === false ||
                    imgData.data[0] !== 0 ||
                    imgData.data[1] !== 0 ||
                    imgData.data[2] !== 0 ||
                    imgData.data[3] !== 0
                ) {
                    return;
                }
                iconData[img.i][img.p] = imgData;
            }
            icons[0] = { tabId: 0, imageData: iconData[0] };
            icons[1] = { tabId: 0, imageData: iconData[1] };
        };
        for ( let img of imgs ) {
            img.r = new Image();
            img.r.addEventListener('load', onLoaded, { once: true });
            img.r.src = icons[img.i].path[img.p];
        }
    })();

    var onTabReady = function(tab, state, badge, parts) {
        if ( vAPI.lastError() || !tab ) { return; }

        if ( browserAction.setIcon !== undefined ) {
            if ( parts === undefined || (parts & 0x01) !== 0 ) {
                icons[state].tabId = tab.id;
                // Somewhere (quite possibly in Edge's engine itself) the tabId property
                // is being assigned to the path object. If we pass by reference then it
                // gets passed in future calls, and then Edge complains about the
                // unsupported tabId property. Cloning solves this issue.
                const icon = Object.assign({}, icons[state]);
                icon.path = Object.assign({}, icon.path);
                browserAction.setIcon(icon);
            }
            browserAction.setBadgeText({ tabId: tab.id, text: badge });
        }

        if ( browserAction.setTitle !== undefined ) {
            browserAction.setTitle({
                tabId: tab.id,
                title: titleTemplate.replace(
                    '{badge}',
                    state === 1 ? (badge !== '' ? badge : '0') : 'off'
                )
            });
        }
    };

    // parts: bit 0 = icon
    //        bit 1 = badge

    return function(tabId, state, badge, parts) {
        tabId = toEdgeTabId(tabId);
        if ( tabId === 0 ) { return; }

        browser.tabs.get(tabId, function(tab) {
            onTabReady(tab, state, badge, parts);
        });

        if ( vAPI.contextMenu instanceof Object ) {
            vAPI.contextMenu.onMustUpdate(tabId);
        }
    };
})();

browser.browserAction.onClicked.addListener(function(tab) {
    vAPI.tabs.open({
        select: true,
        url: 'popup.html?tabId=' + tab.id + '&mobile=1'
    });
});

/******************************************************************************/
/******************************************************************************/

vAPI.messaging = {
    ports: new Map(),
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: noopFunc,
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onPortMessage = (function() {
    var messaging = vAPI.messaging;

    // Use a wrapper to avoid closure and to allow reuse.
    var CallbackWrapper = function(port, request) {
        this.callback = this.proxy.bind(this); // bind once
        this.init(port, request);
    };

    CallbackWrapper.prototype = {
        init: function(port, request) {
            this.port = port;
            this.request = request;
            return this;
        },
        proxy: function(response) {
            // https://github.com/chrisaljoudi/uBlock/issues/383
            if ( messaging.ports.has(this.port.name) ) {
                this.port.postMessage({
                    auxProcessId: this.request.auxProcessId,
                    channelName: this.request.channelName,
                    msg: response !== undefined ? response : null
                });
            }
            // Mark for reuse
            this.port = this.request = null;
            callbackWrapperJunkyard.push(this);
        }
    };

    var callbackWrapperJunkyard = [];

    var callbackWrapperFactory = function(port, request) {
        var wrapper = callbackWrapperJunkyard.pop();
        if ( wrapper ) {
            return wrapper.init(port, request);
        }
        return new CallbackWrapper(port, request);
    };

    var toFramework = function(request, port, callback) {
        var sender = port && port.sender;
        if ( !sender ) { return; }
        var tabId = sender.tab && sender.tab.id || undefined;
        var msg = request.msg,
            toPort;
        switch ( msg.what ) {
            case 'connectionAccepted':
            case 'connectionRefused':
                toPort = messaging.ports.get(msg.fromToken);
                if ( toPort !== undefined ) {
                    msg.tabId = tabId;
                    toPort.postMessage(request);
                } else {
                    msg.what = 'connectionBroken';
                    port.postMessage(request);
                }
                break;
            case 'connectionRequested':
                msg.tabId = tabId;
                for ( toPort of messaging.ports.values() ) {
                    toPort.postMessage(request);
                }
                break;
            case 'connectionBroken':
            case 'connectionCheck':
            case 'connectionMessage':
                toPort = messaging.ports.get(
                    port.name === msg.fromToken ? msg.toToken : msg.fromToken
                );
                if ( toPort !== undefined ) {
                    msg.tabId = tabId;
                    toPort.postMessage(request);
                } else {
                    msg.what = 'connectionBroken';
                    port.postMessage(request);
                }
                break;
            case 'userCSS':
                if ( tabId === undefined ) { break; }
                var details = {
                    code: undefined,
                    frameId: sender.frameId,
                    matchAboutBlank: true
                };
                if ( vAPI.supportsUserStylesheets ) {
                    details.cssOrigin = 'user';
                }
                if ( msg.add ) {
                    details.runAt = 'document_start';
                }
                var cssText;
                var countdown = 0;
                var countdownHandler = function() {
                    void browser.runtime.lastError;
                    countdown -= 1;
                    if ( countdown === 0 && typeof callback === 'function' ) {
                        callback();
                    }
                };
                for ( cssText of msg.add ) {
                    countdown += 1;
                    details.code = cssText;
                    try {
                        browser.tabs.insertCSS(tabId, details, countdownHandler);
                    } catch (e) {
                        // Sometimes Edge balks at a frameId property. If we were aiming for the top frame anyway,
                        // try again without the property altogether.
                        if ( !details.frameId ) {
                            delete details.frameId;
                            browser.tabs.insertCSS(tabId, details, countdownHandler);
                        }
                    }
                }
                if ( typeof browser.tabs.removeCSS === 'function' ) {
                    for ( cssText of msg.remove ) {
                        countdown += 1;
                        details.code = cssText;
                        browser.tabs.removeCSS(tabId, details, countdownHandler);
                    }
                }
                if ( countdown === 0 && typeof callback === 'function' ) {
                    callback();
                }
                break;
        }
    };

    // https://bugzilla.mozilla.org/show_bug.cgi?id=1392067
    //   Workaround: manually remove ports matching removed tab.
    browser.tabs.onRemoved.addListener(function(tabId) {
        for ( var port of messaging.ports.values() ) {
            var tab = port.sender && port.sender.tab;
            if ( !tab ) { continue; }
            if ( tab.id === tabId ) {
                vAPI.messaging.onPortDisconnect(port);
            }
        }
    });

    return function(request, port) {
        // prepare response
        var callback = this.NOOPFUNC;
        if ( request.auxProcessId !== undefined ) {
            callback = callbackWrapperFactory(port, request).callback;
        }

        // Content process to main process: framework handler.
        if ( request.channelName === 'vapi' ) {
            toFramework(request, port, callback);
            return;
        }

        // Auxiliary process to main process: specific handler
        var r = this.UNHANDLED,
            listener = this.listeners[request.channelName];
        if ( typeof listener === 'function' ) {
            r = listener(request.msg, port.sender, callback);
        }
        if ( r !== this.UNHANDLED ) { return; }

        // Auxiliary process to main process: default handler
        r = this.defaultHandler(request.msg, port.sender, callback);
        if ( r !== this.UNHANDLED ) { return; }

        // Auxiliary process to main process: no handler
        console.error(
            'vAPI.messaging.onPortMessage > unhandled request: %o',
            request
        );

        // Need to callback anyways in case caller expected an answer, or
        // else there is a memory leak on caller's side
        callback();
    }.bind(vAPI.messaging);
})();

/******************************************************************************/

vAPI.messaging.onPortDisconnect = function(port) {
    port.onDisconnect.removeListener(this.onPortDisconnect);
    port.onMessage.removeListener(this.onPortMessage);
    this.ports.delete(port.name);
}.bind(vAPI.messaging);

/******************************************************************************/

vAPI.messaging.onPortConnect = function(port) {
    port.onDisconnect.addListener(this.onPortDisconnect);
    port.onMessage.addListener(this.onPortMessage);
    this.ports.set(port.name, port);
}.bind(vAPI.messaging);

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    browser.runtime.onConnect.addListener(this.onPortConnect);
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    var messageWrapper = {
        broadcast: true,
        msg: message
    };
    for ( var port of this.ports.values() ) {
        port.postMessage(messageWrapper);
    }
};

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3474
// https://github.com/gorhill/uBlock/issues/2823
// - foil ability of web pages to identify uBO through
//   its web accessible resources.
// https://github.com/gorhill/uBlock/issues/3497
// - prevent web pages from interfering with uBO's element picker

(function() {
    vAPI.warSecret =
        Math.floor(Math.random() * 982451653 + 982451653).toString(36) +
        Math.floor(Math.random() * 982451653 + 982451653).toString(36);

    var key = 'secret=' + vAPI.warSecret;
    var root = vAPI.getURL('/');
    var guard = function(details) {
        if ( details.url.indexOf(key) === -1 ) {
            return { redirectUrl: root };
        }
    };

    try {
        browser.webRequest.onBeforeRequest.addListener(
            guard,
            {
                urls: [root + 'web_accessible_resources/*']
            },
            ['blocking']
        );
    } catch (e) {
        // Edge doesn't currently support extension URLs in listeners
        // Using try/catch means it should start working when support is added
    }
})();

/******************************************************************************/
/******************************************************************************/

// https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/contextMenus#Browser_compatibility
//   Firefox for Android does no support browser.contextMenus.

vAPI.contextMenu = browser.contextMenus && {
    _callback: null,
    _entries: [],
    _createEntry: function(entry) {
        browser.contextMenus.create(
            JSON.parse(JSON.stringify(entry)),
            vAPI.resetLastError
        );
    },
    onMustUpdate: function() {},
    setEntries: function(entries, callback) {
        entries = entries || [];
        var n = Math.max(this._entries.length, entries.length),
            oldEntryId, newEntry;
        for ( var i = 0; i < n; i++ ) {
            oldEntryId = this._entries[i];
            newEntry = entries[i];
            if ( oldEntryId && newEntry ) {
                if ( newEntry.id !== oldEntryId ) {
                    browser.contextMenus.remove(oldEntryId);
                    this._createEntry(newEntry);
                    this._entries[i] = newEntry.id;
                }
            } else if ( oldEntryId && !newEntry ) {
                browser.contextMenus.remove(oldEntryId);
            } else if ( !oldEntryId && newEntry ) {
                this._createEntry(newEntry);
                this._entries[i] = newEntry.id;
            }
        }
        n = this._entries.length = entries.length;
        callback = callback || null;
        if ( callback === this._callback ) {
            return;
        }
        if ( n !== 0 && callback !== null ) {
            browser.contextMenus.onClicked.addListener(callback);
            this._callback = callback;
        } else if ( n === 0 && this._callback !== null ) {
            browser.contextMenus.onClicked.removeListener(this._callback);
            this._callback = null;
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.commands = browser.commands;

/******************************************************************************/
/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {
    // http://code.google.com/p/chromium/issues/detail?id=410868#c11
    // Need to be sure to access `vAPI.lastError()` to prevent
    // spurious warnings in the console.
    var onScriptInjected = function() {
        vAPI.lastError();
    };
    var scriptStart = function(tabId) {
        var manifest = browser.runtime.getManifest();
        if ( manifest instanceof Object === false ) { return; }
        for ( var contentScript of manifest.content_scripts ) {
            for ( var file of contentScript.js ) {
                vAPI.tabs.injectScript(tabId, {
                    file: file,
                    allFrames: contentScript.all_frames,
                    runAt: contentScript.run_at
                }, onScriptInjected);
            }
        }
    };
    var bindToTabs = function(tabs) {
        var µb = µBlock;
        var i = tabs.length, tab;
        while ( i-- ) {
            tab = tabs[i];
            µb.tabContextManager.commit(tab.id, tab.url);
            µb.bindTabToPageStats(tab.id);
            // https://github.com/chrisaljoudi/uBlock/issues/129
            if ( /^https?:\/\//.test(tab.url) ) {
                scriptStart(tab.id);
            }
        }
    };

    browser.tabs.query({ url: '<all_urls>' }, bindToTabs);
};

/******************************************************************************/
/******************************************************************************/

vAPI.punycodeHostname = function(hostname) {
    return hostname;
};

vAPI.punycodeURL = function(url) {
    return url;
};

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/531
// Storage area dedicated to admin settings. Read-only.

// https://github.com/gorhill/uBlock/commit/43a5ed735b95a575a9339b6e71a1fcb27a99663b#commitcomment-13965030
// Not all Chromium-based browsers support managed storage. Merely testing or
// exception handling in this case does NOT work: I don't know why. The
// extension on Opera ends up in a non-sensical state, whereas vAPI become
// undefined out of nowhere. So only solution left is to test explicitly for
// Opera.
// https://github.com/gorhill/uBlock/issues/900
// Also, UC Browser: http://www.upsieutoc.com/image/WXuH

vAPI.adminStorage = browser.storage.managed && {
    getItem: function(key, callback) {
        var onRead = function(store) {
            var data;
            if (
                !browser.runtime.lastError &&
                typeof store === 'object' &&
                store !== null
            ) {
                data = store[key];
            }
            callback(data);
        };
        try {
            browser.storage.managed.get(key, onRead);
        } catch (ex) {
            callback();
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.cloud = (function() {
    var chunkCountPerFetch = 16; // Must be a power of 2

    // Mind browser.storage.sync.MAX_ITEMS (512 at time of writing)
    var maxChunkCountPerItem = Math.floor(512 * 0.75) & ~(chunkCountPerFetch - 1);

    // Mind browser.storage.sync.QUOTA_BYTES_PER_ITEM (8192 at time of writing)
    // https://github.com/gorhill/uBlock/issues/3006
    //  For Firefox, we will use a lower ratio to allow for more overhead for
    //  the infrastructure. Unfortunately this leads to less usable space for
    //  actual data, but all of this is provided for free by browser vendors,
    //  so we need to accept and deal with these limitations.
    var evalMaxChunkSize = function() {
        return Math.floor(
            (browser.storage.sync.QUOTA_BYTES_PER_ITEM || 8192) *
            (vAPI.webextFlavor.soup.has('firefox') ? 0.6 : 0.75)
        );
    };

    var maxChunkSize = evalMaxChunkSize();

    // The real actual webextFlavor value may not be set in stone, so listen
    // for possible future changes.
    window.addEventListener('webextFlavor', function() {
        maxChunkSize = evalMaxChunkSize();
    }, { once: true });

    // Mind browser.storage.sync.QUOTA_BYTES (128 kB at time of writing)
    // Firefox:
    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/storage/sync
    // > You can store up to 100KB of data using this API/
    var maxStorageSize = browser.storage.sync.QUOTA_BYTES || 102400;

    var options = {
        defaultDeviceName: window.navigator.platform,
        deviceName: vAPI.localStorage.getItem('deviceName') || ''
    };

    // This is used to find out a rough count of how many chunks exists:
    // We "poll" at specific index in order to get a rough idea of how
    // large is the stored string.
    // This allows reading a single item with only 2 sync operations -- a
    // good thing given browser.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE
    // and browser.storage.sync.MAX_WRITE_OPERATIONS_PER_HOUR.

    var getCoarseChunkCount = function(dataKey, callback) {
        var bin = {};
        for ( var i = 0; i < maxChunkCountPerItem; i += 16 ) {
            bin[dataKey + i.toString()] = '';
        }

        browser.storage.sync.get(bin, function(bin) {
            if ( browser.runtime.lastError ) {
                callback(0, browser.runtime.lastError.message);
                return;
            }

            var chunkCount = 0;
            for ( var i = 0; i < maxChunkCountPerItem; i += 16 ) {
                if ( bin[dataKey + i.toString()] === '' ) {
                    break;
                }
                chunkCount = i + 16;
            }

            callback(chunkCount);
        });
    };

    var deleteChunks = function(dataKey, start) {
        var keys = [];

        // No point in deleting more than:
        // - The max number of chunks per item
        // - The max number of chunks per storage limit
        var n = Math.min(
            maxChunkCountPerItem,
            Math.ceil(maxStorageSize / maxChunkSize)
        );
        for ( var i = start; i < n; i++ ) {
            keys.push(dataKey + i.toString());
        }
        if ( keys.length !== 0 ) {
            browser.storage.sync.remove(keys);
        }
    };

    var start = function(/* dataKeys */) {
    };

    var push = function(dataKey, data, callback) {

        var bin = {
            'source': options.deviceName || options.defaultDeviceName,
            'tstamp': Date.now(),
            'data': data,
            'size': 0
        };
        bin.size = JSON.stringify(bin).length;
        var item = JSON.stringify(bin);

        // Chunkify taking into account QUOTA_BYTES_PER_ITEM:
        //   https://developer.chrome.com/extensions/storage#property-sync
        //   "The maximum size (in bytes) of each individual item in sync
        //   "storage, as measured by the JSON stringification of its value
        //   "plus its key length."
        bin = {};
        var chunkCount = Math.ceil(item.length / maxChunkSize);
        for ( var i = 0; i < chunkCount; i++ ) {
            bin[dataKey + i.toString()] = item.substr(i * maxChunkSize, maxChunkSize);
        }
        bin[dataKey + i.toString()] = ''; // Sentinel

        browser.storage.sync.set(bin, function() {
            var errorStr;
            if ( browser.runtime.lastError ) {
                errorStr = browser.runtime.lastError.message;
                // https://github.com/gorhill/uBlock/issues/3006#issuecomment-332597677
                // - Delete all that was pushed in case of failure.
                // - It's unknown whether such issue applies only to Firefox:
                //   until such cases are reported for other browsers, we will
                //   reset the (now corrupted) content of the cloud storage
                //   only on Firefox.
                if ( vAPI.webextFlavor.soup.has('firefox') ) {
                    chunkCount = 0;
                }
            }
            callback(errorStr);

            // Remove potentially unused trailing chunks
            deleteChunks(dataKey, chunkCount);
        });
    };

    var pull = function(dataKey, callback) {

        var assembleChunks = function(bin) {
            if ( browser.runtime.lastError ) {
                callback(null, browser.runtime.lastError.message);
                return;
            }

            // Assemble chunks into a single string.
            var json = [], jsonSlice;
            var i = 0;
            for (;;) {
                jsonSlice = bin[dataKey + i.toString()];
                if ( jsonSlice === '' ) {
                    break;
                }
                json.push(jsonSlice);
                i += 1;
            }

            var entry = null;
            try {
                entry = JSON.parse(json.join(''));
            } catch(ex) {
            }
            callback(entry);
        };

        var fetchChunks = function(coarseCount, errorStr) {
            if ( coarseCount === 0 || typeof errorStr === 'string' ) {
                callback(null, errorStr);
                return;
            }

            var bin = {};
            for ( var i = 0; i < coarseCount; i++ ) {
                bin[dataKey + i.toString()] = '';
            }

            browser.storage.sync.get(bin, assembleChunks);
        };

        getCoarseChunkCount(dataKey, fetchChunks);
    };

    var getOptions = function(callback) {
        if ( typeof callback !== 'function' ) {
            return;
        }
        callback(options);
    };

    var setOptions = function(details, callback) {
        if ( typeof details !== 'object' || details === null ) {
            return;
        }

        if ( typeof details.deviceName === 'string' ) {
            vAPI.localStorage.setItem('deviceName', details.deviceName);
            options.deviceName = details.deviceName;
        }

        getOptions(callback);
    };

    return {
        start: start,
        push: push,
        pull: pull,
        getOptions: getOptions,
        setOptions: setOptions
    };
})();

/******************************************************************************/
/******************************************************************************/

})();

/******************************************************************************/
