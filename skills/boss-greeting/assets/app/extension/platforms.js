/* Shared URL allowlist for the extension and Node service. No network requests. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RecruitmentPlatforms = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  const labels = Object.freeze({boss:'BOSS直聘',liepin:'猎聘',zhilian:'智联招聘'});
  const matches = Object.freeze([
    'https://www.zhipin.com/job_detail/*', 'https://www.zhipin.com/web/geek/job*',
    'https://www.liepin.com/job/*', 'https://www.liepin.com/a/*',
    'https://www.zhaopin.com/jobdetail/*', 'https://jobs.zhaopin.com/*'
  ]);
  function identifyJobURL(value) {
    let url;
    try {url = new URL(value);} catch {return null;}
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    // BOSS job identifiers can contain '~', including its escaped URL form.
    // Decode only this unreserved character; encoded separators stay rejected.
    const pathname = url.hostname === 'www.zhipin.com' ? url.pathname.replace(/%7e/gi, '~') : url.pathname;
    let id = '', canonicalUrl = url.origin + pathname;
    if (url.hostname === 'www.zhipin.com' &&
      (/^\/job_detail\/[\w~-]+\.html$/.test(pathname) || /^\/web\/geek\/(?:job|job-recommend)\/?$/.test(pathname))) id = 'boss';
    else if (url.hostname === 'www.liepin.com' && /^\/(?:job|a)\/\d{5,30}\.shtml$/.test(pathname)) id = 'liepin';
    else if (url.hostname === 'www.zhaopin.com' && /^\/jobdetail\/[a-z0-9_-]{6,100}\.html?$/i.test(pathname)) id = 'zhilian';
    else if (url.hostname === 'jobs.zhaopin.com' && /^\/[a-z0-9_-]{6,100}\.html?$/i.test(pathname)) {
      id = 'zhilian'; canonicalUrl = 'https://www.zhaopin.com/jobdetail' + pathname;
    }
    return id ? {id,label:labels[id],canonicalUrl} : null;
  }
  return Object.freeze({identifyJobURL,isSupportedURL:value=>Boolean(identifyJobURL(value)),labels,matches});
});
