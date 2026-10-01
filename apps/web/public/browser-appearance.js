try {
  const appearance = localStorage.getItem('moor-appearance');
  if (['light', 'dark', 'system'].includes(appearance))
    document.documentElement.dataset.theme = appearance;
} catch {
  // The browser's system theme remains available without persistent preferences.
}
