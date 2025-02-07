import {Pattern} from './pattern.js';
import {Color} from './color.js';

/*
  Chrome v3 (current) encrypts username/passwords using CryptoJS 3.1.2
  CryptoJS library is used to migrate preferences to v8.0 but will be removed in future upgrades
  Original CryptoJS 3.1.2 aes.js  https://cdnjs.cloudflare.com/ajax/libs/crypto-js/3.1.2/rollups/aes.js
  `export {CryptoJS};` was added to be able to import as ES6 module
*/
import {CryptoJS} from '../lib/aes.3.1.2.js';

/*
  ----- Patterns -----
  Chrome v3 (current) features full/partial url match pattern
  Firefox v4 to v7 (current) features host only match pattern
  - Migrating v4 to v7 storage data to full/partial url match pattern
  - Dropping select for http|https|all

  ----- SOCKS keyword -----
  https://developer.chrome.com/docs/extensions/reference/proxy/#proxy-rules
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo
  https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#http-proxy-scheme
  Chrome PAC schemes  PROXY | HTTPS | SOCKS4/SOCKS | SOCKS5
  Chrome API schemes  http | https | socks4 | socks5

  Firefox PAC schemes PROXY/HTTP | HTTPS | SOCKS4/SOCKS | SOCKS5
  Firefox API types   http | https | socks4 | socks (means socks5) | direct

  Firefox/Chrome PAC 'SOCKS' means SOCKS4
  Firefox API 'SOCKS' means SOCKS5
  Code uses PAC 'SOCKS4/5' but converts to socks in Firefox PAC

  ----- host/hostname keywords -----
  Firefox/Chrome API/PAC use 'host' for domain/ip
  JavaScript uses 'hostname' for for domain/ip & 'host' for domain:port/ip:port
  Code uses JavaScript 'hostname' domain/ip
*/

export class Migrate {

  static async init(pref) {
    switch (true) {
      case pref.hasOwnProperty('settings'):
        pref = this.convert3(pref);

      default:
        pref = this.convert7(pref);
    }

    // --- update database
    await browser.storage.local.clear();
    await browser.storage.local.set(pref);
    return pref;
  }

  static decrypt(str, key) {
    return CryptoJS.AES.decrypt(str, key).toString(CryptoJS.enc.Utf8).split(/(?<!\\):/).map(i => i.replace(/\\:/g, ':'));
  }

  // --- Chrome v3
  static convert3(pref) {
    // https://groups.google.com/a/chromium.org/g/chromium-extensions/c/6qiMo0P-XS4
    // mode in v3 was saved to localStorage and not accessible in MV3 service worker/event page

    // new database format
    const db = {
      mode: 'disable',
      sync: !!pref?.settings?.useSyncStorage,
      proxyDNS: true,                                       // global preference
      globalExcludeWildcard: '',
      globalExcludeRegex: '',
      data: []
    };

    const sk = pref.settings.sk;                            // CryptoJS key
    pref.proxyList?.forEach(key => {
      const item = pref[key].data;
      if (key === 'default' || !item?.patterns) { return; } // skip

      const type = item.isSocks ? (item.socks === '5' ? 'socks5' : 'socks4') :
        (item.type === 'auto' ? 'pac' : 'http');            // default HTTP (no HTTPS option in FP Chrome v3)

      // decrypt username, password
      const [username = '', password = ''] = sk ? this.decrypt(item.credentials, sk) : [];

      const pxy = {
        active: item.enabled,
        title: item.name || '',
        color: item.color || Color.getRandom(),             // random color
        type,                                               // convert to actual type: http | https | socks4 | socks5 | + PAC
        hostname: item.host,                                // rename to hostname
        port: item.port,
        username,
        password,
        cc: '',                                             // remove country, use CC in country-code.js
        city: '',
        include: [],
        exclude: [],
        pac: type === 'pac' ? item.configUrl : ''
      };

      // process include/exclude
      item.patterns.forEach(elem => {
        const p = elem.data;
        if (!p?.type) { return; }                           //skip

        const pat = {
          active: true,
          pattern: p.url,                                   // v3 keep patterns as they are
          title: p.name || '',
          type: p.type === 'wildcard' ? 'wildcard' : 'regex' // uses wildcard | regexp  -> change to regex
        };

        // Validate RegExp, deactivate on error
        !Pattern.validate(p.pattern, p.type) && (p.active = false);

        // whitelist: Inclusive/Exclusive
        p.whitelist === 'Inclusive' ? pxy.include.push(pat) : pxy.exclude.push(pat);
      });

      db.data.push(pxy);
    });

    return db;
  }

  // --- Firefox v6-7 (also used in Options -> Import Older Export)
  static convert7(pref) {
    const typeSet = {
      1: 'http',    // PROXY_TYPE_HTTP
      2: 'https',   // PROXY_TYPE_HTTPS
      3: 'socks5',  // PROXY_TYPE_SOCKS5
      4: 'socks4',  // PROXY_TYPE_SOCKS4
      5: 'direct'   // PROXY_TYPE_NONE
    };

    const patternSet = {
      1: 'wildcard',
      2: 'regex'
    };

    // new database format
    let mode = pref.mode || 'disable';
    pref.mode === 'disabled' && (pref.mode = 'disable');    // rename disabled -> disable
    pref.mode === 'patterns' && (pref.mode = 'pattern');    // rename patterns -> pattern
    if (pref[pref.mode]) {                                  // convert old mode
      const i = pref[pref.mode];
      mode = `${i.address}:${i.port}`;
    }

    const db = {
      mode,
      sync: !!pref.sync,
      proxyDNS: true,                                       // global preference
      globalExcludeWildcard: '',
      globalExcludeRegex: '',
      data: []
    };

    const data = Object.values(pref).filter(i => i.hasOwnProperty('address'));
    data.sort((a, b) => a.index - b.index);                 // sort by index

    data.forEach(item => {
      const pxy = {
        active: item.active === 'true' || item.active === true, // convert to boolean, some old databases have mixed types
        title: item.title || '',
        color: item.color || Color.getRandom(),             // random color
        type: typeSet[item.type],                           // convert to actual type: http | https | socks4 | socks5 | direct | + add PAC
        hostname: item.address,                             // rename to hostname
        port: item.port,
        username: item.username,
        password: item.password,
        cc: item.cc || '',                                  // remove country, use CC in country-code.js
        city: '',
        include: item.whitePatterns,                        // rename to include
        exclude: item.blackPatterns,                        // rename to exclude
        pac: ''                                             // add PAC option
      };

      // --- type 'direct'
      pxy.type === 'direct' && (pxy.hostname = 'DIRECT');

/*
      {
        "active": true,
        "pattern": "*.example.com",
        "title": "example",
        "type": 1,
       // "protocols": 1,
      },
*/
      // process include/exclude
      [...pxy.include, ...pxy.exclude].forEach(item => {
        item.type = patternSet[item.type];                  // convert to actual type: wildcard | regex
        item.pattern = this.convertPattern(item.pattern, item.protocols); // convert all | http | https to v3 patterns
        delete item.protocols;                              // no longer needed

        // Validate RegExp, deactivate on error
        !Pattern.validate(item.pattern, item.type) && (item.active = false);
      });

      db.data.push(pxy);
    });

    return db;
  }

/*
  .bbc.co.uk      exact domain and all subdomains
  *.bbc.co.uk     exact domain and all subdomains
  **.bbc.co.uk    subdomains only (not bbc.co.uk)
*/
  static convertPattern(pat, protocol) {
    const protocolSet = {
      1: '*://',            // all
      2: 'http://',         // http
      4: 'https://'         // https
    };

    return protocolSet[protocol] + (pat[0] === '.' ? '*' : '') + pat + '/';
  }
}