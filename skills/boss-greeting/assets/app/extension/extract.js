/* This helper reads only known, visible job-detail roots. It never reads body text. */
(() => {
  const registry = globalThis.RecruitmentPlatforms;
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
      try {
        const candidate = registry.identifyJobURL(new URL(jobLink.getAttribute('href'), url).href);
        if (candidate?.id === 'boss' && new URL(candidate.canonicalUrl).pathname.startsWith('/job_detail/')) jobUrl = candidate.canonicalUrl;
      } catch { /* Ignore an invalid detail link; keep the verified current route. */ }
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
  function boss(doc, identified) {
    // The shared registry already verified this BOSS route. Reuse its canonical
    // path so detail extraction cannot drift from panel and server validation.
    const detailPage = new URL(identified.canonicalUrl).pathname.startsWith('/job_detail/');
    // On search pages a modal must contain its own title and full description.
    const roots = detailPage
      ? ['.job-detail-box', '.job-detail-container', '.job-detail', '#main']
      : ['.job-detail-container', '.job-detail-box', '.job-detail', '.job-detail-dialog', '[role="dialog"]'];
    for (const selector of roots) {
      for (const root of doc.querySelectorAll(selector)) {
        if (root.closest('.job-list-box,.job-list,.chat-conversation,.chat-record')) continue;
        const result = collect(root, identified.canonicalUrl, detailPage);
        if (result) return result;
      }
    }
    return null;
  }
  function unique(root, selector) {
    const values = [...root.querySelectorAll(selector)].filter(visible);
    return values.length === 1 ? values[0] : null;
  }
  function liepin(doc, identified) {
    // The verified desktop page uses separate, uniquely scoped header and intro sections.
    const header = unique(doc, '.job-apply-container');
    const details = unique(doc, '.job-apply-container-desc .job-intro-container');
    if (!header || !details || header.closest('.job-list,.job-list-item') || details.closest('.job-list,.job-list-item')) return null;
    const title = first(header, ['.name-box .name'], 160);
    const description = first(details, ['[data-selector="job-intro-content"]'], 18000);
    if (!title || description.length < 30) return null;
    return {
      url: identified.canonicalUrl, title, description,
      company: first(doc, ['.company-info-container .company-card .content .name'], 160),
      salary: first(header, ['.salary'], 100), requirements: first(header, ['.job-properties'], 1000)
    };
  }
  function zhilian(doc, identified) {
    const root = unique(doc, '.main-jobs');
    if (!root || root.closest('.job-list,.chat-conversation,.chat-record')) return null;
    const descriptions = [...root.querySelectorAll('.describtion-card__detail-content')].filter(visible);
    // Guest-clamped descriptions are intentionally incomplete in the visible site UI.
    const complete = descriptions.filter(element => !element.classList?.contains('describtion-card__detail-content--guest-clamp'));
    if (complete.length !== 1) return null;
    const title = first(root, ['.job-summary .summary-planes__title', '.summary-planes__title'], 160);
    const description = text(complete[0],18000);
    if (!title || description.length < 30) return null;
    return {
      url: identified.canonicalUrl, title, description,
      company: first(root, ['.company-info__name', '.company-summary__name-link'], 160),
      salary: first(root, ['.summary-planes__salary'], 100),
      requirements: first(root, ['.summary-planes__info'], 1000)
    };
  }
  function extract(doc = document, url = location.href) {
    const identified = registry?.identifyJobURL(url);
    if (!identified) return null;
    let result;
    if (identified.id === 'boss') result = boss(doc,identified);
    else if (identified.id === 'liepin') result = liepin(doc,identified);
    else if (identified.id === 'zhilian') result = zhilian(doc,identified);
    return result ? {...result, platform:identified.id,platformLabel:identified.label} : null;
  }
  globalThis.BossJobExtractor = globalThis.RecruitmentJobExtractor = { extract };
})();
