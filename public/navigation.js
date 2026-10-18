(function () {
  'use strict';
  const pages = Object.freeze({
    workbench: { path: '/workbench', label: '汇报工作台' },
    projects: { path: '/projects', label: '我的汇报' },
    guide: { path: '/guide', label: '使用指南' },
    samples: { path: '/samples', label: '汇报样片' },
  });
  const resolve = pathname => Object.keys(pages).find(key => pages[key].path === String(pathname || '').replace(/\/$/, '')) || 'workbench';
  const navigation = Object.freeze({pages, resolve});
  if (typeof window !== 'undefined') window.CampusPPTNavigation = navigation;
  if (typeof module !== 'undefined') module.exports = navigation;
})();
