/* This helper reads only known, visible job-detail roots. It never reads body text. */
(() => {
  const TITLE = ['.job-name', '.name h1', '.job-title', 'h1'];
  const DESCRIPTION = ['.job-sec-text', '.job-detail-body .text', '.job-detail .job-description', '[data-job-description]'];
  function visible(element) {
    if (!element || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
  }
  function text(element, max) {
    if (!visible(element)) return '';
    return (element.innerText || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  }
  function first(root, selectors, max) {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        const value = text(element, max);
        if (value) return value;
      }
    }
    return '';
  }
  function collect(root, url, detailPage) {
    if (!visible(root)) return null;
    const title = first(root, TITLE, 160);
    const description = first(root, DESCRIPTION, 18000);
    if (!title || description.length < 30) return null;
    const jobLink = root.querySelector('a[href*="/job_detail/"]');
    let jobUrl = url;
    if (!detailPage && jobLink) {
      const candidate = new URL(jobLink.getAttribute('href'), url);
      if (candidate.origin === 'https://www.zhipin.com' && /^\/job_detail\/[\w-]+\.html$/.test(candidate.pathname)) jobUrl = candidate.origin + candidate.pathname;
    }
    return {
      url: jobUrl,
      title,
      company: first(root, ['.company-name', '.company-info .name', '.company-info a[title]', '.sider-company .company-name'], 160),
      description,
      salary: first(root, ['.salary', '.job-salary'], 100),
      requirements: first(root, ['.job-limit', '.job-require', '.job-primary .info-primary p'], 1000)
    };
  }
  function extract(doc = document, url = location.href) {
    const address = new URL(url);
    if (address.origin !== 'https://www.zhipin.com') return null;
    const detailPage = /^\/job_detail\/[\w-]+\.html$/.test(address.pathname);
    const searchPage = /^\/web\/geek\/(?:job|job-recommend)\/?$/.test(address.pathname);
    if (!detailPage && !searchPage) return null;
    // On search pages a modal must contain its own title and full description.
    const roots = detailPage
      ? ['.job-detail-box', '.job-detail-container', '.job-detail', '#main']
      : ['.job-detail-container', '.job-detail-box', '.job-detail', '.job-detail-dialog', '[role="dialog"]'];
    for (const selector of roots) {
      for (const root of doc.querySelectorAll(selector)) {
        if (root.closest('.job-list-box,.job-list,.chat-conversation,.chat-record')) continue;
        const result = collect(root, address.origin + address.pathname, detailPage);
        if (result) return result;
      }
    }
    return null;
  }
  globalThis.BossJobExtractor = { extract };
})();
